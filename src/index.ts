import {Context, Hono} from 'hono'
import type {UserRow} from './db/dao'
import {opDomain} from "./certs";
import {cleanDNS} from "./query";
import * as agent from "./agent";
import {hmacSHA2} from "./users";
import {readConf} from "./db/conf";
import * as users from './users';
import * as certs from './certs';
import type {BackgroundContext} from "./notify";
import * as local from "hono/cookie";
import {mountSetupRoutes} from "./routes/setup";
import {mountAdminUsersRoutes} from "./routes/admin_users";
import {mountAdminCertsRoutes} from "./routes/admin_certs";
import {mountAdminConfsRoutes} from "./routes/admin_confs";
import {mountCertDownloadRoutes} from "./routes/cert_download";
import {mountOpenApiRoutes} from "./routes/openapi";
import {mountAccountApiRoutes} from "./routes/account_api";

// 绑定数据 ###############################################################################
// DB_SOURCE：空/d1 → Cloudflare D1；mysql → mysql2；prisma → PrismaClient
// 具体的附加变量（DB_MYSQL_*、DATABASE_URL）在 DB_SOURCE 对应时才会被读取。
export type Bindings = {
    // 数据源 --------------------------------------------------------
    DB_CF?: D1Database, DB_SOURCE?: string,
    DB_MYSQL_URL?: string, DB_MYSQL_HOST?: string, DB_MYSQL_PORT?: string,
    DB_MYSQL_USER?: string, DB_MYSQL_PASS?: string, DB_MYSQL_NAME?: string,
    DATABASE_URL?: string,
    // 邮件 / 站点 / 鉴权 -------------------------------------------
    MAIL_KEYS: string, MAIL_SEND: string, AUTH_KEYS: string, SITE_KEYS?: string,
    SITE_HOST?: string, SITE_TITLE?: string,
    // 初始化安全（防止站点被扫到后抢注管理员）----------------------
    // ADMIN_MAIL + ADMIN_PASS 同时存在时：首次请求自动创建管理员，完全跳过初始化向导
    // SETUP_TOKEN：未预置管理员时，初始化向导必须携带该令牌
    // 两者都没有 → 初始化接口直接拒绝（fail-closed），需要先配置后再访问
    ADMIN_MAIL?: string, ADMIN_PASS?: string, SETUP_TOKEN?: string,
    // DNS 代理 -----------------------------------------------------
    DCV_AGENT: string, DCV_EMAIL: string, DCV_TOKEN: string, DCV_ZONES: string,
    // ACME 账号（各 CA 的 EAB） -----------------------------------
    GTS_keyMC: string, GTS_keyID: string, GTS_KeyTS: string, GTS_useIt: string,
    SSL_keyMC: string, SSL_keyID: string, SSL_KeyTS: string, SSL_useIt: string,
    ZRO_keyMC: string, ZRO_keyID: string, ZRO_KeyTS: string, ZRO_useIt: string
}

/**
 * 明确要求 D1 绑定的环境类型。
 * 供需要在编译期断言 DB_CF 存在的调用方（如定时任务入口）使用；
 * 业务模块统一通过 DAO 访问数据，不直接依赖具体数据源。
 */
export type D1Bindings = Bindings & { DB_CF: D1Database };

/** 通过 c.set() 注入到请求上下文里的变量 */
export type AppVariables = {
    admin?: UserRow,
    apiUser?: UserRow,
};

/** 全项目统一的 Hono 环境类型（app / 各路由模块 / 中间件共用） */
export type AppEnv = { Bindings: Bindings, Variables: AppVariables };

/**
 * 把状态机推进交给响应之后的后台任务。
 * ACME 的每次签名请求都会重新获取 nonce，而 newNonce 单次可达 8~32s。
 * 走到「待验证」需 3 次串行签名请求（createOrder → getOrder → getAuthorizations），
 * 按实测中位数约 30s，正好撞上前端 30s 请求超时；更长则触发 Cloudflare
 * 网关 524（默认 125s 读超时）。
 * 订单状态每步都持久化，后台任务被截断时由 cron 继续推进，不会丢单。
 *
 * Node.js 自托管（@hono/node-server）没有 ExecutionContext，读取
 * c.executionCtx 会直接抛错；此时进程常驻，直接后台执行即可。
 */
