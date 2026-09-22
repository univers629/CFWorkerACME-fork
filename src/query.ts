// 域名记录 #######################

import {dnsAll, uidDel} from "./agent";
// 注意：这里曾经有一行 `import {a} from "xior/xior-D_RKcIOK";`——它指向 xior 包的内部
// 哈希文件名，既没有任何地方使用，也会随 xior 升级直接失效（TS2307）。已删除。

/** 单条 DNS 记录 */
interface DnsResponse {
    name: string; // 查询的域名
    type: string; // 查询的类型
    time: number; // 查询有效期
    data: string; // 查询的结果
}

/**
 * 公共 DoH 解析器候选列表，按可靠性排序。
 * 单一解析器会因负缓存返回空结果：记录刚创建时解析器已缓存「不存在」，
 * 在缓存过期前持续回答无记录，导致验证被误判为失败。
 * 逐个尝试可显著降低误判概率。
 */
const DOH_SERVERS: string[] = [
    "https://cloudflare-dns.com/dns-query",
    "https://dns.google/resolve",
];

// 解析域名 ################################################################
export async function queryDNS( // =========================================
    domain: string,/* 待查询的域名 */ record: string = "TXT", // 查询类型TXT
    server?: string): Promise<DnsResponse[]> {
    const servers = server ? [server] : DOH_SERVERS;
    for (const srv of servers) {
        const rows = await queryOne(srv, domain, record);
        // 任一解析器返回了记录即认为存在；全部为空才判定为不存在
        if (rows.length > 0) return rows;
    }
    return [];
}

