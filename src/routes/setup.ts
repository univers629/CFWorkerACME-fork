/**
 * 初始化向导 - 后端路由
 * -------------------------------------------------------------------------
 * 提供两个端点：
 *   - GET  /bootstrap  → 初始化探测结果（前端启动阶段调用）
 *   - POST /setup      → 一次性初始化系统（写入 Confs、创建管理员账号）
 *
 * 路由在 src/index.ts 中挂载。
 */

import type {Context, Hono} from "hono";
import type {AppEnv, Bindings} from "../index";
import {ensureDao, normalizeDbSource, rawDao} from "../db";
import {readBool, readConf, writeConf, invalidateConf} from "../db/conf";
import CryptoJS from "crypto-js";
// @ts-ignore - nodejs_compat 下 Cloudflare Workers 提供 crypto 模块
import {generateKeyPairSync} from "crypto";

/**
 * 生成一条 ACME 账户私钥（EC prime256v1 / PKCS#8 PEM）。
 * 与 src/users.ts `userRegs` 保持一致的算法与导出格式，
 * 供初始化向导创建 / 升级管理员账号时写入 Users.keys。
 */
function createAcmeAccountKeyPem(): string {
    const {privateKey} = generateKeyPairSync("ec", {namedCurve: "prime256v1"});
    return privateKey.export({type: "pkcs8", format: "pem"}) as string;
}

/**
 * 标准探活结果结构
 */
export interface BootstrapResult {
    initialized: boolean;
    site_title: string;
    site_host: string;
    mail_enabled: boolean;
    db_source: "d1" | "mysql" | "prisma" | "unset";
    db_ok: boolean;
    db_error?: string;
    register_allow: boolean;
    register_code_required: boolean;
    cert_captcha: {
        enabled: boolean;
        provider: string;
        site_key: string;
    };
    /**
     * 登录 / 注册 / 找回密码发送邮件验证码的人机验证开关。
     * 与 cert_captcha 共用同一套 provider / site_key 凭证。
     */
    base_captcha: {
        enabled: boolean;
        provider: string;
        site_key: string;
    };
}

/** SHA256 工具 */
function sha256Hex(text: string): string {
    return CryptoJS.SHA256(text).toString(CryptoJS.enc.Hex);
}

/** 邮箱格式粗校验 */
function isValidEmail(email: string): boolean {
    if (!email || email.length < 5 || email.length > 255) return false;
    return /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email);
}

/**
 * GET /bootstrap
 * 前端启动时调用，返回初始化状态 + 数据源探测结果。
 * 本接口**不做鉴权**，任何访客都可读。
 */
export async function handleBootstrap(c: Context<AppEnv>): Promise<Response> {
    const env = c.env as any;
    const srcNorm = normalizeDbSource(env.DB_SOURCE);
    const dbSource = (srcNorm || "unset") as BootstrapResult["db_source"];

    // 1) 尝试探活 ------------------------------------------------------------
    let dbOk = false;
    let dbError: string | undefined;
    let initialized = false;

    if (srcNorm === "") {
        dbError = "未检测到可用数据库，请先设置 DB_SOURCE 环境变量";
    } else {
        try {
            const dao = rawDao(env);
            const ping = await dao.ping();
            dbOk = ping.ok;
            if (!ping.ok) dbError = ping.error ?? "数据库连接失败";
        } catch (e: any) {
            dbError = e?.message ?? String(e);
        }
    }

    // 2) 读取初始化标记和相关配置 --------------------------------------------
    // 注意：DB 不可用时，下列 read 调用会回退到 env/默认值。
    try {
        initialized = await readBool(env, "INITIALIZED", false);
    } catch {
        initialized = false;
    }

    const siteTitle = (await safeRead(env, "SITE_TITLE")) ?? "SSL 证书助手";
    const siteHost = (await safeRead(env, "SITE_HOST")) ?? "";
    const mailEnabled = await safeReadBool(env, "MAIL_ENABLED", false);
    const registerAllow = await safeReadBool(env, "REGISTER_ALLOW", true);
    const registerCode = (await safeRead(env, "REGISTER_CODE")) ?? "";
    const captchaEnabled = await safeReadBool(env, "CERT_CAPTCHA_ENABLED", false);
    const baseCaptchaEnabled = await safeReadBool(env, "BASE_CAPTCHA_ENABLED", false);
    const captchaProvider = (await safeRead(env, "CERT_CAPTCHA_PROVIDER")) ?? "turnstile";
    // 站点端使用 Site Key；新键 SITE_KEYS 优先，回退旧键 CERT_CAPTCHA_SITE_KEY
    const captchaSiteKey =
        (await safeRead(env, "SITE_KEYS")) ||
        (await safeRead(env, "CERT_CAPTCHA_SITE_KEY")) ||
        "";

    const payload: BootstrapResult = {
        initialized,
        site_title: siteTitle,
        site_host: siteHost,
        mail_enabled: mailEnabled,
        db_source: dbSource,
        db_ok: dbOk,
        db_error: dbError,
        register_allow: registerAllow,
        register_code_required: registerCode.length > 0,
        cert_captcha: {
            enabled: captchaEnabled,
            provider: captchaProvider,
            site_key: captchaSiteKey,
        },
        base_captcha: {
            enabled: baseCaptchaEnabled,
            provider: captchaProvider,
            site_key: captchaSiteKey,
        },
    };
    return c.json(payload, 200);
}