function processInBackground(c: Context<AppEnv>, uuid: string, tag: string) {
    let ctx: BackgroundContext | undefined;
    try {
        ctx = c.executionCtx as BackgroundContext;
    } catch {
        ctx = undefined;
    }
    const run = () => certs.processOne(c.env, uuid, ctx).catch((e) => {
        console.error(`${tag} background processOne error:`, e);
    });
    if (ctx && typeof ctx.waitUntil === "function") {
        ctx.waitUntil(run());
        return;
    }
    void run();
}

/** 订单列表默认每页条数 */
const ORDER_PAGE_SIZE_DEFAULT = 20;
/** 订单列表最大每页条数 */
const ORDER_PAGE_SIZE_MAX = 200;
/** 待验证订单的失效宽限期（与前端 PENDING_EXPIRE_DAYS 一致） */
const PENDING_EXPIRE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * 派生状态过滤条件，与前端 classifyFlag 的判定保持一致：
 *   signed     flag=5 且未过期（next=0 表示未记录到期时间，视为有效）
 *   expired    flag=5 且已过期
 *   verifying  flag=3/4
 *   pending    flag=0/1/2 且未超过失效宽限期（time=0 视为未超时）
 *   failed     flag=-1，或 flag=0/1/2 且已超过失效宽限期
 * 使用 lte flag=4 等可命中 idx_apply_flag，避免全表扫描。
 */
function statusFilter(status: string): import("./db/dao").QueryFilter | null {
    const now = Date.now();
    switch (status) {
        case "signed":
            return {and: [{eq: {flag: 5}}, {or: [{eq: {next: 0}}, {gte: {next: now}}]}]};
        case "expired":
            return {and: [{eq: {flag: 5}}, {gte: {next: 1}}, {lte: {next: now - 1}}]};
        case "verifying":
            return {in: {flag: [3, 4]}};
        case "pending":
            return {
                and: [
                    {in: {flag: [0, 1, 2]}},
                    {or: [{eq: {time: 0}}, {gte: {time: now - PENDING_EXPIRE_MS}}]},
                ],
            };
        case "failed":
            return {
                or: [
                    {eq: {flag: -1}},
                    {
                        and: [
                            {in: {flag: [0, 1, 2]}},
                            {gte: {time: 1}},
                            {lte: {time: now - PENDING_EXPIRE_MS - 1}},
                        ],
                    },
                ],
            };
        default:
            return null;
    }
}

/** 读取分页参数，做上下界收敛 */
function readPaging(c: Context): { page: number; pageSize: number } {
    const q = c.req.query();
    const page = Math.max(1, parseInt(q.page ?? "1", 10) || 1);
    const pageSize = Math.min(
        ORDER_PAGE_SIZE_MAX,
        Math.max(1, parseInt(q.page_size ?? String(ORDER_PAGE_SIZE_DEFAULT), 10) || ORDER_PAGE_SIZE_DEFAULT)
    );
    return {page, pageSize};
}

/**
 * 构造本人订单的查询条件。
 * status 为派生状态；"pending" 同时涵盖验证中（与列表页「处理中」筛选项一致）。
 * q 为域名关键字，匹配 list 字段。
 */
function buildOwnOrderFilter(c: Context, mail: string): import("./db/dao").QueryFilter {
    const status = String(c.req.query("status") ?? "all");
    const keyword = String(c.req.query("q") ?? "").trim();

    const filter: import("./db/dao").QueryFilter = {eq: {mail}};
    if (status === "pending") {
        // 「处理中」= 待验证 + 验证中
        filter.and = [{or: [statusFilter("pending")!, statusFilter("verifying")!]}];
    } else {
        const sub = statusFilter(status);
        if (sub) filter.and = [sub];
    }

    // 关键字同时匹配域名（list 字段）与订单号，与原前端搜索行为一致
    if (keyword) {
        filter.and = [
            ...(filter.and ?? []),
            {or: [{like: {list: keyword}}, {like: {uuid: keyword}}]},
        ];
    }
    return filter;
}

/**
 * 用户订单列表：服务端过滤 + 分页，只返回摘要字段（不含 cert / keys / data）。
 */
