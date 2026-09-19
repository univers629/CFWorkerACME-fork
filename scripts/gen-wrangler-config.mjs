#!/usr/bin/env node
/**
 * 从 wrangler.action.jsonc 模板生成可用的 wrangler 配置
 * -------------------------------------------------------------------------
 * 为什么需要它：仓库里的 wrangler.jsonc 带着注释、且不应该出现任何密钥；
 * 而 CI（GitHub Actions）需要在部署时把仓库 Secrets/Variables 注入进去。
 * 这里做的是「JSON 安全」的占位符替换——不像 sed 那样会被值里的
 * &、|、/、" 等字符搞坏。
 *
 * ⚠️ 为什么敏感值不能进 vars（重要）：
 *   `wrangler deploy` 会把配置里 **所有 vars 的明文值** 打印到日志：
 *       env.MAIL_SEND ("me@private.com")   Environment Variable
 *   而公开仓库的 Actions 日志任何人都能看。GitHub 只会自动脱敏来自
 *   `secrets.*` 的值，**不会**脱敏 `vars.*`。因此凡是与部署者身份/密钥
 *   相关的值，一律不写进配置，改用 `wrangler secret bulk` 单独下发。
 *
 * 用法：
 *   node scripts/gen-wrangler-config.mjs [配置输出路径] [密钥输出路径]
 *   默认输出 wrangler.action.local.jsonc + .deploy-secrets.json（均已 gitignore）
 *
 * 读取的环境变量：模板里出现的所有 ${XXX}，以及可选的默认值：
 *   NAME（默认 cfworker-acme）、D1_DATABASE_NAME（默认 = NAME，即与 Worker 同名）、DB_SOURCE（默认 d1）
 *   D1_DATABASE_ID 为空 → 生成结果里不含 database_id（交给 wrangler 自动创建）
 *   CUSTOM_DOMAIN 为空 → 生成结果里不含 routes
 */
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = resolve(ROOT, 'wrangler.action.jsonc');

/** 留空时使用的默认值 */
const DEFAULTS = {
    NAME: 'cfworker-acme',
    DB_SOURCE: 'd1',
};

/** 缺失时只告警（不阻断部署），但会影响对应功能 */
const RECOMMENDED = [
    'MAIL_KEYS', 'MAIL_SEND', 'AUTH_KEYS',
    'DCV_AGENT', 'DCV_EMAIL', 'DCV_TOKEN', 'DCV_ZONES',
];

/**
 * 敏感项：这些值**绝不写进 wrangler 配置**，改由 `wrangler secret bulk` 下发。
 * 原因见文件头：配置里的 vars 会被 wrangler 明文打印到 CI 日志，而公开仓库
 * 的日志人人可见；GitHub 只自动脱敏 secrets.* 来源的值。
 *
 * 判定标准：泄露后会暴露部署者身份、域名、邮箱或任何可用于调用第三方 API 的凭据。
 * 注意：这些键在 Worker 里同样通过 env.XXX 读取，改成 secret 不影响任何代码。
 */
const SENSITIVE_KEYS = new Set([
    // 邮箱与域名（隐私）
    'MAIL_SEND', 'SITE_HOST', 'DCV_AGENT', 'DCV_EMAIL', 'ADMIN_MAIL',
    // 第三方 API 凭据（密钥）
    'MAIL_KEYS', 'AUTH_KEYS', 'SITE_KEYS', 'DCV_TOKEN', 'DCV_ZONES',
    'ADMIN_PASS', 'SETUP_TOKEN', 'TG_BOT_TOKEN', 'TG_CHAT_ID',
    // 各 CA 的 EAB 凭据
    'GTS_keyMC', 'GTS_keyID', 'GTS_KeyTS',
    'SSL_keyMC', 'SSL_keyID', 'SSL_KeyTS',
    'ZRO_keyMC', 'ZRO_keyID', 'ZRO_KeyTS',
]);

