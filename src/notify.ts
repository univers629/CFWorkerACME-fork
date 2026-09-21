/**
 * 通知推送模块
 * -------------------------------------------------------------------------
 * 目前支持两个通道：
 *   1. Telegram Bot（参考 maillab/cloud-mail 的做法：Bot Token + 多个 Chat ID）
 *   2. 邮件（沿用 users.mailSend 的 Resend 通道）
 *
 * 设计要点：
 *   - **失败绝不影响业务**：所有推送都在 try/catch 内，只记日志，不向上抛。
 *     证书签发是核心流程，不能因为 Telegram 挂了就回滚状态。
 *   - **未配置即静默跳过**：没配 Token/Chat 时只打 debug 日志，不报错。
 *   - **开关可在线改**：NOTIFY_* 系列读取走 Confs → env → 默认值 三级回退，
 *     管理员在系统管理页改完立即生效（writeConf 会主动失效缓存）。
 *   - Chat ID 支持逗号 / 分号 / 空格分隔的多个值（群组 + 私聊同时推送）。
 */

import {readBool, readConf} from "./db/conf";

/** Telegram 请求超时（毫秒）：避免推送阻塞签发流程 */
const TG_TIMEOUT_MS = 8000;

/**
 * 后台任务上下文：只依赖 waitUntil。
 * 用结构化类型而非 ExecutionContext，避免与全局 DOM 类型冲突，
 * 同时便于测试时传入桩对象。
 */
export interface BackgroundContext {
    waitUntil(promise: Promise<any>): void;
}

/** 通知事件类型（与 NOTIFY_* 开关一一对应） */
export type NotifyEvent =
    | "success"   // 证书签发成功
    | "fail"      // 证书签发失败
    | "expire7"   // 证书 7 天内到期
    | "expired"   // 证书已过期
    | "renew_stuck"; // 自动续期已发起但卡在人工验证

/** 事件 → 开关配置名 */
const EVENT_SWITCH: Record<NotifyEvent, string> = {
    success: "NOTIFY_ON_SUCCESS",
    fail: "NOTIFY_ON_FAIL",
    expire7: "NOTIFY_ON_EXPIRE7",
    expired: "NOTIFY_ON_EXPIRED",
    // 复用「即将到期」开关，不单独增加配置项
    renew_stuck: "NOTIFY_ON_EXPIRE7",
};

/** 事件 → 中文标题 */
const EVENT_TITLE: Record<NotifyEvent, string> = {
    success: "✅ 证书签发成功",
    fail: "❌ 证书签发失败",
    expire7: "⏰ 证书即将到期",
    expired: "🚨 证书已过期",
    renew_stuck: "⚠️ 自动续期需要人工处理",
};

export interface NotifyPayload {
    /** 事件类型，决定用哪个开关 */
    event: NotifyEvent;
    /** 涉及的域名列表（证书申请的域名） */
    domains: string[];
    /** 用户邮箱（证书归属者） */
    mail?: string;
    /** 订单 UUID，便于管理员定位 */
    uuid?: string;
    /** 附加说明（失败原因 / 剩余天数等） */
    detail?: string;
    /** 站点地址，用于在消息里附上可点击链接 */
    siteHost?: string;
}

