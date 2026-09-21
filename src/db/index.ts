/**
 * DAO 入口：根据 env.DB_SOURCE 返回对应实现
 * -------------------------------------------------------------------------
 * 约定：
 *   - "" 或 "d1" → D1Dao（需要 env.DB_CF）
 *   - "mysql"   → MysqlDao（需要 env.DB_MYSQL_URL 或 HOST/PORT/USER/PASS/NAME）
 *   - "prisma"  → PrismaDao（可选 env.DATABASE_URL）
 *
 * 任一请求都应在首次调用时执行 `runMigrations(dao)` 完成幂等迁移。
 */

import type {Dao, DbSource} from "./dao";
import {D1Dao} from "./dao.d1";
import {MysqlDao} from "./dao.mysql";
import {PrismaDao} from "./dao.prisma";
import {runMigrations} from "./migrations/001_admin_console";

/** 扩展的 Bindings 字段：这里声明数据源相关的环境变量 */
export interface DbEnv {
    DB_CF?: D1Database;
    DB_SOURCE?: string;
    DB_MYSQL_URL?: string;
    DB_MYSQL_HOST?: string;
    DB_MYSQL_PORT?: string;
    DB_MYSQL_USER?: string;
    DB_MYSQL_PASS?: string;
    DB_MYSQL_NAME?: string;
    DATABASE_URL?: string;
}

/** 规范化 DB_SOURCE 取值 */
export function normalizeDbSource(value?: string): DbSource {
    const v = (value ?? "").trim().toLowerCase();
    if (v === "" || v === "d1") return "d1";
    if (v === "mysql" || v === "prisma") return v;
    // 非法取值按空处理，上层会识别为不可用
    return "";
}

// 模块级单例缓存（每个 Worker 实例内共享）
let _cachedDao: Dao | null = null;
let _cachedSource: string | null = null;
let _cachedBinding: unknown = null;

/**
 * 获取当前 DAO 实例。业务代码统一从此函数取 DAO，禁止直接 `env.DB_CF.prepare()`。
 *
 * 缓存键包含底层绑定对象本身：同一个 Worker 实例通常只有一个 D1 绑定，
 * 但测试或多次注入不同绑定时必须重建，否则会串用上一个数据库。
 */
export function getDao(env: DbEnv): Dao {
    const source = normalizeDbSource(env.DB_SOURCE);
    // 数据源或底层绑定变化时重建
    const binding = source === "d1" ? env.DB_CF
        : source === "mysql" ? (env.DB_MYSQL_URL || env.DB_MYSQL_HOST)
            : env.DATABASE_URL;
    if (_cachedDao && _cachedSource === source && _cachedBinding === binding) return _cachedDao;
    _cachedSource = source;
    _cachedBinding = binding;
    switch (source) {
        case "d1":
            if (!env.DB_CF) {
                throw new Error("[DAO] DB_SOURCE=d1 但未绑定 env.DB_CF");
            }
            _cachedDao = new D1Dao(env.DB_CF);
            return _cachedDao;
        case "mysql":
            _cachedDao = new MysqlDao(env);
            return _cachedDao;
        case "prisma":
            _cachedDao = new PrismaDao(env.DATABASE_URL);
            return _cachedDao;
        default:
            throw new Error(`[DAO] 非法的 DB_SOURCE=${env.DB_SOURCE}`);
    }
}

/**
 * 对外：**首选入口**。
 * 返回 DAO 同时确保迁移已执行。任何异常将透传给调用方（由路由层统一捕获）。
 */
export async function ensureDao(env: DbEnv): Promise<Dao> {
    const dao = getDao(env);
    await runMigrations(dao);
    return dao;
}

/** 仅用于 ping（探活）场景，不做迁移 */
export function rawDao(env: DbEnv): Dao {
    return getDao(env);
}

/** 测试场景下重置单例 */
export function _resetDaoForTests(): void {
    _cachedDao = null;
    _cachedSource = null;
}
