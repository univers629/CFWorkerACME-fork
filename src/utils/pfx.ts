/**
 * PFX / PKCS#12 生成工具
 * -------------------------------------------------------------------------
 * 基于 node-forge 纯 JS 实现，可在 Cloudflare Worker 运行。
 *
 * 输入：PEM 格式的私钥（RSA 或 ECC）与证书链（fullchain.pem）
 * 输出：PKCS#12 二进制 buffer（Uint8Array）
 *
 * 说明：
 *   forge 的 `pki.privateKeyFromPem`、`pki.certificateFromPem` 与 `pkcs12.toPkcs12Asn1`
 *   对 RSA 友好但对 ECC（ecPublicKey）私钥/证书不支持（certificateFromAsn1 会抛
 *   "OID is not RSA"）。本实现完全绕过 forge 的 RSA-only 封装：
 *     1. 将 PEM 私钥统一规整为 PKCS#8 PrivateKeyInfo 的 ASN.1 对象；
 *     2. 证书链只做 PEM → DER 的 base64 解码，不结构化解析；
 *     3. 在自实现的 toPkcs12Asn1 流程中，直接把 PrivateKeyInfo/证书 DER 作为对应 bag 的内容；
 *   这样 RSA / P-256 / P-384 均可正确生成 PFX。
 */

import forge from "node-forge";

const asn1 = forge.asn1;
const pki = forge.pki;
const oids = forge.pki.oids;

/** 命名曲线 OID 表（仅列出常用） */
const NAMED_CURVE_OIDS: Record<string, string> = {
    "P-256": "1.2.840.10045.3.1.7",      // prime256v1 / secp256r1
    "P-384": "1.3.132.0.34",              // secp384r1
    "P-521": "1.3.132.0.35",              // secp521r1
};

/** ecPublicKey 算法 OID */
const EC_PUBLIC_KEY_OID = "1.2.840.10045.2.1";

/**
 * 将 fullchain PEM 拆分为 leaf（叶子证书） 与 chain（中间证书）。
 */
export function splitCertChain(fullchainPem: string): { leaf: string; chain: string } {
    const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    const certs = fullchainPem.match(re) ?? [];
    if (certs.length === 0) return {leaf: "", chain: ""};
    const leaf = certs[0] + "\n";
    const chain = certs.slice(1).join("\n") + (certs.length > 1 ? "\n" : "");
    return {leaf, chain};
}

/**
 * 从 PEM 中提取指定类型块的 DER 字节（binary string）。
 * 返回值同时包含 PEM 的 type（"PRIVATE KEY" / "RSA PRIVATE KEY" / "EC PRIVATE KEY"）。
 */
function decodeFirstPem(pemStr: string): { type: string; bytes: string } {
    const msg = forge.pem.decode(pemStr)[0];
    if (!msg) throw new Error("私钥 PEM 为空或格式非法");
    return {type: msg.type, bytes: msg.body};
}

/**
 * 将 SEC1 EC 私钥（`-----BEGIN EC PRIVATE KEY-----`）转换为 PKCS#8 PrivateKeyInfo ASN.1。
 * SEC1 结构： ECPrivateKey ::= SEQUENCE { version INT, privateKey OCTET STRING,
 *                                         parameters [0] EXPLICIT ECParameters OPTIONAL,
 *                                         publicKey  [1] EXPLICIT BIT STRING OPTIONAL }
 * 需要把其中的 parameters（namedCurve OID）提取到 PKCS#8 的 AlgorithmIdentifier 参数位。
 */
function sec1ToPkcs8Asn1(sec1Der: string): any {
    const sec1 = asn1.fromDer(sec1Der);
    // sec1.value: [version, privateKey, [0] parameters?, [1] publicKey?]
    let curveOidDer: string | null = null;
    for (const child of (sec1 as any).value as any[]) {
        // 寻找 [0] EXPLICIT ECParameters（tagClass = CONTEXT_SPECIFIC, type = 0）
        if (child.tagClass === asn1.Class.CONTEXT_SPECIFIC && child.type === 0) {
            // 其 value[0] 应是 OID（namedCurve）
            const inner = Array.isArray(child.value) ? child.value[0] : null;
            if (inner && inner.type === asn1.Type.OID) {
                curveOidDer = inner.value as string;
            }
            break;
        }
    }
    if (!curveOidDer) {
        throw new Error("EC 私钥缺少 namedCurve 参数，无法转换为 PKCS#8");
    }

    // PKCS#8 PrivateKeyInfo ::= SEQUENCE {
    //   version INTEGER (0),
    //   privateKeyAlgorithm AlgorithmIdentifier,   -- { ecPublicKey, namedCurve }
    //   privateKey OCTET STRING                    -- DER 编码的 ECPrivateKey (SEC1)
    // }
    return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false,
            asn1.integerToDer(0).getBytes()),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                asn1.oidToDer(EC_PUBLIC_KEY_OID).getBytes()),
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, curveOidDer),
        ]),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, sec1Der),
    ]);
}

