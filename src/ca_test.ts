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
    /**
     * 该 CA 按密钥类型拆分的目录后缀。
     * ---------------------------------------------------------------------
     * SSL.com 的 ACME 服务把 RSA 与 ECC 做成**两个独立的 ACME 配置**，
     * 账户在其中一个配置下注册后，换到另一个配置访问会报
     * `The account does not belong to the ACME configuration`。
     * 也就是说同一把账户私钥无法同时用于两种算法 —— 必须分别注册。
     *
     * 此前探测写死 `rsa2048`，于是「注册账户」只在 rsa 端点建了账户，
     * 用户随后提交 ECC 订单必然 401，而报错文案里还夹着一条误导性的 CAA
     * 提示，极难定位。因此这里对每个端点分别探测、分别注册。
     */
    suffixes?: string[];
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
        suffixes: ["rsa", "ecc"],
    },
};

/**
 * 把订单的加密算法映射为 SSL.com 的目录后缀。
 * 订单 type 取值：rsa2048 / eccp256 / eccp384 —— 取前 3 个字符即 rsa / ecc，
 * 与 getStart 拼接目录时的做法一致。
 */
export function sslcomSuffixOf(type: string | undefined): string {
    return String(type ?? "").substring(0, 3).toLowerCase();
}

/** SSL.com 报「账户不属于该 ACME 配置」时的特征串 */
const ACCOUNT_WRONG_CONFIG = /does not belong to the ACME configuration/i;

/** 判断错误是否为「账户注册在另一个 ACME 配置下」 */
export function isWrongAcmeConfiguration(e: any): boolean {
    const data = e?.response?.data;
    const text = [
        typeof data === "string" ? data : "",
        String(data?.detail ?? ""),
        String(data?.message ?? ""),
        String(e?.message ?? ""),
    ].join(" ");
    return ACCOUNT_WRONG_CONFIG.test(text);
}

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
 * 探测单个目录端点：目录可达性 + nonce + EAB 校验。
 *
 * @returns probe 结果；registered 表示本次是否成功注册了账户
 */
