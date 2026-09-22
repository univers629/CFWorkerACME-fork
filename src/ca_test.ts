/**
 * CA 账户凭据自检
 * -------------------------------------------------------------------------
 * 在不申请证书的前提下判断 GTS / ZeroSSL / SSL.com 的账户凭据是否可用。
 * 证书签发配额不会被消耗：整个流程只做 newAccount 探测，不触碰 newOrder。
 *
 * 两级校验：
 *   1) 本地校验：字段完整性、账户私钥 PEM 解析、hmacKey base64 解码 —— 不联网；
 *   2) 只读探针：向 newAccount 发送 `onlyReturnExisting: true` 并强制携带 EAB，
 *      CA 不会创建账户，因此不会消耗 GTS 的一次性 EAB。
 *
 * 只读探针的能力边界（对三家 CA 实测所得，不要在 UI 上过度承诺）：
 *   - SSL.com：会校验 EAB。凭据错误返回 401 unauthorized，正确则返回
 *     accountDoesNotExist（账户尚未注册）或 200（账户已存在）。
 *   - GTS / ZeroSSL：忽略 onlyReturnExisting 请求中的 EAB，凭据无论对错都只
 *     返回 accountDoesNotExist。因此只读模式无法证明这两家的 EAB 正确，
 *     只能确认目录可达、账户私钥可用、EAB 字段格式合法。
 *   - 若需要完整验证 GTS / ZeroSSL 的 EAB，必须真正注册账户（deep 模式）。
 *     注册账户不消耗证书签发配额，但 GTS 的 EAB 是一次性的：注册成功后该
 *     EAB 即失效，若日后更换 GTS_KeyTS 则需重新申请 EAB。故 deep 模式默认关闭。
 */

import * as acme from "acme-client";
import {readConfMap} from "./db/conf";

/** 单个检查项；warn 表示「未能验证」而非「验证失败」 */
export interface CaCheck {
    name: string;
    ok: boolean;
    detail: string;
    warn?: boolean;
}

export interface CaTestResult {
    ok: boolean;
    texts: string;
    checks: CaCheck[];
}

interface CaMeta {
    label: string;
    url: string;
    /** 账户私钥 PEM 的配置名 */
    keyName: string;
    /** EAB KID 的配置名 */
    kidName: string;
    /** EAB HMAC Key 的配置名 */
    mcName: string;
    /** SSL.com 的目录地址需要拼接密钥类型后缀 */
    sslSuffix?: boolean;
}

export const CA_TEST_META: Record<string, CaMeta> = {
    "google-trust": {
        label: "Google Trust Services",
        url: acme.directory.google.production,
        keyName: "GTS_KeyTS",
        kidName: "GTS_keyID",
        mcName: "GTS_keyMC",
    },
    "zeroca-trust": {
        label: "ZeroSSL",
        url: acme.directory.zerossl.production,
        keyName: "ZRO_KeyTS",
        kidName: "ZRO_keyID",
        mcName: "ZRO_keyMC",
    },
    "sslcom-trust": {
        label: "SSL.com",
        url: "https://acme.ssl.com/sslcom-dv-",
        keyName: "SSL_KeyTS",
        kidName: "SSL_keyID",
        mcName: "SSL_keyMC",
        sslSuffix: true,
    },
};

/** 从 ACME 错误对象里取出可读文案（RFC 8555 Problem Details 优先） */
function pickAcmeError(e: any): string {
    const resp = e?.response;
    const data = resp?.data;
    if (data && typeof data === "object") {
        const detail = String(data.detail ?? "").trim();
        const type = String(data.type ?? "").replace("urn:ietf:params:acme:error:", "");
        if (detail) return type ? `${detail}（${type}）` : detail;
        if (type) return type;
    }
    return String(e?.message ?? e ?? "未知错误").replace(/\s+/g, " ").slice(0, 200);
}

/** 取 ACME problem 的 type 短名，用于判定语义 */
function acmeErrorType(e: any): string {
    return String(e?.response?.data?.type ?? "").replace("urn:ietf:params:acme:error:", "");
}

/**
 * 校验某家 CA 的账户凭据。
 *
 * @param deep 是否注册账户以完整校验 EAB（默认 false，只读）。
 *             注册账户不消耗证书签发配额，但会消耗 GTS 的一次性 EAB。
 */