async function listOwnOrders(
    c: Context,
    dao: import("./db/dao").Dao,
    mail: string
): Promise<{ rows: Record<string, any>[]; total: number }> {
    const {page, pageSize} = readPaging(c);
    return await dao.listApplySummaries(buildOwnOrderFilter(c, mail), {
        page, pageSize, orderBy: "time", orderDesc: true,
    }) as any;
}

/**
 * 订单状态统计：对全部本人订单按派生状态计数。
 * 首页需要完整统计，分页后无法由单页数据推导，因此单独用 COUNT 查询。
 */
async function countOwnOrderStats(
    c: Context,
    dao: import("./db/dao").Dao,
    mail: string
): Promise<Record<string, number>> {
    const base = {eq: {mail}};
    const [total, signed, expired, verifying, pending, failed] = await Promise.all([
        dao.countApplies(base),
        dao.countApplies({and: [base, statusFilter("signed")!]}),
        dao.countApplies({and: [base, statusFilter("expired")!]}),
        dao.countApplies({and: [base, statusFilter("verifying")!]}),
        dao.countApplies({and: [base, statusFilter("pending")!]}),
        dao.countApplies({and: [base, statusFilter("failed")!]}),
    ]);
    return {total, pending, verifying, signed, expired, failed};
}

/**
 * 删除订单时清理其写入的 DCV 验证记录。
 * -------------------------------------------------------------------------
 * 记录名由「域名 + 用户邮箱」的 HMAC 前 16 位与 DCV_AGENT 拼接而成，
 * 因此可以脱离订单数据重新算出，无需依赖 list 中的 auto 字段。
 * 清理失败不影响订单删除，仅记录日志。
 */
async function cleanupOrderRecords(env: Bindings, order: Record<string, any> | undefined): Promise<void> {
    if (!order) return;
    try {
        const agentHost = String((await readConf(env as any, "DCV_AGENT")) ?? "").trim();
        if (!agentHost) return;
        const mail = String(order['mail'] ?? "");
        const list: any[] = JSON.parse(String(order['list'] ?? "[]"));
        if (!Array.isArray(list)) return;
        for (const d of list) {
            if (d?.type !== "dns-auto") continue;
            const name = String(d?.name ?? "").replace(/^\*\./, "");
            if (!name) continue;
            const hash = await hmacSHA2(name, mail);
            const recordName = hash.substring(0, 16) + "." + agentHost;
            try {
                await agent.dnsDel(env, recordName);
            } catch (e) {
                console.warn(`[order] 清理验证记录失败 ${recordName}`, e);
            }
        }
    } catch (e) {
        console.warn("[order] 清理订单验证记录失败", e);
    }
}

export const app = new Hono<AppEnv>()

// 初始化向导 #############################################################################
// GET /bootstrap → 前端启动时调用，返回初始化/数据源状态
// POST /setup    → 首次初始化（完成后写入 Confs 并将指定邮箱升级为管理员）
mountSetupRoutes(app);

// 管理员 - 用户管理 ######################################################################
mountAdminUsersRoutes(app);

// 管理员 - 证书管理 ######################################################################
mountAdminCertsRoutes(app);

// 管理员 - 系统配置 ######################################################################
mountAdminConfsRoutes(app);

// 证书下载增强（ZIP / PFX） ##############################################################
mountCertDownloadRoutes(app);

// 开放 API（/api/v1/*） ###################################################################
mountOpenApiRoutes(app);

// 用户自助 API token #####################################################################
mountAccountApiRoutes(app);

// 获取信息 ###############################################################################
app.get('/users/', async (c: Context): Promise<Response> => {
    return c.json({})
});

// 获取种子 ###############################################################################
app.get('/nonce/', async (c: Context): Promise<Response> => {
    return await users.getNonce(c);
});

// 核查状态 ###############################################################################
app.get('/panel/', async (c: Context): Promise<Response> => {
    if (!await users.userAuth(c)) return c.redirect("/#/login", 302);
    return c.redirect("/#/panel", 302);
})

