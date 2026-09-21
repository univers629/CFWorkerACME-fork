/**
 * 开放 API /api/v1/*
 * -------------------------------------------------------------------------
 * 鉴权：X-API-Mail + X-API-Token（或 Authorization: Bearer <mail>:<token>）
 *       token 与 Users.apis 做等值比较；
 *
 * 限流：按用户维度（mail）每分钟 API_RATE_LIMIT（默认 60）次；
 *       超过返回 429。内存计数器在 Worker 实例内生效。
 *
 * 端点：
 *   POST /api/v1/orders                      创建证书申请
 *   GET  /api/v1/orders                      列出当前用户的订单
 *   GET  /api/v1/orders/:uuid                获取单个订单
 *   GET  /api/v1/orders/:uuid/pem            下载 fullchain.pem + privkey
 *   GET  /api/v1/orders/:uuid/zip            下载 ZIP
 *   GET  /api/v1/orders/:uuid/pfx            下载 PFX
 *   POST /api/v1/orders/:uuid/revoke         吊销证书
 *
 * 当 CERT_CAPTCHA_ENABLED=true 时，提交/吊销接口直接 403 CAPTCHA_REQUIRED。
 */

import type {Context, Hono, Next} from "hono";
import type {AppEnv, Bindings} from "../index";
import {ensureDao} from "../db";
import {readInt} from "../db/conf";
import type {ApplyRow, UserRow} from "../db/dao";
import {checkApplyGuard} from "../middleware/applyGuard";
import {buildStoredZip} from "../utils/zip";
import {pemToPfxBuffer, splitCertChain} from "../utils/pfx";
import {getAcmeClient} from "./admin_certs_helper";

/** 解析鉴权头 */
function parseAuth(c: Context): { mail: string; token: string } | null {
    let mail = c.req.header("X-API-Mail") ?? "";
    let token = c.req.header("X-API-Token") ?? "";
    if (!mail || !token) {
        const auth = c.req.header("Authorization") ?? "";
        if (auth.startsWith("Bearer ")) {
            const body = auth.slice(7).trim();
            const idx = body.indexOf(":");
            if (idx > 0) {
                mail = body.slice(0, idx);
                token = body.slice(idx + 1);
            }
        }
    }
    mail = mail.trim().toLowerCase();
    token = token.trim();
    if (!mail || !token) return null;
    return {mail, token};
}

/** 内存限流器：Map<mail, { count, resetAt }> */
const RATE_BUCKET = new Map<string, { count: number; resetAt: number }>();

function rateLimit(mail: string, limitPerMinute: number): boolean {
    const now = Date.now();
    const bucket = RATE_BUCKET.get(mail);
    if (!bucket || bucket.resetAt <= now) {
        RATE_BUCKET.set(mail, {count: 1, resetAt: now + 60_000});
        return true;
    }
    if (bucket.count >= limitPerMinute) return false;
    bucket.count += 1;
    return true;
}

/**
 * 鉴权 + 限流中间件
 * 将当前用户挂到 c.set("apiUser", user)
 */
async function apiAuthMiddleware(c: Context, next: Next): Promise<Response | void> {
    const parsed = parseAuth(c);
    if (!parsed) {
        return c.json({code: "UNAUTHORIZED", message: "缺少鉴权头 X-API-Mail / X-API-Token"}, 401);
    }
    const dao = await ensureDao(c.env as any);
    const user = await dao.getUser(parsed.mail);
    if (!user || !user.apis || user.apis !== parsed.token) {
        return c.json({code: "UNAUTHORIZED", message: "鉴权失败"}, 401);
    }
    if (Number(user.flag) !== 1) {
        return c.json({code: "ACCOUNT_INACTIVE", message: "账号未激活或已禁用"}, 403);
    }
    const limit = await readInt(c.env as any, "API_RATE_LIMIT", 60);
    if (!rateLimit(user.mail, Math.max(1, limit))) {
        return c.json({code: "RATE_LIMITED", message: "请求过于频繁，请稍后重试"}, 429);
    }
    c.set("apiUser", user);
    await next();
}

/** 对订单进行所有权校验（管理员默认可读） */
async function ownsApply(dao: any, user: UserRow, uuid: string): Promise<ApplyRow | null> {
    const row = await dao.getApply(uuid);
    if (!row) return null;
    if (row.mail.toLowerCase() === user.mail.toLowerCase()) return row;
    if (Number(user.is_admin ?? 0) === 1) return row;
    return null;
}

