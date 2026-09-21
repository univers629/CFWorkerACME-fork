/**
 * 自动续期扫描
 * -------------------------------------------------------------------------
 * 扫描 flag=5 且 auto=1 的订单，距到期不足 AUTO_RENEW_DAYS（默认 30 天）时
 * 把 flag 重置为 0，交由 certs.Processing 重新走完签发流程。
 *
 * 幂等：重置后不再是 flag=5，后续扫描不会重复触发；失败停在 -1 同样不重试。
 * 续期失败时旧的 cert/keys 保留在库中，下载接口不要求 flag=5，服役中的
 * 服务器不会因一次失败而拉不到证书。
 */

import * as saves from "./saves";
import {readBool, readInt} from "./db/conf";
import {notify} from "./notify";
import type {D1Bindings} from "./index";

/** 默认提前多少天续期 */
const DEFAULT_RENEW_DAYS = 30;

/**
 * 判断订单是否勾选了自动续期。
 * Web 路径写入布尔值、API 路径写入 1/0，落库后可能是 1 / "1" / true / "true"。
 */
function isAutoRenewOn(v: any): boolean {
    if (v === true || v === 1) return true;
    const s = String(v ?? "").trim().toLowerCase();
    return s === "1" || s === "true";
}

export interface RenewScanResult {
    /** 本次触发续期的订单数 */
    triggered: number;
    /** 扫描过的候选订单数（flag=5 且 auto=1） */
    scanned: number;
    /** 因配置关闭而整体跳过 */
    disabled: boolean;
    /** 触发续期的订单 uuid，便于日志排查 */
    uuids: string[];
    /** 续期卡在人工验证（flag=2）并已发出提醒的订单数 */
    stuck: number;
}

/** 卡住提醒的去重标记（写入 Apply.notified） */
const STUCK_MARK = "renew_stuck";

/**
 * 扫描并触发自动续期。
 * 不抛异常：单个订单失败不影响其它订单，也不影响调用方（cron）。
 */
export async function scanAutoRenew(env: D1Bindings): Promise<RenewScanResult> {
    const result: RenewScanResult = {triggered: 0, scanned: 0, disabled: false, uuids: [], stuck: 0};

    const enabled = await readBool(env as any, "AUTO_RENEW_ENABLED", true);
    if (!enabled) {
        result.disabled = true;
        return result;
    }

    const days = await readInt(env as any, "AUTO_RENEW_DAYS", DEFAULT_RENEW_DAYS);
    const thresholdMs = Math.max(1, days) * 24 * 60 * 60 * 1000;
    const now = Date.now();

    let orders: any[] = [];
    try {
        orders = await saves.selectDB(env.DB_CF, "Apply", {flag: {value: 5}});
    } catch (e) {
        console.error("[renew] 查询已签发订单失败", e);
        return result;
    }

    for (const order of orders) {
        try {
            // 只处理用户显式勾选了自动续期的订单
            if (!isAutoRenewOn(order?.auto)) continue;
            result.scanned++;

            const next = Number(order?.next ?? 0);
            // next 为 0 表示未记录到期时间（老数据）：跳过而不是误触发
            if (!next || next <= 0) continue;

            if (next - now > thresholdMs) continue;

            // 到期（或已过期）也一并触发；续期成功后会刷新 next
            const remainDays = Math.floor((next - now) / (24 * 60 * 60 * 1000));
            console.log(
                `[renew] 触发续期 uuid=${order.uuid} 剩余${remainDays}天 (阈值${days}天)`
            );

            // 重置为 0，交由状态机重新走完整签发流程。
            // 保留 cert/keys，续期失败时旧证书仍可下载。
            await saves.updateDB(
                env.DB_CF, "Apply",
                {
                    flag: 0,
                    text: `[auto-renew] 距到期 ${remainDays} 天，已自动发起续期`,
                    // 清空上次的到期提醒标记，让新证书能重新提醒
                    notified: "",
                },
                {uuid: order.uuid}
            );
            result.triggered++;
            result.uuids.push(String(order.uuid));
        } catch (e) {
            console.error(`[renew] 处理订单 ${order?.uuid} 失败`, e);
        }
    }

    // 第二遍：提醒「已发起续期但卡在人工验证」的订单。
    // 这类订单已离开 flag=5，expiry 扫描覆盖不到，旧证书到期前不会有任何提醒。
    try {
        result.stuck = await notifyStuckRenewals(env, thresholdMs, now);
    } catch (e) {
        console.error("[renew] 卡住订单扫描失败", e);
    }

    return result;
}

/**
 * 提醒卡住的续期订单：flag=2 且已持有旧证书（区别于首次申请）。
 * 通过 notified 里的 renew_stuck 标记去重，同一订单只提醒一次。
 */
async function notifyStuckRenewals(
    env: D1Bindings, thresholdMs: number, now: number
): Promise<number> {
    let rows: any[] = [];
    try {
        rows = await saves.selectDB(env.DB_CF, "Apply", {flag: {value: 2}});
    } catch (e) {
        console.error("[renew] 查询 flag=2 订单失败", e);
        return 0;
    }

    let sent = 0;
    for (const row of rows) {
        try {
            if (!isAutoRenewOn(row?.auto)) continue;
            // 没有旧证书 → 首次申请卡住，不属于「续期失败」，交给原有流程处理
            if (!row?.cert) continue;

            const next = Number(row?.next ?? 0);
            if (!next || next <= 0) continue;
            // 只在临近到期时才提醒，避免刚发起就打扰
            if (next - now > thresholdMs) continue;

            const marks = new Set(
                String(row?.notified ?? "").split(",").map((s: string) => s.trim()).filter(Boolean)
            );
            if (marks.has(STUCK_MARK)) continue;

            const remainDays = Math.floor((next - now) / (24 * 60 * 60 * 1000));
            await notify(env, {
                event: "renew_stuck",
                domains: safeDomains(row?.list),
                mail: row?.mail,
                uuid: row?.uuid,
                detail:
                    `自动续期已发起，但订单停在「等待域名验证」，` +
                    `旧证书 ${remainDays} 天后到期。请登录后台完成验证。`,
                siteHost: (await readConfHost(env)) || undefined,
            });

            marks.add(STUCK_MARK);
            await saves.updateDB(
                env.DB_CF, "Apply",
                {notified: [...marks].join(",")},
                {uuid: row.uuid}
            );
            sent++;
        } catch (e) {
            console.error(`[renew] 提醒卡住订单 ${row?.uuid} 失败`, e);
        }
    }
    return sent;
}

/** 从 list JSON 取域名数组；异常时返回空数组 */
function safeDomains(list: any): string[] {
    try {
        const arr = JSON.parse(list ?? "[]");
        if (!Array.isArray(arr)) return [];
        return arr.map((d: any) => d?.name).filter((n: any) => typeof n === "string" && n);
    } catch {
        return [];
    }
}

/** 读站点域名（用于通知里的链接）；读不到返回空串 */
async function readConfHost(env: D1Bindings): Promise<string> {
    try {
        const {readConf} = await import("./db/conf");
        return (await readConf(env as any, "SITE_HOST")) ?? "";
    } catch {
        return "";
    }
}