// 申请证书 ###############################################################################
app.use('/apply/', async (c: Context): Promise<Response> => {
    if (c.req.method !== 'POST') return c.json({"flags": 1, "texts": "请求方式无效"}, 400);
    if (!await users.userAuth(c)) return c.json({"flags": 2, "texts": "用户尚未登录"}, 401);
    // 读取数据
    try {
        let upload_json = await c.req.json();
        let domain_list = upload_json['domains'];
        let domain_save = []
        for (let domain in domain_list) {
            // console.log(domain,domain_list[domain]);
            domain_list[domain]["flag"] = 0;
            domain_list[domain]["text"] = "";
            domain_save.push(domain_list[domain]);
        }

        // 三重校验：captcha / 月度上限 / 配额 ------------------------------------
        const user_mail = local.getCookie(c, 'mail') ?? "";
        const {ensureDao} = await import("./db");
        const dao = await ensureDao(c.env as any);
        const userRow = await dao.getUser(user_mail);
        if (!userRow) return c.json({flags: 4, texts: "用户不存在"}, 401);
        // WEB 文件验证走 http-01，而 CA 无法对 `*.example.com` 发 HTTP 请求，
        // 通配符授权只提供 dns-01。这种组合永远无法通过，在落库前就拒绝，
        // 避免用户拿到一个必然失败的订单。
        const badWildcard = domain_save.find(
            (d: any) => d?.type === 'web-self' && String(d?.name ?? '').startsWith('*.')
        );
        if (badWildcard) {
            return c.json({
                flags: 10,
                texts: `${badWildcard.name} 是通配符域名，无法使用 WEB 文件验证，请改用 DNS 自动验证或去掉通配符`,
            }, 400);
        }
        const {checkApplyGuard} = await import("./middleware/applyGuard");
        const guard = await checkApplyGuard(c, {
            source: "web",
            user: userRow,
            captchaToken:
                upload_json['captcha_token'] ??
                upload_json['captchaToken'] ??
                null,
            sign: upload_json['globals']?.['ca'],
        });
        if (!guard.ok) {
            return c.json({
                flags: 10, code: guard.code, texts: guard.message,
            }, guard.status as any);
        }

        // console.log(domain_save);
        let uuid = await users.newNonce(16)
        const applyDao = await (await import("./db")).ensureDao(c.env as any);
        await applyDao.insertApply({
            uuid: uuid,
            mail: local.getCookie(c, 'mail'),
            sign: upload_json['globals']['ca'],
            type: upload_json['globals']['encryption'],
            auto: upload_json['globals']['auto_renew'],
            flag: 0,
            time: Date.now(),
            main: JSON.stringify(upload_json['subject']),
            list: JSON.stringify(domain_save),
            keys: "",
            cert: "",
            next: new Date(new Date().setDate(new Date().getDate() + 7)).getTime(),
            text: "订单提交成功",
        } as any)
        // 订单已落库，状态机推进交由后台任务完成，接口立即返回以便前端轮询进度。
        processInBackground(c, uuid, "apply");
        return c.json({"flags": 0, "texts": "订单已提交，正在后台处理", "order": uuid}, 200);
    } catch (error) {
        return c.json({"flags": 3, "texts": "请求数据无效: " + error}, 400);
    }
})

// 查询申请配额（供前端申请页展示） #########################################################
app.get('/apply/quota', async (c: Context): Promise<Response> => {
    if (!await users.userAuth(c)) return c.json({flags: 2, texts: "用户尚未登录"}, 401);
    const mail = local.getCookie(c, 'mail') ?? "";
    try {
        const {ensureDao} = await import("./db");
        const {readInt} = await import("./db/conf");
        const dao = await ensureDao(c.env as any);
        const user = await dao.getUser(mail);
        if (!user) return c.json({flags: 4, texts: "用户不存在"}, 401);
        const limit = await readInt(c.env as any, "MONTHLY_APPLY_LIMIT", 0);
        const now = new Date();
        const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
        const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
        const used = await dao.countAppliesByMailInRange(mail, start, end);
        const active = await dao.countActiveAppliesByMail(mail);
        return c.json({
            flags: 0,
            monthly_limit: limit,
            month_used: used,
            quota: Number(user.quota ?? -1),
            active_certs: active,
        });
    } catch (e: any) {
        return c.json({flags: 5, texts: e?.message ?? String(e)}, 500);
    }
});

