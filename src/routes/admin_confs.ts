/**
 * /admin/confs —— 系统配置读写
 * -------------------------------------------------------------------------
 * 端点：
 *   GET    /admin/confs                  一次性返回所有已知配置项（敏感项脱敏）
 *   PUT    /admin/confs/:name            写入单个配置项
 *   DELETE /admin/confs/:name            删除配置项，回退到 env/默认值
 *   POST   /admin/confs/mail/test        Resend 空载测试
 *   POST   /admin/confs/captcha/test     验证码空载测试
 *
 * 所有敏感 Secret（MAIL_KEYS / CERT_CAPTCHA_SECRET_KEY）不回显明文，
 * 只返回 `configured: boolean`。
 */

import type {Context, Hono} from "hono";
import type {AppEnv, Bindings} from "../index";
import {ensureDao} from "../db";
import {invalidateConf, readConfMap, writeConf, removeConf} from "../db/conf";
import {adminMiddleware} from "../middleware/admin";
import {Resend} from "resend";

/**
 * 允许前端显示/编辑的配置项清单。未列出的项不允许通过 PUT 接口写入。
 *
 * 命名约定：
 *   - AUTH_KEYS / SITE_KEYS：Turnstile/hCaptcha/reCAPTCHA 的 Secret / Site key。
 *     历史代码中还会看到 CERT_CAPTCHA_SITE_KEY / CERT_CAPTCHA_SECRET_KEY，它们作
 *     为别名保留并在读取时自动回退。
 *   - MAIL_KEYS / MAIL_SEND：Resend 的 API Key 与发件地址。
 *   - DCV_AGENT / DCV_EMAIL / DCV_TOKEN / DCV_ZONES：Cloudflare DNS 代理配置。
 *   - GTS_* / SSL_* / ZRO_*：证书提供商的账户凭据；*_KeyTS 为私钥 PEM，仅在本接口
 *     的 SECRET_KEYS 白名单中脱敏返回。
 */
const ALLOWED_KEYS: string[] = [
    // 站点 -----------------------------------------------
    "SITE_TITLE", "SITE_HOST",
    // 邮件 -----------------------------------------------
    "MAIL_ENABLED", "MAIL_KEYS", "MAIL_SEND",
    "NOTIFY_ON_SUCCESS", "NOTIFY_ON_FAIL", "NOTIFY_ON_EXPIRE7", "NOTIFY_ON_EXPIRED",
    // Telegram 推送（TG_BOT_TOKEN 属密钥，只回显是否已配置）
    "TG_BOT_ENABLED", "TG_BOT_TOKEN", "TG_CHAT_ID",
    // 注册策略 -------------------------------------------
    "REGISTER_ALLOW", "REGISTER_CODE", "DEFAULT_QUOTA",
    // 防滥用 ---------------------------------------------
    "CERT_CAPTCHA_ENABLED", "BASE_CAPTCHA_ENABLED", "CERT_CAPTCHA_PROVIDER",
    "AUTH_KEYS", "SITE_KEYS",
    // 兼容旧命名 -----------------------------------------
    "CERT_CAPTCHA_SITE_KEY", "CERT_CAPTCHA_SECRET_KEY",
    "MONTHLY_APPLY_LIMIT",
    // 开放 API ------------------------------------------
    "API_RATE_LIMIT",
    // 自动续期 ------------------------------------------
    "AUTO_RENEW_ENABLED", "AUTO_RENEW_DAYS",
    // DCV（Cloudflare DNS 代理）------------------------
    "DCV_AGENT", "DCV_EMAIL", "DCV_TOKEN", "DCV_ZONES",
    // 证书提供商 · Google Trust Services --------------
    "GTS_useIt", "GTS_keyMC", "GTS_keyID", "GTS_KeyTS",
    // 证书提供商 · SSL.com ----------------------------
    "SSL_useIt", "SSL_keyMC", "SSL_keyID", "SSL_KeyTS",
    // 证书提供商 · ZeroSSL ----------------------------
    "ZRO_useIt", "ZRO_keyMC", "ZRO_keyID", "ZRO_KeyTS",
];

/**
 * 敏感项名单：只返回 configured 布尔，不回显明文。
 * 规则：
 *   - 三家 CA 的 *_KeyTS（账户私钥 PEM）必须脱敏；
 *   - MAIL_KEYS、AUTH_KEYS / CERT_CAPTCHA_SECRET_KEY 这类密钥按用户需求可查看，
 *     因此不纳入脱敏；若部署方希望脱敏，可在此处按需追加。
 */
