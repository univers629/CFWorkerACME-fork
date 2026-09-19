/**
 * Cloudflare Workers 入口
 * -------------------------------------------------------------------------
 * 静态资源（前端 dist）不再由 Worker 自己读取：
 *   - 旧写法依赖 Workers Sites（wrangler.jsonc 的 site.bucket）+ KV 清单模块
 *     `__STATIC_CONTENT_MANIFEST`，该方案已废弃，且需要额外创建 KV 命名空间；
 *   - 现在改用 Workers 静态资源（wrangler.jsonc 的 assets 段）：
 *     命中同名文件时由边缘直接返回（不计费、不经过 Worker），
 *     未命中时按 not_found_handling = "single-page-application" 回退 index.html。
 * 因此本文件只保留：Worker 的 fetch（API 路由）与 scheduled（定时任务）。
 */

import * as index from './index'

export default {
    async fetch(request: Request, env: index.Bindings, ctx: ExecutionContext): Promise<Response> {
        return index.app.fetch(request, env, ctx);
    },

    /**
     * 定时任务（wrangler.jsonc → triggers.crons）
     * 调用证书状态机，驱动自动签发 / 自动续期（等价于手动访问 /tasks/）。
     * 原实现只打印日志，导致 Cloudflare 上的订单永远不会自动推进。
     */
    async scheduled(controller: ScheduledController, env: index.Bindings, ctx: ExecutionContext) {
        const started = Date.now();
        if (!env.DB_CF) {
            // 显式检查：certs 模块直接操作 D1，缺绑定时给出一条可读的日志而不是 TypeError。
            console.error('[cron] 未绑定 D1 数据库（DB_CF），跳过本次任务');
            return;
        }
        try {
            const certs = await import('./certs');
            const result = await certs.Processing({...env, DB_CF: env.DB_CF});
            console.log(`[cron] processed=${result.length} cost=${Date.now() - started}ms at ${controller.scheduledTime}`);

            // 到期提醒扫描（NOTIFY_ON_EXPIRE7 / NOTIFY_ON_EXPIRED 的实际消费点）
            const {scanExpiry} = await import('./expiry');
            const scanned = await scanExpiry({...env, DB_CF: env.DB_CF});
            if (scanned.expire7 || scanned.expired) {
                console.log(`[cron] 到期提醒 expire7=${scanned.expire7} expired=${scanned.expired}`);
            }
        } catch (error) {
            // 定时任务里抛错会导致整个 cron 失败，这里兜底记录，保证下个周期继续跑。
            console.error('[cron] Error processing cron job:', error);
        }
    },
};
