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
    /**
     * 初始化安全模式：
     *   preset —— 已用 ADMIN_MAIL/ADMIN_PASS 自动建好管理员，向导不开放
     *   token  —— 向导开放，但提交时必须带 SETUP_TOKEN
     *   locked —— 未做任何安全配置，初始化接口拒绝服务（默认态）
     * 前端据此决定「显示向导 / 显示令牌输入框 / 显示未配置提示」。
     */
    setup_mode: SetupMode;
    setup_error?: string;
}

/** SHA256 工具 */
function sha256Hex(text: string): string {
    return CryptoJS.SHA256(text).toString(CryptoJS.enc.Hex);
}

/**
 * 初始化安全模式
 * -------------------------------------------------------------------------
 * 背景：`/setup` 原先没有任何鉴权，只要站点还没初始化，任何人扫到域名都能
 *       抢先 POST 一次把自己变成管理员（is_admin=1）并标记 INITIALIZED。
 *       这是实打实的接管漏洞，必须 fail-closed。
 *
 * 三种模式（按优先级）：
 *   preset —— 配了 ADMIN_MAIL + ADMIN_PASS：首次请求自动建管理员，
 *             完全不暴露初始化向导（最安全，推荐）
 *   token  —— 只配了 SETUP_TOKEN：向导可用，但必须带上这个令牌
 *   locked —— 三者都没配：初始化接口直接拒绝（默认态，杜绝裸奔）
 */
export type SetupMode = "preset" | "token" | "locked";

/** 判定当前处于哪种初始化模式 */
export function resolveSetupMode(env: any): SetupMode {
    const mail = String(env?.ADMIN_MAIL ?? "").trim();
    const pass = String(env?.ADMIN_PASS ?? "").trim();
    if (mail && pass) return "preset";
    if (String(env?.SETUP_TOKEN ?? "").trim().length > 0) return "token";
    return "locked";
}

/** 定长比较，避免通过响应时间猜测令牌 */
function safeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/**
 * 归一化管理员密码：
 *   - 64 位十六进制 → 视为已算好的 SHA256（便于脚本直接传哈希）
 *   - 其余 → 按明文处理，计算 SHA256
 * 登录逻辑比对的是 `HMAC(sha256(明文), code)`，所以库里必须存 sha256(明文) 的 hex。
 */
