/**
 * /admin/users  —— 管理员用户管理接口
 * -------------------------------------------------------------------------
 * 端点：
 *   GET    /admin/users                      分页 + 过滤
 *   PATCH  /admin/users/:mail                编辑 flag / is_admin / quota / text
 *   POST   /admin/users/:mail/password       重置密码（body: { pass: SHA256 }）
 *   DELETE /admin/users/:mail                删除（body: { confirm: mail }）
 *
 * 强约束：
 *   1. 响应体严禁回显 Users.keys / Users.apis 的明文 —— 统一以 "***" 脱敏；
 *   2. 禁止「重置/导出 ACME 私钥」：任何涉及 keys 字段的修改一律拒绝；
 *   3. 禁止删除最后一个管理员；禁止管理员取消自身管理员身份。
 */

import type {Context, Hono} from "hono";
import type {AppEnv, Bindings} from "../index";
import {ensureDao} from "../db";
import type {QueryFilter, UserRow} from "../db/dao";
import {adminMiddleware} from "../middleware/admin";

/** 公开给前端的用户视图（脱敏） */
interface UserPublic {
    mail: string;
    flag: string;
    is_admin: number;
    quota: number;
    time: number | null;
    keys_configured: boolean;
    apis_configured: boolean;
    /** 当前生效证书数量 */
    active_certs?: number;
    /** 当前 UTC 自然月已申请数 */
    month_applies?: number;
}

function sanitize(u: UserRow): UserPublic {
    return {
        mail: u.mail,
        flag: String(u.flag ?? "0"),
        is_admin: Number(u.is_admin ?? 0),
        quota: Number(u.quota ?? -1),
        time: u.time ?? null,
        keys_configured: !!(u.keys && u.keys.length > 0),
        apis_configured: !!(u.apis && u.apis.length > 0),
    };
}

/** 计算当前 UTC 自然月的 [start, end) 毫秒区间 */
function monthRangeUtc(now: Date = new Date()): { start: number; end: number } {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    return {start, end};
}

