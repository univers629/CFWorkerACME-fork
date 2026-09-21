/**
 * 管理员吊销证书时复用的 ACME 客户端初始化。
 * 仅暴露 getAcmeClient(env, user, order) 以避免循环依赖。
 *
 * CA 账户凭据（GTS_* / SSL_* / ZRO_*）遵循 Confs → env → 默认值 的三级回退，
 * 便于管理员在系统管理页面直接覆盖而无需重新发布 Worker。
 */
import * as acme from "acme-client";
import type {Bindings} from "../index";
import type {ApplyRow, UserRow} from "../db/dao";
import {readConf} from "../db/conf";

const ACME_URL: Record<string, any> = {
    "lets-encrypt": acme.directory.letsencrypt.production,
    "google-trust": acme.directory.google.production,
    "bypass-trust": acme.directory.buypass.production,
    "zeroca-trust": acme.directory.zerossl.production,
    "sslcom-trust": "https://acme.ssl.com/sslcom-dv-",
};

/** 与 certs.ts 中 getStart() 等价，独立于证书状态机模块 */
export async function getAcmeClient(
    env: Bindings,
    user: UserRow,
    order: ApplyRow,
): Promise<acme.Client> {
    const sign = String(order.sign ?? "lets-encrypt");
    let url = ACME_URL[sign];

    // 从 Confs 读取三家 CA 的账户凭据（回退 env / 默认值）
    const [GTS_KeyTS, GTS_keyID, GTS_keyMC,
        SSL_KeyTS, SSL_keyID, SSL_keyMC,
        ZRO_KeyTS, ZRO_keyID, ZRO_keyMC] = await Promise.all([
        readConf(env as any, "GTS_KeyTS"),
        readConf(env as any, "GTS_keyID"),
        readConf(env as any, "GTS_keyMC"),
        readConf(env as any, "SSL_KeyTS"),
        readConf(env as any, "SSL_keyID"),
        readConf(env as any, "SSL_keyMC"),
        readConf(env as any, "ZRO_KeyTS"),
        readConf(env as any, "ZRO_keyID"),
        readConf(env as any, "ZRO_keyMC"),
    ]);

    const keysMap: Record<string, any> = {
        "lets-encrypt": user.keys,
        "google-trust": GTS_KeyTS,
        "bypass-trust": user.keys,
        "zeroca-trust": ZRO_KeyTS,
        "sslcom-trust": SSL_KeyTS,
    };
    const eabMap: Record<string, any> = {
        "lets-encrypt": undefined,
        "google-trust": {kid: GTS_keyID, hmacKey: GTS_keyMC},
        "bypass-trust": undefined,
        "zeroca-trust": {kid: ZRO_keyID, hmacKey: ZRO_keyMC},
        "sslcom-trust": {kid: SSL_keyID, hmacKey: SSL_keyMC},
    };
    if (sign === "sslcom-trust" && typeof order.type === "string") {
        url += (order.type as string).substring(0, 3);
    }
    const client = new acme.Client({
        directoryUrl: url,
        accountKey: keysMap[sign] ?? "",
        externalAccountBinding: eabMap[sign],
    });
    try {
        client.getAccountUrl();
    } catch {
        await client.createAccount({
            termsOfServiceAgreed: true,
            contact: ["mailto:" + user.mail],
        });
    }
    return client;
}
