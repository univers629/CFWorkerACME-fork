import * as acme from 'acme-client';
import {Client} from "acme-client";
import * as index from './index'
import * as agent from "./agent";
import * as query from "./query";
import {Bindings} from './index'
import {hmacSHA2} from "./users";
import {notify, type BackgroundContext} from "./notify";
// 注意：这里曾经有一行 `import {errors} from "wrangler";`（实际从未使用）。
// 它会让 esbuild 在打包 Worker 时去解析 wrangler 这个 10MB+ 的开发期 CLI 包，
// 一旦安装时跳过了 devDependencies（npm ci --omit=dev），打包就会直接失败。
// 已删除，不要加回来。
import {readConf} from "./db/conf";
import {ensureDao} from "./db";
import {parseCertValidity} from "./utils/certinfo";


const acme_url_map: Record<string, any> = {
    "lets-encrypt": acme.directory.letsencrypt.production,
    // "lets-encrypt": "https://encrys.524228.xyz/directory",
    "google-trust": acme.directory.google.production,
    "bypass-trust": acme.directory.buypass.production,
    "zeroca-trust": acme.directory.zerossl.production,
    "sslcom-trust": "https://acme.ssl.com/sslcom-dv-",
}

/** 等待若干毫秒（用于签发后的短轮询） */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 订单处理互斥表。
 * -------------------------------------------------------------------------
 * cron 的 Processing() 与手动「立即处理」都可能推进同一订单，并发进入会
 * 重复生成私钥、重复提交 CSR。这里用模块级 Map 做同实例内的互斥。
 *
 * 必须带过期时间（租约）而不是单纯 Set：
 * 后台任务跑在 waitUntil 里，而 Cloudflare 只给响应后 30 秒 —— 一次 ACME
 * 交互（directory + nonce + createOrder + 写 DNS）很容易超出该窗口，
 * isolate 被掐断时 finally 不会执行。若锁没有租约，它会永久留在内存中，
 * 导致之后「立即处理」和 cron 都被判为「正在处理」而直接跳过，
 * 订单就永久卡在当前状态且没有任何提示。
 *
 * 租约到期后允许再次占用。ACME 侧对重复操作本身是幂等的
 * （同一订单只接受一次 finalize），因此偶尔的重复推进是可接受的代价，
 * 远优于永久卡死。
 */
const _processing = new Map<string, number>();

/** 单次处理的最长占用时间；超过即视为上一次已被中断 */
export const PROCESS_LEASE_MS = 120000;

/**
 * 尝试占用订单。
 * @param now 当前时间戳（可注入，便于测试租约过期）
 * @returns 释放函数；订单仍被未过期的租约占用时返回 null
 */
export function acquireOrder(uuid: string, now: number = Date.now()): (() => void) | null {
    const held = _processing.get(uuid);
    if (held !== undefined && now - held < PROCESS_LEASE_MS) return null;
    if (held !== undefined) {
        console.warn(`[certs] 订单 ${uuid} 的处理租约已过期（${now - held}ms），允许重新占用`);
    }
    _processing.set(uuid, now);
    // 只有仍持有本次租约时才删除，避免把后来者的租约误删
    return () => {
        if (_processing.get(uuid) === now) _processing.delete(uuid);
    };
}

/**
 * 判断 ACME 订单是否已过期。
 * ACME 的 expires 为 RFC 3339 字符串；缺失或无法解析时视为未过期，
 * 避免因字段异常把正常订单误判为失败。
 */
function isOrderExpired(orders_data: any): boolean {
    const raw = orders_data?.expires;
    if (!raw) return false;
    const ts = new Date(String(raw)).getTime();
    if (!Number.isFinite(ts)) return false;
    return Date.now() > ts;
}

/**
 * 合并多域名场景下的订单状态，按严重程度取「最差」的那个。
 * -------------------------------------------------------------------------
 * 一张订单可含多个域名，每个域名各自给出状态。若直接逐个赋值，后面的
 * 「已通过(4)」会覆盖前面的「本地未通过(2)」，订单就会带着未验证的域名
 * 继续走到签发阶段。
 *
 * 优先级：-1（失败）> 2（本地未通过，需用户处理）> 3（校验中）> 4（已通过）
 *
 * @param cur 当前累计状态
 * @param next 新域名给出的状态
 */
export function mergeStatusFlag(cur: number, next: number): number {
    const rank = (f: number): number => {
        if (f === -1) return 0;
        if (f === 2) return 1;
        if (f === 3) return 2;
        if (f === 4) return 3;
        return 4; // 未知状态视为最轻，不掩盖已知问题
    };
    return rank(next) < rank(cur) ? next : cur;
}

// challenge 校验结果判定 ==========================================================================
/**
 * 把 ACME challenge 的状态映射为域名与订单的状态。
 * -------------------------------------------------------------------------
 * 独立成纯函数的原因：这段判定曾因漏掉 processing 状态而让订单永久停在
 * 「申请中」并写下「域名验证通过」的错误文案，需要能被单元测试直接覆盖。
 *
 * 设计约束（重要）：调用方跑在 waitUntil 里，只有响应后 30 秒，
 * 因此这里**只做状态映射、绝不等待**。每个状态都必须在一次调用内
 * 产生明确的下一步，否则订单会卡住：
 *   - invalid    → 失败终态
 *   - valid      → 该域名完成
 *   - pending    → 本轮提交校验，下轮再查
 *   - processing → CA 校验中，下轮再查
 *
 * @param chStatus ACME challenge 的 status 字段
 * @returns domainFlag 域名状态；statusFlag 订单状态；submit 是否需提交校验
 */
export function challengeOutcome(chStatus: string): {
    domainFlag: number;
    statusFlag: number;
    submit: boolean;
} {
    const s = String(chStatus ?? "").toLowerCase();
    if (s === "invalid") return {domainFlag: -1, statusFlag: -1, submit: false};
    if (s === "valid") return {domainFlag: 4, statusFlag: 4, submit: false};
    if (s === "pending") return {domainFlag: 3, statusFlag: 3, submit: true};
    // processing 及其它中间态：CA 正在校验，等下一轮
    return {domainFlag: 3, statusFlag: 3, submit: false};
}

/** challenge 停在 processing 超过该时长后，主动重新 POST 一次催 CA 重查 */
export const CHALLENGE_RESUBMIT_MS = 10 * 60 * 1000;

/**
 * 判断处于 processing 的 challenge 是否应重新提交。
 * -------------------------------------------------------------------------
 * RFC 8555 §8.2：服务端首次校验失败后按自己的退避计划重试，期间状态一直
 * 是 processing，只有彻底放弃才转 invalid。**客户端可以重新 POST 一次
 * challenge 来请求立即重试**，这正是 DNS 改好后该做的事。
 *
 * ZeroSSL（Sectigo）的退避可以很长 —— cert-manager #5690 记录其 Retry-After
 * 可达 86400 秒。用户改完 DNS 后如果只是干等，订单会卡很久且毫无进展：
 * 此前 processing 分支什么都不做，点多少次「立即处理」都只是把同一句
 * 「CA 校验中」再写一遍。
 *
 * 判据用「本轮与上次提交的时间差」而不是固定轮次，避免 cron 频率变化后失效。
 *
 * @param lastSubmitAt 上次提交（或首次进入 processing）的时间戳；0/未记录视为需要提交
 * @param now 当前时间戳
 * @returns true 表示应重新 POST 触发 CA 重查
 */
export function shouldResubmitChallenge(
    lastSubmitAt: number, now: number = Date.now()
): boolean {
    if (!Number.isFinite(lastSubmitAt) || lastSubmitAt <= 0) return true;
    return now - lastSubmitAt >= CHALLENGE_RESUBMIT_MS;
}

