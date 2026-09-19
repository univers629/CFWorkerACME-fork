import {Context} from "hono";
import * as saves from './saves'
import * as local from "hono/cookie";
import {Resend} from "resend";
import CryptoJS from "crypto-js";// @ts-ignore
import {generateKeyPairSync} from "crypto";


// 获取种子 ###############################################################################
export async function getNonce(c: Context, lens: number = 8) {
    const email = <string>c.req.query('email');
    const setup = <string>c.req.query('setup');
    const reset = <string>c.req.query('reset');
    const invite = <string>(c.req.query('invite') ?? "");
    let user_db: Record<string, any> = await getUsers(c, email);
    const nonce: string = await newNonce(lens);
    // 注册新用户 ========================================================================
    if (setup != undefined && setup.length > 0 && (setup == "1" || setup == "true") ||
        reset != undefined && reset.length > 0 && (reset == "1" || reset == "true")) {
        if (!await Turnstile(c, "base")) return c.json({"nonce": "请先完成验证"}, 403);

        // 仅在注册路径（setup=1）校验注册策略；reset 走密码重置不需要
        const isRegister = setup == "1" || setup == "true";
        if (isRegister) {
            try {
                const {readBool, readConf} = await import("./db/conf");
                const allow = await readBool(c.env as any, "REGISTER_ALLOW", true);
                if (!allow) {
                    return c.json({"nonce": "当前站点未开放注册"}, 403);
                }
                const code = (await readConf(c.env as any, "REGISTER_CODE")) ?? "";
                if (code.length > 0 && invite !== code) {
                    return c.json({"nonce": "邀请码错误"}, 400);
                }
            } catch (e) {
                console.error("[getNonce] read register policy failed:", e);
            }
        }

        if (Object.keys(user_db).length > 0) {
            const row = user_db[0];
            const flagNum = Number(row["flag"] ?? 0);
            const diff: number = Date.now() - Number(row["time"] ?? 0);
            const vars: number = Math.floor((300000 - diff) / 60000 + 1);

            // 已完成注册的账号（flag >= 1）-----------------------------------
            if (flagNum >= 1) {
                if (reset == "1" || reset == "true") {
                    // 找回密码：重新发送验证码并刷新占位 code
                    // 保持 HTTP 200，通过 body.flags 表达业务成败，避免前端全局拦截器介入
                    return c.json(await addUsers(c, email, true));
                }
                // 注册路径：此邮箱已被注册，必须在发送验证码之前拦截
                console.warn("[getNonce] 邮箱已被注册，拒绝再次注册", {email});
                return c.json(
                    {"flags": 1, "nonce": "此邮箱已经被注册\n请直接登录\n如忘记密码请重置"}, 400);
            }

            // 注册占位行（flag=0）：受 5 分钟冷却保护 ------------------------
            if (diff < 300000) {
                return c.json(
                    {"nonce": "操作过于频繁\n请等" + vars + "分钟后再试"}, 403);
            }
            // 过期占位行：先删再重建
            try {
                await delUsers(c, email);
            } catch (e) {
                console.error("[getNonce] delUsers failed", {email, error: e});
                return c.json({"nonce": "系统暂时不可用，请稍后再试"}, 500);
            }
        }
        // 保持 HTTP 200，通过 body.flags 表达业务成败，避免前端全局拦截器介入
        return c.json(await addUsers(c, email)) // 新增真用户
    }
    if (Object.keys(user_db).length > 0) {
        await saves.updateDB(c.env.DB_CF, "Users",
            {code: nonce,},
            {mail: email,});
    }
    return c.json({"nonce": nonce}, 200);
}

// 校验验证 ###############################################################################
/**
 * 人机验证校验器
 * -------------------------------------------------------------------------
 * scope 控制按哪个开关判定是否启用人机验证：
 *   - "base" ：登录 / 注册 / 找回密码发送邮件验证码等基础场景，使用 BASE_CAPTCHA_ENABLED
 *   - "cert" ：证书申请（防滥用），使用 CERT_CAPTCHA_ENABLED
 * 两个 scope 共用同一套 provider / SITE_KEYS / AUTH_KEYS 凭证。
 * 开关关闭时直接返回 true 放行；开启时按 provider 去 siteverify 做真实校验。
 */
