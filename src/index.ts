import {Context, Hono} from 'hono'
import type {UserRow} from './db/dao'
import {opDomain} from "./certs";
import {cleanDNS} from "./query";
import * as users from './users';
import * as saves from './saves';
import * as certs from './certs';
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
    // DNS 代理 -----------------------------------------------------
    DCV_AGENT: string, DCV_EMAIL: string, DCV_TOKEN: string, DCV_ZONES: string,
    // ACME 账号（各 CA 的 EAB） -----------------------------------
    GTS_keyMC: string, GTS_keyID: string, GTS_KeyTS: string, GTS_useIt: string,
    SSL_keyMC: string, SSL_keyID: string, SSL_KeyTS: string, SSL_useIt: string,
    ZRO_keyMC: string, ZRO_keyID: string, ZRO_KeyTS: string, ZRO_useIt: string
}

/**
 * 需要「直接」操作 D1 的模块（certs.ts 等）使用的绑定类型。
 * 这些代码绕过 DAO 抽象直接调用 saves.selectDB(env.DB_CF, ...)，
 * 因此要求 DB_CF 必然存在；缺失时由调用方给出明确报错，而不是中途 TypeError。
 */
export type D1Bindings = Bindings & { DB_CF: D1Database };

/** 通过 c.set() 注入到请求上下文里的变量 */
export type AppVariables = {
    admin?: UserRow,
    apiUser?: UserRow,
};

/** 全项目统一的 Hono 环境类型（app / 各路由模块 / 中间件共用） */
export type AppEnv = { Bindings: Bindings, Variables: AppVariables };

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
        const {checkApplyGuard} = await import("./middleware/applyGuard");
        const guard = await checkApplyGuard(c, {
            source: "web",
            user: userRow,
            captchaToken:
                upload_json['captcha_token'] ??
                upload_json['captchaToken'] ??
                null,
        });
        if (!guard.ok) {
            return c.json({
                flags: 10, code: guard.code, texts: guard.message,
            }, guard.status as any);
        }

        // console.log(domain_save);
        let uuid = await users.newNonce(16)
        await saves.insertDB(c.env.DB_CF, "Apply", {
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
        })
        // 创建订单后立即推进一次状态机（生成 ACME 订单 + 写入 TXT 挑战记录）
        // 若推进失败（如 ACME 服务端拒绝），把错误原因回显给前端，便于用户即时看到失败原因
        let apply_warn: string | null = null;
        try {
            await certs.processOne(c.env, uuid);
            // 再查一次订单，如果已经被置为失败状态（flag=-1），把 text 作为警告返回
            const fresh: any = await saves.selectDB(
                c.env.DB_CF, "Apply", {uuid: {value: uuid}});
            if (fresh && fresh[0] && Number(fresh[0].flag) < 0) {
                apply_warn = String(fresh[0].text || "证书申请处理失败");
            }
        } catch (e) {
            const {extractAcmeError} = await import("./certs");
            apply_warn = "证书申请处理失败: " + extractAcmeError(e);
            console.error("apply processOne error:", e);
        }
        if (apply_warn) {
            return c.json({
                "flags": 11, "texts": apply_warn, "order": uuid,
            }, 200);
        }
        return c.json({"flags": 0, "texts": "证书申请成功", "order": uuid}, 200);
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
        let order_data: Record<string, any>[];
        if (order_uuid == "all") {
            order_data = await saves.selectDB(c.env.DB_CF, "Apply", {
                mail: {value: user_email}
            });
            // console.log(user_email, order_data)
        } else {
            order_data = await saves.selectDB(c.env.DB_CF, "Apply", {
                uuid: {value: order_uuid},
                mail: {value: user_email}
            });
        }
        // if (order_data.length < 1)
        //     return c.json({"flags": 6, "texts": "请求订单无效"}, 400);
        if (order_acts == undefined || order_acts === "") { // 获取订单信息 -----------
            let order_save: any = order_uuid == "all" ? order_data : order_data[0];
            return c.json({"flags": 0, "order": order_save}, 200);
        } else { // 对订单执行操作 ----------------------------------------------------------
            if (order_acts === "verify" && order_data[0].flag == 2) {// 提交验证请求
                await saves.updateDB(c.env.DB_CF, "Apply", {flag: 3}, {uuid: order_uuid})
                let order_info = order_data[0]; // 获取当前订单详细情况
                let order_mail = order_info['mail']; // 当前订单用户邮箱
                let order_user: any = (await saves.selectDB( // 查询申请者信息
                    c.env.DB_CF, "Users", {mail: {value: order_mail}}))[0];
                await opDomain(c.env, order_user, order_info, ["all"]);
            } else if (order_acts === "process") { // 立即按当前 flag 一键推进到底
                let order_info = order_data[0]; // 获取当前订单详细情况
                let cur_flag = Number(order_info['flag']);
                if (cur_flag === 5 || cur_flag < 0)
                    return c.json({"flags": 0, "texts": "当前订单无需处理", "order": order_acts});
                if (cur_flag === 2) { // 等待 DNS 配置阶段：立即触发一次验证，再推进到底
                    await saves.updateDB(c.env.DB_CF, "Apply", {flag: 3}, {uuid: order_uuid});
                    let order_mail = order_info['mail'];
                    let order_user: any = (await saves.selectDB(
                        c.env.DB_CF, "Users", {mail: {value: order_mail}}))[0];
                    let fresh_info: any = (await saves.selectDB(
                        c.env.DB_CF, "Apply", {uuid: {value: order_uuid}}))[0];
                    await opDomain(c.env, order_user, fresh_info, ["all"]);
                }
                await certs.processOne(c.env, order_uuid);
            } else if (order_acts === "reload")
                await saves.updateDB(c.env.DB_CF, "Apply", {flag: 0}, {uuid: order_uuid})
            else if (order_acts === "modify" || order_acts === "cancel")
                await saves.deleteDB(c.env.DB_CF, "Apply", {uuid: order_uuid})
            else if (order_acts === "single") {
                order_acts += "-" + order_push
                if (order_push == undefined || order_push == "undefined")
                    return c.json({"flags": 5, "texts": "请求操作无效", "order": order_acts});
                let order_info = order_data[0]; // 获取当前订单详细情况
                let order_mail = order_info['mail']; // 当前订单用户邮箱
                let order_user: any = (await saves.selectDB( // 查询申请者信息
                    c.env.DB_CF, "Users", {mail: {value: order_mail}}))[0];
                await opDomain(c.env, order_user, order_info, [order_push]);
            } else if (order_acts === "ca_get") {
                order_acts = order_data[0].cert;
            } else if (order_acts === "ca_key") {
                order_acts = order_data[0].keys;
            } else if (order_acts === "re_new") {
                await saves.updateDB(c.env.DB_CF, "Apply", {flag: 0}, {uuid: order_uuid})
            } else if (order_acts === "rm_key") {
                await saves.updateDB(c.env.DB_CF, "Apply", {keys: ""}, {uuid: order_uuid})
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
    let result: any[] = await certs.Processing(c.env);
    return c.json(result)
})