/** 把 Chat ID 串拆成数组：支持 , ; 空格 以及中文逗号分隔 */
export function parseChatIds(raw: string | null | undefined): string[] {
    if (!raw) return [];
    return String(raw)
        .split(/[,;，；\s]+/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

/** HTML 转义：Telegram parse_mode=HTML 下，正文里的 < > & 必须转义 */
function escapeHtml(text: string): string {
    return String(text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/** 组装消息正文（HTML） */
export function buildMessage(payload: NotifyPayload, siteTitle: string): string {
    const lines: string[] = [];
    lines.push(`<b>${EVENT_TITLE[payload.event]}</b>`);
    if (payload.domains.length > 0) {
        lines.push(`<b>域名：</b>${escapeHtml(payload.domains.join(", "))}`);
    }
    if (payload.mail) {
        lines.push(`<b>用户：</b>${escapeHtml(payload.mail)}`);
    }
    if (payload.detail) {
        lines.push(`<b>说明：</b>${escapeHtml(payload.detail)}`);
    }
    if (payload.uuid) {
        lines.push(`<b>订单：</b><code>${escapeHtml(payload.uuid)}</code>`);
    }
    if (payload.siteHost) {
        const url = payload.siteHost.startsWith("http")
            ? payload.siteHost
            : `https://${payload.siteHost}`;
        lines.push(`<a href="${escapeHtml(url)}">${escapeHtml(siteTitle)}</a>`);
    }
    return lines.join("\n");
}

/**
 * 通过 Telegram Bot 推送。
 * 返回 {ok, skipped, error}：skipped 表示未配置（不算失败）。
 */
export async function sendTelegram(
    env: any,
    text: string
): Promise<{ ok: boolean; skipped?: boolean; error?: string; sent?: number }> {
    try {
        const token = (await readConf(env, "TG_BOT_TOKEN")) ?? "";
        const chatIds = parseChatIds(await readConf(env, "TG_CHAT_ID"));
        const enabled = await readBool(env, "TG_BOT_ENABLED", false);

        if (!enabled) return {ok: false, skipped: true, error: "TG_BOT_ENABLED 未开启"};
        if (!token) return {ok: false, skipped: true, error: "TG_BOT_TOKEN 未配置"};
        if (chatIds.length === 0) return {ok: false, skipped: true, error: "TG_CHAT_ID 未配置"};

        let sent = 0;
        const errors: string[] = [];

        // 逐个 Chat ID 发送；单个失败不影响其它
        for (const chatId of chatIds) {
            try {
                // 超时兜底：Telegram 不可达时不能让调用方无限等待
                const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
                    method: "POST",
                    headers: {"Content-Type": "application/json"},
                    body: JSON.stringify({
                        chat_id: chatId,
                        parse_mode: "HTML",
                        text,
                        disable_web_page_preview: true,
                    }),
                    signal: AbortSignal.timeout(TG_TIMEOUT_MS),
                });
                const data: any = await res.json().catch(() => ({}));
                if (res.ok && data?.ok) {
                    sent++;
                } else {
                    const desc = data?.description ?? `HTTP ${res.status}`;
                    errors.push(`${chatId}: ${desc}`);
                    console.error("[telegram] 发送失败", {chatId, status: res.status, desc});
                }
            } catch (e: any) {
                errors.push(`${chatId}: ${e?.message ?? String(e)}`);
                console.error("[telegram] 请求异常", {chatId, error: e?.message ?? e});
            }
        }

        if (sent === 0) {
            return {ok: false, error: errors.join("; ") || "全部发送失败"};
        }
        return {ok: true, sent, error: errors.length ? errors.join("; ") : undefined};
    } catch (e: any) {
        console.error("[telegram] 读取配置失败", e);
        return {ok: false, error: e?.message ?? String(e)};
    }
}

/**
 * 统一通知入口：按事件开关决定是否推送 Telegram。
 * 调用方不需要 try/catch——本函数保证不抛异常。
 *
 * 传入 ctx 时改为后台推送：HTTP 请求路径上的通知不再阻塞响应，
 * 由 ExecutionContext 保证 Worker 在响应返回后继续执行完成。
 * 定时任务（cron）没有响应可阻塞，同样可以安全使用。
 */
export async function notify(env: any, payload: NotifyPayload, ctx?: BackgroundContext): Promise<void> {
    if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(notifyNow(env, payload));
        return;
    }
    await notifyNow(env, payload);
}

async function notifyNow(env: any, payload: NotifyPayload): Promise<void> {
    try {
        const switchKey = EVENT_SWITCH[payload.event];
        const enabled = await readBool(env, switchKey, true);
        if (!enabled) return;

        const siteTitle = (await readConf(env, "SITE_TITLE")) || "SSL 证书助手";
        const text = buildMessage(payload, siteTitle);
        const r = await sendTelegram(env, text);
        if (r.ok) {
            console.log(`[notify] ${payload.event} 已推送 Telegram（${r.sent} 个会话）`);
        } else if (!r.skipped) {
            console.warn(`[notify] ${payload.event} 推送失败：${r.error}`);
        }
    } catch (e: any) {
        // 兜底：通知失败绝不能影响证书签发等核心流程
        console.error("[notify] 未预期错误", e?.message ?? e);
    }
}

/** 测试推送：返回详细结果供管理页展示 */
export async function sendTestTelegram(env: any): Promise<{ flags: number; texts: string }> {
    const siteTitle = (await readConf(env, "SITE_TITLE")) || "SSL 证书助手";
    const text = [
        "<b>🔔 Telegram 推送测试</b>",
        `来自：${escapeHtml(siteTitle)}`,
        "如果你看到这条消息，说明 Bot Token 与 Chat ID 配置正确。",
    ].join("\n");
    const r = await sendTelegram(env, text);
    if (r.ok) {
        return {flags: 0, texts: `测试消息已发送（${r.sent} 个会话）` + (r.error ? `；部分失败：${r.error}` : "")};
    }
    if (r.skipped) {
        return {flags: 5, texts: "推送未启用或未配置：" + (r.error ?? "")};
    }
    return {flags: 6, texts: "发送失败：" + (r.error ?? "未知错误")};
}
