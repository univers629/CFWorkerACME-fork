import {Bindings} from "./index";
import {readConf} from "./db/conf";
import {parseZoneIds, resolveZone, listZones} from "./zones";

/**
 * 读取 DCV 相关配置：Confs → env → ""
 * 单次请求周期内多次访问同一 key 由 readConf 内部缓存兜底，性能与直读 env 接近。
 */
async function dcv(env: Bindings, name: "DCV_ZONES" | "DCV_EMAIL" | "DCV_TOKEN"): Promise<string> {
    return (await readConf(env as any, name)) ?? "";
}

/**
 * 构造 Cloudflare API 的鉴权头。
 * -------------------------------------------------------------------------
 * Cloudflare 有两套互不兼容的鉴权方式：
 *   1. Global API Key（37 位十六进制）：`X-Auth-Email` + `X-Auth-Key`
 *   2. API Token（40 位、可细粒度授权）：`Authorization: Bearer <token>`
 * 把 scoped Token 塞进 X-Auth-Key 会被拒（6003 Invalid request headers），
 * 所以这里按「有没有邮箱 + token 形态」自动选择，两种凭证都能用。
 */
function cfAuthHeaders(email: string, token: string): Record<string, string> {
    const isGlobalKey = /^[0-9a-fA-F]{37}$/.test(token);
    if (email && isGlobalKey) {
        return {'X-Auth-Email': email, 'X-Auth-Key': token};
    }
    // 其余情况（scoped API Token，或只给了 token 没给邮箱）走 Bearer
    return {'Authorization': `Bearer ${token}`};
}

/**
 * 解析记录所属的 Zone。
 * 优先按域名匹配；匹配不到时回退到显式配置的 DCV_ZONES（多值时取首个）。
 * @param recordName 完整记录名（如 <hash>.dcv.example.com）
 * @returns Zone ID；无法确定时返回空串
 */
async function zoneForRecord(env: Bindings, recordName: string): Promise<string> {
    const zone = await resolveZone(env, recordName);
    if (zone) return zone.id;

    // 回退：显式配置的 DCV_ZONES（Token 可能不具备 Zone:Read 权限）
    const raw = await dcv(env, "DCV_ZONES");
    const ids = parseZoneIds(raw);
    if (ids.length === 1) return ids[0];
    if (ids.length > 1) {
        // 多值时无法判断归属，取首个并记录日志
        console.warn(
            `[agent] 无法为 ${recordName} 匹配 Zone，回退到第一个配置值 ${ids[0]}`
        );
        return ids[0];
    }
    return "";
}

export async function dnsAdd(env: Bindings, domain_item: any, domain_name: string) {
    const [email, token] = await Promise.all([dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN")]);
    const recordName = String(domain_item['auto'] ?? "");
    const zoneId = await zoneForRecord(env, recordName);
    if (!zoneId) {
        console.error(`[agent] 无法确定 ${recordName} 所属 Zone，跳过写入`);
        return {success: false, errors: [{message: "无法确定域名所属 Zone，请检查 DCV_ZONES 或 Token 的 Zone:Read 权限"}]};
    }
    return dnsAPI(
        "POST", `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`,
        {
            'Content-Type': 'application/json',
            ...cfAuthHeaders(email, token),
        },
        JSON.stringify({
            comment: 'DCV-Agent#' + Date.now() + '@' + domain_name,
            content: domain_item['auth'],
            name: recordName,
            ttl: 60,
            type: 'TXT'
        }))
}

export async function dnsDel(env: Bindings, domain_name: string, domain_type: string = "TXT") {
    let domain_uuid: string = await dnsUID(env, domain_name, domain_type);
    return await uidDel(env, domain_name, domain_uuid);
}

/**
 * 查找某条 DNS 记录的 ID。
 * @returns 记录 ID；未找到返回空串
 */
export async function dnsUID(
    env: Bindings, domain_name: string, domain_type: string = "TXT"
): Promise<string> {
    const found = await findRecord(env, domain_name, domain_type);
    return found?.id ?? "";
}

/** 在所有候选 Zone 中查找记录，返回记录 ID 与所属 Zone */
async function findRecord(
    env: Bindings, domain_name: string, domain_type: string
): Promise<{id: string; zoneId: string} | null> {
    const [email, token] = await Promise.all([dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN")]);

    // 候选 Zone：优先按域名匹配，匹配不到再退回全部
    const matched = await resolveZone(env, domain_name);
    const zones = matched ? [matched] : await listZones(env);

    for (const z of zones) {
        const page = await dnsAPI(
            "GET",
            `https://api.cloudflare.com/client/v4/zones/${z.id}/dns_records?per_page=100&type=${encodeURIComponent(domain_type)}`,
            cfAuthHeaders(email, token), undefined);
        const rows: any[] = Array.isArray(page?.result) ? page.result : [];
        for (const item of rows) {
            if (item?.name === domain_name && item?.type === domain_type) {
                return {id: String(item.id), zoneId: z.id};
            }
        }
    }
    return null;
}

/** 列出所有 Zone 下的 DNS 记录（合并结果） */
export async function dnsAll(env: Bindings): Promise<{result: any[]}> {
    const [email, token] = await Promise.all([dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN")]);
    const zones = await listZones(env);
    const merged: any[] = [];
    for (const z of zones) {
        const page = await dnsAPI(
            "GET",
            `https://api.cloudflare.com/client/v4/zones/${z.id}/dns_records?per_page=100`,
            cfAuthHeaders(email, token), undefined);
        const rows: any[] = Array.isArray(page?.result) ? page.result : [];
        for (const r of rows) merged.push({...r, _zoneId: z.id});
    }
    return {result: merged};
}

/**
 * 删除 DNS 记录。
 * @param domain_name 记录名，用于定位所属 Zone；为空时回退到配置中的首个 Zone
 * @param domain_uuid 记录 ID
 */
export async function uidDel(env: Bindings, domain_name: string, domain_uuid: string) {
    const [email, token] = await Promise.all([dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN")]);
    if (!domain_uuid) return {success: false, errors: [{message: "记录不存在"}]};

    // 复用调用方已解析到的 Zone，避免重复遍历全部 Zone 的记录
    const zoneId = await zoneForRecord(env, domain_name);
    if (!zoneId) {
        console.error(`[agent] 无法确定记录 ${domain_name} 所属 Zone，跳过删除`);
        return {success: false, errors: [{message: "无法确定域名所属 Zone"}]};
    }
    return dnsAPI(
        "DELETE", `https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${domain_uuid}`,
        cfAuthHeaders(email, token), undefined)
}

export async function dnsAPI(method: string = "POST",
                             url: string,
                             header: Record<string, any>,
                             body: BodyInit | null | undefined) {
    try {
        console.log(method, url);
        const response = await fetch(url,
            {
                method: method,
                headers: header,
                body: body
            }
        );
        const data: Record<string, any> = await response.json();
        // console.log('Result:', data);
        return data;
    } catch (error) {
        console.error(error);
        return {};
    }
}
