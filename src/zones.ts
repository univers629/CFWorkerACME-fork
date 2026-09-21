/**
 * Cloudflare Zone 解析
 * -------------------------------------------------------------------------
 * DCV_ZONES 旧语义是单个 Zone ID，直接拼进 `/zones/${zones}/dns_records`，
 * 多根域无法同时托管，且必须手工抄写 32 位 ID。
 *
 * 本模块提供：
 *   - listZones()：用 DNS Token 调 GET /zones 列出账号下所有 Zone；
 *   - resolveZone()：按域名最长后缀匹配所属 Zone，兼容子域单独托管；
 *   - 结果按凭据缓存在 Worker 实例内，避免每次验证都请求一次 API。
 *
 * 兼容：DCV_ZONES 仍支持，语义放宽为「分隔符分隔的 Zone ID 列表」，
 * 作为显式候选集；未配置或匹配不到时回退到 GET /zones。
 */

import type {Bindings} from "./index";
import {readConf} from "./db/conf";

/** Zone 精简信息 */
export interface ZoneInfo {
    id: string;
    name: string;
}

/** 缓存 TTL：Zone 列表变化不频繁，10 分钟足够 */
const ZONE_CACHE_TTL_MS = 10 * 60 * 1000;

interface ZoneCacheEntry {
    zones: ZoneInfo[];
    expireAt: number;
}

const _zoneCache = new Map<string, ZoneCacheEntry>();

/** 清空缓存（配置变更后调用） */
export function invalidateZoneCache(): void {
    _zoneCache.clear();
}

/** 构造 Cloudflare 鉴权头（与 agent.ts 保持一致的判定规则） */
function cfAuthHeaders(email: string, token: string): Record<string, string> {
    const isGlobalKey = /^[0-9a-fA-F]{37}$/.test(token);
    if (email && isGlobalKey) {
        return {"X-Auth-Email": email, "X-Auth-Key": token};
    }
    return {"Authorization": `Bearer ${token}`};
}

/** 读取 DCV 凭据 */
async function dcvCreds(env: Bindings): Promise<{zones: string; email: string; token: string}> {
    const [zones, email, token] = await Promise.all([
        readConf(env as any, "DCV_ZONES"),
        readConf(env as any, "DCV_EMAIL"),
        readConf(env as any, "DCV_TOKEN"),
    ]);
    return {zones: zones ?? "", email: email ?? "", token: token ?? ""};
}

/** 解析 DCV_ZONES：支持逗号 / 分号 / 空格分隔的多个 Zone ID */
export function parseZoneIds(raw: string): string[] {
    return String(raw ?? "")
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
}

/**
 * 列出账号下所有 Zone（分页拉全）。
 * 失败（无权限 / 网络错误）时返回空数组，由调用方回退。
 */
export async function listZones(env: Bindings): Promise<ZoneInfo[]> {
    const {email, token} = await dcvCreds(env);
    if (!token) return [];

    const cacheKey = `${email}|${token.slice(0, 8)}`;
    const cached = _zoneCache.get(cacheKey);
    if (cached && cached.expireAt > Date.now()) return cached.zones;

    const all: ZoneInfo[] = [];
    // Cloudflare /zones 默认每页 20，最多 50；这里显式要 50 并翻页
    for (let page = 1; page <= 20; page++) {
        let body: any;
        try {
            const res = await fetch(
                `https://api.cloudflare.com/client/v4/zones?per_page=50&page=${page}`,
                {headers: cfAuthHeaders(email, token)}
            );
            body = await res.json();
        } catch (e) {
            console.error("[zones] 请求 /zones 失败", e);
            break;
        }
        if (!body?.success) {
            console.warn(
                "[zones] 无法列出 Zone（Token 可能缺少 Zone:Read 权限）：",
                JSON.stringify(body?.errors ?? body)
            );
            break;
        }
        const batch: any[] = Array.isArray(body.result) ? body.result : [];
        for (const z of batch) {
            if (z?.id && z?.name) all.push({id: String(z.id), name: String(z.name)});
        }
        const info = body.result_info ?? {};
        const totalPages = Number(info.total_pages ?? 1);
        if (!batch.length || page >= totalPages) break;
    }

    // 只缓存成功的结果，避免把一次权限错误缓存 10 分钟
    if (all.length > 0) {
        _zoneCache.set(cacheKey, {zones: all, expireAt: Date.now() + ZONE_CACHE_TTL_MS});
    }
    return all;
}

/** 去掉开头的通配符与结尾的点，便于匹配 */
function normalizeDomain(domain: string): string {
    return String(domain ?? "").trim().toLowerCase().replace(/^\*\./, "").replace(/\.$/, "");
}

/**
 * 判断 domain 是否属于 zone：相等，或以 `.zone` 结尾。
 * 用后缀匹配而不是 `endsWith` 裸判，避免 `notexample.com` 命中 `example.com`。
 */
function belongsTo(domain: string, zoneName: string): boolean {
    return domain === zoneName || domain.endsWith("." + zoneName);
}

/**
 * 解析域名所属的 Zone。
 * 匹配优先级：
 *   1. 显式配置的 DCV_ZONES（若其中某个 Zone 名匹配）—— 精确可控；
 *   2. GET /zones 拉到的列表里**最长后缀匹配** —— 兼容子域单独托管。
 * @returns 匹配到的 Zone；无法确定时返回 null
 */
export async function resolveZone(
    env: Bindings,
    domain: string
): Promise<ZoneInfo | null> {
    const target = normalizeDomain(domain);
    if (!target) return null;

    const {zones, email, token} = await dcvCreds(env);
    const explicitIds = parseZoneIds(zones);

    // 先取全部 Zone（含显式 ID 对应的名称，用于匹配判断）
    let candidates: ZoneInfo[] = await listZones(env);

    // 显式配置的 Zone ID 不在列表里（例如 Token 无 Zone:Read 权限）时，
    // 通过逐个查询 Zone 详情补全，保证老配置仍可用。
    if (explicitIds.length > 0 && token) {
        const known = new Set(candidates.map((z) => z.id));
        for (const id of explicitIds) {
            if (known.has(id)) continue;
            try {
                const res = await fetch(
                    `https://api.cloudflare.com/client/v4/zones/${id}`,
                    {headers: cfAuthHeaders(email, token)}
                );
                const body: any = await res.json();
                if (body?.success && body.result?.id && body.result?.name) {
                    candidates.push({id: String(body.result.id), name: String(body.result.name)});
                }
            } catch (e) {
                console.error(`[zones] 查询 Zone ${id} 失败`, e);
            }
        }
    }

    // 最长后缀优先：a.b.example.com 应命中 b.example.com 而不是 example.com
    let best: ZoneInfo | null = null;
    for (const z of candidates) {
        if (!belongsTo(target, z.name)) continue;
        if (!best || z.name.length > best.name.length) best = z;
    }
    return best;
}

/**
 * 取域名的根域（Zone 名）。解析不到时回退为「去掉最左一段」的朴素推断。
 * 仅用于生成 CNAME 目标等展示场景。
 */
export async function resolveZoneName(env: Bindings, domain: string): Promise<string> {
    const z = await resolveZone(env, domain);
    if (z) return z.name;
    const parts = normalizeDomain(domain).split(".");
    return parts.length > 2 ? parts.slice(1).join(".") : normalizeDomain(domain);
}
