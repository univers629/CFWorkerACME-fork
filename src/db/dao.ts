/**
 * DAO 统一接口定义
 * -------------------------------------------------------------------------
 * 目标：让业务代码不再直接调用 env.DB_CF / mysql2 / PrismaClient 原生 API，
 *       而是通过统一接口访问 Users / Apply / Confs 三张表。
 *
 * 设计取舍：
 *   - 仅覆盖本项目用到的最小集合，不做通用 ORM。
 *   - 返回值统一使用 `Record<string, any>` 或具名 Row 类型，保证跨实现一致。
 *   - 参数化查询由各实现自行完成；上层禁止字符串拼接。
 */

/** Users 行（按 schema.set.sql 字段映射） */
export interface UserRow {
    mail: string;
    flag: string;        // '0' | '1' | '2'
    code?: string | null;
    keys?: string | null;
    pass?: string | null;
    apis?: string | null;
    time?: number | null;
    is_admin: number;    // 0 | 1
    quota: number;       // -1 表示不限制
}

/** Apply 行 */
export interface ApplyRow {
    uuid: string;
    mail: string;
    sign: number | null;
    type: number | null;
    auto: number;
    flag: number;        // -1, 0~5
    time: number;
    next: number;
    main: string;
    list: string;
    keys?: string | null;
    cert?: string | null;
    data?: string | null;
    text?: string | null;
    /** 已推送过的到期提醒标记（如 "expire7,expired"），避免 cron 重复推送 */
    notified?: string | null;
}

/** Confs 行 */
export interface ConfRow {
    name: string;
    data: string | null;
    time: number | null;
}

/** 列表查询通用过滤条件（AND 语义） */
export interface QueryFilter {
    /** 精确等值 */
    eq?: Record<string, string | number | null>;
    /** 模糊匹配（LIKE %xxx%） */
    like?: Record<string, string>;
    /** 不等于 */
    neq?: Record<string, string | number | null>;
    /** 范围比较（>= / <=） */
    gte?: Record<string, number>;
    lte?: Record<string, number>;
    /** IN (...) */
    in?: Record<string, (string | number)[]>;
}

/** 分页入参 */
export interface Pagination {
    page?: number;       // 1-based
    pageSize?: number;   // <= 200
    orderBy?: string;    // 列名
    orderDesc?: boolean;
}

/** 统一 DAO 接口 */
export interface Dao {
    /* --------------------- 元信息 --------------------- */
    /** 探活：读一次元数据 + 写一次临时键 */
    ping(): Promise<{ ok: boolean; error?: string }>;

    /** 获取表的全部列名（用于迁移判断） */
    columns(table: string): Promise<string[]>;

    /** 执行无参 DDL / DML（仅用于迁移脚本） */
    exec(sql: string): Promise<void>;

    /* --------------------- Users --------------------- */
    getUser(mail: string): Promise<UserRow | null>;
    listUsers(filter?: QueryFilter, page?: Pagination): Promise<{ rows: UserRow[]; total: number }>;
    insertUser(row: Partial<UserRow> & { mail: string }): Promise<void>;
    updateUser(mail: string, patch: Partial<UserRow>): Promise<void>;
    deleteUser(mail: string): Promise<void>;
    countAdmins(): Promise<number>;

    /* --------------------- Apply --------------------- */
    getApply(uuid: string): Promise<ApplyRow | null>;
    listApplies(filter?: QueryFilter, page?: Pagination): Promise<{ rows: ApplyRow[]; total: number }>;
    insertApply(row: ApplyRow): Promise<void>;
    updateApply(uuid: string, patch: Partial<ApplyRow>): Promise<void>;
    deleteApply(uuid: string): Promise<void>;
    deleteAppliesByMail(mail: string): Promise<number>;
    /** 统计某用户某时间段内创建的 Apply 数（用于月度限额） */
    countAppliesByMailInRange(mail: string, startMs: number, endMs: number): Promise<number>;
    /** 统计某用户当前有效（flag=5 且未过期）证书数量（用于配额） */
    countActiveAppliesByMail(mail: string): Promise<number>;

    /* --------------------- Confs --------------------- */
    getConf(name: string): Promise<string | null>;
    listConfs(): Promise<ConfRow[]>;
    upsertConf(name: string, data: string, time: number): Promise<void>;
    deleteConf(name: string): Promise<void>;
}

/** 支持的数据源枚举 */
export type DbSource = "d1" | "mysql" | "prisma" | "";
