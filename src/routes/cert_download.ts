/**
 * 证书下载增强：ZIP 与 PFX
 * -------------------------------------------------------------------------
 * - GET /ca_zip/?uuid=xxx  返回 application/zip，包含全链路证书与私钥
 * - GET /ca_pfx/?uuid=xxx  返回 application/x-pkcs12，密码随机 12 位
 *
 * 权限：
 *   - 证书拥有者（cookie 登录）或管理员；其余一律 403；
 *   - cert/keys 为空 → 404（不要求 flag=5，见 loadOrderForDownload）；
 *   - PFX 密码以 X-PFX-Password 响应头返回，仅一次，不入库不记日志。
 */

import type {Context, Hono} from "hono";
import type {AppEnv, Bindings} from "../index";
import * as local from "hono/cookie";
import {ensureDao} from "../db";
import {userAuth} from "../users";
import type {ApplyRow} from "../db/dao";
import {buildStoredZip} from "../utils/zip";
import {pemToPfxBuffer, splitCertChain} from "../utils/pfx";

/** 随机 12 位 a-zA-Z0-9 */
function randomPfxPassword(): string {
    const charset = "ABCDEFGHJKLMNPQRSTUWXYZabcdefghjkmnpqrstuwxyz23456789";
    const arr = new Uint8Array(12);
    (globalThis.crypto as Crypto).getRandomValues(arr);
    let s = "";
    for (let i = 0; i < 12; i++) s += charset[arr[i] % charset.length];
    return s;
}

/**
 * 校验当前请求对订单有读取权限：所有者 or 管理员。
 * @returns 通过时返回 ApplyRow，失败时返回 Response。
 */
async function loadOrderForDownload(
    c: Context<AppEnv>,
    uuid: string,
): Promise<ApplyRow | Response> {
    if (!await userAuth(c)) {
        return c.json({flags: 2, texts: "用户尚未登录"}, 401);
    }
    const dao = await ensureDao(c.env as any);
    const order = await dao.getApply(uuid);
    if (!order) return c.json({flags: 5, texts: "订单不存在"}, 404);

    const mail = local.getCookie(c, "mail") ?? "";
    if (mail.toLowerCase() !== order.mail.toLowerCase()) {
        // 非所有者：需管理员身份
        const u = await dao.getUser(mail);
        if (!u || Number(u.is_admin ?? 0) !== 1) {
            return c.json({flags: 7, texts: "无权限访问该证书"}, 403);
        }
    }

    // 只要求证书与私钥存在，不要求 flag=5：自动续期会把订单重置为 flag=0，
    // 此时旧证书仍在服役，同步脚本必须仍能拉取。
    if (!order.cert || !order.keys) {
        return c.json({flags: 6, texts: "证书尚未签发或已被清除"}, 404);
    }
    return order;
}

/** 主域名解析：从 list JSON 中找第一个 */
function primaryDomain(order: ApplyRow): string {
    try {
        const arr = JSON.parse(order.list) as any[];
        if (Array.isArray(arr) && arr.length > 0 && arr[0]?.name) {
            return String(arr[0].name).replace(/^\*\./, "");
        }
    } catch {/* ignore */}
    return order.uuid;
}

/** 生成 README 内容 */
function buildReadme(order: ApplyRow): string {
    const domains = (() => {
        try {
            const a = JSON.parse(order.list) as any[];
            return a.map((d: any) => d?.name).filter(Boolean).join(", ");
        } catch {
            return "";
        }
    })();
    const expire = order.next ? new Date(order.next).toISOString() : "-";
    return [
        "CertHub - SSL 证书下载包",
        "===============================",
        `订单 UUID: ${order.uuid}`,
        `域名列表:  ${domains}`,
        `签发时间:  ${new Date(order.time).toISOString()}`,
        `到期时间:  ${expire}`,
        "",
        "文件说明：",
        "  fullchain.pem   证书 + 中间证书（大多数 Web 服务器使用此项）",
        "  cert.pem        仅叶子证书",
        "  chain.pem       仅中间证书（CA Bundle）",
        "  privkey.pem     私钥",
        "",
        "请妥善保管私钥，不要将其暴露在公网。",
    ].join("\n");
}

/* ============================= GET /ca_zip/ ============================= */
export async function handleCaZip(c: Context<AppEnv>): Promise<Response> {
    const uuid = (c.req.query("uuid") ?? "").trim();
    if (!uuid) return c.json({flags: 4, texts: "缺少 uuid"}, 400);

    const result = await loadOrderForDownload(c, uuid);
    if (result instanceof Response) return result;
    const order = result;

    const {leaf, chain} = splitCertChain(order.cert ?? "");

    const files: { path: string; content: string }[] = [
        {path: "fullchain.pem", content: order.cert ?? ""},
        {path: "cert.pem", content: leaf},
        {path: "chain.pem", content: chain},
        {path: "privkey.pem", content: order.keys ?? ""},
        {path: "README.txt", content: buildReadme(order)},
    ];

    const zipBuffer = await buildStoredZip(files);
    const name = primaryDomain(order);
    return new Response(zipBuffer, {
        status: 200,
        headers: {
            "Content-Type": "application/zip",
            "Content-Disposition": `attachment; filename="${name}.zip"`,
            "Cache-Control": "no-store",
        },
    });
}

/* ============================= GET /ca_pfx/ ============================= */
export async function handleCaPfx(c: Context<AppEnv>): Promise<Response> {
    const uuid = (c.req.query("uuid") ?? "").trim();
    if (!uuid) return c.json({flags: 4, texts: "缺少 uuid"}, 400);

    const result = await loadOrderForDownload(c, uuid);
    if (result instanceof Response) return result;
    const order = result;

    const password = randomPfxPassword();
    let pfxBuf: Uint8Array;
    try {
        pfxBuf = await pemToPfxBuffer(
            order.keys ?? "",
            order.cert ?? "",
            password,
            primaryDomain(order),
        );
    } catch (e: any) {
        console.error("[ca_pfx] generate failed:", e?.message ?? e);
        return c.json({flags: 8, texts: "PFX 生成失败，请联系管理员"}, 500);
    }

    const name = primaryDomain(order);
    return new Response(pfxBuf, {
        status: 200,
        headers: {
            "Content-Type": "application/x-pkcs12",
            "Content-Disposition": `attachment; filename="${name}.pfx"`,
            "Cache-Control": "no-store",
            "X-PFX-Password": password,
            // 暴露给浏览器可读（跨域并非默认；同源下 fetch 可直接读取）
            "Access-Control-Expose-Headers": "X-PFX-Password",
        },
    });
}

export function mountCertDownloadRoutes(app: Hono<AppEnv>): void {
    app.get("/ca_zip/", handleCaZip);
    app.get("/ca_pfx/", handleCaPfx);
}
