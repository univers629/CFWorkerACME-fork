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
 * 订单处理互斥集合。
 * -------------------------------------------------------------------------
 * cron 的 Processing() 与手动「立即处理」都可能推进同一订单，并发进入会
 * 重复生成私钥、重复提交 CSR。这里用模块级集合做同实例内的互斥。
 * 局限：Workers 多实例部署时无法跨实例互斥；ACME 侧对重复 CSR 提交本身
 * 是幂等的（同一订单只接受一次 finalize），因此该保护足以覆盖主要场景，
 * 且无需为分布式锁引入额外的表与迁移。
 */
const _processing = new Set<string>();

/** 尝试占用订单；返回释放函数，已被占用时返回 null */
function acquireOrder(uuid: string): (() => void) | null {
    if (_processing.has(uuid)) return null;
    _processing.add(uuid);
    return () => { _processing.delete(uuid); };
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

// challenge 校验结果判定 ==========================================================================
/**
 * 把「等待 CA 校验」的结果映射为域名与订单的状态。
 * -------------------------------------------------------------------------
 * 独立成纯函数的原因：这段判定曾因漏掉 processing 状态而让订单永久停在
 * 「申请中」并写下「域名验证通过」的错误文案，需要能被单元测试直接覆盖。
 *
 * @param waited valid=CA 确认通过；pending=仍在校验；error=等待过程抛错
 * @returns domainFlag 域名状态；statusFlag 订单状态（null 表示不改动）；
 *          retry 是否需要把「稍后重试」写入订单文案
 */
export function challengeOutcome(waited: "valid" | "pending" | "error"): {
    domainFlag: number;
    statusFlag: number | null;
    retry: boolean;
} {
    if (waited === "valid") {
        // 域名完成，订单状态保持不动：同一订单可能还有其它域名未验证，
        // 由 status_flag 的初值（4）与其它域名的判定共同决定最终值。
        return {domainFlag: 4, statusFlag: null, retry: false};
    }
    // pending / error 都必须把订单压回「验证中」，否则订单会带着未验证的
    // 域名继续走到签发阶段。
    return {domainFlag: 3, statusFlag: 3, retry: waited === "error"};
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
export async function Processing(env: Bindings, ctx?: BackgroundContext) {
    const dao = await ensureDao(env as any);
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
            // 将错误信息持久化到订单，供前端展示
            try {
                await dao.updateApply(order_uuid, {flag: -1, text: "处理失败: " + msg});
            } catch (ue) {
                console.error("processOne persist error failed:", ue);
            }
            result.push({"texts": "处理失败: " + msg});
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
        // 记录到订单：标记失败 + 写入明确错误原因，便于前端显示
        try {
            await dao.updateApply(order_info['uuid'],
                {flag: -1, text: "订单创建失败: " + msg});
        } catch (ue) {
            console.error("newApply persist error failed:", ue);
        }
        // 包装后再抛出，调用方（processOne）可直接使用
        const wrapped: any = new Error(msg);
        wrapped.cause = e;
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
        // web-self（http-01验证）不需要DNS检查，直接提交验证
        let lookup: query.DnsLookup | null = domain_item.type === "web-self"
            ? null
            : await dnsCheck(author_save, domain_item)
        let author_flag: boolean = domain_item.type === "web-self"
            ? (author_save[domain_item.name] != undefined)
            : !!lookup?.matched
        if (status_flag == -1) {
            domain_save.push(domain_item);
            continue
        }
        console.log(domain_item.name, author_flag);
        if (!author_flag) { // 本地验证失败 ========================================================
            // dns-auto 的失败常见于同名 TXT 遮蔽 CNAME（解析器不再跟随 CNAME，
            // CA 读不到 DCV_AGENT 上的值）。cnameEnsure 只在 setApply 阶段跑过一次，
            // 旧订单不会重跑，因此这里补一次自愈清理。
            let cleaned = 0;
            if (domain_item.type === "dns-auto") {
                try {
                    // 先算出必须保留的 TXT（同域名的 dns-self 活动订单可能正依赖它们），
                    // 为 null 表示无法确认占用情况，此时放弃清理以免误删。
                    const protect = await protectedTxtValues(dao, domain_item.name);
                    if (protect !== null) {
                        cleaned = await agent.healShadowingTxt(env, domain_item.name, protect);
                    }
                } catch (e) {
                    console.warn(`[certs] 自愈清理同名 TXT 失败 ${domain_item.name}:`, e);
                }
            }
            if (cleaned > 0) {
                // 已清掉遮蔽记录：保持 flag=3 让下一轮 cron 自动重试。
                // 不能落到 flag=2 —— 该状态在 opDomain(…, []) 下不会推进，
                // 会把本可自动恢复的订单挂起，等用户手点「验证全部」。
                domain_item.flag = 3;
                status_flag = 3;
                domain_fail.push(
                    `${domain_item.name}: 已自动清理 ${cleaned} 条遮蔽 CNAME 的同名 TXT，稍后自动重试`
                );
            } else {
                domain_item.flag = 2;
                status_flag = 2
                // 记录失败原因，供订单 text 字段展示
                domain_fail.push(
                    lookup
                        ? `${domain_item.name}: ${query.describeLookup(lookup)}`
                        : `${domain_item.name}: 未获取到 ACME 验证挑战`
                );
            }
        } else { // 本地验证成功 =====================================================================
            let author_data: Record<string, any> = author_save[domain_item.name]
            // challenge 的状态集合是 pending | processing | valid | invalid（RFC 8555 §7.1.6）。
            // 旧实现只判断了 invalid / pending / valid，processing 会从三个分支中间漏过去：
            // 既不标记完成也不标记失败，而 status_flag 仍为初值 4，于是订单被置为
            // 「申请中」并写下「域名验证通过」—— 状态卡死且文案与事实相反。
            let ch_status: string = String(author_data.data['status'] ?? "")
            if (ch_status == "invalid") { // 已有验证失败
                domain_item.flag = -1;
                status_flag = -1;
            } else if (ch_status == "valid") {
                domain_item.flag = 4;
            } else {
                // pending：尚未提交，需要先 verifyChallenge / completeChallenge；
                // processing：CA 已受理并在异步校验，只需等待。
                let waited: "valid" | "pending" | "error" = "pending";
                let waitErr: any = null;
                try {
                    if (ch_status == 'pending') {
                        let upload_flag: boolean = await client_data.verifyChallenge(author_data.auth, author_data.data);
                        console.log('Domain Server Verify Status:', upload_flag);
                        let submit_flag: any = await client_data.completeChallenge(author_data.data);
                        console.log('Domain Remote Upload Status:', submit_flag['status']);
                    }
                    let result_flag = await client_data.waitForValidStatus(author_data.data);
                    console.log('Domain Remote Verify Status:', result_flag['status']);
                    waited = result_flag.status == "valid" ? "valid" : "pending";
                } catch (error) {
                    // waitForValidStatus 超时或网络异常时 CA 可能仍在校验，不能直接判失败。
                    // 保留 flag=3 交由下一轮 cron 继续；若确实被 CA 判为 invalid，
                    // 下一轮 getAuthy 会取回 invalid 状态并走上面的失败分支。
                    console.log('Domain Remote Verify Errors:', error);
                    waited = "error";
                    waitErr = error;
                }
                const outcome = challengeOutcome(waited);
                domain_item.flag = outcome.domainFlag;
                if (outcome.statusFlag !== null) status_flag = outcome.statusFlag;
                if (outcome.retry) {
                    domain_fail.push(
                        `${domain_item.name}: 验证尚未完成（${extractAcmeError(waitErr)}），稍后自动重试`
                    );
                }
            }
        }
        domain_save.push(domain_item);
    }
    orders_data = await client_data.getOrder(orders_text);
    // console.log(orders_data);
    await dao.updateApply(order_info['uuid'], {data: JSON.stringify(orders_data)})
    await dao.updateApply(order_info['uuid'], {list: JSON.stringify(domain_save)})
    await dao.updateApply(order_info['uuid'], {flag: status_flag})
    if (status_flag == -1) await dao.updateApply(order_info['uuid'], {
        text: "域名验证失败:" + JSON.stringify(domain_fail)
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
        await dao.updateApply(order_info['uuid'], {flag: -1})
        await dao.updateApply(order_info['uuid'], {text: "证书签发失败"})
        // 通知（失败不抛异常，不影响主流程）
        await notify(env, {
            event: "fail",
            domains: await safeDomainNames(order_info),
            mail: order_info['mail'],
            uuid: order_info['uuid'],
            detail: "ACME 侧返回 invalid，请检查域名解析或验证配置",
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
        try {
            await dao.updateApply(order_info['uuid'], {pending_keys: privateKeyBuff.toString()})
        } catch (e) {
            console.warn(
                `[certs] pending_keys 写入失败，回退为直接写 keys（uuid=${order_info['uuid']}）`, e
            );
            await dao.updateApply(order_info['uuid'], {keys: privateKeyBuff.toString()})
        }
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
        await dao.updateApply(order_info['uuid'], {text: "证书正在等待完成签发"})
    }
    if (orders_data.status === 'valid') {
        const certificate: any = await client_data.getCertificate(orders_data);// 获取证书
        // console.log('Orders Remote Issues Status:', certificate);
        // cert 与 keys 必须**同一次写入**：只要二者不同步，下载端就可能拿到
        // 不匹配的一对。pending_keys 是本轮 ready 阶段生成的新私钥；
        // 若它缺失（老数据 / 异常中断）则保留原 keys，避免把私钥写没。
        const pendingKeys = order_info['pending_keys'];
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
 * 判定 dns-auto 模式下 `_acme-challenge.<域名>` 上的同名 TXT 是否构成遮蔽。
 * -------------------------------------------------------------------------
 * DNS 规定同一名字上 CNAME 不能与其它记录共存。若该名字上还有 TXT，
 * 解析器会返回这条 TXT 而不再跟随 CNAME，CA 因此读不到 DCV_AGENT 上的值。
 *
 * 但不能一见 TXT 就判失败：若该 TXT 恰好就是本次的验证值（用户可能手工
 * 把值填在了 `_acme-challenge` 上），CA 一样能验证通过，此时应视为成功。
 *
 * @param found 该名字上实际查到的 TXT 值
 * @param expected 本次验证期望的值
 * @returns clear=无 TXT；matched=有 TXT 且含期望值；shadowed=有 TXT 但不含期望值
 */
export function shadowVerdict(found: string[], expected: string): "clear" | "matched" | "shadowed" {
    if (!found || found.length === 0) return "clear";
    return found.includes(String(expected ?? "")) ? "matched" : "shadowed";
}

/**
 * 计算自愈清理时必须保留的 TXT 值集合。
 * -------------------------------------------------------------------------
 * 自愈会删除 `_acme-challenge.<域名>` 上的同名 TXT，但 dns-self 订单的验证
 * 恰恰依赖用户手工放在该名字上的 TXT。若同域名存在另一张活动的 dns-self
 * 订单，直接删除会毁掉那张订单的验证，因此先把这些值收集起来。
 *
 * 只收集 dns-self 的 auth：dns-auto 的 auth 放在 `<hash>.<DCV_AGENT>` 上，
 * 本来就不在 `_acme-challenge.<域名>`，不应参与保护（否则会保护到自己的旧值）。
 *
 * @returns 受保护的值集合；读取订单失败时返回 null（调用方应放弃删除）
 */
export async function protectedTxtValues(dao: any, host: string): Promise<Set<string> | null> {
    const protect = new Set<string>();
    const target = `_acme-challenge.${String(host ?? "").replace(/^\*\./, "").trim().toLowerCase()}`;
    try {
        const active: any = await dao.scanApplies({lte: {flag: 4}});
        // scanApplies 可能返回数组或按 uuid 索引的对象，统一成可遍历的值集合
        const rows: any[] = Array.isArray(active) ? active : Object.values(active ?? {});
        for (const row of rows) {
            // 只保护仍在进行中的订单：已完成(5)/失败(<0)的订单不再需要其记录
            const flag = Number(row?.flag ?? -1);
            if (flag < 0 || flag > 4) continue;
            let list: any[];
            try {
                list = JSON.parse(row?.list ?? "[]");
            } catch { continue; }
            for (const d of list) {
                if (String(d?.type ?? "") !== "dns-self") continue;
                const name = String(d?.name ?? "").replace(/^\*\./, "").trim().toLowerCase();
                if (!name || `_acme-challenge.${name}` !== target) continue;
                const auth = String(d?.auth ?? "").trim();
                if (auth) protect.add(auth);
            }
        }
    } catch (e) {
        // 无法确认占用情况时保守处理：宁可留着陈旧 TXT，也不误删他人记录
        console.warn(`[certs] 读取活动订单失败，跳过 TXT 自愈清理 ${host}:`, e);
        return null;
    }
    return protect;
}

async function dnsCheck(author_save: any, domain_item: any): Promise<query.DnsLookup | null> {
    if (author_save[domain_item.name] == undefined) return null;
    // 设置数据 =============================================
    let domain_name = domain_item.name.replaceAll("*.", "")
    let author_text = domain_item.auth; // 目标解析记录
    let domain_type = "TXT" // 待验证域名格式文本TXT
    if (domain_item.type == "dns-auto") { // 如果DNS-AUTO模式
        domain_type = "CNAME" // 此时需检查CNAME而不是TXT记录
        author_text = domain_item.auto // 验证内容也改为CNAME
    } // 查询DNS ============================================
    const name = "_acme-challenge." + domain_name;
    // dns-auto 模式额外查一次 TXT，判定同名 TXT 是否遮蔽了 CNAME
    if (domain_type === "CNAME") {
        const shadow = await query.lookupDNS(name, "TXT", domain_item.auth);
        const verdict = shadowVerdict(shadow.found, domain_item.auth);
        if (verdict === "matched") {
            // 同名 TXT 已包含验证值，CA 能验证通过
            return {name, type: "TXT", expect: author_text, found: shadow.found, matched: true};
        }
        if (verdict === "shadowed") {
            return {
                name,
                type: "TXT",
                expect: `(无 TXT，仅保留 CNAME → ${author_text})`,
                found: shadow.found,
                matched: false,
                hint: `存在 ${shadow.found.length} 条同名 TXT 记录，会遮蔽 CNAME 导致 CA 读不到验证值；` +
                    `请删除这些 TXT 后重试（本系统会自动清理）`,
            };
        }
    }
    // 返回完整诊断信息（期望值 + 实际值），使失败原因能展示给用户
    return await query.lookupDNS(name, domain_type, author_text);
}

async function dnsOrder(author_save: any, domain_item: any) {

}