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
): Promise<{id: string; zoneId: string; content?: string}[]> {
    const [email, token] = await Promise.all([dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN")]);

    // 候选 Zone：优先按域名匹配，匹配不到再退回全部
    const matched = await resolveZone(env, domain_name);
    const zones = matched ? [matched] : await listZones(env);

    const hits: {id: string; zoneId: string; content?: string}[] = [];
    for (const z of zones) {
        // 带上 name 让 Cloudflare 服务端先筛一遍：只靠 per_page=100 的首页结果，
        // 记录较多的 Zone 会漏掉目标记录（删除/查重都会因此失效）。
        const qs = new URLSearchParams({
            per_page: "100",
            type: domain_type,
            name: domain_name,
        });
        const page = await dnsAPI(
            "GET",
            `https://api.cloudflare.com/client/v4/zones/${z.id}/dns_records?${qs.toString()}`,
            cfAuthHeaders(email, token), undefined);
        const rows: any[] = Array.isArray(page?.result) ? page.result : [];
        for (const item of rows) {
            if (item?.name === domain_name && item?.type === domain_type) {
                // 顺带带回 content，供调用方判断该记录是否仍被其它订单引用，
                // 避免为每条记录再发一次 GET。
                hits.push({id: String(item.id), zoneId: z.id, content: String(item?.content ?? "")});
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
 *
 * 关于同名 TXT：DNS 规定同一名字上 CNAME 不能与其它记录共存。若历史上残留过
 * `_acme-challenge.<域名>` 的 TXT（例如该域名曾用 dns-self 手动验证），解析器
 * 会返回这条 TXT 而不再跟随 CNAME，CA 因此永远读不到 DCV_AGENT 上的值 ——
 * 表现为「CNAME 看起来配好了，验证却一直卡在验证中」。所以这里在确认 CNAME
 * 存在后，仍需清掉同名 TXT，否则 CNAME 形同虚设。
 */
export async function cnameEnsure(
    env: Bindings, domain_name: string, target: string
): Promise<{success: boolean; unchanged?: boolean; cleaned?: number; errors?: any[]}> {
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

    // 同名 TXT 会遮蔽 CNAME，必须先清掉。放在 CNAME 判断之前，
    // 保证「CNAME 已存在」这条早退路径也不会漏掉清理。
    const cleaned = await dropShadowingTxt(env, recordName);

    // 已存在则保持原样：用户可能已手工配置，不覆盖
    const existing = await findRecords(env, recordName, "CNAME");
    if (existing.length > 0) {
        return {success: true, unchanged: true, cleaned};
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
    if (isIdenticalRecordError(res)) return {success: true, unchanged: true, cleaned};
    // dnsAPI 在异常时返回 {}，统一补齐 success 字段供调用方判断
    return {success: !!res?.success, cleaned, errors: res?.errors};
}

/**
 * 删除 `_acme-challenge.<域名>` 上的 TXT 记录（同名 TXT 会遮蔽 CNAME）。
 * 失败不抛错：清理属于 best-effort，删不掉时仍继续尝试创建 CNAME，
 * 由后续的 DNS 预检把冲突明确报给用户。
 * @param protect 需要保留的记录值（仍被其它活动订单引用）；由调用方计算后传入，
 *                避免本模块依赖数据层，也便于单元测试直接构造场景。
 * @returns 实际删除成功的条数
 */
async function dropShadowingTxt(
    env: Bindings, recordName: string, protect: Set<string> = new Set()
): Promise<number> {
    try {
        const rows = await findRecords(env, recordName, "TXT");
        if (rows.length === 0) return 0;

        const [email, token] = await Promise.all([dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN")]);
        let removed = 0;
        for (const r of rows) {
            // 仍被其它活动订单引用的值：留给对应订单自行处理，不在此删除
            const val = String(r.content ?? "").trim();
            if (val && protect.has(val)) {
                console.warn(`[agent] 保留仍被活动订单引用的 TXT ${recordName}: ${val}`);
                continue;
            }
            const res = await dnsAPI(
                "DELETE",
                `https://api.cloudflare.com/client/v4/zones/${r.zoneId}/dns_records/${r.id}`,
                cfAuthHeaders(email, token), undefined);
            if (res?.success) removed++;
            else console.warn(`[agent] 清理同名 TXT 失败 ${recordName} id=${r.id}:`, res?.errors);
        }
        if (removed > 0) {
            console.warn(`[agent] 已清理 ${removed} 条遮蔽 CNAME 的 TXT 记录：${recordName}`);
        }
        return removed;
    } catch (e) {
        console.warn(`[agent] 清理同名 TXT 异常 ${recordName}:`, e);
        return 0;
    }
}

/**
 * 自愈入口：清理某域名 `_acme-challenge` 上的同名 TXT。
 * -------------------------------------------------------------------------
 * 供 dnsAuthy 在验证失败时调用。必要性在于 cnameEnsure 只在 setApply（flag=1）
 * 阶段执行一次，而历史订单可能早已越过该阶段 —— 若用户的旧订单曾被手工
 * 添加过 `_acme-challenge` 的 TXT，那条记录会一直遮蔽 CNAME，订单每轮
 * cron 都验证失败却无法自愈，除非用户手工删除。
 * @param protect 需要保留的记录值，见 dropShadowingTxt
 * @returns 删除成功的条数
 */
export async function healShadowingTxt(
    env: Bindings, domain_name: string, protect: Set<string> = new Set()
): Promise<number> {
    const host = String(domain_name ?? "").replace(/^\*\./, "").trim();
    if (!host) return 0;
    return dropShadowingTxt(env, `_acme-challenge.${host}`, protect);
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