export async function Turnstile(c: Context, scope: "base" | "cert" = "base") {
    const {readConf, readBool} = await import("./db/conf");
    const switchKey = scope === "cert" ? "CERT_CAPTCHA_ENABLED" : "BASE_CAPTCHA_ENABLED";
    const enabled = await readBool(c.env as any, switchKey, false);
    if (!enabled) return true;

    const authy = <string>c.req.query('authy');
    if (!authy || authy.length <= 0) return false;

    // AUTH_KEYS 由 readConf 按 Confs → env → 默认值 三级回退，
    // 同时兼容旧键 CERT_CAPTCHA_SECRET_KEY（仅在 AUTH_KEYS 为空时生效）。
    const SECRET_KEY =
        (await readConf(c.env as any, "AUTH_KEYS")) ||
        (await readConf(c.env as any, "CERT_CAPTCHA_SECRET_KEY")) ||
        "";
    if (!SECRET_KEY) {
        // 开启了人机验证但未配置 Secret：明确拒绝，由调用方返回提示
        console.warn(`[Turnstile] ${switchKey}=true 但 AUTH_KEYS 未配置`);
        return false;
    }

    const provider = (
        (await readConf(c.env as any, "CERT_CAPTCHA_PROVIDER")) || "turnstile"
    ).toLowerCase();
    const ip: any = c.req.header("CF-Connecting-IP");

    // 端点映射：三家协议都约定 POST form-urlencoded，返回 {success: boolean}
    let url: string;
    if (provider === "hcaptcha") {
        url = "https://hcaptcha.com/siteverify";
    } else if (provider === "recaptcha") {
        url = "https://www.google.com/recaptcha/api/siteverify";
    } else {
        url = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
    }

    let formData = new FormData();
    formData.append("secret", SECRET_KEY);
    formData.append("response", authy);
    if (ip) formData.append("remoteip", ip);
    try {
        const result = await fetch(url, {body: formData, method: "POST"});
        const outcome: Record<string, any> = await result.json();
        return !!outcome.success;
    } catch (e) {
        console.error("[Turnstile] siteverify failed:", e);
        return false;
    }
}

// 生成种子 ###############################################################################
export async function newNonce(lens: number = 8): Promise<string> {
    let charset = 'ABCDEFGHJKLMNPQRSTUWXY0123456789';
    let results = '';
    for (let i = 0; i < lens; i++) {
        const randomIndex = Math.floor(Math.random() * charset.length);
        results += charset[randomIndex];
    }
    return results;
}


/* ########################################################################################
*                                     用户数据层操作
######################################################################################## */

// 获取用户 ###############################################################################
export async function getUsers(c: Context, email: string) {
    // console.log(email);
    return await saves.selectDB(c.env.DB_CF, "Users", {mail: {value: email}});
}

// 删除用户 ###############################################################################
export async function delUsers(c: Context, email: string) {
    // saves.deleteDB 的 where 参数约定为普通 kv 对象（{col: value}），
    // 不是旧的 SelectWhere 形式（{col: {value, op}}）；传后者会导致
    // D1 bind 收到 object 抛出 D1_TYPE_ERROR。
    return await saves.deleteDB(c.env.DB_CF, "Users", {mail: email});
}

// 新增用户 ###############################################################################
export async function addUsers(c: Context, email: string, reset: boolean = false) {
    const nonce = await newNonce(8);
    if (!reset) {
        await saves.insertDB(c.env.DB_CF, "Users", {
            mail: email,
            code: nonce,
            time: Date.now(),
        });
    } else {
        await saves.updateDB(c.env.DB_CF, "Users", {
            code: nonce,
            time: Date.now(),
        }, {
            mail: email,
        });
    }
    return await codeSend(c, email, nonce)
}


