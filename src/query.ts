// 域名记录 #######################

import {dnsAll, dnsAPI, uidDel} from "./agent";
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

// 解析域名 ################################################################
export async function queryDNS( // =========================================
    domain: string,/* 待查询的域名 */ record: string = "TXT", // 查询类型TXT
    server: string = "https://dns.google/resolve"): Promise<DnsResponse[]> {
    // 查询参数设置 ========================================================
    const params = new URLSearchParams({name: domain, type: record}); // URL
    console.log(`${server}?${params}`);
    try { // 查询过程 ======================================================
        const response = await fetch(`${server}?${params}`);
        if (!response.ok) { // 如果查询失败了 ==============================
            console.error(`查询域名失败: ${response.status}`);
            return []; // 返回空数据保证不异常 =============================
        } // 解析查询数据 ==================================================
        const data: any = await response.json();
        console.log(data);
        if (!data.Answer) return [];
        let txtRecords: any = data.Answer.map( // 映射查询数据 ======
            (r: any) => ({
                name: r.name, type: r.type, time: r.TTL,
                data: r.data.endsWith('.') ? r.data.substring(0, r.data.length - 1) : r.data,
            }));
        // console.log("txtRecords: ", txtRecords);
        return txtRecords || [];
    } catch (error) {
        console.error('解析数据失败:', error);
        return [];
    }
}

// 解析域名 ################################################################
export async function cleanDNS(env: any) { // ===============
    let records: Record<string, any> | any = await dnsAll(env)
    let counter: number = 0;
    const regex = /^[a-f0-9]+\.dcv\.524229\.xyz$/i;
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
                await uidDel(env, rec_uuid)
                delete_t = "Deleted"
                counter += 1
            }
            console.log(rec_uuid, rec_date, rec_name, delete_t)
        }
    }
    return {"flag": true, "text": `已经清理\`${counter}\`个DNS记录`}
}