export async function testCaCredentials(
    env: any,
    sign: string,
    opts: { deep?: boolean; contact?: string; type?: string } = {},
): Promise<CaTestResult> {
    const checks: CaCheck[] = [];
    const meta = CA_TEST_META[sign];
    if (!meta) {
        return {ok: false, texts: `不支持自检的证书提供商：${sign}`, checks};
    }

    // 1) 字段完整性 ------------------------------------------------
    const conf = await readConfMap(env, [meta.keyName, meta.kidName, meta.mcName]);
    const keyPem = String(conf[meta.keyName] ?? "").trim();
    const kid = String(conf[meta.kidName] ?? "").trim();
    const hmacKey = String(conf[meta.mcName] ?? "").trim();

    const missing = [
        !keyPem && meta.keyName,
        !kid && meta.kidName,
        !hmacKey && meta.mcName,
    ].filter(Boolean) as string[];

    if (missing.length) {
        checks.push({
            name: "凭据完整性",
            ok: false,
            detail: `未配置：${missing.join("、")}`,
        });
        return {ok: false, texts: `${meta.label} 凭据不完整`, checks};
    }
    checks.push({name: "凭据完整性", ok: true, detail: "三个字段均已配置"});

    // 2) 本地校验：账户私钥 PEM ------------------------------------
    let client: any;
    try {
        client = new acme.Client({directoryUrl: meta.url, accountKey: keyPem});
        // getJwk 为纯本地解析，不发起网络请求
        const jwk: any = client.http.getJwk();
        const alg = jwk?.crv ? `EC ${jwk.crv}` : String(jwk?.kty ?? "未知");
        checks.push({name: "账户私钥", ok: true, detail: `PEM 解析正常（${alg}）`});
    } catch (e: any) {
        checks.push({
            name: "账户私钥",
            ok: false,
            detail: `${meta.keyName} 不是合法的 PEM 私钥：${String(e?.message ?? e).slice(0, 120)}`,
        });
        return {ok: false, texts: `${meta.label} 账户私钥格式错误`, checks};
    }

    // 3) 本地校验：hmacKey base64 ----------------------------------
    // 按 RFC 8555，EAB 的 HMAC Key 是 base64url 编码的对称密钥。
    const decoded = Buffer.from(hmacKey, "base64");
    if (decoded.length === 0) {
        checks.push({
            name: "HMAC Key",
            ok: false,
            detail: `${meta.mcName} 不是合法的 base64（解码后为空）`,
        });
        return {ok: false, texts: `${meta.label} HMAC Key 格式错误`, checks};
    }
    checks.push({name: "HMAC Key", ok: true, detail: `base64 解码正常（${decoded.length} 字节）`});

    // 4) 只读探针：目录可达 + nonce + EAB --------------------------
    let dirUrl = meta.url;
    if (meta.sslSuffix) {
        const t = String(opts.type ?? "rsa2048");
        dirUrl += t.substring(0, 3);
    }

    // 携带 EAB 的客户端（探针用）
    client = new acme.Client({
        directoryUrl: dirUrl,
        accountKey: keyPem,
        externalAccountBinding: {kid, hmacKey},
    });

    let accountExists = false;
    try {
        const resp: any = await client.api.apiResourceRequest(
            "newAccount",
            {onlyReturnExisting: true},
            [200, 201],
            {includeJwsKid: false, includeExternalAccountBinding: true},
        );
        accountExists = true;
        checks.push({name: "ACME 目录", ok: true, detail: "目录可达，newNonce 正常"});
        checks.push({
            name: "EAB 校验",
            ok: true,
            detail: `账户已注册且凭据有效${resp?.headers?.location ? "" : ""}`,
        });
    } catch (e: any) {
        const type = acmeErrorType(e);

        // 目录 / nonce 层面的失败：无法继续判断 EAB
        if (type !== "accountDoesNotExist" && type !== "unauthorized" && type !== "malformed") {
            checks.push({name: "ACME 目录", ok: false, detail: pickAcmeError(e)});
            return {ok: false, texts: `无法连接 ${meta.label} 的 ACME 目录`, checks};
        }

        checks.push({name: "ACME 目录", ok: true, detail: "目录可达，newNonce 正常"});

        if (type === "unauthorized" || type === "malformed") {
            // 凭据确实被 CA 校验并拒绝
            checks.push({name: "EAB 校验", ok: false, detail: pickAcmeError(e)});
            return {ok: false, texts: `${meta.label} 的 EAB 凭据无效`, checks};
        }

        // accountDoesNotExist：账户尚未注册
        if (sign === "sslcom-trust") {
            // 实测：SSL.com 在只读模式下也会校验 EAB，能走到这里说明 EAB 正确
            checks.push({
                name: "EAB 校验",
                ok: true,
                detail: "EAB 凭据有效；账户尚未注册，首次下单时会自动注册",
            });
        } else {
            // 实测：GTS / ZeroSSL 忽略只读请求里的 EAB，无法据此判定
            checks.push({
                name: "EAB 校验",
                ok: true,
                warn: true,
                detail: `该 CA 在只读模式下不校验 EAB，无法确认 ${meta.kidName} / ${meta.mcName} 是否正确`,
            });
            checks.push({
                name: "账户状态",
                ok: true,
                warn: true,
                detail: "尚未注册；如勾选「注册账户」可完整校验 EAB（不消耗证书签发配额）",
            });
        }
    }

    // 5) 深度校验：注册账户（可选） --------------------------------
    if (opts.deep && !accountExists) {
        try {
            const created: any = await client.createAccount({
                termsOfServiceAgreed: true,
                contact: opts.contact ? [`mailto:${opts.contact}`] : [],
            });
            checks.push({
                name: "注册账户",
                ok: true,
                detail: `注册成功${created?.headers?.location ? "，已获得 accountUrl" : ""}`,
            });
            accountExists = true;
        } catch (e: any) {
            checks.push({name: "注册账户", ok: false, detail: pickAcmeError(e)});
            return {ok: false, texts: `${meta.label} 注册账户失败`, checks};
        }
    }

    const ok = checks.every((x) => x.ok);
    const warned = checks.some((x) => x.warn);
    return {
        ok,
        texts: ok
            ? (warned ? `${meta.label} 基本配置可用（EAB 未完全校验）` : `${meta.label} 配置可用`)
            : `${meta.label} 配置存在问题`,
        checks,
    };
}
