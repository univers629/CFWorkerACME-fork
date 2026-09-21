/**
 * 证书到期提醒扫描
 * -------------------------------------------------------------------------
 * 背景：`NOTIFY_ON_EXPIRE7` / `NOTIFY_ON_EXPIRED` 这两个开关原先只在
 *       系统管理页上存在，后端没有任何代码消费它们——也就是"点了没反应"。
 *       本模块把它们接上，由 cron 定期调用。
 *
 * 触发规则（对 flag=5 已签发且带 next 到期时间的订单）：
 *   - 距到期 <= 7 天且尚未提醒  → expire7
 *   - 已过期（next <= now）且尚未提醒 → expired
 *
 * 去重：把已发过的事件名写进 Apply.notified（逗号分隔），
 *       因此同一个证书的同一类提醒只会推送一次。
 *       续期成功后 next 会被更新，届时由调用方清空 notified 以便下个周期重新提醒。
 */

import {ensureDao} from "./db";
import {notify, type BackgroundContext} from "./notify";
import {readConf} from "./db/conf";
import type {Bindings} from "./index";

/** 7 天的毫秒数 */
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** 解析 notified 字段为集合 */
function parseNotified(raw: any): Set<string> {
    const s = String(raw ?? "").trim();
    if (!s) return new Set();
    return new Set(s.split(",").map((x) => x.trim()).filter(Boolean));
}

/** 解析订单的域名列表（失败返回空数组） */
function domainListOf(order: any): string[] {
    try {
        const data = JSON.parse(order?.list ?? "[]");
        if (Array.isArray(data)) {
            return data.map((d: any) => d?.name).filter((n: any) => typeof n === "string" && n);
        }
        if (data && typeof data === "object") {
            return Object.values(data)
                .map((d: any) => d?.name)
                .filter((n: any) => typeof n === "string" && n);
        }
    } catch {
        /* 忽略：list 异常不影响其它订单 */
    }
    return [];
}

/**
 * 扫描所有已签发证书，按需推送到期提醒。
 * 返回 {expire7, expired} 两个计数，便于 cron 打日志。
 * 不抛异常：任何单个订单的失败都不会中断整轮扫描。
 * @param ctx 可选：传入后通知改为后台推送
 */
export async function scanExpiry(env: Bindings, ctx?: BackgroundContext): Promise<{ expire7: number; expired: number }> {
    const result = {expire7: 0, expired: 0};

    let dao;
    let orders: any[] = [];
    try {
        dao = await ensureDao(env as any);
        // flag=5 表示已签发；next 为到期时间戳
        orders = await dao.scanApplies({eq: {flag: 5}});
    } catch (e) {
        console.error("[expiry] 查询已签发订单失败", e);
        return result;
    }

    const now = Date.now();
    const siteHost = (await readConf(env as any, "SITE_HOST")) || undefined;

    for (const order of orders) {
        try {
            const next = Number(order?.next ?? 0);
            // next 为 0 表示未记录到期时间（老数据），跳过而不是误报
            if (!next || next <= 0) continue;

            const done = parseNotified(order?.notified);
            const remaining = next - now;
            const domains = domainListOf(order);

            let event: "expire7" | "expired" | null = null;
            if (remaining <= 0 && !done.has("expired")) {
                event = "expired";
            } else if (remaining > 0 && remaining <= SEVEN_DAYS_MS && !done.has("expire7")) {
                event = "expire7";
            }
            if (!event) continue;

            const days = Math.max(0, Math.ceil(remaining / (24 * 60 * 60 * 1000)));
            await notify(env, {
                event,
                domains,
                mail: order?.mail,
                uuid: order?.uuid,
                detail: event === "expired"
                    ? "证书已过期，请尽快重新申请"
                    : `剩余 ${days} 天，将自动续期（若已开启自动续期）`,
                siteHost,
            }, ctx);

            // 记录已提醒；注意先写库再计数，避免推送成功但标记失败导致重复轰炸
            done.add(event);
            await dao.updateApply(String(order.uuid), {notified: [...done].join(",")});
            result[event]++;
        } catch (e) {
            console.error(`[expiry] 处理订单 ${order?.uuid} 失败`, e);
        }
    }

    return result;
}