async function safeRead(env: any, name: string): Promise<string | null> {
    try {
        return await readConf(env, name);
    } catch {
        return null;
    }
}

async function safeReadBool(env: any, name: string, fallback: boolean): Promise<boolean> {
    try {
        return await readBool(env, name, fallback);
    } catch {
        return fallback;
    }
}

/**
 * POST /setup
 * body: {
 *   site_host:   string,
 *   admin_mail:  string,
 *   admin_pass:  string,   // SHA256(明文) 由前端完成
 *   site_title:  string,
 *   mail_enabled: boolean,
 *   mail_keys?:  string,   // mail_enabled=true 时必填
 *   mail_send?:  string,
 * }
 *
 * 成功后返回 200；若系统已初始化返回 409。
 */
export async function handleSetup(c: Context<AppEnv>): Promise<Response> {
    const env = c.env as any;

    // 1) 先确认数据库可用 ----------------------------------------------------
    if (normalizeDbSource(env.DB_SOURCE) === "") {
        return c.json({flags: 1, texts: "未检测到 DB_SOURCE，请先配置后重试"}, 503);
    }

    let dao: Awaited<ReturnType<typeof ensureDao>>;
    try {
        dao = await ensureDao(env);
    } catch (e: any) {
        return c.json({flags: 2, texts: "数据库不可用：" + (e?.message ?? String(e))}, 503);
    }

    // 2) 防止重复初始化 ------------------------------------------------------
    const alreadyInit = await readBool(env, "INITIALIZED", false);
    if (alreadyInit) {
        return c.json({flags: 3, texts: "系统已初始化，无法重复执行"}, 409);
    }

    // 3) 读取 body -----------------------------------------------------------
    let body: any;
    try {
        body = await c.req.json();
    } catch {
        return c.json({flags: 4, texts: "请求体不是合法的 JSON"}, 400);
    }
    const siteHost = String(body.site_host ?? "").trim();
    const adminMail = String(body.admin_mail ?? "").trim().toLowerCase();
    const adminPass = String(body.admin_pass ?? "").trim();
    const siteTitle = String(body.site_title ?? "SSL 证书助手").trim();
    const mailEnabled = !!body.mail_enabled;
    const mailKeys = String(body.mail_keys ?? "").trim();
    const mailSend = String(body.mail_send ?? "").trim();

    // 4) 校验 ----------------------------------------------------------------
    if (!isValidEmail(adminMail)) {
        return c.json({flags: 5, texts: "管理员邮箱格式不正确"}, 400);
    }
    if (!adminPass || adminPass.length < 8) {
        return c.json({flags: 6, texts: "管理员密码 SHA256 不能为空（需前端计算）"}, 400);
    }
    if (mailEnabled && (!mailKeys || !mailSend)) {
        return c.json({flags: 7, texts: "启用邮箱功能时需同时填写 MAIL_KEYS 与 MAIL_SEND"}, 400);
    }

    // 5) 写入 Confs ----------------------------------------------------------
    const written: string[] = [];
    try {
        await writeConf(env, "SITE_HOST", siteHost);
        written.push("SITE_HOST");
        await writeConf(env, "SITE_TITLE", siteTitle);
        written.push("SITE_TITLE");
        await writeConf(env, "ADMIN_MAIL", adminMail);
        written.push("ADMIN_MAIL");
        await writeConf(env, "MAIL_ENABLED", mailEnabled ? "true" : "false");
        written.push("MAIL_ENABLED");
        if (mailEnabled) {
            await writeConf(env, "MAIL_KEYS", mailKeys);
            written.push("MAIL_KEYS");
            await writeConf(env, "MAIL_SEND", mailSend);
            written.push("MAIL_SEND");
        }

        // 5.1) 将 env 中的"默认种子"一次性复制到 Confs --------------------
        // 规则：env 中存在且非空时写入；已由上方显式写入过的键不重复覆盖。
        // 这样管理员后续可以在系统管理页面直接编辑而不用重新发布 Worker。
        const ENV_SEEDS: string[] = [
            // 邮件（MAIL_ENABLED=false 时也把 env 里已配置的搬进来）
            "MAIL_KEYS", "MAIL_SEND",
            // 验证码
            "AUTH_KEYS", "SITE_KEYS",
            // DCV
            "DCV_AGENT", "DCV_EMAIL", "DCV_TOKEN", "DCV_ZONES",
            // CA - Google Trust
            "GTS_useIt", "GTS_keyMC", "GTS_keyID", "GTS_KeyTS",
            // CA - SSL.com
            "SSL_useIt", "SSL_keyMC", "SSL_keyID", "SSL_KeyTS",
            // CA - ZeroSSL
            "ZRO_useIt", "ZRO_keyMC", "ZRO_keyID", "ZRO_KeyTS",
        ];
        for (const key of ENV_SEEDS) {
            if (written.includes(key)) continue;
            const raw = env?.[key];
            if (typeof raw === "string" && raw.length > 0) {
                await writeConf(env, key, raw);
                written.push(key);
            }
        }

        // 6) 创建或升级管理员账号 --------------------------------------------
        // 密码存 SHA256（前端已做）；这里二次 SHA256 以与现有 userPost 一致。
        // 现有登录逻辑使用 `user_data_in['pass']`（即 SHA256(明文) 的十六进制）。
        const passStored = adminPass; // 前端已传入 SHA256
        const existing = await dao.getUser(adminMail);
        if (existing) {
            // 升级既有账号为管理员；仅当原先未持有 ACME 私钥时补一条，避免覆盖
            // 用户在普通注册流程里已经生成的账户密钥，导致 ACME 侧账户对应关系丢失。
            const keepKeys = typeof existing.keys === "string" && existing.keys.length > 0;
            const patch: Record<string, any> = {
                flag: "1",
                is_admin: 1,
                pass: passStored,
                quota: -1,
                time: Date.now(),
            };
            if (!keepKeys) {
                patch.keys = createAcmeAccountKeyPem();
            }
            await dao.updateUser(adminMail, patch);
        } else {
            await dao.insertUser({
                mail: adminMail,
                flag: "1",
                is_admin: 1,
                pass: passStored,
                quota: -1,
                keys: createAcmeAccountKeyPem(),
                apis: randomToken(16),
                time: Date.now(),
            });
        }

        // 7) 最后置初始化标记 -----------------------------------------------
        await writeConf(env, "INITIALIZED", "true");
        written.push("INITIALIZED");
    } catch (e: any) {
        // 回滚已写入的 Confs，将 INITIALIZED 保持 false
        for (const name of written) {
            if (name === "INITIALIZED") continue;
            try {
                await dao.deleteConf(name);
                invalidateConf(name);
            } catch {/* ignore */}
        }
        try {
            await dao.deleteConf("INITIALIZED");
            invalidateConf("INITIALIZED");
        } catch {/* ignore */}
        return c.json({flags: 8, texts: "初始化失败：" + (e?.message ?? String(e))}, 500);
    }

    return c.json({flags: 0, texts: "初始化完成"}, 200);
}

/** 用于 API Token 初始化：32 个字符的大小写字母数字字符串 */
function randomToken(lens: number): string {
    const charset = "ABCDEFGHJKLMNPQRSTUWXY0123456789abcdefghjkmnpqrstuwxy";
    let r = "";
    for (let i = 0; i < lens; i++) r += charset[Math.floor(Math.random() * charset.length)];
    return r;
}

/** 注册本路由到 Hono 应用 */
export function mountSetupRoutes(app: Hono<AppEnv>): void {
    app.get("/bootstrap", handleBootstrap);
    app.post("/setup", handleSetup);
}