function normalizeAdminPass(raw: string): string {
    const s = raw.trim();
    if (/^[0-9a-fA-F]{64}$/.test(s)) return s.toLowerCase();
    return sha256Hex(s);
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

    // 2.1) 预置管理员模式：首次访问就把管理员建好并标记初始化 ----------------
    // 这样初始化向导永远不会暴露给访客（杜绝扫站抢注）。
    const setupMode = resolveSetupMode(env);
    let provisionError: string | undefined;
    if (!initialized && dbOk && setupMode === "preset") {
        const r = await ensureAdminProvisioned(env);
        if (r.provisioned) {
            initialized = true;
        } else if (r.error) {
            provisionError = r.error;
            console.error("[bootstrap] 预置管理员初始化失败:", r.error);
        }
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
        setup_mode: setupMode,
        setup_error: provisionError,
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

/**
 * 预置管理员自动初始化（mode = preset）
 * -------------------------------------------------------------------------
 * 幂等：已初始化则直接返回，不覆盖既有管理员密码。
 * 由 handleBootstrap 在首次页面加载时调用，因此站点一起来就是「已初始化」状态，
 * 初始化向导根本不会出现在访客面前。
 */
export async function ensureAdminProvisioned(env: any): Promise<{ provisioned: boolean; error?: string }> {
    if (resolveSetupMode(env) !== "preset") return {provisioned: false};

    // 已初始化 → 不碰
    try {
        if (await readBool(env, "INITIALIZED", false)) return {provisioned: false};
    } catch {
        return {provisioned: false, error: "读取初始化标记失败"};
    }

    const mail = String(env.ADMIN_MAIL ?? "").trim().toLowerCase();
    if (!isValidEmail(mail)) {
        return {provisioned: false, error: "ADMIN_MAIL 不是合法邮箱"};
    }
    const passHash = normalizeAdminPass(String(env.ADMIN_PASS ?? ""));
    if (passHash.length !== 64) {
        return {provisioned: false, error: "ADMIN_PASS 无效"};
    }

    try {
        const dao = await ensureDao(env);
        await upsertAdminUser(dao, mail, passHash);

        // 站点基础信息：env 里配了就用，否则留空让管理员登录后自行设置
        await writeConf(env, "ADMIN_MAIL", mail);
        const siteHost = String(env.SITE_HOST ?? "").trim();
        if (siteHost) await writeConf(env, "SITE_HOST", siteHost);
        const siteTitle = String(env.SITE_TITLE ?? "").trim();
        if (siteTitle) await writeConf(env, "SITE_TITLE", siteTitle);

        // 把 env 中已配置的功能性变量一次性播种到 Confs（管理员后续可在线改）
        await seedConfsFromEnv(env);

        await writeConf(env, "INITIALIZED", "true");
        console.log(`[setup] 已按预置配置自动创建管理员：${mail}`);
        return {provisioned: true};
    } catch (e: any) {
        console.error("[setup] 预置管理员自动初始化失败:", e);
        return {provisioned: false, error: e?.message ?? String(e)};
    }
}

/** 从 env 播种功能性配置到 Confs（已存在的键不覆盖） */
async function seedConfsFromEnv(env: any): Promise<void> {
    const ENV_SEEDS: string[] = [
        "MAIL_KEYS", "MAIL_SEND", "AUTH_KEYS", "SITE_KEYS",
        "DCV_AGENT", "DCV_EMAIL", "DCV_TOKEN", "DCV_ZONES",
        "GTS_useIt", "GTS_keyMC", "GTS_keyID", "GTS_KeyTS",
        "SSL_useIt", "SSL_keyMC", "SSL_keyID", "SSL_KeyTS",
        "ZRO_useIt", "ZRO_keyMC", "ZRO_keyID", "ZRO_KeyTS",
    ];
    for (const key of ENV_SEEDS) {
        const raw = env?.[key];
        if (typeof raw === "string" && raw.length > 0) {
            await writeConf(env, key, raw);
        }
    }
}

/** 创建或升级管理员账号（两个初始化入口共用） */
async function upsertAdminUser(
    dao: Awaited<ReturnType<typeof ensureDao>>,
    mail: string,
    passHash: string
): Promise<void> {
    const existing = await dao.getUser(mail);
    if (existing) {
        // 升级既有账号为管理员；仅当原先未持有 ACME 私钥时补一条，避免覆盖
        // 用户在普通注册流程里已经生成的账户密钥，导致 ACME 侧账户对应关系丢失。
        const keepKeys = typeof existing.keys === "string" && existing.keys.length > 0;
        const patch: Record<string, any> = {
            flag: "1",
            is_admin: 1,
            pass: passHash,
            quota: -1,
            time: Date.now(),
        };
        if (!keepKeys) patch.keys = createAcmeAccountKeyPem();
        await dao.updateUser(mail, patch);
    } else {
        await dao.insertUser({
            mail,
            flag: "1",
            is_admin: 1,
            pass: passHash,
            quota: -1,
            keys: createAcmeAccountKeyPem(),
            apis: randomToken(16),
            time: Date.now(),
        });
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

    // 2.05) 提前解析请求体 ---------------------------------------------------
    // 安全校验需要读 setup_token，因此必须早于鉴权读取；这里解析失败不再直接返回，
    // 由后续统一给出 400（保持原有错误语义）。
    let body: any = null;
    try {
        body = await c.req.json();
    } catch {
        body = null;
    }

    // 2.1) 初始化安全校验（关键）----------------------------------------------
    // 修复「扫到未初始化站点即可抢注管理员」的接管漏洞：
    //   preset —— 管理员已由预置配置自动创建，向导关闭
    //   locked —— 未配置任何安全项，直接拒绝（fail-closed）
    //   token  —— 必须提供与 SETUP_TOKEN 一致的令牌
    const mode = resolveSetupMode(env);
    if (mode === "preset") {
        // 正常情况下 bootstrap 已经建好管理员；走到这里说明建号失败或并发，
        // 无论哪种都不该再让匿名请求通过。
        const r = await ensureAdminProvisioned(env);
        if (r.provisioned) {
            return c.json({flags: 3, texts: "系统已按预置配置完成初始化，请直接登录"}, 409);
        }
        return c.json(
            {flags: 9, texts: "初始化向导已关闭（已配置 ADMIN_MAIL/ADMIN_PASS）。若管理员未能自动创建，请检查配置或日志。"},
            403
        );
    }
    if (mode === "locked") {
        return c.json(
            {flags: 9, texts: "初始化向导未启用：请先配置 ADMIN_MAIL + ADMIN_PASS（推荐）或 SETUP_TOKEN 后再访问。"},
            403
        );
    }
    // mode === "token"
    const provided = String(body?.setup_token ?? c.req.header("X-Setup-Token") ?? "").trim();
    const expected = String(env.SETUP_TOKEN ?? "").trim();
    if (!provided || !safeEqual(provided, expected)) {
        console.warn("[setup] 初始化令牌校验失败", {hasProvided: !!provided});
        return c.json({flags: 9, texts: "初始化令牌无效"}, 403);
    }

    // 3) 读取 body（已在 2.05 解析）-------------------------------------------
    if (!body || typeof body !== "object") {
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
        // 密码存 SHA256（前端已做）；与登录逻辑比对的口径保持一致。
        await upsertAdminUser(dao, adminMail, adminPass);

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