// 定时任务 ###############################################################################
app.get('/tasks/', async (c: Context): Promise<Response> => {
    let result: any[] = await certs.Processing(c.env);
    return c.json(result)
})

// 更新密钥 ###############################################################################
app.use('/acmes/', async (c: Context): Promise<Response> => {
    if (c.req.method !== 'POST') return c.json({"flags": 1, "texts": "请求方式无效"}, 400);
    if (!await users.userAuth(c)) return c.json({"flags": 2, "texts": "用户尚未登录"}, 401);
    let user_email: string | undefined = local.getCookie(c, 'mail')
    let privateKey: string = <string>(await c.req.json())['privateKey'];
    await saves.updateDB(c.env.DB_CF, "Users", {keys: privateKey}, {mail: user_email})
    return c.json({"flags": 0, "texts": "更新ACME密钥成功"}, 200)
})

// 删除账号 ###############################################################################
app.use('/erase/', async (c: Context): Promise<Response> => {
    if (c.req.method !== 'POST') return c.json({"flags": 1, "texts": "请求方式无效"}, 400);
    if (!await users.userAuth(c)) return c.json({"flags": 2, "texts": "用户尚未登录"}, 401);
    let user_email: string | undefined = local.getCookie(c, 'mail')
    let post_email: string = <string>(await c.req.json())['email'];
    if (user_email != post_email) return c.json({"flags": 5, "texts": "用户邮箱无效"}, 403);
    await saves.deleteDB(c.env.DB_CF, "Apply", {mail: user_email})
    await saves.deleteDB(c.env.DB_CF, "Users", {mail: user_email})
    return c.json({"flags": 0, "texts": "删除账号成功"}, 200)
})

// 更新密钥 ###############################################################################
app.use('/token/', async (c: Context): Promise<Response> => {
    if (c.req.method !== 'POST') return c.json({"flags": 1, "texts": "请求方式无效"}, 400);
    if (!await users.userAuth(c)) return c.json({"flags": 2, "texts": "用户尚未登录"}, 401);
    let user_email: string | undefined = local.getCookie(c, 'mail')
    let apis_token: string = <string>(await c.req.json())['privateKey'];
    await saves.updateDB(c.env.DB_CF, "Users", {apis: apis_token}, {mail: user_email})
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
    const now_order: any = await saves.selectDB(
        c.env.DB_CF, "Apply", {uuid: {value: cert_uuid}});
    if (now_order.length == 0)
        return c.json({"flags": 3, "texts": "证书订单ID或密钥无效"}, 400);
    const now_email: string = now_order[0]['mail'];
    const now_users: any = await saves.selectDB(
        c.env.DB_CF, "Users", {mail: {value: now_email}});
    if (now_users.length == 0 || now_users[0]['apis'] != api_token)
        return c.json({"flags": 3, "texts": "证书订单ID或密钥无效"}, 400);
    if (now_order[0].cert.length == 0 || now_order[0].keys.length == 0)
        return c.json({"flags": 4, "texts": "此订单未完成或无密钥"}, 400);
    return c.json({
        "flags": 0, "texts": "证书密钥信息获取成功",
        "cert": now_order[0].cert, "keys": now_order[0].keys
    }, 200)
})


// 默认导出 ###############################################################################
export default app;