async function probeEndpoint(
    meta: CaMeta,
    dirUrl: string,
    keyPem: string,
    kid: string,
    hmacKey: string,
    deep: boolean,
    contact: string | undefined,
): Promise<{ checks: CaCheck[]; fatal: boolean; registered: boolean }> {
    const checks: CaCheck[] = [];
    const client: any = new acme.Client({
        directoryUrl: dirUrl,
        accountKey: keyPem,
        externalAccountBinding: {kid, hmacKey},
    });

    let accountExists = false;
    try {
        await client.api.apiResourceRequest(
            "newAccount",
            {onlyReturnExisting: true},
            [200, 201],
            {includeJwsKid: false, includeExternalAccountBinding: true},
        );
        accountExists = true;
        checks.push({name: "ACME 目录", ok: true, detail: "目录可达，newNonce 正常"});
        checks.push({name: "EAB 校验", ok: true, detail: "账户已注册且凭据有效"});
    } catch (e: any) {
        const type = acmeErrorType(e);
        const wrongConfig = isWrongAcmeConfiguration(e);

        // 账户属于另一个 ACME 配置（SSL.com 的 rsa/ecc 互斥）：
        // 这既不是「凭据错误」也不是「目录不可达」，必须单独说明，
        // 否则用户会照着 CAA 那条误导性提示白查一轮 DNS。
        if (wrongConfig) {
            checks.push({
                name: "ACME 目录",
                ok: true,
                detail: "目录可达，newNonce 正常",
            });
            checks.push({
                name: "EAB 校验",
                ok: true,
                detail: "凭据有效（账户注册在另一个配置下）",
            });
            checks.push({
                name: "账户归属",
                ok: false,
                detail: "该账户已注册在另一个配置下，当前端点无法复用；"
                    + "SSL.com 的 RSA 与 ECC 是两个独立配置，需分别注册",
            });
            return {checks, fatal: false, registered: false};
        }

        // badNonce：acme-client 内部会重试（默认 5 次），走到这里说明
        // 重试已用尽，属服务端 nonce 抖动而非配置问题，不应据此判定失败。
        if (type === "badNonce") {
            checks.push({
                name: "ACME 目录",
                ok: true,
                warn: true,
                detail: "目录可达，但 nonce 校验反复失败（服务端抖动），请稍后重试",
            });
            return {checks, fatal: false, registered: false};
        }

        // 目录 / nonce 层面的失败：无法继续判断 EAB
        if (type !== "accountDoesNotExist" && type !== "unauthorized" && type !== "malformed") {
            checks.push({name: "ACME 目录", ok: false, detail: pickAcmeError(e)});
            return {checks, fatal: true, registered: false};
        }

        checks.push({name: "ACME 目录", ok: true, detail: "目录可达，newNonce 正常"});

        if (type === "unauthorized" || type === "malformed") {
            // 凭据确实被 CA 校验并拒绝
            checks.push({name: "EAB 校验", ok: false, detail: pickAcmeError(e)});
            return {checks, fatal: true, registered: false};
        }

        // accountDoesNotExist：账户尚未注册
        if (meta.suffixes) {
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

    // 深度校验：注册账户（可选）
    if (deep && !accountExists) {
        try {
            await client.createAccount({
                termsOfServiceAgreed: true,
                contact: contact ? [`mailto:${contact}`] : [],
            });
            checks.push({name: "注册账户", ok: true, detail: "注册成功"});
            accountExists = true;
            return {checks, fatal: false, registered: true};
        } catch (e: any) {
            checks.push({name: "注册账户", ok: false, detail: pickAcmeError(e)});
            return {checks, fatal: true, registered: false};
        }
    }

    return {checks, fatal: false, registered: false};
}

/**
 * 校验某家 CA 的账户凭据。
 *
 * @param deep 是否注册账户以完整校验 EAB（默认 false，只读）。
 *             注册账户不消耗证书签发配额，但会消耗 GTS 的一次性 EAB。
 * @param type 订单的加密算法；SSL.com 按 rsa / ecc 拆分配置，需据此选择端点。
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
    try {
        const c: any = new acme.Client({directoryUrl: meta.url, accountKey: keyPem});
        // getJwk 为纯本地解析，不发起网络请求
        const jwk: any = c.http.getJwk();
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

    // 4) 只读探针 + 可选深度注册 -----------------------------------
    // SSL.com：rsa 与 ecc 是两套独立配置，逐个探测。
    // 订单用哪个算法，就落在哪个后缀上 —— 只探测其中一个会给出误导性结论。
    const suffixes = meta.suffixes
        ? (opts.type ? [sslcomSuffixOf(opts.type)] : meta.suffixes)
        : [""];

    let fatal = false;
    let registeredAny = false;
    const wrongConfigAt: string[] = [];

    for (const suffix of suffixes) {
        const dirUrl = meta.url + suffix;
        const label = suffix ? `（${suffix.toUpperCase()}）` : "";
        const r = await probeEndpoint(meta, dirUrl, keyPem, kid, hmacKey, !!opts.deep, opts.contact);
        for (const c of r.checks) {
            // 多端点时给检查项加上端点标识，避免两组结果混在一起看不出属于谁
            checks.push(suffix ? {...c, name: `${c.name}${label}`} : c);
        }
        if (r.registered) registeredAny = true;
        if (r.fatal) { fatal = true; break; }
        if (r.checks.some((c) => c.name === "账户归属" && !c.ok)) wrongConfigAt.push(suffix);
    }

    if (fatal) {
        const bad = checks.find((c) => !c.ok);
        return {ok: false, texts: `${meta.label} 配置存在问题`, checks: bad ? checks : checks};
    }

    const ok = checks.every((x) => x.ok);
    const warned = checks.some((x) => x.warn);
    const conflict = wrongConfigAt.length > 0;

    let texts: string;
    if (!ok) {
        texts = conflict
            ? `${meta.label} 的账户已注册在另一个配置下，需换用对应算法或另配账户私钥`
            : `${meta.label} 配置存在问题`;
    } else if (warned) {
        texts = `${meta.label} 基本配置可用（EAB 未完全校验）`;
    } else if (registeredAny) {
        texts = `${meta.label} 配置可用，已注册账户`;
    } else {
        texts = `${meta.label} 配置可用`;
    }
    return {ok, texts, checks};
}