/**
 * 将任意 PEM 私钥统一转换为 forge 的 PKCS#8 PrivateKeyInfo ASN.1 对象。
 * 支持：
 *   - PKCS#8:  `-----BEGIN PRIVATE KEY-----`（RSA / EC 通用，acme-client 默认输出）
 *   - PKCS#1:  `-----BEGIN RSA PRIVATE KEY-----`
 *   - SEC1:    `-----BEGIN EC PRIVATE KEY-----`
 */
function privateKeyPemToPkcs8Asn1(privateKeyPem: string): any {
    const {type, bytes} = decodeFirstPem(privateKeyPem);
    if (type === "PRIVATE KEY") {
        // 已是 PKCS#8，直接返回对应 ASN.1
        return asn1.fromDer(bytes);
    }
    if (type === "RSA PRIVATE KEY") {
        // PKCS#1 RSAPrivateKey → 套 PKCS#8 外壳
        const rsaAsn1 = asn1.fromDer(bytes);
        return pki.wrapRsaPrivateKey(rsaAsn1);
    }
    if (type === "EC PRIVATE KEY") {
        return sec1ToPkcs8Asn1(bytes);
    }
    throw new Error(`不支持的私钥 PEM 类型: ${type}`);
}

/**
 * 自实现的 toPkcs12Asn1：
 * 功能与 forge.pkcs12.toPkcs12Asn1 等价，但：
 *   - key 参数为 PKCS#8 PrivateKeyInfo 的 ASN.1 对象（而非 forge 的 RSA key 结构）；
 *   - certs 参数为证书 DER 字节串数组（binary string），不要求 forge 能解析其公钥 OID。
 * 这样 RSA / ECC 通吃。
 */
function toPkcs12Asn1FromPkcs8(
    pkAsn1: any,
    certs: string[],
    password: string,
    options: {
        algorithm?: string;
        count?: number;
        saltSize?: number;
        useMac?: boolean;
        friendlyName?: string;
        generateLocalKeyId?: boolean;
    },
): any {
    const opts = {
        saltSize: options.saltSize ?? 8,
        count: options.count ?? 2048,
        algorithm: options.algorithm ?? "aes256",
        useMac: options.useMac ?? true,
        friendlyName: options.friendlyName,
        generateLocalKeyId: options.generateLocalKeyId ?? true,
    };

    // ---- localKeyId：SHA-1(叶子证书 DER) ----
    let localKeyId: string | null = null;
    if (opts.generateLocalKeyId && certs.length > 0) {
        const sha1 = forge.md.sha1.create();
        sha1.update(certs[0]);
        localKeyId = sha1.digest().getBytes();
    }

    // ---- bagAttributes：localKeyId + friendlyName ----
    const attrs: any[] = [];
    if (localKeyId !== null) {
        attrs.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                asn1.oidToDer(oids.localKeyId).getBytes()),
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, localKeyId),
            ]),
        ]));
    }
    if (opts.friendlyName) {
        attrs.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                asn1.oidToDer(oids.friendlyName).getBytes()),
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, [
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.BMPSTRING, false, opts.friendlyName),
            ]),
        ]));
    }
    const bagAttrs = attrs.length > 0
        ? asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SET, true, attrs)
        : undefined;

    const contents: any[] = [];

    // ---- certBag（证书链） ----
    // 直接使用证书 DER 字节串作为 x509Certificate 的 OCTET STRING 内容，
    // 不再让 forge 尝试解析 X.509 结构（它对 ECC 证书会抛 "OID is not RSA"）。
    const certSafeBags = certs.map((certDer, i) => {
        // bagAttributes 只挂在第一张（叶子）证书上；其余证书不挂。
        // 这里用 push 而不是在数组里塞 undefined：ASN.1 子节点必须是真实对象。
        const children: any[] = [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                asn1.oidToDer(oids.certBag).getBytes()),
            asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
                    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                        asn1.oidToDer(oids.x509Certificate).getBytes()),
                    asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
                        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false,
                            certDer),
                    ]),
                ]),
            ]),
        ];
        if (i === 0 && bagAttrs) children.push(bagAttrs);
        return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, children);
    });

    if (certSafeBags.length > 0) {
        const certSafeContents = asn1.create(
            asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, certSafeBags);
        const certCI = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                asn1.oidToDer(oids.data).getBytes()),
            asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false,
                    asn1.toDer(certSafeContents).getBytes()),
            ]),
        ]);
        contents.push(certCI);
    }

    // ---- keyBag（PKCS#8 加密私钥） ----
    let keyBag: any;
    if (password === null || password === undefined) {
        // 未加密
        const children: any[] = [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                asn1.oidToDer(oids.keyBag).getBytes()),
            asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [pkAsn1]),
        ];
        if (bagAttrs) children.push(bagAttrs);
        keyBag = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, children);
    } else {
        // PKCS#8 加密（pkcs8ShroudedKeyBag）
        const encPkInfo = pki.encryptPrivateKeyInfo(pkAsn1, password, {
            algorithm: opts.algorithm,
            count: opts.count,
            saltSize: opts.saltSize,
        } as any);
        const children: any[] = [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                asn1.oidToDer(oids.pkcs8ShroudedKeyBag).getBytes()),
            asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [encPkInfo]),
        ];
        if (bagAttrs) children.push(bagAttrs);
        keyBag = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, children);
    }

    const keySafeContents = asn1.create(
        asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [keyBag]);
    const keyCI = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
            asn1.oidToDer(oids.data).getBytes()),
        asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false,
                asn1.toDer(keySafeContents).getBytes()),
        ]),
    ]);
    contents.push(keyCI);

    // ---- AuthenticatedSafe ----
    const safe = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, contents);

    // ---- MacData（HMAC-SHA1 完整性校验） ----
    let macData: any;
    if (opts.useMac) {
        const sha1 = forge.md.sha1.create();
        // node-forge 的类型声明里 util.ByteBuffer 没被导出（运行时存在），这里显式收窄。
        const macSalt = new (forge.util as any).ByteBuffer(forge.random.getBytes(opts.saltSize));
        const count = opts.count;
        const macKey = (forge.pkcs12 as any).generateKey(password, macSalt, 3, count, 20);
        const mac = forge.hmac.create();
        mac.start(sha1, macKey);
        mac.update(asn1.toDer(safe).getBytes());
        const macValue = mac.getMac();
        macData = asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
                    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                        asn1.oidToDer(oids.sha1).getBytes()),
                    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""),
                ]),
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false,
                    macValue.getBytes()),
            ]),
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false,
                macSalt.getBytes()),
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false,
                asn1.integerToDer(count).getBytes()),
        ]);
    }

    // ---- PFX 外层结构 ----
    return asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.INTEGER, false,
            asn1.integerToDer(3).getBytes()),
        asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
            asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
                asn1.oidToDer(oids.data).getBytes()),
            asn1.create(asn1.Class.CONTEXT_SPECIFIC, 0, true, [
                asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false,
                    asn1.toDer(safe).getBytes()),
            ]),
        ]),
        macData,
    ]);
}