/* ########################################################################################
*                                     用户逻辑层操作
######################################################################################## */

// 用户注册 ###############################################################################
export async function userRegs(c: Context) {
    let mail_data_in: string = <string>c.req.query('email'); // 邮件明文索引用户
    let mail_code_in: string = <string>c.req.query('codes'); // 邮件+验证码 HMAC
    let pass_code_in: string = <string>c.req.query('crypt'); // 密码+验证码 AES2
    let pass_sets_in: string = <string>c.req.query('token'); // 用户+原密码 HMAC
    // 修改密码 ==========================================================================
    if (pass_sets_in != undefined && pass_sets_in.length > 0) {
        if (!await userAuth(c)) return c.json({"flags": 2, "texts": "用户尚未登录"}, 401);
        let user_data_db: Record<string, any>[] = await getUsers(c, mail_data_in);
        if (Object.keys(user_data_db).length <= 0) return c.json({flags: 2}, 401);
        let user_data_in = user_data_db[0]
        console.log(user_data_in['pass'], pass_code_in, pass_sets_in);
        if (user_data_in['pass'] !== pass_code_in) return c.json({flags: 5}, 403);
        await saves.updateDB(c.env.DB_CF, "Users", {pass: pass_sets_in}, {mail: mail_data_in})
        return c.redirect("/#/login", 302);
    }
    // 校验验证码 ========================================================================
    let user_data_db: Record<string, any>[] = await getUsers(c, mail_data_in);
    if (Object.keys(user_data_db).length <= 0)
        return c.json({error: '请先发送邮件验证码'}, 200);
    let user_data_in: Record<string, any> = user_data_db[0]

    // 注册策略二次校验（关键）==========================================================
    // 说明：getNonce 在「发验证码」阶段已经拦过 REGISTER_ALLOW，但这里是真正写库的入口。
    // 只要库里存在一条 flag=0 的待验证行（例如管理员是在用户点了「发送验证码」之后
    // 才关闭注册的），攻击者就能拿着那串验证码直接调 /setup/ 完成注册，绕过开关。
    // 因此必须在写库前再判一次，且只对「新注册」生效（flag=0）；
    // 已注册用户（flag>=1）走的是重置密码流程，不受注册开关影响。
    //
    // 注意：邀请码（REGISTER_CODE）不在这里校验——前端 registerUser 不会把 invite
    // 带到 /setup/，在这里判会误伤所有正常用户。邀请码作为「准入门槛」在发码阶段
    // （getNonce）校验即可：拿不到验证码就走到不了这一步。
    const isFresh = Number(user_data_in["flag"] ?? 0) === 0;
    if (isFresh) {
        try {
            const {readBool} = await import("./db/conf");
            const allow = await readBool(c.env as any, "REGISTER_ALLOW", true);
            if (!allow) {
                return c.json({flags: 1, texts: "当前站点未开放注册"}, 403);
            }
        } catch (e) {
            console.error("[userRegs] read register policy failed:", e);
            return c.json({flags: 1, texts: "系统暂时不可用，请稍后再试"}, 500);
        }
    }

    // 验证码时效校验（关键）============================================================
    // code 只在 5 分钟冷却窗口内有效；原实现没有任何过期判断，
    // 意味着一条旧验证码可以永久重复使用（只要 pass 还没被设置）。
    if (isFresh) {
        const issuedAt = Number(user_data_in["time"] ?? 0);
        const age = Date.now() - issuedAt;
        const CODE_TTL_MS = 5 * 60 * 1000;
        if (!issuedAt || age > CODE_TTL_MS || age < 0) {
            try {
                await delUsers(c, mail_data_in);
            } catch {/* 清理失败不阻断错误返回 */}
            return c.json({flags: 1, texts: "验证码已过期，请重新发送"}, 403);
        }
    }

    let code_hash_db = CryptoJS.SHA256(user_data_in["code"]).toString(CryptoJS.enc.Hex);
    let mail_data_db = CryptoJS.HmacSHA256(mail_data_in, code_hash_db) // 邮箱
    let mail_code_db = mail_data_db.toString(CryptoJS.enc.Hex);
    if (mail_code_db == mail_code_in) { // 验证通过，要保存密码
        try { // 解密密码sha256 ----------------------------------------------------------
            const save_word = CryptoJS.enc.Hex.parse(pass_code_in);
            const save_base = CryptoJS.enc.Base64.stringify(save_word);
            const keys_word = CryptoJS.enc.Hex.parse(code_hash_db);
            // ===========================================================================
            // console.log("save_word", save_word);
            // console.log("save_text", save_text);
            // console.log("save_base", save_base);
            // console.log("keys_word", keys_word);
            // console.log("keys_text", code_hash_db);
            // 执行解密 ==================================================================
            const decrypted = CryptoJS.AES.decrypt(save_base, keys_word, {
                mode: CryptoJS.mode.ECB, padding: CryptoJS.pad.Pkcs7
            });
            const data_text = decrypted.toString(CryptoJS.enc.Hex);
            // console.log("data_word:", decrypted);
            // console.log("data_text:", data_text);
            // 存储密码 =====================================================
            // const pass_salt = bcrypt.genSaltSync(10);
            // const pass_save = bcrypt.hashSync(data_text, pass_salt);
            // console.log("pass_salt:", pass_salt);
            // console.log("pass_save:", pass_save);


            const {publicKey, privateKey} = generateKeyPairSync(
                'ec', {namedCurve: 'prime256v1'});
            console.log(publicKey);

            // 新注册用户（flag 原为 0）需要初始化 quota 与 is_admin；
            // 重置密码路径（flag 已为 1）保留原 quota / is_admin，不被回溯。
            const isFreshRegister = Number(user_data_in["flag"] ?? 0) === 0;
            // ACME 账户私钥：
            //   - 新注册：务必生成并存入 keys 字段（后续申请证书直接复用，无需再在申请时生成）
            //   - 重置密码：保留原 keys（避免与 CA 侧账号失联）；仅当历史账号缺失时补生成
            const existing_keys: string = String(user_data_in["keys"] ?? "");
            const keep_keys = !isFreshRegister && existing_keys.length > 0;
            const updates: Record<string, any> = {
                code: "",
                flag: "1",
                pass: data_text,
                apis: await newNonce(16),
                time: Date.now(),
            };
            if (!keep_keys) {
                updates["keys"] = privateKey.export({type: 'pkcs8', format: 'pem'});
            }
            if (isFreshRegister) {
                try {
                    const {readInt} = await import("./db/conf");
                    const quota = await readInt(c.env as any, "DEFAULT_QUOTA", -1);
                    updates["quota"] = quota;
                    updates["is_admin"] = 0;
                } catch (e) {
                    console.error("[userRegs] read DEFAULT_QUOTA failed:", e);
                    updates["quota"] = -1;
                    updates["is_admin"] = 0;
                }
            }
            await saves.updateDB(c.env.DB_CF, "Users",
                updates,
                {mail: mail_data_in,}
            );

            return c.redirect("/#/login", 302);
            // return c.json({error: 'OK'}, 200);
        } catch (error) {
            return c.json({error: 'Decryption Failed, ' + error}, 400);
        }
    } else { // 否则验证码错误，验证失败 ==================================================
        return c.json({error: 'Error SMS Code'}, 401);
    }
}

