import {Bindings} from "./index";
import {readConf} from "./db/conf";

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

export async function dnsAdd(env: Bindings, domain_item: any, domain_name: string) {
    const [zones, email, token] = await Promise.all([
        dcv(env, "DCV_ZONES"), dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN"),
    ]);
    return dnsAPI(
        "POST", `https://api.cloudflare.com/client/v4/zones/${zones}/dns_records`,
        {
            'Content-Type': 'application/json',
            ...cfAuthHeaders(email, token),
        },
        JSON.stringify({
            comment: 'DCV-Agent#' + Date.now() + '@' + domain_name,
            content: domain_item['auth'],
            name: domain_item['auto'],
            ttl: 60,
            type: 'TXT'
        }))
}

export async function dnsDel(env: Bindings, domain_name: string, domain_type: string = "TXT") {
    let domain_uuid: string = await dnsUID(env, domain_name, domain_type);
    return await uidDel(env, domain_uuid);

}

export async function dnsUID(env: Bindings, domain_name: string, domain_type: string = "TXT") {
    let domain_list: Record<string, any> = await dnsAll(env);
    let domain_uuid = "";
    for (const domain_item of domain_list['result']) {
        // console.log(domain_item['name'], domain_name);
        if (domain_item['name'] === domain_name
            && domain_item.type == domain_type) {
            domain_uuid = domain_item['id'];
            break;
        }
    }
    return domain_uuid;
}

export async function dnsAll(env: Bindings) {
    const [zones, email, token] = await Promise.all([
        dcv(env, "DCV_ZONES"), dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN"),
    ]);
    return dnsAPI(
        "GET", `https://api.cloudflare.com/client/v4/zones/${zones}/dns_records`,
        cfAuthHeaders(email, token), undefined)
}

export async function uidDel(env: Bindings, domain_uuid: string) {
    const [zones, email, token] = await Promise.all([
        dcv(env, "DCV_ZONES"), dcv(env, "DCV_EMAIL"), dcv(env, "DCV_TOKEN"),
    ]);
    return dnsAPI(
        "DELETE", `https://api.cloudflare.com/client/v4/zones/${zones}/dns_records/${domain_uuid}`,
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
