/**
 * X.509 有效期解析
 * -------------------------------------------------------------------------
 * 用于记录证书真实的到期时间（notAfter），供到期提醒与自动续期使用。
 *
 * 实现取舍：
 *   - 不使用 forge.pki.certificateFromPem：它对 ECC 证书抛 "OID is not RSA"，
 *     而本项目默认签发 eccp256；
 *   - 使用 forge.asn1 做通用 DER 解析，按 RFC 5280 结构定位 validity，
 *     RSA 与 ECDSA 证书均可解析；
 *   - 解析失败返回 null，由调用方回退，不影响签发主流程。
 */

import forge from "node-forge";

const asn1 = forge.asn1;

/** ASN.1 Time（UTCTime / GeneralizedTime）→ 毫秒时间戳；无法解析返回 null */
function timeToMs(node: any): number | null {
    if (!node) return null;
    const s = String(node.value ?? "").trim();
    // UTCTime: YYMMDDHHMMSSZ（RFC 5280 要求以 Z 结尾）
    const utc = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
    if (utc) {
        const yy = parseInt(utc[1], 10);
        // RFC 5280 4.1.2.5.1：50-99 表示 19xx，00-49 表示 20xx
        const year = yy >= 50 ? 1900 + yy : 2000 + yy;
        return Date.UTC(year, +utc[2] - 1, +utc[3], +utc[4], +utc[5], +utc[6]);
    }
    // GeneralizedTime: YYYYMMDDHHMMSSZ
    const gen = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
    if (gen) {
        return Date.UTC(+gen[1], +gen[2] - 1, +gen[3], +gen[4], +gen[5], +gen[6]);
    }
    return null;
}

/** 取 PEM 中第一张证书的 DER（binary string）；失败返回 null */
function firstCertDer(pem: string): string | null {
    const m = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(pem ?? "");
    if (!m) return null;
    try {
        return forge.util.decode64(m[1].replace(/[\s\r\n]/g, ""));
    } catch {
        return null;
    }
}

/**
 * 解析证书链中**叶子证书**的有效期。
 * @param pem 任意包含 CERTIFICATE 块的 PEM（通常为 fullchain）
 * @returns {notBefore, notAfter} 毫秒时间戳；解析失败返回 null
 */
export function parseCertValidity(pem: string): { notBefore: number; notAfter: number } | null {
    const der = firstCertDer(pem);
    if (!der) return null;

    let cert: any;
    try {
        cert = asn1.fromDer(der);
    } catch {
        return null;
    }

    // Certificate ::= SEQUENCE { tbsCertificate, signatureAlgorithm, signatureValue }
    const tbs = cert?.value?.[0];
    const kids = tbs?.value;
    if (!Array.isArray(kids)) return null;

    // TBSCertificate ::= SEQUENCE {
    //   version [0] EXPLICIT OPTIONAL, serialNumber, signature, issuer, validity, ... }
    // 有 version 时下标整体后移一位；validity 恒为第 4 个字段。
    let i = 0;
    if (kids[0]?.tagClass === asn1.Class.CONTEXT_SPECIFIC && kids[0]?.type === 0) i = 1;
    const validity = kids[i + 3];
    const times = validity?.value;
    if (!Array.isArray(times) || times.length < 2) return null;

    const notBefore = timeToMs(times[0]);
    const notAfter = timeToMs(times[1]);
    if (notBefore === null || notAfter === null) return null;
    return {notBefore, notAfter};
}