// 用户登录 ###############################################################################
export async function userPost(c: Context) {
    let pass_hmac_in: string = <string>c.req.query('token');
    let mail_data_in: string = <string>c.req.query('email');
    // if (!await Turnstile(c)) return c.json({"nonce": "请先完成验证"}, 403);
    let user_data_db: Record<string, any>[] = await getUsers(c, mail_data_in);
    if (Object.keys(user_data_db).length <= 0) return c.json({flags: 0}, 401);
    let user_data_in = user_data_db[0]
    const pass_hmac_db = await hmacSHA2(user_data_in['pass'], user_data_in['code']);
    if (pass_hmac_db != pass_hmac_in) return c.json({flags: 0, nonce: "用户名密码错误"}, 401);
    // 密码正确设置 Cookie ================================================================
    local.deleteCookie(c, 'users')
    local.setCookie(c, 'mail', mail_data_in);
    await local.setSignedCookie(c, 'auth', pass_hmac_in, user_data_in['pass']);
    await saves.updateDB(c.env.DB_CF, "Users",
        {code: "",},
        {mail: mail_data_in,}
    );
    return c.json({flags: 1});
}

// 验证登录 ###############################################################################
export async function userAuth(c: Context) {
    const user_mail = local.getCookie(c, 'mail')
    // console.log(user_mail);
    if (!user_mail || user_mail.length <= 0) return false;
    const user_data: Record<string, any> = (await getUsers(c, user_mail))[0];
    if (!user_data || Object.keys(user_data).length <= 2) return false;
    // console.log(user_data);
    const user_auth = await local.getSignedCookie(
        c, user_data["pass"], 'auth')
    // console.log(user_auth);
    return !(!user_auth || user_auth.length <= 0);
}