// challenge 诊断信息提取 ==========================================================================
/**
 * 从 ACME challenge 对象里抽出 CA 给出的失败原因。
 * -------------------------------------------------------------------------
 * RFC 8555 §7.1.6：challenge 带有 `error` 字段（Problem Details 文档），
 * CA 就是在这里说明「为什么校验没过」——例如 TXT 值不匹配、解析不到记录、
 * CAA 拒绝等。此前代码只读 `status`，把 CA 已经给出的原因整段丢掉了，
 * 用户看到的永远是「CA 校验中，稍后自动重试」，点多少次「立即处理」都
 * 查不出所以然，只能靠外部 DNS 探测反推。
 *
 * 独立成纯函数以便单元测试直接覆盖（真实故障里 CA 的措辞五花八门）。
 *
 * @param ch ACME challenge 对象
 * @returns 可读的原因文本；无可用信息时返回空串（调用方回退到默认文案）
 */
export function describeChallengeError(ch: any): string {
    if (!ch || typeof ch !== "object") return "";
    const err = ch['error'];
    if (!err) return "";
    // 少数 CA 直接把原因写成字符串
    if (typeof err === "string") return err.trim();
    if (typeof err !== "object") return String(err);

    const detail = String(err['detail'] ?? "").trim();
    const type = String(err['type'] ?? "").trim();
    const subs: any[] = Array.isArray(err['subproblems']) ? err['subproblems'] : [];
    const subText = subs
        .map((s) => {
            const id = s?.identifier?.value ? `[${s.identifier.value}] ` : "";
            return id + String(s?.detail ?? s?.type ?? "").trim();
        })
        .filter(Boolean)
        .join("; ");

    const core = [detail, subText].filter(Boolean).join(" | ");
    // ACME 的 type 是 urn:ietf:params:acme:error:xxx，保留末段更易读
    const shortType = type ? type.replace(/^urn:ietf:params:acme:error:/, "") : "";
    if (core && shortType) return `${core}（${shortType}）`;
    if (core) return core;
    if (shortType) return shortType;
    // 结构未知时兜底序列化，至少不要把信息丢掉
    try {
        const s = JSON.stringify(err);
        if (s && s !== "{}") return s;
    } catch { /* ignore */ }
    return "";
}

/**
 * 描述「CA 尚未确认通过」时的可观测状态，供订单 text 展示。
 * -------------------------------------------------------------------------
 * 只报 challenge 的 status 不足以区分两种截然不同的情形：
 *   - challenge=processing 且 authz=pending → CA 已受理，正在异步校验（正常等待）
 *   - challenge=processing 且 authz=invalid → 校验其实已失败，只是状态未同步
 * 因此把两者一起报出来，避免用户面对「稍后自动重试」却无从判断。
 *
 * @param chStatus challenge.status
 * @param authzStatus authorization.status
 */
export function describePendingReason(chStatus: string, authzStatus: string): string {
    const c = String(chStatus ?? "").trim() || "未知";
    const a = String(authzStatus ?? "").trim();
    return a
        ? `CA 校验中（challenge=${c}，授权=${a}），稍后自动重试`
        : `CA 校验中（challenge=${c}），稍后自动重试`;
}

// 错误分类 ========================================================================================
/**
 * 判断一个 ACME 错误是否为「临时故障」（重试可能成功）。
 * -------------------------------------------------------------------------
 * 真实故障：ZeroSSL 返回 502 Bad Gateway（newNonce 端点），
 * processOne 捕获后把订单直接置为 flag=-1「已失效」——用户点一次「立即处理」
 * 就把一个本来能签下来的订单判死了，只能删掉重建。这是不可接受的：
 * 网关抖动、限流、超时都不是「CA 拒绝了这个订单」。
 *
 * 判定原则：只有 CA **明确表态**（4xx 的 ACME 语义错误，或 challenge/order
 * 被标为 invalid）才算永久失败；其余（5xx、429、408、网络层异常、超时）
 * 一律视为临时，保留订单状态等下一轮 cron 重试。
 *
 * @param e 抛出的错误对象
 * @returns true 表示可重试（调用方不应把订单置为终态失败）
 */