/* ============================= GET /admin/users ============================= */
export async function handleListUsers(c: Context<AppEnv>): Promise<Response> {
    const dao = await ensureDao(c.env as any);
    const q = c.req.query();
    const page = Math.max(1, parseInt(q.page ?? "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(q.page_size ?? "20", 10) || 20));

    // 过滤条件 ------------------------------------------------------------
    const filter: QueryFilter = {eq: {}, like: {}, gte: {}, lte: {}};
    if (q.mail) filter.like!["mail"] = q.mail;
    if (q.flag) filter.eq!["flag"] = q.flag;
    if (q.is_admin === "0" || q.is_admin === "1") {
        filter.eq!["is_admin"] = Number(q.is_admin);
    }
    if (q.quota_min) filter.gte!["quota"] = Number(q.quota_min);
    if (q.quota_max) filter.lte!["quota"] = Number(q.quota_max);

    const {rows, total} = await dao.listUsers(filter, {
        page, pageSize, orderBy: "time", orderDesc: true,
    });

    // 每行附带 active_certs / month_applies（N 次查询，用户量级可控）
    const {start, end} = monthRangeUtc();
    const items: UserPublic[] = [];
    for (const u of rows) {
        const base = sanitize(u);
        try {
            base.active_certs = await dao.countActiveAppliesByMail(u.mail);
            base.month_applies = await dao.countAppliesByMailInRange(u.mail, start, end);
        } catch {
            base.active_certs = 0;
            base.month_applies = 0;
        }
        items.push(base);
    }

    return c.json({
        flags: 0,
        total,
        page,
        page_size: pageSize,
        items,
    });
}

/* ============================= PATCH /admin/users/:mail ============================= */
export async function handleUpdateUser(c: Context<AppEnv>): Promise<Response> {
    const admin = c.get("admin") as UserRow;
    const target = decodeURIComponent(c.req.param("mail") ?? "").toLowerCase();
    if (!target) return c.json({flags: 4, texts: "目标邮箱无效"}, 400);

    let body: any;
    try {
        body = await c.req.json();
    } catch {
        return c.json({flags: 4, texts: "请求体不是合法 JSON"}, 400);
    }

    const dao = await ensureDao(c.env as any);
    const victim = await dao.getUser(target);
    if (!victim) return c.json({flags: 5, texts: "用户不存在"}, 404);

    // 构造允许的补丁字段 -------------------------------------------------
    const patch: Partial<UserRow> = {};
    if (typeof body.flag !== "undefined") patch.flag = String(body.flag);
    if (typeof body.is_admin !== "undefined") patch.is_admin = body.is_admin ? 1 : 0;
    if (typeof body.quota !== "undefined") {
        const q = Number(body.quota);
        if (!Number.isFinite(q) || q < -1) {
            return c.json({flags: 6, texts: "配额必须为 -1 或非负整数"}, 400);
        }
        patch.quota = q;
    }

    // 禁止通过本接口改动 keys / apis / pass 等敏感字段
    if (body.keys !== undefined || body.apis !== undefined || body.pass !== undefined) {
        return c.json({flags: 7, texts: "不允许通过此接口修改 keys/apis/pass 字段"}, 403);
    }

    // 禁止管理员取消自身管理员 ------------------------------------------
    if (patch.is_admin === 0 && admin.mail.toLowerCase() === target) {
        return c.json({flags: 8, texts: "不能取消自身的管理员身份"}, 400);
    }

    // 禁止把最后一个管理员降级 ------------------------------------------
    if (patch.is_admin === 0 && Number(victim.is_admin) === 1) {
        const adminCount = await dao.countAdmins();
        if (adminCount <= 1) {
            return c.json({flags: 9, texts: "系统中必须保留至少一名管理员"}, 400);
        }
    }

    if (Object.keys(patch).length === 0) {
        return c.json({flags: 10, texts: "没有可更新的字段"}, 400);
    }

    await dao.updateUser(target, patch);
    const updated = await dao.getUser(target);
    return c.json({flags: 0, texts: "更新成功", item: updated ? sanitize(updated) : null});
}

/* ============================= POST /admin/users/:mail/password ============================= */
export async function handleResetPassword(c: Context<AppEnv>): Promise<Response> {
    const target = decodeURIComponent(c.req.param("mail") ?? "").toLowerCase();
    if (!target) return c.json({flags: 4, texts: "目标邮箱无效"}, 400);

    let body: any;
    try {
        body = await c.req.json();
    } catch {
        return c.json({flags: 4, texts: "请求体不是合法 JSON"}, 400);
    }
    const pass = String(body.pass ?? "").trim();
    // 约定前端提交 SHA256(明文)，长度应为 64 的 hex 字符串
    if (!/^[A-Fa-f0-9]{64}$/.test(pass)) {
        return c.json({flags: 6, texts: "密码格式无效：需提交 SHA256 十六进制"}, 400);
    }

    const dao = await ensureDao(c.env as any);
    const victim = await dao.getUser(target);
    if (!victim) return c.json({flags: 5, texts: "用户不存在"}, 404);

    await dao.updateUser(target, {pass});
    return c.json({flags: 0, texts: "密码已重置，请线下告知用户新密码"});
}

/* ============================= DELETE /admin/users/:mail ============================= */
export async function handleDeleteUser(c: Context<AppEnv>): Promise<Response> {
    const admin = c.get("admin") as UserRow;
    const target = decodeURIComponent(c.req.param("mail") ?? "").toLowerCase();
    if (!target) return c.json({flags: 4, texts: "目标邮箱无效"}, 400);

    let body: any;
    try {
        body = await c.req.json();
    } catch {
        body = {};
    }
    const confirm = String(body.confirm ?? "").trim().toLowerCase();
    if (confirm !== target) {
        return c.json({flags: 6, texts: "请输入目标邮箱进行二次确认"}, 400);
    }

    if (admin.mail.toLowerCase() === target) {
        return c.json({flags: 7, texts: "不能删除自身账号"}, 400);
    }

    const dao = await ensureDao(c.env as any);
    const victim = await dao.getUser(target);
    if (!victim) return c.json({flags: 5, texts: "用户不存在"}, 404);

    // 最后一个管理员保护
    if (Number(victim.is_admin) === 1) {
        const adminCount = await dao.countAdmins();
        if (adminCount <= 1) {
            return c.json({flags: 8, texts: "系统中必须保留至少一名管理员"}, 400);
        }
    }

    // 先级联删 Apply，再删 User
    await dao.deleteAppliesByMail(target);
    await dao.deleteUser(target);
    return c.json({flags: 0, texts: "已删除用户及其证书申请记录"});
}

/* ============================= 挂载 ============================= */
export function mountAdminUsersRoutes(app: Hono<AppEnv>): void {
    app.use("/admin/users", adminMiddleware);
    app.use("/admin/users/*", adminMiddleware);
    app.get("/admin/users", handleListUsers);
    app.patch("/admin/users/:mail", handleUpdateUser);
    app.post("/admin/users/:mail/password", handleResetPassword);
    app.delete("/admin/users/:mail", handleDeleteUser);
}