// 用户退出 ###############################################################################
export async function userExit(c: Context) {
    local.deleteCookie(c, 'mail')
    local.deleteCookie(c, 'auth')
    return c.redirect("/#/login", 302);
}

// 发送验证 ###############################################################################
export async function codeSend(c: Context, mail: string, code: string) {
    return await mailSend(c, mail, "SSL证书助手 - 邮件验证",
        "您正在注册SSL证书助手平台，验证码为：" + code + "，五分钟内有效。")
}

// 发送邮件 ###############################################################################
export async function mailSend(c: Context, email: string, title: string, text: string) {
    try {
        // 统一走 readConf：Confs → env → 默认值 三级回退，无需额外 || c.env.XXX。
        const {readConf} = await import("./db/conf");
        const mailKeys = (await readConf(c.env as any, "MAIL_KEYS")) ?? "";
        const mailSend = (await readConf(c.env as any, "MAIL_SEND")) ?? "";
        const siteTitle = (await readConf(c.env as any, "SITE_TITLE")) || "SSL Helper";
        if (!mailKeys || !mailSend) {
            console.warn("[mailSend] MAIL_KEYS / MAIL_SEND 未配置，已跳过发送", {
                mailKeysConfigured: !!mailKeys,
                mailSendConfigured: !!mailSend,
                to: email,
            });
            return {"flags": 1, "nonce": "系统尚未配置邮件发送服务"};
        }
        // 自动从 MAIL_SEND 发件地址里解析域名（@ 后半段）
        // 用于：日志诊断 / domain 未验证错误提示 / 校验发件地址格式
        const sendMatch = String(mailSend).match(/^\s*([^\s<>@]+)@([^\s<>@]+?)\s*$/);
        const sendLocal = sendMatch ? sendMatch[1] : "";
        const sendDomain = sendMatch ? sendMatch[2].toLowerCase() : "";
        if (!sendDomain) {
            console.error("[mailSend] MAIL_SEND 发件地址格式非法", {mailSend});
            return {"flags": 1, "nonce": "系统配置的发件邮箱格式非法（MAIL_SEND）"};
        }
        const fromAddr = `${siteTitle}<${sendLocal}@${sendDomain}>`;
        // 记录发送开始时间、发件域、Resend 密钥诊断信息
        const sendStartAt = Date.now();
        console.log("[mailSend] sending", {
            from: fromAddr,
            fromDomain: sendDomain,
            to: email,
            subject: title,
            // 不直接打印密钥，只保留前缀用于确认是否符合 re_xxx 的 Resend Key 格式
            mailKeyPrefix: String(mailKeys).slice(0, 4),
            mailKeyLength: String(mailKeys).length,
            siteTitle,
        });
        const resend = new Resend(mailKeys);
        const sendResult = await resend.emails.send({
            from: fromAddr,
            to: [email],
            subject: title,
            html: text,
        });
        const sendElapsedMs = Date.now() - sendStartAt;
        const {data, error} = sendResult;
        // 无论成败都打印一份 Resend 完整响应摘要
        let resultJson = "";
        try { resultJson = JSON.stringify(sendResult); } catch { /* ignore */ }
        console.log("[mailSend] Resend response", {
            elapsedMs: sendElapsedMs,
            from: fromAddr,
            fromDomain: sendDomain,
            to: email,
            hasData: !!data,
            hasError: !!error,
            messageId: (data as any)?.id,
            errorName: (error as any)?.name,
            errorMessage: (error as any)?.message,
            rawResult: resultJson,
        });
        if (error) {
            // 打印完整 error 对象 + JSON 序列化，便于定位 Resend 返回的具体原因
            // 常见错误如：validation_error、invalid_api_key、domain_not_verified、missing_api_key
            let errJson = "";
            try { errJson = JSON.stringify(error); } catch { /* ignore */ }
            console.error("[mailSend] Resend send failed", {
                error,
                errorJson: errJson,
                errorName: (error as any)?.name,
                errorMessage: (error as any)?.message,
                errorStatusCode: (error as any)?.statusCode,
                from: fromAddr,
                fromDomain: sendDomain,
                to: email,
                subject: title,
            });
            const errMsg: string =
                (error as any)?.message ||
                (error as any)?.name ||
                errJson ||
                String(error);
            // 针对 Resend "associated domain / domain not verified" 错误做更精准的中文提示：
            // 实战中这个错最常见的原因并不是"域名没验证"，而是 —— Resend API Key
            // 在创建时被限定为 "Restricted to a single domain"（只允许发送某一个域名），
            // 或者 Key 归属的 Resend 账户里并没有当前这个发件域名。
            // 所以即使管理员在 Resend 后台已经看到 `${sendDomain}` 验证通过，依旧会报此错。
            const isDomainNotVerified =
                /not\s+verified|verify\s+a\s+domain|domain[_\s-]?not[_\s-]?verified|associated\s+domain/i
                    .test(errMsg);
            if (isDomainNotVerified) {
                return {
                    "flags": 1,
                    "nonce":
                        `邮件发送失败：当前 Resend API Key 无权使用发件域名「${sendDomain}」。\n` +
                        `请在 Resend 控制台确认：\n` +
                        `1) 域名「${sendDomain}」已完成 DNS 记录验证（Domains 页签状态为 Verified）；\n` +
                        `2) 当前使用的 API Key 权限为「Full access」，或「Sending access」且 Domain 选择了「${sendDomain}」/「All domains」；\n` +
                        `3) API Key 与验证通过的域名位于同一个 Resend 账户 / Team 下。\n` +
                        `若上述均无误仍报错，请在 Resend 后台重新生成一个 Full access 的 API Key 后更新 MAIL_KEYS。`,
                };
            }
            return {"flags": 1, "nonce": "邮件发送失败：" + errMsg};
        }
        console.log("[mailSend] Resend send ok", {
            to: email,
            from: fromAddr,
            fromDomain: sendDomain,
            messageId: (data as any)?.id,
            elapsedMs: sendElapsedMs,
        });
        return {"flags": 0, "nonce": "邮件发送成功，请查收"};
    } catch (error: any) {
        // Resend SDK 在网络错误 / 参数非法时会抛异常
        let errJson = "";
        try { errJson = JSON.stringify(error); } catch { /* ignore */ }
        console.error("[mailSend] exception thrown", {
            error,
            errorJson: errJson,
            errorName: error?.name,
            errorMessage: error?.message,
            errorStack: error?.stack,
            to: email,
            subject: title,
        });
        return {"flags": 1, "nonce": "邮件发送异常：" + (error?.message ?? String(error))};
    }
}

// 生成 HMAC-SHA256 #######################################################################
export async function hmacSHA2(data_text: string, keys_text: string) {
    let temp_data = CryptoJS.HmacSHA256(data_text, keys_text)
    return temp_data.toString(CryptoJS.enc.Hex);
}
