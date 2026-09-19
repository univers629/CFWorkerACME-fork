#!/usr/bin/env node
/**
 * 从 wrangler.action.jsonc 模板生成可用的 wrangler 配置
 * -------------------------------------------------------------------------
 * 为什么需要它：仓库里的 wrangler.jsonc 带着注释、且不应该出现任何密钥；
 * 而 CI（GitHub Actions）需要在部署时把仓库 Secrets/Variables 注入进去。
 * 这里做的是「JSON 安全」的占位符替换——不像 sed 那样会被值里的
 * &、|、/、" 等字符搞坏，也不会把值写进日志（只打印是否已设置 + 长度）。
 *
 * 用法：
 *   node scripts/gen-wrangler-config.mjs [输出路径]
 *   默认输出 wrangler.action.local.jsonc（已 gitignore）
 *
 * 读取的环境变量：模板里出现的所有 ${XXX}，以及可选的默认值：
 *   NAME（默认 cfworker-acme）、D1_DATABASE_NAME（默认 DB_CF）、DB_SOURCE（默认 d1）
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
    D1_DATABASE_NAME: 'DB_CF',
    DB_SOURCE: 'd1',
};

/** 缺失时只告警（不阻断部署），但会影响对应功能 */
const RECOMMENDED = [
    'MAIL_KEYS', 'MAIL_SEND', 'AUTH_KEYS',
    'DCV_AGENT', 'DCV_EMAIL', 'DCV_TOKEN', 'DCV_ZONES',
];

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

    const env = {...DEFAULTS};
    for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && value !== '') env[key] = value;
    }
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

    writeFileSync(outPath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');

    console.log(`✅ 已生成 ${outPath}`);
    console.log(`   Worker 名称：${config.name}`);
    console.log(`   D1 数据库：${database?.database_name ?? '(无)'}` +
        ` / database_id：${database?.database_id ? `${String(database.database_id).slice(0, 8)}…` : '由 wrangler 自动创建'}`);
    console.log(`   自定义域名：${config.routes?.length ? config.routes[0].pattern : '未设置（仅 workers.dev）'}`);
    console.log('   变量注入情况（只显示是否设置，不显示内容）：');
    for (const key of [...used].sort()) {
        const value = env[key];
        console.log(`     - ${key}: ${value ? `已设置（${String(value).length} 字符）` : '未设置'}`);
    }

    const missing = RECOMMENDED.filter((key) => !env[key] || !String(env[key]).trim());
    if (missing.length > 0) {
        console.warn(`⚠️ 以下变量为空，部署后对应功能不可用：${missing.join(', ')}`);
        console.warn('   （可以在仓库 Secrets/Variables 里补，或部署后在 Cloudflare 控制台 Settings → Variables 补）');
    }
}

main();