// 订单状态统计 ###############################################################################
// 首页概览需要全部订单的派生状态计数；列表分页后无法由单页推导，故单独提供。
app.get('/order/stats', async (c: Context): Promise<Response> => {
    if (!await users.userAuth(c)) return c.json({"flags": 2, "texts": "用户尚未登录"}, 401);
    const mail = local.getCookie(c, 'mail');
    if (!mail) return c.json({"flags": 4, "texts": "用户尚未登录"}, 401);
    try {
        const {ensureDao} = await import("./db");
        const dao = await ensureDao(c.env as any);
        const stats = await countOwnOrderStats(c, dao, mail);
        return c.json({"flags": 0, "stats": stats}, 200);
    } catch (e: any) {
        return c.json({"flags": 3, "texts": "请求数据无效: " + (e?.message ?? e)}, 400);
    }
})

// 获取订单 ###############################################################################
app.use('/order/', async (c: Context): Promise<Response> => {
    if (c.req.method !== 'GET') return c.json({"flags": 1, "texts": "请求方式无效"}, 400);
    if (!await users.userAuth(c)) return c.json({"flags": 2, "texts": "用户尚未登录"}, 401);
    let order_uuid: string = <string>c.req.query('id'); // 用户邮件
    let order_acts: string = <string>c.req.query('op'); // 执行操作
    let order_push: string = <string>c.req.query('cd'); // 执行操作
    let user_email: string | undefined = local.getCookie(c, 'mail')
    if (!order_uuid) return c.json({"flags": 5, "texts": "订单ID不存在"}, 401);
    if (!user_email) return c.json({"flags": 4, "texts": "用户尚未登录"}, 401);
    // 读取数据 ============================================================================
    try {
        const {ensureDao} = await import("./db");
        const dao = await ensureDao(c.env as any);
        let order_data: Record<string, any>[];
        let list_total = 0;
        if (order_uuid == "all") {
            const listed = await listOwnOrders(c, dao, user_email);
            order_data = listed.rows;
            list_total = listed.total;
        } else {
            const one = await dao.getApply(order_uuid);
            order_data = (one && String(one.mail) === user_email) ? [one as any] : [];
        }
        // if (order_data.length < 1)
        //     return c.json({"flags": 6, "texts": "请求订单无效"}, 400);
        if (order_acts == undefined || order_acts === "") { // 获取订单信息 -----------
            if (order_uuid == "all") {
                const {page, pageSize} = readPaging(c);
                return c.json({
                    "flags": 0,
                    "order": order_data,
                    "total": list_total,
                    "page": page,
                    "page_size": pageSize,
                }, 200);
            }
            return c.json({"flags": 0, "order": order_data[0]}, 200);
        } else { // 对订单执行操作 ----------------------------------------------------------
            if (order_acts === "verify" && order_data[0].flag == 2) {// 提交验证请求
                await dao.updateApply(order_uuid, {flag: 3})
                let order_info = order_data[0]; // 获取当前订单详细情况
                let order_mail = order_info['mail']; // 当前订单用户邮箱
                let order_user: any = await dao.getUser(order_mail);
                await opDomain(c.env, order_user, order_info, ["all"]);
                // opDomain 只负责把域名标记为待验证；实际验证与签发在此后台推进。
                // 否则订单会停在 flag=3 直到下一次 cron。
                // 本地 DNS 预检未通过时 dnsAuthy 会把订单退回 flag=2，可重试。
                processInBackground(c, order_uuid, "verify");
            } else if (order_acts === "process") { // 立即按当前 flag 一键推进到底
                let order_info = order_data[0]; // 获取当前订单详细情况
                let cur_flag = Number(order_info['flag']);
                if (cur_flag === 5 || cur_flag < 0)
                    return c.json({"flags": 0, "texts": "当前订单无需处理", "order": order_acts});
                if (cur_flag === 2) { // 等待 DNS 配置阶段：立即触发一次验证，再推进到底
                    await dao.updateApply(order_uuid, {flag: 3});
                    let order_mail = order_info['mail'];
                    let order_user: any = await dao.getUser(order_mail);
                    let fresh_info: any = await dao.getApply(order_uuid);
                    await opDomain(c.env, order_user, fresh_info, ["all"]);
                }
                // 与申请接口同理：ACME 交互耗时不可控，放到响应之后执行，
                // 由前端轮询订单状态获取进度，cron 作为兜底继续推进。
                processInBackground(c, order_uuid, "order");
            } else if (order_acts === "reload")
                await dao.updateApply(order_uuid, {flag: 0})
            else if (order_acts === "modify" || order_acts === "cancel") {
                // 删除订单前先清理它写入的 DCV 验证记录，否则记录会变成孤儿，
                // 下次申请同域名时 dnsAdd 会因记录已存在而失败。
                await cleanupOrderRecords(c.env, order_data[0]);
                await dao.deleteApply(order_uuid)
            }
            else if (order_acts === "single") {
                order_acts += "-" + order_push
                if (order_push == undefined || order_push == "undefined")
                    return c.json({"flags": 5, "texts": "请求操作无效", "order": order_acts});
                let order_info = order_data[0]; // 获取当前订单详细情况
                let order_mail = order_info['mail']; // 当前订单用户邮箱
                let order_user: any = await dao.getUser(order_mail);
                await opDomain(c.env, order_user, order_info, [order_push]);
                // 全部域名都已就绪时 opDomain 会把订单置为 flag=3，需后台推进；
                // 仍有域名待验证时订单为 flag=2，processOne 会立即返回，无副作用。
                processInBackground(c, order_uuid, "single");
            } else if (order_acts === "ca_get") {
                order_acts = order_data[0].cert;
            } else if (order_acts === "ca_key") {
                order_acts = order_data[0].keys;
            } else if (order_acts === "re_new") {
                await dao.updateApply(order_uuid, {flag: 0})
            } else if (order_acts === "rm_key") {
                // 一并清掉 pending_keys，否则 certs.healMissingKeys 会把私钥填回来，
                // 使「清空后无法恢复」的承诺失效。
                await dao.updateApply(order_uuid, {keys: "", pending_keys: ""})
            } else if (order_acts === "ca_del") {
                // 吊销证书：支持通过 cd 参数传递 RFC5280 吊销原因码（数字 0/1/3/4/5 等）
                let order_info = order_data[0];
                let reason_raw = c.req.query('reason');
                let reason_num = 0;
                if (reason_raw === undefined || reason_raw === "") {
                    // 兼容旧调用：cd 没有具体域名语义时可复用为原因码
                    const cd_num = Number(order_push);
                    if (Number.isFinite(cd_num)) reason_num = cd_num;
                } else {
                    const n = Number(reason_raw);
                    if (Number.isFinite(n)) reason_num = n;
                }
                const revoke_res: any = await certs.revokeCert(c.env, order_info, reason_num);
                if (revoke_res && revoke_res.flags !== 0) {
                    return c.json({
                        "flags": revoke_res.flags,
                        "texts": revoke_res.texts,
                        "order": order_acts,
                    }, 400);
                }
            } else
                return c.json({"flags": 5, "texts": "请求操作无效", "order": order_acts});
            return c.json({"flags": 0, "texts": "执行操作成功", "order": order_acts});
        }
    } catch (error) {
        return c.json({"flags": 3, "texts": "请求数据无效: " + error}, 400);
    }
})