const SECRET_KEYS = new Set<string>([
    "GTS_KeyTS",
    "SSL_KeyTS",
    "ZRO_KeyTS",
    // Telegram Bot Token 等同密码：只返回 configured 布尔，不回显明文
    "TG_BOT_TOKEN",
]);

/** DCV 凭据变更后失效 Zone 缓存，否则最长后缀匹配会继续使用旧账号的 Zone 列表 */
async function invalidateZoneCacheIfDcv(name: string): Promise<void> {
    if (!name.startsWith("DCV_")) return;
    const {invalidateZoneCache} = await import("../zones");
    invalidateZoneCache();
}

/** GET /admin/confs —— 一次性快照 */
export async function handleListConfs(c: Context<AppEnv>): Promise<Response> {
    const map = await readConfMap(c.env as any, ALLOWED_KEYS);
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(map)) {
        if (SECRET_KEYS.has(k)) {
            out[k] = {configured: !!(v && String(v).length > 0)};
        } else {
            out[k] = v ?? "";
        }
    }
    return c.json({flags: 0, items: out, secret_keys: Array.from(SECRET_KEYS)});
}

/** PUT /admin/confs/:name —— 写入 */
export async function handlePutConf(c: Context<AppEnv>): Promise<Response> {
    const name = c.req.param("name") ?? "";
    if (!ALLOWED_KEYS.includes(name)) {
        return c.json({flags: 4, texts: "配置项不受管理"}, 400);
    }

    let body: any;
    try {
        body = await c.req.json();
    } catch {
        return c.json({flags: 5, texts: "请求体不是合法 JSON"}, 400);
    }
    const raw = body?.data;
    if (raw === undefined || raw === null) {
        return c.json({flags: 6, texts: "缺少 data 字段"}, 400);
    }
    // 统一序列化为字符串
    let value = "";
    if (typeof raw === "boolean") value = raw ? "true" : "false";
    else if (typeof raw === "number") value = String(raw);
    else value = String(raw);

    // 业务约束：开启人机验证前必须先配置 site_key / secret_key
    // 优先读新键 SITE_KEYS / AUTH_KEYS，缺失回退到 CERT_CAPTCHA_SITE_KEY / CERT_CAPTCHA_SECRET_KEY
    if (
        (name === "CERT_CAPTCHA_ENABLED" || name === "BASE_CAPTCHA_ENABLED") &&
        (value === "true" || value === "1")
    ) {
        const cf = await import("../db/conf");
        const siteKey =
            (await cf.readConf(c.env as any, "SITE_KEYS")) ??
            (await cf.readConf(c.env as any, "CERT_CAPTCHA_SITE_KEY"));
        const secret =
            (await cf.readConf(c.env as any, "AUTH_KEYS")) ??
            (await cf.readConf(c.env as any, "CERT_CAPTCHA_SECRET_KEY"));
        if (!siteKey || !secret) {
            return c.json({
                flags: 7,
                texts: "开启人机验证前请先填写 Site Key (SITE_KEYS) 与 Secret Key (AUTH_KEYS)",
            }, 400);
        }
    }

    await writeConf(c.env as any, name, value);
    invalidateConf(name);
    await invalidateZoneCacheIfDcv(name);
    return c.json({flags: 0, texts: "已保存"});
}

/** DELETE /admin/confs/:name —— 回退 env/默认值 */
export async function handleDeleteConf(c: Context<AppEnv>): Promise<Response> {
    const name = c.req.param("name") ?? "";
    if (!ALLOWED_KEYS.includes(name)) {
        return c.json({flags: 4, texts: "配置项不受管理"}, 400);
    }
    await removeConf(c.env as any, name);
    await invalidateZoneCacheIfDcv(name);
    return c.json({flags: 0, texts: "已回退到 env/默认值"});
}

