/**
 * /admin/certs —— 管理员证书管理接口
 * -------------------------------------------------------------------------
 * 端点：
 *   GET    /admin/certs                     分页 + 过滤
 *   PATCH  /admin/certs/:uuid               修改 flag（可附带 text 追加操作日志）
 *   POST   /admin/certs/:uuid/revoke        吊销证书（flag=5 时才生效）
 *   POST   /admin/certs/:uuid/purge         清除 keys/cert（禁用下载）
 *   DELETE /admin/certs/:uuid               物理删除
 */

import type {Context, Hono} from "hono";
import type {AppEnv, Bindings} from "../index";
import {ensureDao} from "../db";
import type {ApplyRow, QueryFilter, UserRow} from "../db/dao";
import {adminMiddleware} from "../middleware/admin";
import * as acme from "acme-client";

const FLAG_SET = new Set([-1, 0, 1, 2, 3, 4, 5]);

function appendText(old: string | null | undefined, extra: string): string {
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
    const prefix = `[${stamp}] `;
    const base = old && old.length > 0 ? old + "\n" : "";
    return base + prefix + extra;
}

/**
 * 单条订单的管理员视图：保留 cert / keys 原文。
 * 列表接口改用 DAO 的摘要投影，不返回这些大字段。
 */
function publicApply(r: ApplyRow): any {
    return r;
}

/** 剔除 cert / keys / data，仅保留是否存在的标记 */
function briefApply(r: ApplyRow): any {
    const {keys, cert, data, ...rest} = r;
    return {
        ...rest,
        has_keys: !!(keys && keys.length > 0),
        has_cert: !!(cert && cert.length > 0),
    };
}

/* ============================= GET /admin/certs ============================= */
export async function handleListCerts(c: Context<AppEnv>): Promise<Response> {
    const dao = await ensureDao(c.env as any);
    const q = c.req.query();
    const page = Math.max(1, parseInt(q.page ?? "1", 10) || 1);
    const pageSize = Math.min(200, Math.max(1, parseInt(q.page_size ?? "20", 10) || 20));

    const filter: QueryFilter = {eq: {}, like: {}, gte: {}, lte: {}};
    if (q.mail) filter.like!["mail"] = q.mail;
    if (q.domain) filter.like!["list"] = q.domain;
    if (q.flag !== undefined && q.flag !== "") {
        filter.eq!["flag"] = Number(q.flag);
    }
    if (q.sign !== undefined && q.sign !== "") filter.eq!["sign"] = Number(q.sign);
    if (q.next_from) filter.gte!["next"] = Number(q.next_from);
    if (q.next_to) filter.lte!["next"] = Number(q.next_to);

    const {rows, total} = await dao.listApplySummaries(filter, {
        page, pageSize, orderBy: "time", orderDesc: true,
    });

    return c.json({
        flags: 0,
        total,
        page,
        page_size: pageSize,
        // has_cert / has_keys 在 SQL 中为 0/1，统一转成布尔以匹配前端类型
        items: rows.map((r) => ({...r, has_cert: !!r.has_cert, has_keys: !!r.has_keys})),
    });
}

/* ============================= PATCH /admin/certs/:uuid ============================= */
export async function handleUpdateCert(c: Context<AppEnv>): Promise<Response> {
    const admin = c.get("admin") as UserRow;
    const uuid = c.req.param("uuid") ?? "";
    if (!uuid) return c.json({flags: 4, texts: "订单 UUID 无效"}, 400);

    let body: any;
    try {
        body = await c.req.json();
    } catch {
        return c.json({flags: 4, texts: "请求体不是合法 JSON"}, 400);
    }
    const dao = await ensureDao(c.env as any);
    const row = await dao.getApply(uuid);
    if (!row) return c.json({flags: 5, texts: "订单不存在"}, 404);

    const patch: Partial<ApplyRow> = {};
    if (typeof body.flag !== "undefined") {
        const f = Number(body.flag);
        if (!FLAG_SET.has(f)) return c.json({flags: 6, texts: "flag 取值非法"}, 400);
        patch.flag = f;
    }
    if (typeof body.text === "string" && body.text.length > 0) {
        patch.text = appendText(row.text, `[admin:${admin.mail}] ${body.text}`);
    } else if (patch.flag !== undefined) {
        patch.text = appendText(row.text, `[admin:${admin.mail}] flag → ${patch.flag}`);
    }
    if (Object.keys(patch).length === 0) {
        return c.json({flags: 7, texts: "没有可更新的字段"}, 400);
    }
    await dao.updateApply(uuid, patch);
    const updated = await dao.getApply(uuid);
    return c.json({flags: 0, texts: "更新成功", item: updated ? briefApply(updated) : null});
}

