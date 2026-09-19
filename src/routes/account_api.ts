/**
 * 用户自助：API 凭证
 * -------------------------------------------------------------------------
 * - GET  /account/apitoken          仅返回 {configured, fingerprint}
 * - GET  /account/apitoken?reveal=1 额外返回 token 明文（供页面显示一次）
 * - POST /account/apitoken/rotate   重置 apis token
 *
 * 所有端点需登录态（Cookie）。**严禁在前端持久化或自动展示明文。**
 */

import type {Context, Hono} from "hono";
import * as local from "hono/cookie";
import type {AppEnv, Bindings} from "../index";
import {ensureDao} from "../db";
import {userAuth, newNonce} from "../users";

async function fingerprint(token: string): Promise<string> {
    const enc = new TextEncoder().encode(token);
    const digest = await (globalThis.crypto as Crypto).subtle.digest("SHA-256", enc);
    const arr = new Uint8Array(digest);
    let hex = "";
    for (let i = 0; i < 4; i++) hex += arr[i].toString(16).padStart(2, "0");
    return hex;
}

async function handleGetToken(c: Context<AppEnv>): Promise<Response> {
    if (!await userAuth(c)) return c.json({flags: 2, texts: "用户尚未登录"}, 401);
    const mail = local.getCookie(c, "mail") ?? "";
    const dao = await ensureDao(c.env as any);
    const u = await dao.getUser(mail);
    if (!u) return c.json({flags: 4, texts: "用户不存在"}, 404);
    const reveal = c.req.query("reveal") === "1";
    const configured = !!(u.apis && u.apis.length > 0);
    const fp = configured ? await fingerprint(u.apis ?? "") : "";
    const body: any = {
        flags: 0,
        configured,
        fingerprint: fp,
        mail: u.mail,
    };
    if (reveal && configured) body.token = u.apis;
    return c.json(body);
}

async function handleRotateToken(c: Context<AppEnv>): Promise<Response> {
    if (!await userAuth(c)) return c.json({flags: 2, texts: "用户尚未登录"}, 401);
    const mail = local.getCookie(c, "mail") ?? "";
    const dao = await ensureDao(c.env as any);
    const newToken = await newNonce(32);
    await dao.updateUser(mail, {apis: newToken});
    return c.json({
        flags: 0,
        texts: "已重置；请立即复制新 token，后续再获取只会看到指纹",
        token: newToken,
        fingerprint: await fingerprint(newToken),
    });
}

export function mountAccountApiRoutes(app: Hono<AppEnv>): void {
    app.get("/account/apitoken", handleGetToken);
    app.post("/account/apitoken/rotate", handleRotateToken);
}