// 用户注册 ###############################################################################
app.get('/setup/', async (c: Context): Promise<Response> => {
    return users.userRegs(c);
})

// 用户登录 ###############################################################################
app.get('/login/', async (c: Context): Promise<Response> => {
    return users.userPost(c)
})

// 检查登录 ###############################################################################
app.use('/check/', async (c: Context): Promise<Response> => {
    if (!await users.userAuth(c)) return c.json({"flags": 2, "texts": "用户尚未登录"}, 401);
    let user_email: string | undefined = local.getCookie(c, 'mail');
    // 附带 is_admin / quota 字段便于前端控制菜单与操作
    let is_admin = 0;
    let quota = -1;
    try {
        const dao = await (await import("./db")).ensureDao(c.env as any);
        const u = await dao.getUser(user_email ?? "");
        if (u) {
            is_admin = Number(u.is_admin ?? 0);
            quota = Number(u.quota ?? -1);
        }
    } catch {/* ignore, 保持默认 */}
    return c.json({"flags": 0, "texts": user_email, "is_admin": is_admin, "quota": quota}, 200);
})

// 退出登录 ###############################################################################
app.get('/exits/', async (c: Context): Promise<Response> => {
    return users.userExit(c)
})

// 定时任务 ###############################################################################
app.get('/tests/', async (c: Context): Promise<Response> => {
    let result: any[] = await certs.Processing(c.env, c.executionCtx);
    return c.json(result)
})