export function isTransientAcmeError(e: any): boolean {
    if (!e) return false;
    // 1) HTTP 状态码：5xx 网关/服务端故障、429 限流、408 请求超时均可重试
    const status = Number(e?.response?.status ?? e?.config?.response?.status ?? e?.status ?? 0);
    if (status >= 500 && status <= 599) return true;
    if (status === 429 || status === 408) return true;

    // 2) 明确的 ACME 语义错误 → 永久失败（CA 已表态，重试也没用）
    const type = String(e?.response?.data?.type ?? e?.config?.response?.data?.type ?? "");
    if (type.startsWith("urn:ietf:params:acme:error:")) return false;

    // 3) 网络层 / 运行时异常：连接重置、DNS 失败、超时、Worker 主动中止
    const code = String(e?.cause?.code ?? e?.code ?? "");
    if (["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
         "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code)) return true;
    if (e?.name === "TimeoutError" || e?.name === "AbortError") return true;
    const msg = String(e?.message ?? "");
    if (/timeout|timed out|network|fetch failed|socket hang up|aborted/i.test(msg)) return true;
    // Cloudflare 网关错误码（如 `error code: 524`）
    if (/error code:\s*(52[0-9]|530)/i.test(msg)) return true;

    // 4) 无状态码、无 ACME 类型、无已知网络特征：保守视为永久失败，
    //    避免把真正的问题（如凭据错误）无限重试下去。
    return false;
}

// 错误消息提取 ====================================================================================
// 针对 acme-client / xior 抛出的错误对象，优先抽取 ACME Problem Details 中的友好信息，
// 方便写入订单 text 字段后展示给用户。
export function extractAcmeError(e: any): string {
    if (!e) return "未知错误";
    try {
        // xior / axios 风格：错误对象自带 response.data
        const resp = e.response ?? e?.config?.response;
        const data = resp?.data;
        // 附加的 HTTP / URL 上下文（便于排查）
        const status: any = resp?.status ?? e?.status;
        const statusText: string = resp?.statusText ?? e?.statusText ?? "";
        const url: string = e?.request?.url ?? e?.config?.url ?? resp?.url ?? "";
        const ctxParts: string[] = [];
        if (status) ctxParts.push(`HTTP ${status}${statusText ? " " + statusText : ""}`);
        if (url) ctxParts.push(url);
        const ctx = ctxParts.length ? ` [${ctxParts.join(" @ ")}]` : "";

        if (data) {
            // 1) RFC 8555 Problem Details: { type, detail, status, subproblems }
            if (typeof data === "object") {
                const detail = data.detail || data.Detail || "";
                const type = data.type || data.Type || "";
                const subs: any[] = Array.isArray(data.subproblems) ? data.subproblems : [];
                const subText = subs
                    .map((s) => {
                        const id = s?.identifier?.value ? `[${s.identifier.value}] ` : "";
                        return id + (s?.detail || s?.type || "");
                    })
                    .filter(Boolean)
                    .join("; ");
                const core = [detail, subText].filter(Boolean).join(" | ");
                if (core) return (type ? `${core} (${type})` : core) + ctx;
                if (type) return type + ctx;
                // 无 detail/type 时，把对象序列化做兜底
                try {
                    const jsonStr = JSON.stringify(data);
                    if (jsonStr && jsonStr !== "{}") return jsonStr + ctx;
                } catch { /* ignore */ }
            }
            // 2) 纯文本响应（典型：Cloudflare 网关返回的 `error code: 525` 等）
            if (typeof data === "string" && data.trim()) {
                const text = data.trim();
                // 识别 Cloudflare 错误码，给出更友好的中文提示
                const cfMatch = text.match(/error code:\s*(\d{3,4})/i);
                if (cfMatch) {
                    const code = cfMatch[1];
                    const cfHint: Record<string, string> = {
                        "520": "网关返回空响应",
                        "521": "源站拒绝连接",
                        "522": "源站连接超时",
                        "523": "源站不可达",
                        "524": "源站响应超时",
                        "525": "SSL 握手失败（源站 TLS 配置异常）",
                        "526": "源站 SSL 证书无效",
                        "527": "Railgun 连接中断",
                    };
                    const hint = cfHint[code] || "网关错误";
                    return `Cloudflare ${code} ${hint}：${text}${ctx}`;
                }
                return text + ctx;
            }
        }
        // 3) acme-client 的 HTTPError / 普通 Error
        if (e.message) return String(e.message) + ctx;
        // 4) 完全无结构：尽力序列化
        try {
            const s = JSON.stringify(e);
            if (s && s !== "{}") return s + ctx;
        } catch { /* ignore */ }
        return "未知错误" + ctx;
    } catch {
        return e?.message ? String(e.message) : String(e);
    }
}

// 整体处理进程 ====================================================================================

/**
 * 修复「已签发但私钥没落库」的订单。
 * -------------------------------------------------------------------------
 * 成因：getCerts 的 ready 阶段把新私钥写入 pending_keys，随后**同一轮内**
 * 轮询到 valid 并取回证书；但 valid 分支读的是函数入口时的内存快照
 * order_info['pending_keys']，不含刚写入的值，于是只写了 cert、没写 keys。
 * 订单因此显示「密钥：无」，且下载密钥 / ZIP / PFX、清空私钥、吊销等
 * 依赖 keys 的按钮全部不可用。
 *
 * 好消息是私钥并没丢：pending_keys 字段仍保留着它，这里把它搬回 keys。
 * 只处理 flag=5 且 keys 为空、pending_keys 非空的订单，不会覆盖已有私钥。
 *
 * @returns 修复的订单数量
 */
export async function healMissingKeys(env: Bindings): Promise<number> {
    const dao = await ensureDao(env as any);
    const signed: any = await dao.scanApplies({eq: {flag: 5}});
    let healed = 0;
    for (const id in signed) {
        const row = signed[id];
        const keys = row?.['keys'];
        const pending = row?.['pending_keys'];
        // 已有私钥的不动；没有待用私钥的无法修复（只能等下次续期重新生成）
        if (typeof keys === "string" && keys.length > 0) continue;
        if (typeof pending !== "string" || pending.length === 0) continue;
        try {
            // cert 与 keys 一次写入，避免出现只有其一的中间态
            await dao.updateApply(row['uuid'], {keys: pending, pending_keys: ""});
            healed += 1;
            console.log(`[certs] 订单 ${row['uuid']} 私钥已从 pending_keys 恢复`);
        } catch (e) {
            console.error(`[certs] 恢复订单 ${row['uuid']} 私钥失败:`, e);
        }
    }
    return healed;
}
export async function Processing(env: Bindings, ctx?: BackgroundContext) {
    const dao = await ensureDao(env as any);
    // 先修复历史脏数据：已签发但私钥没落库的订单（见 healMissingKeys 注释）。
    // 放在推进之前，这样修复后的订单同一次 tick 就能被正常处理。
    try {
        const healed = await healMissingKeys(env);
        if (healed > 0) console.log(`[certs] 已修复 ${healed} 个缺少私钥的已签发订单`);
    } catch (e) {
        console.error("[certs] 修复缺少私钥的订单失败（继续处理其余订单）:", e);
    }
    // flag <= 4 等价于「未签发或已失效」，且能命中 idx_apply_flag；
    // 原先的 flag != 5 无法使用索引，每次 cron 都是全表扫描。
    let order_list: any = await dao.scanApplies({lte: {flag: 4}});
    let result: any[] = []
    for (const id in order_list) { // 获取信息 ==================================================================
        let order_info = order_list[id]; // 获取当前订单详细情况
        // 跳过正被手动「立即处理」占用的订单，避免并发重复推进
        const release = acquireOrder(order_info['uuid']);
        if (!release) continue;
        try {
            let order_mail = order_info['mail']; // 当前订单用户邮箱
            let order_user: any = await dao.getUser(order_mail); // 按不同阶段分配程序处理 ========================
            if (order_info['flag'] == 0) result.push(await newApply(env, order_user, order_info));// 执行创建订单操作
            if (order_info['flag'] == 1) result.push(await setApply(env, order_user, order_info));// 自动执行域名代理
            if (order_info['flag'] == 2) result.push(await opDomain(env, order_user, order_info, []));// 等待用户配置 DNS 记录
            if (order_info['flag'] == 3) result.push(await dnsAuthy(env, order_user, order_info));// 自动执行域名验证
            if (order_info['flag'] == 4) result.push(await getCerts(env, order_user, order_info, ctx));// 自动执行获取证书
        } catch (e) {
            // 单个订单出错不能中断整轮 cron：否则它后面的所有订单都被饿死
            // （永远轮不到处理），且下一轮又会从同一个坏订单开始，形成长期阻塞。
            // 这里只记录日志并继续，订单自身的状态由各阶段内部的 catch 负责落库。
            console.error(`[certs] 订单 ${order_info['uuid']} 处理异常（继续处理其余订单）:`, e);
            result.push({"uuid": order_info['uuid'], "texts": "处理异常: " + extractAcmeError(e)});
        } finally {
            release();
        }
    } // ========================================================================================================
    return result;
}

// 单订单一键推进 ==================================================================================
// 按当前 flag 循环推进状态机，直到进入需要外部介入的节点：
// - flag=2  需要用户配置 DNS（等用户触发验证）
// - flag=5  证书签发完成
// - flag=-1 失败
// - 或中间某步 flag 未发生变化（避免死循环）
export async function processOne(env: Bindings, order_uuid: string, ctx?: BackgroundContext) {
    // 同一订单禁止并发处理（cron 与手动触发可能同时到达）
    const release = acquireOrder(order_uuid);
    if (!release) {
        console.warn(`[certs] 订单 ${order_uuid} 正在处理中，跳过重复调用`);
        return [{"texts": "订单正在处理中，请稍候"}];
    }
    try {
        return await processOneLocked(env, order_uuid, ctx);
    } finally {
        release();
    }
}

/** processOne 的实际执行体；调用前需已通过 acquireOrder 取得互斥 */
async function processOneLocked(env: Bindings, order_uuid: string, ctx?: BackgroundContext) {
    let result: any[] = [];
    const dao = await ensureDao(env as any);
    // 自愈检查：订单已创建（data 存在）但 list 中某些域名 auth 缺失，则强制回到 flag=1 重跑 setApply
    {
        let cur: any = await dao.getApply(order_uuid);
        if (cur && cur['data'] && cur['list']) {
            let cur_flag = Number(cur['flag']);
            if (cur_flag >= 1 && cur_flag < 4) { // 只对尚未开始验证的中间态做自愈
                try {
                    let list_items: any[] = JSON.parse(cur['list']) || [];
                    let need_repair = list_items.length > 0 && list_items.some((it: any) => {
                        let auth_val = (it && (it['auth'] || it['text'])) || "";
                        return !auth_val;
                    });
                    if (need_repair && cur_flag !== 1) {
                        await dao.updateApply(order_uuid, {flag: 1});
                        console.log("processOne self-heal: reset flag=1 for order " + order_uuid);
                    }
                } catch (e) {
                    console.error("processOne self-heal parse error:", e);
                }
            }
        }
    }
    for (let i = 0; i < 8; i++) { // 最多推进 8 步，防止极端情况死循环
        let order_info: any = await dao.getApply(order_uuid);
        if (!order_info) break;
        let flag = Number(order_info['flag']);
        if (flag === 2 || flag === 5 || flag < 0) break; // 终止条件
        let order_user: any = await dao.getUser(order_info['mail']);
        try {
            if (flag === 0) result.push(await newApply(env, order_user, order_info));
            else if (flag === 1) result.push(await setApply(env, order_user, order_info));
            else if (flag === 3) result.push(await dnsAuthy(env, order_user, order_info));
            else if (flag === 4) result.push(await getCerts(env, order_user, order_info, ctx));
            else break; // 其它未知状态，停止推进
        } catch (e) {
            const msg = extractAcmeError(e);
            console.error("processOne error at flag=" + flag + ":", e);
            if (isTransientAcmeError(e)) {
                // 临时故障（网关 5xx、限流、超时、网络抖动）：**保留当前 flag**，
                // 只把原因写进文案，等下一轮 cron 或用户再点一次「立即处理」重试。
                // 此前这里无条件置 flag=-1，导致 ZeroSSL 一次 502 就把订单判成
                // 「已失效」，用户只能删掉重建 —— 一个本可签下来的订单被白白作废。
                try {
                    await dao.updateApply(order_uuid, {
                        text: "临时故障，稍后自动重试: " + msg
                    });
                } catch (ue) {
                    console.error("processOne persist transient error failed:", ue);
                }
                result.push({"texts": "临时故障，稍后自动重试: " + msg});
            } else {
                // CA 明确拒绝（4xx ACME 语义错误等）：终态失败，不再重试
                try {
                    await dao.updateApply(order_uuid, {flag: -1, text: "处理失败: " + msg});
                } catch (ue) {
                    console.error("processOne persist error failed:", ue);
                }
                result.push({"texts": "处理失败: " + msg});
            }
            break;
        }
        // 若本轮处理后 flag 未推进，防止死循环
        let next_info: any = await dao.getApply(order_uuid);
        if (!next_info || Number(next_info['flag']) === flag) break;
    }
    return result;
}

// 新增证书订单 =====================================================================================
export async function newApply(env: Bindings, order_user: any, order_info: any) {
    const dao = await ensureDao(env as any);
    // 获取申请域名信息 =============================================================================
    let client_data: any = await getStart(env, order_user, order_info); // 获取域名证书的申请操作接口
    if (client_data == null) return {"texts": "处理失败，详见日志输出"};
    let domain_list: any = await getNames(order_info, true) // 获取当前申请域名的详细信息和类型
    // console.log("domain_list: ", domain_list);
    try {
        let orders_data: any = JSON.stringify(await client_data.createOrder({identifiers: domain_list}));
        // 写入订单详细数据 =============================================================================
        const timestamp = new Date(new Date().setDate(new Date().getDate() + 7)).getTime();
        await dao.updateApply(order_info['uuid'], {flag: 1}) // 更改状态码
        await dao.updateApply(order_info['uuid'], {next: timestamp})
        await dao.updateApply(order_info['uuid'], {text: "订单创建成功"})
        await dao.updateApply(order_info['uuid'], {data: orders_data})
    } catch (e) {
        const msg = extractAcmeError(e);
        console.error("newApply createOrder failed:", e);
        // 临时故障（网关 5xx、限流、超时）不判死：保留 flag=0，等下一轮重试。
        // 只有 CA 明确拒绝才写终态失败。
        const transient = isTransientAcmeError(e);
        try {
            await dao.updateApply(order_info['uuid'], transient
                ? {text: "订单创建遇到临时故障，稍后自动重试: " + msg}
                : {flag: -1, text: "订单创建失败: " + msg});
        } catch (ue) {
            console.error("newApply persist error failed:", ue);
        }
        // 包装后再抛出，调用方（processOne）可直接使用。
        // 必须把原始错误挂在 cause 上：processOne 要靠它判断是否临时故障，
        // 只传 message 会丢掉 HTTP 状态码，分类就失效了。
        const wrapped: any = new Error(msg);
        wrapped.cause = e;
        // 同时透传常见字段，避免调用方只能通过 cause 逐层取值
        const rawErr: any = e;
        wrapped.response = rawErr?.response ?? rawErr?.config?.response;
        wrapped.status = rawErr?.response?.status ?? rawErr?.config?.response?.status ?? rawErr?.status;
        throw wrapped;
    }
    return {"texts": "处理成功"};
    // ==============================================================================================
}

// 自动验证代理 =====================================================================================
export async function setApply(env: Bindings, order_user: any, order_info: any) {
    const dao = await ensureDao(env as any);
    let domain_list: any = order_info['list'];
    let orders_text: any = JSON.parse(order_info['data'])
    let client_data: any = await getStart(env, order_user, order_info);
    let orders_data: any = await client_data.getOrder(orders_text); // 获取授权信息
    // console.log(domain_list, orders_data);
    // 执行验证部分 ================================================================================
    let author_save: Record<string, Record<string, any>> = await getAuthy(client_data, orders_data)
    let domain_save: any[] = []
    let domain_flag: number = 2
    let domain_text: string = ""
    // 清理上一轮的验证记录。
    // 新建订单的 list 中还没有 auto 字段，若只按 auto 删除会漏删，导致 dnsAdd
    // 报「identical record already exists」。这里按同样的公式重算记录名，
    // 保证无论 auto 是否已写入都能定位到旧记录。
    const dcvAgentForClean = String((await readConf(env as any, "DCV_AGENT")) ?? "").trim();
    for (let domain_item of JSON.parse(domain_list)) {
        if (domain_item['type'] != "dns-auto") continue;
        const cleanName = dcvAgentForClean
            ? (await hmacSHA2(String(domain_item.name).replaceAll("*.", ""), order_user['mail']))
                .substring(0, 16) + "." + dcvAgentForClean
            : String(domain_item['auto'] ?? "").trim();
        if (!cleanName) continue;
        try {
            await agent.dnsDel(env, cleanName); // 删除原来
        } catch (e) {
            // 清理失败不应中断写入流程，后续 dnsAdd 会按实际情况报错
            console.warn(`[certs] 清理旧验证记录失败 ${cleanName}`, e);
        }
    }
    for (let domain_item of JSON.parse(domain_list)) {
        let domain_name = domain_item.name;
        // if (domain_item.wild) domain_name = "*." + domain_name
        // console.log(domain_name, author_save, author_save[domain_name]);
        if (author_save[domain_name] == undefined) {
            // 未拿到挑战：保留原条目但标记未就绪，触发下次自愈重试覆盖写入
            domain_item['auth'] = domain_item['auth'] || "";
            domain_item.flag = 1;
            domain_flag = 1;
            domain_text += domain_item.name + ": 未获取到验证挑战，稍后重试；";
            domain_save.push(domain_item);
            continue;
        }
        // console.log(author_save);
        domain_item['auth'] = author_save[domain_name]['text'];
        // 对于http-01验证（web-self），额外保存token用于前端展示验证路径
        if (author_save[domain_name]['data']?.type === 'http-01') {
            domain_item['token'] = author_save[domain_name]['data']['token'];
        }
        domain_item.flag = 2
        if (domain_item['type'] == "dns-auto") {
            let domain_auto = await hmacSHA2(domain_name.replaceAll("*.", ""), order_user['mail'])
            const dcvAgent = String((await readConf(env as any, "DCV_AGENT")) ?? "").trim()
            if (!dcvAgent) {
                // 未配置 DCV_AGENT 时记录名会退化为 "<hash>."，属非法域名
                domain_item.flag = 1
                domain_flag = 1
                domain_text += domain_item.name + ": 未配置 DCV_AGENT，无法生成验证记录名；"
                domain_save.push(domain_item)
                continue
            }
            domain_item['auto'] = domain_auto.substring(0, 16) + "." + dcvAgent
            // console.log(domain_item['auto'])
            // 自动建立 CNAME：用户无需再手工添加 _acme-challenge 记录。
            // 失败不阻断流程（例如 Token 对该域名无编辑权限），此时仍按原有
            // 方式提示用户在订单页手动配置。
            try {
                const cname = await agent.cnameEnsure(env, domain_name, domain_item['auto']);
                if (!cname?.success) {
                    const msg = cname?.errors?.[0]?.message ?? "未知原因";
                    console.warn(`[certs] 自动创建 CNAME 失败 ${domain_name}: ${msg}`);
                }
            } catch (e) {
                console.warn(`[certs] 自动创建 CNAME 异常 ${domain_name}`, e);
            }
            try { // 设置域名内容 ====================================================
                let data: Record<string, any> = await agent.dnsAdd(
                    env, domain_item, domain_name);
                if (!data['success']) {
                    domain_item.flag = 1
                    domain_flag = 1
                    domain_text += domain_item.name +
                        ": 无法设置DNS记录: " + data['errors'][0]['message'].toString()
                }
            } catch (error) {
                console.error('Error:', error);
            }
        }
        // console.log(domain_item);
        domain_save.push(domain_item);
    }
    if (domain_text.length == 0) domain_text = "域名处理成功"
    await dao.updateApply(order_info['uuid'], {list: JSON.stringify(domain_save)})
    await dao.updateApply(order_info['uuid'], {flag: domain_flag})
    await dao.updateApply(order_info['uuid'], {text: domain_text})
    // console.log(domain_save);
    return {"texts": domain_text};
}

// 修改验证状态 =====================================================================================
export async function opDomain(env: Bindings, order_user: any, order_info: any, sets_list: string[]) {
    const dao = await ensureDao(env as any);
    let domain_list: any = order_info['list'];
    // 执行操作部分 =================================================================================
    let domain_save: any[] = []
    let domain_flag: number = 3
    for (let domain_item of JSON.parse(domain_list)) {
        // console.log(domain_item, sets_list);
        // console.log(sets_list.some(item => item.toLowerCase() === domain_item.name.toLowerCase()));
        if (domain_item.flag >= 4) {
            domain_save.push(domain_item);
            continue;
        }
        if (sets_list.some(item => item.toLowerCase() === domain_item.name.toLowerCase()
            || item.toLowerCase() === "all")) {
            domain_item.flag = 3;
        } else domain_flag = 2;
        if (sets_list.length == 0 && domain_item.flag == 3) {
            await dnsAuthy(env, order_user, order_info);
            break;
        }
        domain_save.push(domain_item);
    }
    if (sets_list.length !== 0) {
        await dao.updateApply(order_info['uuid'], {list: JSON.stringify(domain_save)})
        await dao.updateApply(order_info['uuid'], {text: "订单域名验证状态修改成功"})
        await dao.updateApply(order_info['uuid'], {flag: domain_flag})
    }
    return {"texts": "处理成功"};
}

// 执行域名验证 ====================================================================================
export async function dnsAuthy(env: Bindings, order_user: any, order_info: any) {
    const dao = await ensureDao(env as any);
    let domain_list: any = order_info['list'];
    let orders_text: any = JSON.parse(order_info['data'])
    let client_data: any = await getStart(env, order_user, order_info);
    let orders_data: any = await client_data.getOrder(orders_text); // 获取授权信息
    let author_save: Record<string, Record<string, any>> = await getAuthy(client_data, orders_data)
    // 验证所有域名 ================================================================================
    let domain_save: any[] = [] // 需要最后保存的域名详细验证数据
    let status_flag: number = 4;
    let domain_fail: string[] = [];
    for (let domain_item of JSON.parse(domain_list)) { // 验证DNS
        // 已有域名判定失败：订单已是终态，其余域名只需原样保留
        if (status_flag == -1) {
            domain_save.push(domain_item);
            continue
        }
        // web-self（http-01验证）不需要DNS检查，直接提交验证
        let lookup: query.ChainLookup | null = domain_item.type === "web-self"
            ? null
            : await dnsCheck(author_save, domain_item)
        let author_flag: boolean = domain_item.type === "web-self"
            ? (author_save[domain_item.name] != undefined)
            : !!lookup?.ok
        console.log(domain_item.name, author_flag);
        if (!author_flag) { // 本地验证失败 ========================================================
            domain_item.flag = 2;
            status_flag = mergeStatusFlag(status_flag, 2)
            // 记录失败原因，供订单 text 字段展示
            domain_fail.push(
                lookup
                    ? `${domain_item.name}: ${query.describeChain(lookup)}`
                    : `${domain_item.name}: 未获取到 ACME 验证挑战`
            );
        } else { // 本地验证成功 =====================================================================
            let author_data: Record<string, any> = author_save[domain_item.name]
            // 关键约束：本函数跑在 waitUntil 里，而 Cloudflare 只给响应后 30 秒。
            // 因此这里**不做任何等待** —— 每轮只推进一步，challenge 的最新状态
            // 由下一轮开头的 getAuthy 重新拉取。
            //
            // 原实现在 Node 常驻进程里同步阻塞等待（waitForValidStatus 最坏 245s）
            // 是安全的，但移植到 Workers 后必然被中途掐断：状态没写完、租约也
            // 没释放，订单就卡死了。
            //
            // 提交前的本地复核由上面的 dnsCheck 完成：它以 DoH 等价实现了
            // acme-client verifyChallenge 的 CNAME 跟随 + TXT 值比对，
            // 且是单次查询、不退避，适配这里的 30 秒预算。
            const ch_status: string = String(author_data.data['status'] ?? "")
            const outcome = challengeOutcome(ch_status)
            domain_item.flag = outcome.domainFlag
            status_flag = mergeStatusFlag(status_flag, outcome.statusFlag)
            // CA 若已在 challenge 上写明失败原因，直接透出，不再让用户面对
            // 「稍后自动重试」这种无从下手的提示。
            const ch_reason = describeChallengeError(author_data.data)
            // 上次提交（或首次进入 processing）的时间，用于判断是否该催 CA 重查
            const lastSubmitAt = Number(domain_item['submit_at'] ?? 0)
            if (outcome.submit) {
                // 尚未提交：通知 CA 开始校验，本轮即结束，下轮看结果
                try {
                    const submit_flag: any = await client_data.completeChallenge(author_data.data);
                    console.log('Domain Remote Upload Status:', submit_flag?.['status']);
                    domain_item['submit_at'] = Date.now()
                    domain_fail.push(`${domain_item.name}: 已提交 CA 校验，等待结果`);
                } catch (error) {
                    console.log('Domain Remote Submit Errors:', error);
                    // 提交失败可能只是网络抖动，保留 flag=3 下轮重试；
                    // 若确实被 CA 拒绝，下轮 getAuthy 会取回 invalid 并走失败分支。
                    domain_fail.push(
                        `${domain_item.name}: 提交校验失败（${extractAcmeError(error)}），稍后自动重试`
                    );
                }
            } else if (ch_status === "processing") {
                // CA 正在按自己的退避计划重试，期间状态一直是 processing。
                // 用户改完 DNS 后如果只是干等，可能等到 Retry-After 到期
                // （ZeroSSL 可达数小时甚至 24 小时）才会有结果。
                // RFC 8555 §8.2 允许客户端重新 POST 一次 challenge 请求立即
                // 重查 —— 这正是 DNS 已修正时该做的事。
                const authz_status = String(author_data.auth?.['status'] ?? "")
                if (shouldResubmitChallenge(lastSubmitAt)) {
                    try {
                        const again: any = await client_data.completeChallenge(author_data.data);
                        console.log('Domain Remote Resubmit Status:', again?.['status']);
                        domain_item['submit_at'] = Date.now()
                        domain_fail.push(
                            `${domain_item.name}: CA 校验中，已请求立即重查（challenge=${String(again?.['status'] ?? ch_status)}）`
                        );
                    } catch (error) {
                        // 部分 CA 对已受理的 challenge 再次 POST 会报错，属正常；
                        // 记录时间避免每轮都重复请求。
                        domain_item['submit_at'] = Date.now()
                        console.log('Domain Remote Resubmit Errors:', error);
                        domain_fail.push(
                            `${domain_item.name}: CA 校验中（challenge=${ch_status}，授权=${authz_status || "未知"}），重新请求未受理（${extractAcmeError(error)}），稍后自动重试`
                        );
                    }
                } else {
                    domain_fail.push(
                        `${domain_item.name}: ${ch_reason || describePendingReason(ch_status, authz_status)}`
                    );
                }
            } else if (ch_status === "invalid") {
                // CA 判定校验失败。原实现只置 flag=-1 而不记录任何原因，
                // 于是订单显示「域名验证失败:[]」—— 一个空数组，用户完全
                // 无从下手。这里优先报 CA 写明的原因，CA 没写时用本地链路
                // 诊断补上（哪一段断了、期望什么、实际什么）。
                const authz_status = String(author_data.auth?.['status'] ?? "")
                const detail = ch_reason
                    || (lookup ? query.describeChain(lookup) : "")
                    || (authz_status
                        ? `CA 判定校验失败（授权=${authz_status}）`
                        : "CA 判定校验失败，未给出具体原因");
                domain_fail.push(`${domain_item.name}: ${detail}`);
            } else if (ch_status !== "valid") {
                // 优先报 CA 写明的失败原因；没有时退回报「谁在等谁」的状态组合，
                // 至少能看出是正常校验中还是状态不同步。
                const authz_status = String(author_data.auth?.['status'] ?? "")
                domain_fail.push(ch_reason
                    ? `${domain_item.name}: ${ch_reason}`
                    : `${domain_item.name}: ${describePendingReason(ch_status, authz_status)}`);
            }
        }
        domain_save.push(domain_item);
    }
    orders_data = await client_data.getOrder(orders_text);
    // console.log(orders_data);
    await dao.updateApply(order_info['uuid'], {data: JSON.stringify(orders_data)})
    await dao.updateApply(order_info['uuid'], {list: JSON.stringify(domain_save)})
    await dao.updateApply(order_info['uuid'], {flag: status_flag})
    // 失败文案不再用 JSON.stringify：domain_fail 为空时会输出 `[]`，
    // 界面上就是「域名验证失败:[]」，用户完全无从下手。
    if (status_flag == -1) await dao.updateApply(order_info['uuid'], {
        text: domain_fail.length
            ? "域名验证失败：" + domain_fail.join("；")
            : "域名验证失败，但未取得具体原因，请查看日志"
    })
    else if (status_flag == 2) await dao.updateApply(order_info['uuid'], {
        text: "域名验证未通过：" + domain_fail.join("；")
    })
    else if (status_flag == 3) await dao.updateApply(order_info['uuid'], {
        text: domain_fail.length
            ? "域名验证进行中：" + domain_fail.join("；")
            : "域名验证进行中，等待 CA 完成校验"
    })
    else await dao.updateApply(order_info['uuid'], {text: "域名验证通过"})
    return {"texts": "处理成功"};
}

// 完成证书申请 #######################################################################################################
export async function getCerts(env: Bindings, order_user: any, order_info: any, ctx?: BackgroundContext) {
    const dao = await ensureDao(env as any);
    let orders_text: any = JSON.parse(order_info['data'])
    let client_data: any = await getStart(env, order_user, order_info);
    let orders_data: any = await client_data.getOrder(orders_text); // 获取授权信息
    // console.log(orders_data);
    console.log('Orders Remote Verify Status:', orders_data.status);
    // 订单已过期：ACME 侧不再接受验证或签发，回到 flag=0 重新下单。
    // 不标记为失败，避免用户需要手动删除重建订单。
    if (orders_data.status !== 'valid' && isOrderExpired(orders_data)) {
        console.warn(`[certs] 订单已过期，重新创建 uuid=${order_info['uuid']} expires=${orders_data.expires}`);
        await dao.updateApply(order_info['uuid'], {flag: 0})
        await dao.updateApply(order_info['uuid'], {text: "ACME 订单已过期，正在重新创建"})
        return {"texts": "订单已过期，重新创建"};
    }
    if (orders_data.status === 'pending') {
        // ACME 订单仍是 pending：说明授权尚未全部通过，但本地 flag 已经是 4。
        // 这通常来自历史上 dnsAuthy 漏判 processing 状态留下的脏数据，若不纠正，
        // getCerts 会一直空转到订单过期。
        //
        // 只在「本地仍有域名未验证通过」时退回 flag=3：此时重跑验证是有意义的。
        // 若本地域名已全部为 4 而 CA 仍报 pending，说明是 CA 侧的传播延迟或异常，
        // 此时退回 flag=3 会让订单在 3/4 之间反复翻转（每轮 cron 一次），
        // 因此保持原状等待，最终由订单过期逻辑回收重建。
        const localPending = ((): boolean => {
            try {
                const items: any[] = JSON.parse(order_info['list'] ?? "[]");
                return items.some((it: any) => Number(it?.flag ?? 0) < 4);
            } catch {
                return false;
            }
        })();
        if (localPending) {
            console.warn(`[certs] 订单 ${order_info['uuid']} 处于 pending 且本地验证未完成，退回 flag=3`);
            await dao.updateApply(order_info['uuid'], {flag: 3})
            await dao.updateApply(order_info['uuid'], {text: "域名验证尚未完成，正在重新校验"})
            return {"texts": "域名验证尚未完成"};
        }
        console.warn(`[certs] 订单 ${order_info['uuid']} 本地已通过但 CA 仍为 pending，等待其完成`);
        await dao.updateApply(order_info['uuid'], {text: "等待 CA 确认订单状态"})
        return {"texts": "等待 CA 确认"};
    }
    if (orders_data.status == "invalid") {
        // RFC 8555 §7.1.6：Order 对象同样带 error，写明为什么签发失败。
        // 与 challenge.error 一样，这里此前只写「证书签发失败」，把原因丢了。
        const order_reason = describeChallengeError(orders_data)
        await dao.updateApply(order_info['uuid'], {flag: -1})
        await dao.updateApply(order_info['uuid'], {
            text: order_reason ? "证书签发失败：" + order_reason : "证书签发失败"
        })
        // 通知（失败不抛异常，不影响主流程）
        await notify(env, {
            event: "fail",
            domains: await safeDomainNames(order_info),
            mail: order_info['mail'],
            uuid: order_info['uuid'],
            detail: order_reason
                ? "ACME 侧返回 invalid：" + order_reason
                : "ACME 侧返回 invalid，请检查域名解析或验证配置",
            siteHost: await siteHostOf(env),
        }, ctx);
        return {"texts": "验证状态无效"};
    }
    if (orders_data.status === 'ready') {
        let domainsListCSR: any = await getNames(order_info, false);
        let privateKeyText = null // 私钥创建过程 ===================================================================
        if (order_info['type'] == "rsa2048") privateKeyText = await acme.crypto.createPrivateRsaKey(2048);
        if (order_info['type'] == "eccp256") privateKeyText = await acme.crypto.createPrivateEcdsaKey('P-256');
        if (order_info['type'] == "eccp384") privateKeyText = await acme.crypto.createPrivateEcdsaKey('P-384');
        let [privateKeyBuff, certificateCSR] = await acme.crypto.createCsr({ // 创建证书请求 ==============================
            altNames: domainsListCSR, commonName: domainsListCSR[0], country: order_info['C'], state: order_info['S'],
            locality: order_info['ST'], organization: order_info['O'], organizationUnit: order_info['OU']
        }, privateKeyText || "");
        // 新私钥先写入 pending_keys，不覆盖 keys：此时 cert 仍是上一张证书，
        // 直接覆盖会让库中出现「新私钥 + 旧证书」的组合。
        // 列不存在（迁移未执行）时退回旧行为，避免阻断签发。
        let pendingKeysWritten = "";
        try {
            pendingKeysWritten = privateKeyBuff.toString();
            await dao.updateApply(order_info['uuid'], {pending_keys: pendingKeysWritten})
        } catch (e) {
            console.warn(
                `[certs] pending_keys 写入失败，回退为直接写 keys（uuid=${order_info['uuid']}）`, e
            );
            pendingKeysWritten = "";
            await dao.updateApply(order_info['uuid'], {keys: privateKeyBuff.toString()})
        }
        // 关键：同步内存快照。下面的轮询会让 ready→valid 在**同一轮内**完成，
        // 而 valid 分支读的是 order_info['pending_keys'] —— 该对象是本函数入口
        // 时取的快照，不含刚写入的私钥。不同步就会把新证书配上空私钥落库，
        // 表现为「密钥：无」，且下载密钥/ZIP/PFX、清空私钥、吊销按钮全部不可用。
        if (pendingKeysWritten) order_info['pending_keys'] = pendingKeysWritten;
        const finish_text: any = await client_data.finalizeOrder(orders_data, certificateCSR);// 最终确认订单
        console.log('Orders Remote Finish Status:', finish_text);
        await dao.updateApply(order_info['uuid'], {text: "证书签发请求提交成功"})

        // CA 通常在数秒内完成签发，无需等到下一轮 cron。
        // 这里短暂轮询若干次，签发完成则直接落到下方 valid 分支取回证书。
        for (let attempt = 0; attempt < 5; attempt++) {
            await sleep(2000);
            try {
                orders_data = await client_data.getOrder(orders_text);
            } catch (e) {
                console.warn(`[certs] 轮询订单状态失败 uuid=${order_info['uuid']}`, e);
                break;
            }
            if (orders_data.status === 'valid' || orders_data.status === 'invalid') break;
        }
    }
    if (orders_data.status === 'processing') {
        console.log('Orders Remote Finish Status:', "Certificate Processing");
        // 订单已进入 processing，但 CA 有时会在这里附上原因（如 CAA 拒绝），
        // 有就透出，没有才是真正的「等待签发」。
        const order_reason = describeChallengeError(orders_data)
        await dao.updateApply(order_info['uuid'], {
            text: order_reason ? "证书正在等待完成签发：" + order_reason : "证书正在等待完成签发"
        })
    }
    if (orders_data.status === 'valid') {
        const certificate: any = await client_data.getCertificate(orders_data);// 获取证书
        // console.log('Orders Remote Issues Status:', certificate);
        // cert 与 keys 必须**同一次写入**：只要二者不同步，下载端就可能拿到
        // 不匹配的一对。pending_keys 是本轮 ready 阶段生成的新私钥；
        // 若它缺失（老数据 / 异常中断）则保留原 keys，避免把私钥写没。
        //
        // 从数据库重读而不是用内存快照：ready 与 valid 现在可能在同一轮内
        // 先后执行（见上面的轮询），而函数入口时的 order_info 不含刚写入的
        // pending_keys。曾因此把新证书配上空私钥落库，订单显示「密钥：无」，
        // 且下载密钥/ZIP/PFX、清空私钥、吊销按钮全部不可用。
        let pendingKeys = order_info['pending_keys'];
        try {
            const fresh: any = await dao.getApply(order_info['uuid']);
            if (fresh && typeof fresh['pending_keys'] === "string" && fresh['pending_keys'].length > 0) {
                pendingKeys = fresh['pending_keys'];
            }
        } catch (e) {
            console.warn(`[certs] 重读 pending_keys 失败，沿用内存快照 uuid=${order_info['uuid']}`, e);
        }
        const hasPending = typeof pendingKeys === "string" && pendingKeys.length > 0;
        await dao.updateApply(
            order_info['uuid'],
            hasPending
                ? {cert: certificate, keys: pendingKeys, pending_keys: ""}
                : {cert: certificate}
        );
        if (!hasPending) {
            console.warn(
                `[certs] 订单 ${order_info['uuid']} 缺少 pending_keys，保留原私钥`
            );
        }
        // 同步内存快照，供同一轮内后续逻辑与调用方使用
        if (hasPending) order_info['keys'] = pendingKeys;
        await dao.updateApply(order_info['uuid'], {flag: 5})
        // 到期时间：优先用证书里真实的 notAfter（CA 不一定是 90 天，
        // 例如 ZeroSSL/Google 的策略会变），解析失败才回退到 +90 天。
        const validity = parseCertValidity(String(certificate ?? ""));
        const timestamp = validity?.notAfter
            ?? new Date(new Date().setDate(new Date().getDate() + 90)).getTime();
        if (!validity) {
            console.warn(
                `[certs] 无法解析证书有效期 uuid=${order_info['uuid']}，回退为 +90 天`
            );
        }
        // 新证书：清空到期提醒标记，让下个周期的 expire7/expired 能重新推送
        await dao.updateApply(order_info['uuid'], {next: timestamp, notified: ""})
        await dao.updateApply(order_info['uuid'], {text: "恭喜！证书已成功签发"})
        // 通知（失败不抛异常，不影响主流程）
        await notify(env, {
            event: "success",
            domains: await safeDomainNames(order_info),
            mail: order_info['mail'],
            uuid: order_info['uuid'],
            detail: `有效期至 ${new Date(timestamp).toLocaleDateString('zh-CN')}`,
            siteHost: await siteHostOf(env),
        }, ctx);
    }
    return {"texts": "处理成功"};
}

// 吊销证书 ########################################################################################
// RFC 5280 吊销原因码（Let's Encrypt 目前常用支持：0/1/3/4/5）
// 参考：https://datatracker.ietf.org/doc/html/rfc5280#section-5.3.1
//  0 unspecified            未指定（默认）
//  1 keyCompromise          密钥已泄露
//  3 affiliationChanged     归属关系变更
//  4 superseded             已被新证书替代
//  5 cessationOfOperation   停止运营
export const REVOKE_REASONS = new Set<number>([0, 1, 2, 3, 4, 5, 6, 8, 9, 10]);

export async function revokeCert(env: Bindings, order_info: any, reason: number = 0) {
    const dao = await ensureDao(env as any);
    // 基本校验：必须存在证书原文 =====================================================================
    const cert_pem: string = order_info?.cert || "";
    if (!cert_pem || !/BEGIN CERTIFICATE/.test(cert_pem)) {
        return {"flags": 5, "texts": "当前订单未签发证书，无需吊销"};
    }
    // 读取申请者信息用于获取 ACME 账户上下文 =========================================================
    let order_user: any = await dao.getUser(order_info['mail']);
    if (!order_user) return {"flags": 5, "texts": "找不到订单对应的用户信息"};
    // 组装 ACME Client ============================================================================
    let client_data: any;
    try {
        client_data = await getStart(env, order_user, order_info);
    } catch (e) {
        const msg = extractAcmeError(e);
        return {"flags": 5, "texts": "ACME 账户初始化失败: " + msg};
    }
    if (client_data == null) return {"flags": 5, "texts": "ACME 账户初始化失败"};
    // 规整 reason 参数 =============================================================================
    let reason_code = Number(reason);
    if (!Number.isFinite(reason_code) || !REVOKE_REASONS.has(reason_code)) reason_code = 0;
    // 调用 ACME 吊销接口 ===========================================================================
    try {
        await client_data.revokeCertificate(cert_pem, {reason: reason_code});
    } catch (e: any) {
        const msg = extractAcmeError(e);
        console.error("revokeCert acme error:", e);
        // 记录失败原因，但不修改订单状态，允许用户重新尝试
        try {
            await dao.updateApply(order_info['uuid'], {text: "证书吊销失败: " + msg});
        } catch {/* ignore */}
        return {"flags": 5, "texts": "证书吊销失败: " + msg};
    }
    // 吊销成功：更新订单状态为已失效（-1），并清空 cert/keys，便于用户重新申请 =========================
    const timestamp = Date.now();
    await dao.updateApply(order_info['uuid'],
        {flag: -1, text: "证书已吊销 (reason=" + reason_code + ")", next: timestamp});
    return {"flags": 0, "texts": "证书吊销成功"};
}

// 获取域名信息 ####################################################################################
async function getNames(order_info: any, full: boolean = false) {
    // 处理域名信息 ================================================================================
    let domain_save: string[] | Record<string, any> = [];
    let domain_data = JSON.parse(order_info['list']);
    for (const uid in domain_data) {
        const domain_now = domain_data[uid];
        // console.log("domain_now: ", domain_now);
        const author_now = domain_now['type'].split("-")[0]
        // 判断是否为IP证书
        const isIP = !!domain_now['isIP'];
        if (full) {
            domain_save.push({
                type: isIP ? 'ip' : author_now,
                value: domain_now['name']
            });
        } else {
            domain_save.push(domain_now['name']);
        }
    }
    return domain_save;
}

/** 安全取域名列表：list 字段异常时返回空数组，绝不让通知逻辑拖垮主流程 */
async function safeDomainNames(order_info: any): Promise<string[]> {
    try {
        const names = await getNames(order_info, false);
        return Array.isArray(names) ? names as string[] : [];
    } catch (e) {
        console.warn("[notify] 解析域名列表失败", e);
        return [];
    }
}

/** 读取站点域名用于消息里的链接（读不到就返回空，消息里省略该行） */
async function siteHostOf(env: Bindings): Promise<string | undefined> {
    try {
        const {readConf} = await import("./db/conf");
        const host = (await readConf(env as any, "SITE_HOST")) ?? "";
        return host || undefined;
    } catch {
        return undefined;
    }
}

// 获取操作接口 ####################################################################################
async function getStart(env: Bindings, order_user: any, order_info: any) {
    let acme_url = acme_url_map[order_info['sign']];
    // 从 Confs 优先读取三家 CA 的账户凭据（回退到 env / 默认值）
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
    const acme_key_map: Record<string, any> = {
        "lets-encrypt": order_user['keys'],
        "google-trust": GTS_KeyTS,
        "bypass-trust": order_user['keys'],
        "zeroca-trust": ZRO_KeyTS,
        "sslcom-trust": SSL_KeyTS,
    }
    const acme_eab_map: Record<string, any> = {
        "lets-encrypt": undefined,
        "google-trust": {kid: GTS_keyID, hmacKey: GTS_keyMC,},
        "bypass-trust": undefined,
        "zeroca-trust": {kid: ZRO_keyID, hmacKey: ZRO_keyMC,},
        "sslcom-trust": {kid: SSL_keyID, hmacKey: SSL_keyMC,}
    }
    if (order_info['sign'] == "sslcom-trust") acme_url += order_info['type'].substring(0, 3);
    let client_data: Client = new acme.Client({
        directoryUrl: acme_url,
        accountKey: acme_key_map[order_info.sign],
        externalAccountBinding: acme_eab_map[order_info.sign],
        // 收紧退避：本进程只有响应后 30 秒预算，而 acme-client 默认允许
        // 10 次重试、5s 起步、30s 封顶（最坏约 215 秒退避）。虽然现在已经
        // 不再调用会长时间轮询的 waitForValidStatus，但 createAccount /
        // createOrder 等签名请求仍会复用这套退避，一旦 CA 抖动就可能拖过窗口。
        // 压到约 12 秒，失败就交给下一轮 cron，而不是把一次调用拖死。
        backoffAttempts: 4,
        backoffMin: 2000,
        backoffMax: 6000,
    });
    try { // 获取账户信息 ================================
        client_data.getAccountUrl();
    } catch (e) { // 尝试创建账户 ========================
        try {
            await client_data.createAccount({
                termsOfServiceAgreed: true,
                contact: ['mailto:' + order_user['mail']],
            });
        } catch (e) {
            if (e instanceof Error) {
                console.error("Error stack:", e.stack);
                console.error("Error message:", e.message);
            } else {
                console.error("An unknown error occurred:", e);
            }
            throw e;
            // return null
        }
    }
    return client_data;
}

// 获取验证数据 ####################################################################################
async function getAuthy(client_data: any, orders_data: any) {
    let author_list: any[] = await client_data.getAuthorizations(orders_data);
    let author_maps: Record<string, any> = {}
    // console.log("author_list: ", author_list);
    for (const author_data of author_list) {
        // 待验证信息 ======================================
        let author_info: any = author_data['identifier'];
        let author_name: string = author_info['value'];
        if (author_data['wildcard'] === true)
            author_name = "*." + author_name;
        // let author_type: string = author_info['type'];
        // 查找验证信息（优先dns-01，IP证书使用http-01）=================================
        let author_save = undefined
        // console.log(author_data)
        for (const c of author_data['challenges']) {
            if (c.type === "dns-01") {
                author_save = c
                break
            }
        }
        // 如果没有dns-01（如IP证书），尝试http-01
        if (author_save == undefined) {
            for (const c of author_data['challenges']) {
                if (c.type === "http-01") {
                    author_save = c
                    break
                }
            }
        }
        if (author_save == undefined) continue
        let author_text = await client_data.getChallengeKeyAuthorization(author_save)
        console.log(author_text);
        // 返回结果 ========================================
        // console.log(author_name, author_type, author_save['token']);
        author_maps[author_name] = {
            text: author_text,
            data: author_save,
            auth: author_data,
        }
    }
    // console.log(author_maps);
    return author_maps;
}

/**
 * 校验 DCV 的完整解析链路。
 * -------------------------------------------------------------------------
 * dns-01 需要两段都对：挑战名上的 CNAME 指向，以及 CNAME 目标上的 TXT 值。
 * 此前只检查第一段（CNAME 是否存在），于是「指向对了但值是错的」这种情况
 * 会被判为本地通过、直接提交给 CA，换回一个不带原因的 invalid。
 *
 * 原实现在提交前调用 acme-client 的 verifyChallenge 做这一步：它内部用
 * node:dns 先跟随 CNAME 再比对 TXT。该实现依赖 node:dns 且自带退避重试，
 * 不适合 Workers 的 30 秒预算，因此改为等价的 DoH 单次查询。
 *
 * @param author_save getAuthy 的结果，用于确认该域名确实拿到了挑战
 * @param domain_item 订单中的域名条目
 * @returns 链路诊断；未拿到挑战时返回 null
 */
async function dnsCheck(author_save: any, domain_item: any): Promise<query.ChainLookup | null> {
    const author = author_save[domain_item.name];
    if (author == undefined) return null;
    const domain_name = String(domain_item.name).replaceAll("*.", "");
    const record = "_acme-challenge." + domain_name;
    // 期望值优先用本轮从 CA 取回的 keyAuthorization（author.text）：
    // CA 就是拿它比对 DNS 的。订单里存的 auth 可能来自更早一轮 ——
    // 订单重建 / challenge token 变更后旧值就失效了，拿它比对会误报
    // 「值不匹配」，而 DNS 里其实已经是对的（或反之）。
    const expect = String(author.text ?? domain_item.auth ?? "");
    // dns-auto：挑战名上应有一条指向 DCV_AGENT 的 CNAME，值在目标上
    // 其它模式（dns-self / web-self）：值直接写在挑战名上，不期望 CNAME
    const cnameExpect = domain_item.type == "dns-auto"
        ? String(domain_item.auto ?? "").trim()
        : "";
    return await query.lookupChain(record, expect, cnameExpect);
}

async function dnsOrder(author_save: any, domain_item: any) {

}