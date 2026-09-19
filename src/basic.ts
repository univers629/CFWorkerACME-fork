/**
 * Node.js 自托管入口（Docker-Lite / `npm run dev-js`）
 * -------------------------------------------------------------------------
 * 与 Workers 入口（src/cfapp.ts）的区别：
 *   - 用 @hono/node-server 起一个普通 HTTP 服务；
 *   - 环境变量从 .env / 容器 -e 注入，而不是 wrangler.jsonc 的 vars。
 *
 * 变量读取规则：`MAIL_KEYS` 优先，其次 `OPLIST_MAIL_KEYS`（Docker 镜像沿用
 * 的历史前缀，两边都识别，兼容 docker-compose.yml 里现有的写法）。
 */
import {config} from 'dotenv'
config()

import {Hono} from 'hono'
import {serveStatic} from '@hono/node-server/serve-static'
import {serve} from '@hono/node-server'
import {readFileSync, existsSync} from 'node:fs'

/** 需要从进程环境注入到请求上下文的环境变量清单（与 wrangler.jsonc 的 vars 对应） */
const ENV_KEYS = [
    // 数据源
    'DB_SOURCE',
    'DB_MYSQL_URL', 'DB_MYSQL_HOST', 'DB_MYSQL_PORT', 'DB_MYSQL_USER', 'DB_MYSQL_PASS', 'DB_MYSQL_NAME',
    'DATABASE_URL',
    // 邮件 / 站点 / 鉴权
    'MAIL_KEYS', 'MAIL_SEND', 'AUTH_KEYS', 'SITE_KEYS', 'SITE_HOST', 'SITE_TITLE',
    // DCV 自动验证代理
    'DCV_AGENT', 'DCV_EMAIL', 'DCV_TOKEN', 'DCV_ZONES',
    // CA 厂商（EAB）
    'GTS_useIt', 'GTS_keyMC', 'GTS_keyID', 'GTS_KeyTS',
    'SSL_useIt', 'SSL_keyMC', 'SSL_keyID', 'SSL_KeyTS',
    'ZRO_useIt', 'ZRO_keyMC', 'ZRO_keyID', 'ZRO_KeyTS',
] as const;

/** 读取单个变量：先取原名，再取 OPLIST_ 前缀（Docker 镜像的历史习惯） */
function readEnv(key: string): string | undefined {
    return process.env[key] ?? process.env[`OPLIST_${key}`];
}

// 1. 创建主应用实例
const app = new Hono()

// 2. 环境变量中间件（必须在挂载路由之前）
app.use('*', async (c, next) => {
    const env: Record<string, string> = {...(c.env as Record<string, string> | undefined)};
    for (const key of ENV_KEYS) {
        const value = readEnv(key);
        if (value !== undefined) env[key] = value;
    }
    c.env = env;
    await next()
})

// 3. 挂载路由（import 必须在中间件之后，保证中间件先注册）
import * as index from './index'

app.route('/', index.app)

// 静态文件服务
app.use('*', serveStatic({root: 'public/'}))

// SPA fallback：任何未匹配的 GET 请求都回退到 index.html，
// 确保用户直接访问 /panel 或刷新页面时也能正确加载前端。
app.get('*', (c) => {
    const indexPath = 'public/index.html'
    if (existsSync(indexPath)) {
        return c.html(readFileSync(indexPath, 'utf-8'))
    }
    return c.text('index.html not found, please run `npm run build`', 404)
})

serve({
    fetch: app.fetch,
    port: Number(readEnv('PORT') ?? 3000),
})

export default app