/**
 * PEM → PFX（PKCS#12 二进制）
 * @param privateKeyPem PEM 格式私钥（RSA / ECC 均可）
 * @param fullchainPem  PEM 格式证书链（叶子 + 中间）
 * @param password      PFX 密码
 * @param friendlyName  友好名（通常为主域名）
 */
export async function pemToPfxBuffer(
    privateKeyPem: string,
    fullchainPem: string,
    password: string,
    friendlyName: string,
): Promise<Uint8Array> {
    // ---- 解析私钥为 PKCS#8 PrivateKeyInfo ASN.1 ----
    let pkAsn1: any;
    try {
        pkAsn1 = privateKeyPemToPkcs8Asn1(privateKeyPem);
    } catch (e: any) {
        throw new Error(`无法解析私钥 PEM: ${e?.message ?? e}`);
    }

    // ---- 解析证书链（仅 PEM → DER，不结构化解析，避免 forge RSA-only 校验） ----
    const re = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    const pemBlocks = fullchainPem.match(re) ?? [];
    if (pemBlocks.length === 0) throw new Error("证书链为空");
    const certDers: string[] = [];
    for (const pemBlock of pemBlocks) {
        try {
            const {bytes} = decodeFirstPem(pemBlock);
            certDers.push(bytes);
        } catch {
            /* 跳过无法 base64 解码的异常块 */
        }
    }
    if (certDers.length === 0) throw new Error("证书链解析后为空");

    // ---- 创建 PKCS#12 ----
    // 使用 AES-256 作为私钥加密算法：
    //   - Windows 10+ / macOS / OpenSSL 3.x 均默认支持；
    //   - OpenSSL 1.1.x 需要 -legacy 或明确启用 aes，但兼容性已足够；
    //   - 比 3DES 更安全，密钥导出更快。
    const p12Asn1 = toPkcs12Asn1FromPkcs8(
        pkAsn1,
        certDers,
        password,
        {
            friendlyName,
            algorithm: "aes256",
        },
    );

    const derBytes = asn1.toDer(p12Asn1).getBytes();
    // forge 的 getBytes() 返回 binary string，这里转为 Uint8Array
    const out = new Uint8Array(derBytes.length);
    for (let i = 0; i < derBytes.length; i++) out[i] = derBytes.charCodeAt(i) & 0xff;
    return out;
}
