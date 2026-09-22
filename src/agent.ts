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

/** Cloudflare 对「已存在完全相同的记录」返回的错误；此时目标状态已达成，应视为成功 */
const CF_ERR_IDENTICAL_EXISTS = 81057;

/** 判断 dnsAPI 返回值是否表示「完全相同的记录已存在」 */
function isIdenticalRecordError(res: any): boolean {
    if (!res || res.success !== false) return false;
    const errors: any[] = Array.isArray(res.errors) ? res.errors : [];
    return errors.some((e) =>
        Number(e?.code) === CF_ERR_IDENTICAL_EXISTS
        || /identical record already exists|record already exists/i.test(String(e?.message ?? ""))
    );
}

export async function dnsAdd(env: Bindings, domain_item: any, domain_name: string) {
    const [email, token] = await Promise.all([dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN")]);
    const recordName = String(domain_item['auto'] ?? "").trim();
    if (!recordName) {
        return {success: false, errors: [{message: "验证记录名为空，请检查 DCV_AGENT 配置"}]};
    }
    const zoneId = await zoneForRecord(env, recordName);
    if (!zoneId) {
        console.error(`[agent] 无法确定 ${recordName} 所属 Zone，跳过写入`);
        return {success: false, errors: [{message: "无法确定域名所属 Zone，请检查 DCV_ZONES 或 Token 的 Zone:Read 权限"}]};
    }
    const res = await dnsAPI(
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
        }));
    // 记录已存在且内容一致：无需重复写入，直接按成功处理，避免订单被误判为失败
    if (isIdenticalRecordError(res)) {
        console.log(`[agent] ${recordName} 已存在相同记录，视为写入成功`);
        return {success: true, result: null, unchanged: true};
    }
    return res;
}

/** 删除指定记录名下的全部记录（同名多条时逐一删除） */
export async function dnsDel(env: Bindings, domain_name: string, domain_type: string = "TXT") {
    const name = String(domain_name ?? "").trim();
    if (!name) return {success: false, errors: [{message: "记录名为空"}]};

    const found = await findRecords(env, name, domain_type);
    if (found.length === 0) return {success: false, errors: [{message: "记录不存在"}]};

    let last: any = {success: true};
    for (const rec of found) {
        last = await uidDel(env, name, rec.id);
    }
    return last;
}

/** 在所有候选 Zone 中查找同名同类型的全部记录 */
async function findRecords(
    env: Bindings, domain_name: string, domain_type: string
): Promise<{id: string; zoneId: string}[]> {
    const [email, token] = await Promise.all([dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN")]);

    // 候选 Zone：优先按域名匹配，匹配不到再退回全部
    const matched = await resolveZone(env, domain_name);
    const zones = matched ? [matched] : await listZones(env);

    const hits: {id: string; zoneId: string}[] = [];
    for (const z of zones) {
        const page = await dnsAPI(
            "GET",
            `https://api.cloudflare.com/client/v4/zones/${z.id}/dns_records?per_page=100&type=${encodeURIComponent(domain_type)}`,
            cfAuthHeaders(email, token), undefined);
        const rows: any[] = Array.isArray(page?.result) ? page.result : [];
        for (const item of rows) {
            if (item?.name === domain_name && item?.type === domain_type) {
                hits.push({id: String(item.id), zoneId: z.id});
            }
        }
    }
    return hits;
}

/**
 * 为 dns-auto 域名自动创建 `_acme-challenge.<域名>` → `DCV_AGENT` 的 CNAME。
 * -------------------------------------------------------------------------
 * 验证链需要用户在自己的域名下把 `_acme-challenge` 指向 DCV_AGENT。
 * 该记录只与域名相关、续期时不变，因此创建一次即可长期有效。
 *
 * 行为约定（全部为 best-effort，失败不影响主流程）：
 *   - 已存在同类型记录时不做任何修改，返回 unchanged；
 *   - 代理状态固定为关闭（DNS only），否则 ACME 服务器查不到 TXT；
 *   - Token 对该域名无编辑权限时返回失败原因，由调用方决定是否提示用户。
 */
export async function cnameEnsure(
    env: Bindings, domain_name: string, target: string
): Promise<{success: boolean; unchanged?: boolean; errors?: any[]}> {
    const host = String(domain_name ?? "").replace(/^\*\./, "").trim();
    const dest = String(target ?? "").trim();
    if (!host || !dest) {
        return {success: false, errors: [{message: "域名或目标为空"}]};
    }
    const recordName = `_acme-challenge.${host}`;

    const zone = await resolveZone(env, host);
    if (!zone) {
        return {success: false, errors: [{message: `无法确定 ${host} 所属 Zone`}]};
    }

    // 已存在则保持原样：用户可能已手工配置，不覆盖
    const existing = await findRecords(env, recordName, "CNAME");
    if (existing.length > 0) {
        return {success: true, unchanged: true};
    }

    const [email, token] = await Promise.all([dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN")]);
    const res = await dnsAPI(
        "POST", `https://api.cloudflare.com/client/v4/zones/${zone.id}/dns_records`,
        {
            'Content-Type': 'application/json',
            ...cfAuthHeaders(email, token),
        },
        JSON.stringify({
            comment: 'DCV-Agent#' + Date.now() + '@' + host,
            content: dest,
            name: recordName,
            proxied: false,
            ttl: 60,
            type: 'CNAME'
        }));
    if (isIdenticalRecordError(res)) return {success: true, unchanged: true};
    // dnsAPI 在异常时返回 {}，统一补齐 success 字段供调用方判断
    return {success: !!res?.success, errors: res?.errors};
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