/* ============================= POST /api/v1/orders ============================= */
async function handleCreateOrder(c: Context<AppEnv>): Promise<Response> {
    const user = c.get("apiUser") as UserRow;

    // 开放 API 的提交类不走 captcha；统一由 applyGuard 拦截
    let body: any;
    try {
        body = await c.req.json();
    } catch {
        return c.json({code: "BAD_REQUEST", message: "请求体不是合法 JSON"}, 400);
    }
    if (!body?.domains || !Array.isArray(body.domains) || body.domains.length === 0) {
        return c.json({code: "BAD_REQUEST", message: "缺少 domains"}, 400);
    }

    const guard = await checkApplyGuard(c, {source: "api", user});
    if (!guard.ok) {
        return c.json({code: guard.code, message: guard.message}, guard.status as any);
    }

    // 组织 Apply 记录，复用 Web 格式
    const domainSave = body.domains.map((d: any) => ({
        name: d.name, wild: !!d.wild, root: !!d.root, type: d.type ?? "dns-self",
        flag: 0, text: "",
    }));
    const uuid = randomUuid(16);
    const dao = await ensureDao(c.env as any);
    const now = Date.now();
    await dao.insertApply({
        uuid,
        mail: user.mail,
        sign: body.globals?.ca ?? "lets-encrypt",
        type: body.globals?.encryption ?? "eccp256",
        auto: body.globals?.auto_renew ? 1 : 0,
        flag: 0,
        time: now,
        next: new Date(now + 7 * 86400 * 1000).getTime(),
        main: JSON.stringify(body.subject ?? {}),
        list: JSON.stringify(domainSave),
        keys: "", cert: "", data: "",
        text: "订单提交成功（来自 API）",
    } as ApplyRow);

    return c.json({code: "OK", message: "已创建", uuid}, 200);
}

function randomUuid(lens: number): string {
    const charset = "ABCDEFGHJKLMNPQRSTUWXY0123456789";
    let r = "";
    const buf = new Uint8Array(lens);
    (globalThis.crypto as Crypto).getRandomValues(buf);
    for (let i = 0; i < lens; i++) r += charset[buf[i] % charset.length];
    return r;
}