// 定时任务 ###############################################################################
app.get('/tasks/', async (c: Context): Promise<Response> => {
    let result: any[] = await certs.Processing(c.env, c.executionCtx);
    return c.json(result)
})

// 更新密钥 ###############################################################################
app.use('/acmes/', async (c: Context): Promise<Response> => {
    if (c.req.method !== 'POST') return c.json({"flags": 1, "texts": "请求方式无效"}, 400);
    if (!await users.userAuth(c)) return c.json({"flags": 2, "texts": "用户尚未登录"}, 401);
    let user_email: string | undefined = local.getCookie(c, 'mail')
    let privateKey: string = <string>(await c.req.json())['privateKey'];
    const acmeDao = await (await import("./db")).ensureDao(c.env as any);
    await acmeDao.updateUser(String(user_email), {keys: privateKey})
    return c.json({"flags": 0, "texts": "更新ACME密钥成功"}, 200)
})

// 删除账号 ###############################################################################
app.use('/erase/', async (c: Context): Promise<Response> => {
    if (c.req.method !== 'POST') return c.json({"flags": 1, "texts": "请求方式无效"}, 400);
    if (!await users.userAuth(c)) return c.json({"flags": 2, "texts": "用户尚未登录"}, 401);
    let user_email: string | undefined = local.getCookie(c, 'mail')
    let post_email: string = <string>(await c.req.json())['email'];
    if (user_email != post_email) return c.json({"flags": 5, "texts": "用户邮箱无效"}, 403);
    const eraseDao = await (await import("./db")).ensureDao(c.env as any);
    await eraseDao.deleteAppliesByMail(String(user_email))
    await eraseDao.deleteUser(String(user_email))
    return c.json({"flags": 0, "texts": "删除账号成功"}, 200)
})

// 更新密钥 ###############################################################################
app.use('/token/', async (c: Context): Promise<Response> => {
    if (c.req.method !== 'POST') return c.json({"flags": 1, "texts": "请求方式无效"}, 400);
    if (!await users.userAuth(c)) return c.json({"flags": 2, "texts": "用户尚未登录"}, 401);
    let user_email: string | undefined = local.getCookie(c, 'mail')
    let apis_token: string = <string>(await c.req.json())['privateKey'];
    const tokenDao = await (await import("./db")).ensureDao(c.env as any);
    await tokenDao.updateUser(String(user_email), {apis: apis_token})
    return c.json({"flags": 0, "texts": "更新API TOKEN密钥成功"}, 200)
})

// 定时任务 ###############################################################################
app.use('/clean/', async (c: Context): Promise<Response> => {
    const result: Record<string, any> = await cleanDNS(c.env);
    return c.json({"flag": result.flag, "text": result.text})
})

// 获取证书 ###############################################################################
app.use('/certs/:uuid', async (c: Context): Promise<any> => {
    const cert_uuid: string | undefined = c.req.param('uuid');
    const api_token: string | undefined = c.req.query('keys');
    if (cert_uuid === undefined || api_token === undefined)
        return c.json({"flags": 1, "texts": "证书订单ID或密钥无效"}, 400);
    const certDao = await (await import("./db")).ensureDao(c.env as any);
    const now_order: any = await certDao.getApply(cert_uuid);
    if (!now_order)
        return c.json({"flags": 3, "texts": "证书订单ID或密钥无效"}, 400);
    const now_email: string = now_order['mail'];
    const now_users: any = await certDao.getUser(now_email);
    if (!now_users || now_users['apis'] != api_token)
        return c.json({"flags": 3, "texts": "证书订单ID或密钥无效"}, 400);
    if (!now_order.cert || !now_order.keys)
        return c.json({"flags": 4, "texts": "此订单未完成或无密钥"}, 400);
    return c.json({
        "flags": 0, "texts": "证书密钥信息获取成功",
        "cert": now_order.cert, "keys": now_order.keys
    }, 200)
})


// 默认导出 ###############################################################################
export default app;