/** 单个 DoH 解析器发起查询；任何异常都返回空数组 */
async function queryOne(server: string, domain: string, record: string): Promise<DnsResponse[]> {
    // 查询参数设置 ========================================================
    const params = new URLSearchParams({name: domain, type: record}); // URL
    try { // 查询过程 ======================================================
        const response = await fetch(`${server}?${params}`, {
            headers: {"accept": "application/dns-json"},
            signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) { // 如果查询失败了 ==============================
            console.error(`查询域名失败 ${server}: ${response.status}`);
            return []; // 返回空数据保证不异常 =============================
        } // 解析查询数据 ==================================================
        const data: any = await response.json();
        if (!data.Answer) return [];
        return data.Answer.map( // 映射查询数据 ======
            (r: any) => ({
                name: r.name, type: r.type, time: r.TTL,
                data: r.data.endsWith('.') ? r.data.substring(0, r.data.length - 1) : r.data,
            }));
    } catch (error) {
        console.error(`解析数据失败 ${server}:`, error);
        return [];
    }
}

/** 带诊断信息的 DNS 查询结果，用于把验证失败原因暴露给用户 */
export interface DnsLookup {
    /** 查询的记录名 */
    name: string;
    /** 查询的记录类型 */
    type: string;
    /** 期望匹配的值 */
    expect: string;
    /** 实际查询到的全部值 */
    found: string[];
    /** 是否命中期望值 */
    matched: boolean;
    /** 已知的失败原因（优先于通用的「值不一致」描述展示给用户） */
    hint?: string;
}

/**
 * 查询并比对期望值，返回完整诊断信息。
 * 与 queryDNS 的区别：不提前短路，始终返回「期望值 + 实际值」，
 * 使调用方能区分「记录不存在」与「记录存在但值不匹配」。
 */
export async function lookupDNS(name: string, type: string, expect: string): Promise<DnsLookup> {
    const rows = await queryDNS(name, type);
    const found = rows.map((r) => String(r.data ?? "")).filter(Boolean);
    return {
        name,
        type,
        expect: String(expect ?? ""),
        found,
        matched: found.includes(String(expect ?? "")),
    };
}

/** 把诊断结果转成简短的中文描述，供订单 text 字段展示 */
export function describeLookup(l: DnsLookup): string {
    if (l.matched) return `${l.name} ${l.type} 记录正确`;
    if (l.hint) return `${l.name}: ${l.hint}`;
    if (l.found.length === 0) {
        return `${l.name} 未查询到 ${l.type} 记录（期望 ${l.expect}）`;
    }
    return `${l.name} 的 ${l.type} 记录值为 ${l.found.join(" / ")}，与期望的 ${l.expect} 不一致`;
}

// 解析域名 ################################################################
/** 记录在未被任何活动订单引用时，至少闲置多久才允许清理（防止误删进行中的记录） */
const CLEAN_IDLE_MS = 60 * 60 * 1000;
/** 被活动订单引用、但已长时间未更新的记录，视为泄漏并清理 */
const CLEAN_STALE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 清理本系统写入的 DCV 验证记录（`<hex>.<DCV_AGENT>`）。
 * -------------------------------------------------------------------------
 * 判定规则：
 *   1. 仍被活动订单（flag 0..4）引用的记录默认保留，避免删除进行中的验证记录；
 *   2. 未被引用且闲置超过 1 小时的记录直接清理（覆盖删单产生的孤儿记录）；
 *   3. 被引用但超过 7 天未更新的记录同样清理（覆盖订单长期卡死的泄漏）。
 */
export async function cleanDNS(env: any) { // ===============
    let records: Record<string, any> | any = await dnsAll(env)
    let counter: number = 0;
    // 只清理本系统写入的验证记录：<hex>.<DCV_AGENT>
    const {readConf} = await import("./db/conf");
    const agentHost = String((await readConf(env, "DCV_AGENT")) ?? "").trim();
    if (!agentHost) {
        console.warn("[clean] 未配置 DCV_AGENT，跳过清理");
        return {"flag": false, "text": "未配置 DCV_AGENT，无法判断哪些记录属于本系统"};
    }
    const escaped = agentHost.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`^[a-f0-9]+\\.${escaped}$`, "i");

    // 活动订单正在使用的记录名集合
    const inUse = new Set<string>();
    try {
        const {ensureDao} = await import("./db");
        const dao = await ensureDao(env);
        const active: any = await dao.scanApplies({lte: {flag: 4}});
        for (const id in active) {
            const row = active[id];
            if (Number(row?.flag ?? -1) < 0) continue;
            try {
                const list: any[] = JSON.parse(row?.list ?? "[]");
                for (const d of list) {
                    const auto = String(d?.auto ?? "").trim().toLowerCase();
                    if (auto) inUse.add(auto);
                }
            } catch { /* list 解析失败时忽略该订单 */ }
        }
    } catch (e) {
        console.warn("[clean] 读取活动订单失败，跳过本轮清理", e);
        return {"flag": false, "text": "无法确认记录占用情况，已跳过清理"};
    }

    if (records['result']) records = records['result']
    for (let single of records) {
        let rec_name: string = single['name'];
        let rec_date: string = single['modified_on'];
        let rec_uuid: string = single['id'];
        let delete_t: string = ''
        if (regex.test(rec_name)) {
            let num_date = new Date(rec_date).getTime();
            let now_date = Date.now();
            const age = Number.isFinite(num_date) ? Math.abs(now_date - num_date) : 0;
            const referenced = inUse.has(String(rec_name).trim().toLowerCase());
            // 未引用：闲置满 1 小时即可清理；已引用：仅在超过 7 天未更新时清理
            const expired = referenced ? age >= CLEAN_STALE_MS : age >= CLEAN_IDLE_MS;
            if (expired) {
                // 传入记录名，让 uidDel 能定位到正确的 Zone（多根域场景）
                await uidDel(env, rec_name, rec_uuid)
                delete_t = referenced ? "Deleted(stale)" : "Deleted(orphan)"
                counter += 1
            }
            console.log(rec_uuid, rec_date, rec_name, delete_t)
        }
    }
    return {"flag": true, "text": `已经清理\`${counter}\`个DNS记录`}
}