/* ============================= GET /api/v1/orders ============================= */
async function handleListOrders(c: Context<AppEnv>): Promise<Response> {
    const user = c.get("apiUser") as UserRow;
    const q = c.req.query();
    const page = Math.max(1, parseInt(q.page ?? "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(q.page_size ?? "20", 10) || 20));
    const dao = await ensureDao(c.env as any);
    const {rows, total} = await dao.listApplies(
        {eq: {mail: user.mail}},
        {page, pageSize, orderBy: "time", orderDesc: true},
    );
    return c.json({
        code: "OK",
        total,
        page,
        page_size: pageSize,
        items: rows.map(r => ({
            uuid: r.uuid, flag: r.flag, time: r.time, next: r.next,
            sign: r.sign, type: r.type, auto: r.auto,
            main: r.main, list: r.list,
            has_cert: !!(r.cert && r.cert.length > 0),
            has_keys: !!(r.keys && r.keys.length > 0),
        })),
    });
}

/* ============================= GET /api/v1/orders/:uuid ============================= */
async function handleGetOrder(c: Context<AppEnv>): Promise<Response> {
    const user = c.get("apiUser") as UserRow;
    const uuid = c.req.param("uuid") ?? "";
    const dao = await ensureDao(c.env as any);
    const row = await ownsApply(dao, user, uuid);
    if (!row) return c.json({code: "NOT_FOUND", message: "订单不存在或无权访问"}, 404);
    // 仅返回可公开字段：整行展开会连带输出 cert / keys / pending_keys 的私钥明文
    return c.json({
        code: "OK",
        item: {
            uuid: row.uuid, flag: row.flag, time: row.time, next: row.next,
            sign: row.sign, type: row.type, auto: row.auto,
            main: row.main, list: row.list, text: row.text,
            has_cert: !!(row.cert && row.cert.length > 0),
            has_keys: !!(row.keys && row.keys.length > 0),
        },
    });
}

/* ============================= 下载类：pem / zip / pfx ============================= */
async function handleDownloadPem(c: Context<AppEnv>): Promise<Response> {
    const user = c.get("apiUser") as UserRow;
    const uuid = c.req.param("uuid") ?? "";
    const dao = await ensureDao(c.env as any);
    const row = await ownsApply(dao, user, uuid);
    if (!row) return c.json({code: "NOT_FOUND", message: "订单不存在或无权访问"}, 404);
    // 不要求 flag=5：自动续期会把订单重置为 flag=0，此时旧证书仍在服役
    if (!row.cert) {
        return c.json({code: "NOT_READY", message: "证书尚未签发或已被清除"}, 404);
    }
    return c.json({
        code: "OK",
        fullchain: row.cert,
        privkey: row.keys ?? "",
    });
}

async function handleDownloadZip(c: Context<AppEnv>): Promise<Response> {
    const user = c.get("apiUser") as UserRow;
    const uuid = c.req.param("uuid") ?? "";
    const dao = await ensureDao(c.env as any);
    const row = await ownsApply(dao, user, uuid);
    if (!row) return c.json({code: "NOT_FOUND", message: "订单不存在或无权访问"}, 404);
    // 不要求 flag=5（同 handleDownloadPem）
    if (!row.cert || !row.keys) {
        return c.json({code: "NOT_READY", message: "证书尚未签发或已被清除"}, 404);
    }
    const {leaf, chain} = splitCertChain(row.cert);
    const files = [
        {path: "fullchain.pem", content: row.cert},
        {path: "cert.pem", content: leaf},
        {path: "chain.pem", content: chain},
        {path: "privkey.pem", content: row.keys},
    ];
    const buf = await buildStoredZip(files);
    return new Response(buf, {
        status: 200,
        headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${uuid}.zip"`,
            "Cache-Control": "no-store",
        },
    });
}

async function handleDownloadPfx(c: Context<AppEnv>): Promise<Response> {
    const user = c.get("apiUser") as UserRow;
    const uuid = c.req.param("uuid") ?? "";
    const dao = await ensureDao(c.env as any);
    const row = await ownsApply(dao, user, uuid);
    if (!row) return c.json({code: "NOT_FOUND", message: "订单不存在或无权访问"}, 404);
    // 不要求 flag=5（同 handleDownloadPem）
    if (!row.cert || !row.keys) {
        return c.json({code: "NOT_READY", message: "证书尚未签发或已被清除"}, 404);
    }
    // 生成随机 12 位密码
    const buf = new Uint8Array(12);
    (globalThis.crypto as Crypto).getRandomValues(buf);
    const chars = "ABCDEFGHJKLMNPQRSTUWXYZabcdefghjkmnpqrstuwxyz23456789";
    let password = "";
    for (let i = 0; i < 12; i++) password += chars[buf[i] % chars.length];

    try {
        const pfx = await pemToPfxBuffer(row.keys, row.cert, password, primaryDomain(row));
        return new Response(pfx, {
            status: 200,
            headers: {
                "Content-Type": "application/x-pkcs12",
                "Content-Disposition": `attachment; filename="${uuid}.pfx"`,
                "Cache-Control": "no-store",
                "X-PFX-Password": password,
                "Access-Control-Expose-Headers": "X-PFX-Password",
            },
        });
    } catch (e: any) {
        console.error("[api pfx] generate failed:", e?.message ?? e);
        return c.json({code: "PFX_ERROR", message: "PFX 生成失败"}, 500);
    }
}

function primaryDomain(r: ApplyRow): string {
    try {
        const arr = JSON.parse(r.list) as any[];
        if (Array.isArray(arr) && arr.length > 0 && arr[0]?.name) {
            return String(arr[0].name).replace(/^\*\./, "");
        }
    } catch {/* ignore */}
    return r.uuid;
}

/* ============================= POST /api/v1/orders/:uuid/revoke ============================= */
async function handleRevokeOrder(c: Context<AppEnv>): Promise<Response> {
    const user = c.get("apiUser") as UserRow;
    const uuid = c.req.param("uuid") ?? "";

    // captcha 开启时禁止
    const guard = await checkApplyGuard(c, {source: "api", user});
    if (!guard.ok && guard.code === "CAPTCHA_REQUIRED") {
        return c.json({code: guard.code, message: guard.message}, guard.status as any);
    }

    const dao = await ensureDao(c.env as any);
    const row = await ownsApply(dao, user, uuid);
    if (!row) return c.json({code: "NOT_FOUND", message: "订单不存在或无权访问"}, 404);
    if (Number(row.flag) !== 5 || !row.cert) {
        return c.json({code: "NOT_READY", message: "仅对已签发的证书支持吊销"}, 400);
    }
    try {
        const client = await getAcmeClient(c.env as any, user, row);
        await client.revokeCertificate(row.cert);
    } catch (e: any) {
        return c.json({code: "REVOKE_FAILED", message: e?.message ?? "吊销失败"}, 500);
    }
    await dao.updateApply(uuid, {
        flag: -1,
        text: ((row.text ?? "") + `\n[api:${user.mail}] 通过开放 API 吊销证书`).trim(),
    });
    return c.json({code: "OK", message: "已吊销"});
}

/* ============================= 指纹 / 指示器 ============================= */
export async function handleApiFingerprint(
    c: Context<AppEnv>,
    userMail: string,
): Promise<{ configured: boolean; fingerprint: string }> {
    const dao = await ensureDao(c.env as any);
    const u = await dao.getUser(userMail);
    if (!u || !u.apis) return {configured: false, fingerprint: ""};
    // 简单 SHA-256 前 8 字节 hex
    const enc = new TextEncoder().encode(u.apis);
    const digest = await (globalThis.crypto as Crypto).subtle.digest("SHA-256", enc);
    const arr = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < 4; i++) {
        hex += arr[i].toString(16).padStart(2, "0");
    }
    return {configured: true, fingerprint: hex};
}

/* ============================= 挂载 ============================= */
export function mountOpenApiRoutes(app: Hono<AppEnv>): void {
    app.use("/api/v1/*", apiAuthMiddleware);
    app.post("/api/v1/orders", handleCreateOrder);
    app.get("/api/v1/orders", handleListOrders);
    app.get("/api/v1/orders/:uuid", handleGetOrder);
    app.get("/api/v1/orders/:uuid/pem", handleDownloadPem);
    app.get("/api/v1/orders/:uuid/zip", handleDownloadZip);
    app.get("/api/v1/orders/:uuid/pfx", handleDownloadPfx);
    app.post("/api/v1/orders/:uuid/revoke", handleRevokeOrder);
}
