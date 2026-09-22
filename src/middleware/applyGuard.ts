/**
 * 证书申请前置三重校验
 * -------------------------------------------------------------------------
 * 顺序：
 *   1. 人机验证（Web 侧）：CERT_CAPTCHA_ENABLED=true 时必须带 captcha_token
 *   2. 月度申请上限：MONTHLY_APPLY_LIMIT > 0 时按当前 UTC 自然月统计
 *   3. 个人配额：Users.quota >= 0 时，有效证书数 >= quota 拒绝
 *
 * 所有创建 Apply 记录的入口（Web /apply/ 与开放 API POST /api/v1/orders）
 * 都应在写入之前调用 `checkApplyGuard(c, opts)`。
 */

import type {Context} from "hono";
import {ensureDao} from "../db";
import {readBool, readConf, readInt} from "../db/conf";
import type {UserRow} from "../db/dao";

/** 当前请求来源：web（cookie）或 open-api（X-API-Token） */
export type ApplySource = "web" | "api";

export interface ApplyGuardOptions {
    source: ApplySource;
    user: UserRow;
    captchaToken?: string | null;
    /** 本次申请使用的 CA 标识；提供时校验该 CA 是否已启用 */
    sign?: string;
}

export interface ApplyGuardReject {
    ok: false;
    code:
        | "CAPTCHA_REQUIRED"
        | "CAPTCHA_INVALID"
        | "MONTHLY_LIMIT_EXCEEDED"
        | "QUOTA_EXCEEDED"
        | "CA_DISABLED"
        | "INTERNAL";
    status: number;
    message: string;
}

export interface ApplyGuardPass {
    ok: true;
}

export type ApplyGuardResult = ApplyGuardPass | ApplyGuardReject;

/** 计算当前 UTC 自然月 [start, end) 毫秒 */
function monthRangeUtc(now: Date = new Date()): { start: number; end: number } {
    const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
    return {start, end};
}

/** 调用 provider 做 captcha server-side 校验 */
async function verifyCaptcha(
    provider: string,
    secret: string,
    token: string,
    remoteIp?: string,
): Promise<boolean> {
    let url = "";
    if (provider === "turnstile") {
        url = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
    } else if (provider === "hcaptcha") {
        url = "https://hcaptcha.com/siteverify";
    } else if (provider === "recaptcha") {
        url = "https://www.google.com/recaptcha/api/siteverify";
    } else {
        return false;
    }
    try {
        const fd = new FormData();
        fd.append("secret", secret);
        fd.append("response", token);
        if (remoteIp) fd.append("remoteip", remoteIp);
        const res = await fetch(url, {method: "POST", body: fd});
        const json: any = await res.json();
        return !!json?.success;
    } catch (e) {
        console.error("[verifyCaptcha] error:", e);
        return false;
    }
}

/**
 * 执行三重校验。失败时返回具体 code / status / message。
 */
export async function checkApplyGuard(
    c: Context,
    opts: ApplyGuardOptions,
): Promise<ApplyGuardResult> {
    const {source, user, captchaToken, sign} = opts;
    const env = c.env as any;

    // ---------- 0) CA 启用状态 ----------
    // 前端已隐藏未启用的厂商，这里再校验一次，避免绕过 UI 直接调用接口。
    if (sign) {
        try {
            const {isCaEnabled, CA_LABELS} = await import("../ca");
            if (!(await isCaEnabled(env, sign))) {
                const label = CA_LABELS[sign] ?? sign;
                return {
                    ok: false,
                    code: "CA_DISABLED",
                    status: 403,
                    message: `证书厂商 ${label} 当前未启用，请改用其它厂商`,
                };
            }
        } catch (e) {
            console.error("[applyGuard] CA 启用状态检查失败:", e);
            // 读配置失败时不阻断申请，交由后续流程按凭据缺失报错
        }
    }

    // ---------- 1) 人机验证 ----------
    try {
        const captchaEnabled = await readBool(env, "CERT_CAPTCHA_ENABLED", false);
        if (captchaEnabled) {
            if (source === "api") {
                return {
                    ok: false,
                    code: "CAPTCHA_REQUIRED",
                    status: 403,
                    message: "当前已开启人机验证，请改用网页提交证书申请",
                };
            }
            const token = (captchaToken ?? "").trim();
            if (!token) {
                return {
                    ok: false,
                    code: "CAPTCHA_REQUIRED",
                    status: 400,
                    message: "请先完成人机验证",
                };
            }
            const provider = (await readConf(env, "CERT_CAPTCHA_PROVIDER")) ?? "turnstile";
            // 验证码 Secret：优先新键 AUTH_KEYS，回退旧键 CERT_CAPTCHA_SECRET_KEY
            const secret =
                (await readConf(env, "AUTH_KEYS")) ||
                (await readConf(env, "CERT_CAPTCHA_SECRET_KEY")) ||
                "";
            if (!secret) {
                return {
                    ok: false,
                    code: "INTERNAL",
                    status: 500,
                    message: "系统未配置验证码 Secret Key（AUTH_KEYS）",
                };
            }
            const ip = c.req.header("CF-Connecting-IP") ?? undefined;
            const passed = await verifyCaptcha(provider, secret, token, ip);
            if (!passed) {
                return {
                    ok: false,
                    code: "CAPTCHA_INVALID",
                    status: 400,
                    message: "人机验证未通过，请重试",
                };
            }
        }
    } catch (e) {
        console.error("[applyGuard] captcha step failed:", e);
        // 降级：不因 captcha 读配置失败而放行
        return {ok: false, code: "INTERNAL", status: 500, message: "人机验证配置读取失败"};
    }

    // ---------- 2) 月度申请上限 ----------
    let dao;
    try {
        dao = await ensureDao(env);
    } catch (e) {
        console.error("[applyGuard] dao init failed:", e);
        return {ok: false, code: "INTERNAL", status: 503, message: "数据库不可用"};
    }
    try {
        const limit = await readInt(env, "MONTHLY_APPLY_LIMIT", 0);
        if (limit > 0) {
            const {start, end} = monthRangeUtc();
            const used = await dao.countAppliesByMailInRange(user.mail, start, end);
            if (used >= limit) {
                return {
                    ok: false,
                    code: "MONTHLY_LIMIT_EXCEEDED",
                    status: 429,
                    message: "本月证书申请次数已达上限",
                };
            }
        }
    } catch (e) {
        console.error("[applyGuard] monthly check failed:", e);
        // 读失败时放行，以免阻塞正常用户
    }

    // ---------- 3) 个人配额 ----------
    try {
        const quota = Number(user.quota ?? -1);
        if (quota >= 0) {
            const active = await dao.countActiveAppliesByMail(user.mail);
            if (active >= quota) {
                return {
                    ok: false,
                    code: "QUOTA_EXCEEDED",
                    status: 403,
                    message: "已达到证书配额上限",
                };
            }
        }
    } catch (e) {
        console.error("[applyGuard] quota check failed:", e);
    }

    return {ok: true};
}

/** 辅助：获取当前用户在当月已申请数（用于前端展示） */
export async function currentMonthApplyCount(
    c: Context,
    mail: string,
): Promise<number> {
    try {
        const dao = await ensureDao(c.env as any);
        const {start, end} = monthRangeUtc();
        return await dao.countAppliesByMailInRange(mail, start, end);
    } catch {
        return 0;
    }
}
