/**
 * Worker 运行时全局变量补充声明
 * -------------------------------------------------------------------------
 * `@cloudflare/workers-types` 没有声明 `globalThis.crypto`（tsconfig 的 lib 只开了
 * ESNext，没引 DOM/WebWorker），但 Cloudflare Workers 运行时一定提供 Web Crypto。
 * 这里补上声明，避免各处 `(globalThis.crypto as Crypto)` 报 TS2339。
 */
declare var crypto: Crypto;