/* ============================= POST /admin/certs/:uuid/revoke ============================= */
export async function handleRevokeCert(c: Context<AppEnv>): Promise<Response> {
    const admin = c.get("admin") as UserRow;
    const uuid = c.req.param("uuid") ?? "";
    if (!uuid) return c.json({flags: 4, texts: "订单 UUID 无效"}, 400);

    const dao = await ensureDao(c.env as any);
    const row = await dao.getApply(uuid);
    if (!row) return c.json({flags: 5, texts: "订单不存在"}, 404);
    if (Number(row.flag) !== 5) {
        return c.json({flags: 6, texts: "仅对已签发（flag=5）的证书支持吊销"}, 400);
    }
    if (!row.cert || row.cert.length === 0) {
        return c.json({flags: 7, texts: "证书内容为空，无法吊销"}, 400);
    }

    const user = await dao.getUser(row.mail);
    if (!user) {
        return c.json({flags: 8, texts: "对应用户已不存在"}, 400);
    }

    // 尝试调用 ACME 吊销；不同 CA 的支持情况不同，失败时保留原状态
    try {
        const {getAcmeClient} = await import("./admin_certs_helper");
        const client = await getAcmeClient(c.env as any, user, row);
        await client.revokeCertificate(row.cert);
    } catch (e: any) {
        const msg = e?.message ?? String(e);
        console.error("[admin revoke] failed:", msg);
        await dao.updateApply(uuid, {
            text: appendText(row.text, `[admin:${admin.mail}] 吊销失败：${msg}`),
        });
        return c.json({flags: 9, texts: "吊销失败：" + msg}, 500);
    }

    // 成功：flag 改为 -1，追加日志；保留 cert 供审计，只是禁止下载（由下载接口校验 flag）
    await dao.updateApply(uuid, {
        flag: -1,
        text: appendText(row.text, `[admin:${admin.mail}] 已吊销证书`),
    });
    return c.json({flags: 0, texts: "已成功吊销证书"});
}

/* ============================= POST /admin/certs/:uuid/purge ============================= */
export async function handlePurgeCert(c: Context<AppEnv>): Promise<Response> {
    const admin = c.get("admin") as UserRow;
    const uuid = c.req.param("uuid") ?? "";
    if (!uuid) return c.json({flags: 4, texts: "订单 UUID 无效"}, 400);

    const dao = await ensureDao(c.env as any);
    const row = await dao.getApply(uuid);
    if (!row) return c.json({flags: 5, texts: "订单不存在"}, 404);

    await dao.updateApply(uuid, {
        keys: "",
        cert: "",
        // 一并清掉 pending_keys：该字段是签发过程中暂存的新私钥，
        // 若留下，certs.healMissingKeys 会把 keys 重新填回去，
        // 使这个「不可恢复」的操作被下一轮 cron 悄悄撤销。
        pending_keys: "",
        text: appendText(row.text, `[admin:${admin.mail}] 已清除证书密钥与证书内容`),
    });
    return c.json({flags: 0, texts: "已清除 keys/cert，证书不再支持下载"});
}

/* ============================= DELETE /admin/certs/:uuid ============================= */
export async function handleDeleteCert(c: Context<AppEnv>): Promise<Response> {
    const uuid = c.req.param("uuid") ?? "";
    if (!uuid) return c.json({flags: 4, texts: "订单 UUID 无效"}, 400);

    let body: any = {};
    try {
        body = await c.req.json();
    } catch {/* 允许空 body */}

    const dao = await ensureDao(c.env as any);
    const row = await dao.getApply(uuid);
    if (!row) return c.json({flags: 5, texts: "订单不存在"}, 404);

    // 二次确认：前端应传 confirm = uuid
    if (String(body.confirm ?? "") !== uuid) {
        return c.json({flags: 6, texts: "请输入订单 UUID 进行二次确认"}, 400);
    }

    await dao.deleteApply(uuid);
    return c.json({flags: 0, texts: "已删除订单"});
}

/* ============================= 挂载 ============================= */
export function mountAdminCertsRoutes(app: Hono<AppEnv>): void {
    app.use("/admin/certs", adminMiddleware);
    app.use("/admin/certs/*", adminMiddleware);
    app.get("/admin/certs", handleListCerts);
    app.patch("/admin/certs/:uuid", handleUpdateCert);
    app.post("/admin/certs/:uuid/revoke", handleRevokeCert);
    app.post("/admin/certs/:uuid/purge", handlePurgeCert);
    app.delete("/admin/certs/:uuid", handleDeleteCert);
}

// 重新导出以避免 circular import 问题
export {publicApply};
