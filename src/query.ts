// 域名记录 #######################

import {dnsAll, uidDel} from "./agent";
// 注意：这里曾经有一行 `import {a} from "xior/xior-D_RKcIOK";`——它指向 xior 包的内部
// 哈希文件名，既没有任何地方使用，也会随 xior 升级直接失效（TS2307）。已删除。

interface DnsResponse {
    Status: number; // 查询响应状态
    Answer: { // 返回的查询完整结果
        name: string; // 查询的域名
        type: string; // 查询的类型
        time: number; // 查询有效期
        data: string; // 查询的结果
    };
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

/** 向单个 DoH 解析器发起查询；任何异常都返回空数组 */
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

// 解析域名 ################################################################
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
    if (records['result']) records = records['result']
    for (let single of records) {
        let rec_name: string = single['name'];
        let rec_date: string = single['modified_on'];
        let rec_uuid: string = single['id'];
        let delete_t: string = ''
        if (regex.test(rec_name)) {
            let num_date = new Date(rec_date).getTime();
            let now_date = Date.now();
            if (Math.abs(now_date - num_date) >= 7 * 24 * 60 * 60 * 1000) {
                // 传入记录名，让 uidDel 能定位到正确的 Zone（多根域场景）
                await uidDel(env, rec_name, rec_uuid)
                delete_t = "Deleted"
                counter += 1
            }
            console.log(rec_uuid, rec_date, rec_name, delete_t)
        }
    }
    return {"flag": true, "text": `已经清理\`${counter}\`个DNS记录`}
}
