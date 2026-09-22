/**
 * 证书厂商（CA）启用状态
 * -------------------------------------------------------------------------
 * `XXX_useIt` 控制某家 CA 是否对用户开放：
 *   - Let's Encrypt / BuyPass 不需要 EAB 凭据，始终可用；
 *   - Google Trust / ZeroSSL / SSL.com 共用实例级凭据，可单独关闭。
 * 关闭后前端不再展示该选项，后端也会拒绝以该 CA 下单，避免仅靠 UI 限制。
 */

import {readConf} from "./db/conf";

/** CA 标识 → 启用开关的配置名；未列出的 CA 视为始终启用 */
const CA_USE_IT_KEY: Record<string, string> = {
    "google-trust": "GTS_useIt",
    "zeroca-trust": "ZRO_useIt",
    "sslcom-trust": "SSL_useIt",
};

/** CA 标识 → 该 CA 所需的 EAB 凭据字段（全部非空才算已配置） */
const CA_CREDENTIAL_KEYS: Record<string, string[]> = {
    "google-trust": ["GTS_keyMC", "GTS_keyID", "GTS_KeyTS"],
    "zeroca-trust": ["ZRO_keyMC", "ZRO_keyID", "ZRO_KeyTS"],
    "sslcom-trust": ["SSL_keyMC", "SSL_keyID", "SSL_KeyTS"],
};

/** 用户可选的 CA 标识，顺序与前端 SIGN_OPTIONS 一致 */
export const CA_SIGNS: string[] = [
    "google-trust",
    "lets-encrypt",
    "zeroca-trust",
    "sslcom-trust",
];

/** CA 标识 → 展示名，用于错误提示 */
export const CA_LABELS: Record<string, string> = {
    "google-trust": "Google Trust Service",
    "lets-encrypt": "Let's Encrypt",
    "zeroca-trust": "ZeroSSL",
    "sslcom-trust": "SSL.com",
    "bypass-trust": "BuyPass",
};

/** 判断某家 CA 的 EAB 凭据是否已完整配置 */
async function hasCredentials(env: any, sign: string): Promise<boolean> {
    const keys = CA_CREDENTIAL_KEYS[sign];
    if (!keys) return true;
    for (const k of keys) {
        const v = await readConf(env, k);
        if (!v || !String(v).trim()) return false;
    }
    return true;
}

/**
 * 判断某家 CA 是否启用。
 * -------------------------------------------------------------------------
 * `XXX_useIt` 取值为三态：
 *   - "false"：显式关闭，始终不可用；
 *   - "true" ：显式开启，可用；
 *   - 空值   ：未显式设置。历史版本只播种空值且从不读取该开关，
 *              因此这里回退为「凭据是否已配置」，避免升级后既有部署
 *              因开关为空而全部失效。
 * 无对应开关的 CA（Let's Encrypt / BuyPass）始终返回 true。
 */
export async function isCaEnabled(env: any, sign: string): Promise<boolean> {
    const key = CA_USE_IT_KEY[sign];
    if (!key) return true;
    const raw = String((await readConf(env, key)) ?? "").trim().toLowerCase();
    if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false;
    if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return true;
    return await hasCredentials(env, sign);
}

/** 列出当前启用的 CA 标识，供 bootstrap 下发给前端 */
export async function enabledCaSigns(env: any): Promise<string[]> {
    const result: string[] = [];
    for (const sign of CA_SIGNS) {
        if (await isCaEnabled(env, sign)) result.push(sign);
    }
    return result;
}