/** POST /admin/confs/mail/test —— Resend 空载发送测试 */
export async function handleMailTest(c: Context<AppEnv>): Promise<Response> {
    let body: any;
    try {
        body = await c.req.json();
    } catch {
        body = {};
    }
    const toEmail: string = String(body.to ?? "").trim();
    if (!toEmail) {
        return c.json({flags: 4, texts: "请提供收件地址 to"}, 400);
    }
    const conf = await readConfMap(c.env as any, ["MAIL_KEYS", "MAIL_SEND", "SITE_TITLE"]);
    const key = conf.MAIL_KEYS;
    const from = conf.MAIL_SEND;
    if (!key || !from) {
        return c.json({flags: 5, texts: "尚未配置 MAIL_KEYS / MAIL_SEND"}, 400);
    }
    try {
        const r = new Resend(key);
        const {data, error} = await r.emails.send({
            from: `${conf.SITE_TITLE ?? "SSL Helper"}<${from}>`,
            to: [toEmail],
            subject: "系统管理测试邮件",
            html: "<p>这是一封来自系统管理页面的测试邮件。</p>",
        });
        if (error) {
            return c.json({flags: 6, texts: "邮件发送失败：" + String(error)}, 500);
        }
        return c.json({flags: 0, texts: "测试邮件已发送", id: (data as any)?.id});
    } catch (e: any) {
        return c.json({flags: 7, texts: "测试失败：" + (e?.message ?? String(e))}, 500);
    }
}

/** POST /admin/confs/captcha/test —— 验证码空载校验 */
export async function handleCaptchaTest(c: Context<AppEnv>): Promise<Response> {
    let body: any;
    try {
        body = await c.req.json();
    } catch {
        body = {};
    }
    const token: string = String(body.token ?? "").trim();
    if (!token) {
        return c.json({flags: 4, texts: "请提供验证码 token"}, 400);
    }
    const conf = await readConfMap(c.env as any, [
        "CERT_CAPTCHA_PROVIDER", "AUTH_KEYS", "CERT_CAPTCHA_SECRET_KEY",
    ]);
    const provider = conf.CERT_CAPTCHA_PROVIDER ?? "turnstile";
    // 优先 AUTH_KEYS，回退到旧键 CERT_CAPTCHA_SECRET_KEY
    const secret = conf.AUTH_KEYS || conf.CERT_CAPTCHA_SECRET_KEY;
    if (!secret) {
        return c.json({flags: 5, texts: "尚未配置 AUTH_KEYS（验证码 Secret Key）"}, 400);
    }

    // 不同 provider 的校验端点
    let verifyUrl = "";
    if (provider === "turnstile") {
        verifyUrl = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
    } else if (provider === "hcaptcha") {
        verifyUrl = "https://hcaptcha.com/siteverify";
    } else if (provider === "recaptcha") {
        verifyUrl = "https://www.google.com/recaptcha/api/siteverify";
    } else {
        return c.json({flags: 6, texts: "不支持的 provider: " + provider}, 400);
    }

    try {
        const fd = new FormData();
        fd.append("secret", secret);
        fd.append("response", token);
        const res = await fetch(verifyUrl, {method: "POST", body: fd});
        const json: any = await res.json();
        // 不回显 secret，仅透传 provider 原始错误码
        if (json?.success) {
            return c.json({flags: 0, texts: "验证通过"});
        }
        return c.json({
            flags: 7,
            texts: "验证失败",
            provider_error_codes: json?.["error-codes"] ?? json?.errorCodes ?? [],
        }, 400);
    } catch (e: any) {
        return c.json({flags: 8, texts: "调用 provider 失败：" + (e?.message ?? String(e))}, 500);
    }
}

/**
 * POST /admin/confs/telegram/test
 * 用当前配置发一条测试消息，便于管理员在页面上直接验证 Token / Chat ID 是否可用。
 */
export async function handleTelegramTest(c: Context<AppEnv>): Promise<Response> {
    const {sendTestTelegram} = await import("../notify");
    try {
        const r = await sendTestTelegram(c.env);
        return c.json(r, r.flags === 0 ? 200 : 400);
    } catch (e: any) {
        return c.json({flags: 7, texts: "测试失败：" + (e?.message ?? String(e))}, 500);
    }
}

/** 挂载 */
export function mountAdminConfsRoutes(app: Hono<AppEnv>): void {
    app.use("/admin/confs", adminMiddleware);
    app.use("/admin/confs/*", adminMiddleware);
    app.get("/admin/confs", handleListConfs);
    app.put("/admin/confs/:name", handlePutConf);
    app.delete("/admin/confs/:name", handleDeleteConf);
    app.post("/admin/confs/mail/test", handleMailTest);
    app.post("/admin/confs/captcha/test", handleCaptchaTest);
    app.post("/admin/confs/telegram/test", handleTelegramTest);
}

export const ADMIN_CONF_KEYS = ALLOWED_KEYS;