/** 去掉 JSONC 的注释（// 与 /* *\/），字符串内的 // 不动 */
function stripJsonComments(text) {
    let out = '';
    let inString = false;
    let escaped = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            out += ch;
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') {
            inString = true;
            out += ch;
            continue;
        }
        if (ch === '/' && text[i + 1] === '/') {
            while (i < text.length && text[i] !== '\n') i++;
            out += '\n';
            continue;
        }
        if (ch === '/' && text[i + 1] === '*') {
            i += 2;
            while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
            i += 1; // 跳过闭合的 '/'
            continue;
        }
        out += ch;
    }
    return out;
}

/** 递归把字符串里的 ${KEY} 换成环境变量值 */
function substitute(node, env, used) {
    if (typeof node === 'string') {
        return node.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, key) => {
            used.add(key);
            return env[key] ?? '';
        });
    }
    if (Array.isArray(node)) return node.map((item) => substitute(item, env, used));
    if (node && typeof node === 'object') {
        const result = {};
        for (const [key, value] of Object.entries(node)) result[key] = substitute(value, env, used);
        return result;
    }
    return node;
}

function main() {
    const outPath = resolve(ROOT, process.argv[2] ?? 'wrangler.action.local.jsonc');
    // 敏感值单独落到这个文件，交给 `wrangler secret bulk` 下发；绝不进 wrangler 配置
    const secretPath = resolve(ROOT, process.argv[3] ?? '.deploy-secrets.json');

    const env = {...DEFAULTS};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && value !== '') env[key] = value;
    }
    // 库名默认跟 Worker 同名：面板里 Worker 和 D1 一眼对得上号，不用猜哪个库配哪个 Worker。
    env.D1_DATABASE_NAME = process.env.D1_DATABASE_NAME || env.NAME;
    // D1 ID 允许来自 D1_DATABASE_ID_INPUT（CI 里的原始输入）或已解析出的 D1_DATABASE_ID
    env.D1_DATABASE_ID = process.env.D1_DATABASE_ID || process.env.D1_DATABASE_ID_INPUT || '';

    let config;
    try {
        config = JSON.parse(stripJsonComments(readFileSync(TEMPLATE, 'utf-8')));
    } catch (error) {
        console.error(`❌ 解析模板失败：${TEMPLATE}`);
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
    }

    const used = new Set();
    config = substitute(config, env, used);

    // 空值清理：没有 ID 就交给 wrangler 自动创建；没有域名就不要写 routes
    const database = Array.isArray(config.d1_databases) ? config.d1_databases[0] : undefined;
    if (database && !database.database_id) delete database.database_id;
    if (Array.isArray(config.routes) && config.routes.every((route) => !route || !route.pattern)) {
        delete config.routes;
    }

    // ---- 敏感项搬出 vars ----------------------------------------------------
    // wrangler deploy 会把 vars 的明文值打印到日志（公开仓库的 Actions 日志人人可见），
    // 而 GitHub 只自动脱敏 secrets.* 来源的值。因此这些键改由 secret bulk 下发。
    const secrets = {};
    const movedToSecret = [];

    // 只存在于 CI 变量、不在模板里的敏感项：
    // ADMIN_PASS / SETUP_TOKEN 故意不出现在 wrangler.action.jsonc 模板里
    // （模板要提交进仓库，不该出现这些键）。它们在 CI 中以 *_INPUT 命名传入。
    for (const [key, inputKey] of [['ADMIN_PASS', 'ADMIN_PASS_INPUT'], ['SETUP_TOKEN', 'SETUP_TOKEN_INPUT']]) {
        const value = String(process.env[inputKey] ?? '').trim();
        if (value !== '') {
            secrets[key] = value;
            movedToSecret.push(key);
        }
    }

    if (config.vars && typeof config.vars === 'object') {
        for (const key of Object.keys(config.vars)) {
            if (!SENSITIVE_KEYS.has(key)) continue;
            const value = String(config.vars[key] ?? '').trim();
            delete config.vars[key];
            if (value !== '') {
                secrets[key] = value;
                movedToSecret.push(key);
            }
        }
    }

    // vars 里的空字符串要删掉，原因有两个：
    //   1) 空的 vars 会以 "" 覆盖掉同名 secret（wrangler 部署时报重复绑定错误）；
    //   2) 未配置的项留空没有意义，反而在 CF 控制台里造成"已配置"的错觉。
    const emptyVars = [];
    if (config.vars && typeof config.vars === 'object') {
        for (const [key, value] of Object.entries(config.vars)) {
            if (typeof value === 'string' && value.trim() === '') {
                delete config.vars[key];
                emptyVars.push(key);
            }
        }
    }
    // vars 被清空时整个删掉，避免生成 "vars": {} 这种噪音
    if (config.vars && Object.keys(config.vars).length === 0) delete config.vars;

    writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
    // 密钥文件：权限收紧，且已在 .gitignore 中忽略
    writeFileSync(secretPath, `${JSON.stringify(secrets, null, 2)}\n`, {encoding: 'utf-8', mode: 0o600});

    console.log(`✅ 已生成 ${outPath}`);
    console.log(`   Worker 名称：${config.name}`);
    console.log(`   D1 数据库：${database?.database_name ?? '(无)'}` +
        ` / database_id：${database?.database_id ? `${String(database.database_id).slice(0, 8)}…` : '由 wrangler 自动创建'}`);
    // 注意：不打印自定义域名的具体值——公开仓库的 CI 日志人人可见，
    // 域名属于部署者隐私。只报告是否已配置。
    console.log(`   自定义域名：${config.routes?.length ? '已配置（内容不在此显示）' : '未设置（仅 workers.dev）'}`);
    console.log(`   敏感项：${movedToSecret.length} 项改由 secret 下发（不写入配置）：${movedToSecret.join(', ') || '无'}`);
    console.log('   变量注入情况（只显示是否设置，不显示内容）：');
    for (const key of [...used].sort()) {
        const value = env[key];
        const how = SENSITIVE_KEYS.has(key) ? 'secret' : 'vars';
        console.log(`     - ${key}: ${value ? `已设置（${String(value).length} 字符，走 ${how}）` : '未设置'}`);
    }

    const missing = RECOMMENDED.filter((key) => !env[key] || !String(env[key]).trim());
    if (missing.length > 0) {
        console.warn(`⚠️ 以下变量为空，部署后对应功能不可用：${missing.join(', ')}`);
        console.warn('   （可以在仓库 Secrets/Variables 里补，或部署后在 Cloudflare 控制台 Settings → Variables 补）');
    }

    // 初始化安全提示：三种模式（preset / token / locked）对应完全不同的安全强度
    // 兼容 CI 里的 *_INPUT 命名（密钥在 CI 中不直接叫 ADMIN_PASS，避免误进配置）
    const adminMail = String(env.ADMIN_MAIL ?? '').trim();
    const adminPass = String(env.ADMIN_PASS || env.ADMIN_PASS_INPUT || '').trim();
    const setupToken = String(env.SETUP_TOKEN || env.SETUP_TOKEN_INPUT || '').trim();
    if (adminMail && adminPass) {
        console.log('   初始化安全：preset（已预置管理员，首次请求自动建号，向导不开放）✔ 推荐');
    } else if (setupToken) {
        console.log('   初始化安全：token（向导开放，必须携带 SETUP_TOKEN）');
    } else {
        console.warn('   ⚠️ 初始化安全：locked —— 未配置 ADMIN_MAIL+ADMIN_PASS 或 SETUP_TOKEN，');
        console.warn('      站点初始化接口将拒绝服务（这是防止扫站抢注的 fail-closed 默认值）。');
    }
}

main();
