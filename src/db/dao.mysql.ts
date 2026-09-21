/**
 * DAO - MySQL 实现（基于 mysql2/promise）
 * -------------------------------------------------------------------------
 * 仅在 DB_SOURCE = "mysql" 时才会被实例化。
 *
 * ⚠️ Cloudflare Worker 原生运行环境不支持 mysql2 的 TCP 连接；
 *   此实现用于 Node 侧（entrypoint.sh / @hono/node-server）或
 *   支持 Node compat 的托管平台（如 Docker 容器、EO 函数等）。
 *
 * 连接参数优先级：
 *   1. env.DB_MYSQL_URL
 *   2. DB_MYSQL_HOST / _PORT / _USER / _PASS / _NAME 组合
 */

import type {
    Dao, UserRow, ApplyRow, ApplySummaryRow, ConfRow, QueryFilter, Pagination
} from "./dao";

interface MysqlEnv {
    DB_MYSQL_URL?: string;
    DB_MYSQL_HOST?: string;
    DB_MYSQL_PORT?: string;
    DB_MYSQL_USER?: string;
    DB_MYSQL_PASS?: string;
    DB_MYSQL_NAME?: string;
}

/**
 * 将单个过滤节点翻译为 SQL 片段（不含 WHERE 关键字）+ 参数数组。
 * 节点内各条件之间为 AND；and / or 子节点分别以 AND / OR 连接。
 */
function buildNode(filter: QueryFilter | undefined): { sql: string; params: any[] } {
    if (!filter) return {sql: "", params: []};
    const parts: string[] = [];
    const params: any[] = [];
    const push = (col: string, op: string, val: any) => {
        parts.push(`\`${col}\` ${op} ?`);
        params.push(val);
    };
    for (const [k, v] of Object.entries(filter.eq ?? {})) push(k, v === null ? "IS" : "=", v);
    for (const [k, v] of Object.entries(filter.neq ?? {})) push(k, "!=", v);
    for (const [k, v] of Object.entries(filter.like ?? {})) push(k, "LIKE", `%${v}%`);
    for (const [k, v] of Object.entries(filter.gte ?? {})) push(k, ">=", v);
    for (const [k, v] of Object.entries(filter.lte ?? {})) push(k, "<=", v);
    for (const [k, v] of Object.entries(filter.in ?? {})) {
        if (!v || v.length === 0) {
            parts.push("0 = 1");
            continue;
        }
        parts.push(`\`${k}\` IN (${v.map(() => "?").join(",")})`);
        params.push(...v);
    }
    for (const sub of filter.and ?? []) {
        const inner = buildNode(sub);
        if (!inner.sql) continue;
        parts.push(`(${inner.sql})`);
        params.push(...inner.params);
    }
    const orParts: string[] = [];
    for (const sub of filter.or ?? []) {
        const inner = buildNode(sub);
        if (!inner.sql) continue;
        orParts.push(`(${inner.sql})`);
        params.push(...inner.params);
    }
    if (orParts.length === 1) parts.push(orParts[0]);
    else if (orParts.length > 1) parts.push("(" + orParts.join(" OR ") + ")");
    return {sql: parts.join(" AND "), params};
}

function buildWhere(filter?: QueryFilter): { sql: string; params: any[] } {
    const {sql, params} = buildNode(filter);
    return sql ? {sql: " WHERE " + sql, params} : {sql: "", params: []};
}

function buildPage(page?: Pagination): string {
    if (!page) return "";
    let s = "";
    if (page.orderBy) s += ` ORDER BY \`${page.orderBy}\` ${page.orderDesc ? "DESC" : "ASC"}`;
    if (page.pageSize && page.pageSize > 0) {
        const size = Math.min(page.pageSize, 200);
        const offset = Math.max(0, ((page.page ?? 1) - 1) * size);
        s += ` LIMIT ${size} OFFSET ${offset}`;
    }
    return s;
}

export class MysqlDao implements Dao {
    private pool: any = null;

    constructor(private readonly env: MysqlEnv) {}

    private async getPool(): Promise<any> {
        if (this.pool) return this.pool;
        // 动态 import 避免 Worker 环境打包时报错。
        // mysql2 为 optional 依赖；若缺失则在这里给出明确错误。
        let mysql: any;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            mysql = await import(/* webpackIgnore: true */ "mysql2/promise" as any);
        } catch (e) {
            throw new Error("[MysqlDao] 未能加载 mysql2/promise，请先安装依赖：npm i mysql2");
        }
        const opt: any = this.env.DB_MYSQL_URL
            ? {uri: this.env.DB_MYSQL_URL}
            : {
                host: this.env.DB_MYSQL_HOST,
                port: Number(this.env.DB_MYSQL_PORT || 3306),
                user: this.env.DB_MYSQL_USER,
                password: this.env.DB_MYSQL_PASS,
                database: this.env.DB_MYSQL_NAME,
            };
        this.pool = mysql.createPool({
            ...opt,
            connectionLimit: 4,
            waitForConnections: true,
            multipleStatements: false,
        });
        return this.pool;
    }

    private async q<T = any>(sql: string, params: any[] = []): Promise<T[]> {
        const pool = await this.getPool();
        const [rows] = await pool.query(sql, params);
        return rows as T[];
    }

    async ping(): Promise<{ ok: boolean; error?: string }> {
        try {
            await this.q("SELECT 1");
            await this.q(
                "CREATE TABLE IF NOT EXISTS Confs (" +
                "`name` VARCHAR(128) NOT NULL PRIMARY KEY, " +
                "`data` TEXT, " +
                "`time` BIGINT)"
            );
            const k = `__ping_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            await this.q(
                "INSERT INTO Confs(`name`,`data`,`time`) VALUES(?,?,?) " +
                "ON DUPLICATE KEY UPDATE `data`=VALUES(`data`),`time`=VALUES(`time`)",
                [k, "1", Date.now()]
            );
            await this.q("DELETE FROM Confs WHERE `name` = ?", [k]);
            return {ok: true};
        } catch (e: any) {
            return {ok: false, error: e?.message ?? String(e)};
        }
    }

    async columns(table: string): Promise<string[]> {
        const rows = await this.q<any>(
            "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS " +
            "WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?",
            [table]
        );
        return rows.map(r => String(r.name));
    }

    async exec(sql: string): Promise<void> {
        await this.q(sql);
    }

    /* -------------------- Users -------------------- */
    async getUser(mail: string): Promise<UserRow | null> {
        const rows = await this.q<UserRow>("SELECT * FROM Users WHERE mail = ? LIMIT 1", [mail]);
        return rows[0] ?? null;
    }

    async listUsers(filter?: QueryFilter, page?: Pagination) {
        const {sql: where, params} = buildWhere(filter);
        const c = await this.q<any>(`SELECT COUNT(*) AS c FROM Users${where}`, params);
        const total = Number(c[0]?.c ?? 0);
        const rows = await this.q<UserRow>(`SELECT * FROM Users${where}${buildPage(page)}`, params);
        return {rows, total};
    }

    async insertUser(row: Partial<UserRow> & { mail: string }): Promise<void> {
        const cols = Object.keys(row);
        await this.q(
            `INSERT INTO Users(${cols.map(c => `\`${c}\``).join(",")}) VALUES(${cols.map(() => "?").join(",")})`,
            Object.values(row) as any[]
        );
    }

    async updateUser(mail: string, patch: Partial<UserRow>): Promise<void> {
        const cols = Object.keys(patch);
        if (cols.length === 0) return;
        const set = cols.map(c => `\`${c}\` = ?`).join(", ");
        await this.q(`UPDATE Users SET ${set} WHERE mail = ?`, [...Object.values(patch), mail]);
    }

    async deleteUser(mail: string): Promise<void> {
        await this.q("DELETE FROM Users WHERE mail = ?", [mail]);
    }

    async countAdmins(): Promise<number> {
        const r = await this.q<any>("SELECT COUNT(*) AS c FROM Users WHERE is_admin = 1");
        return Number(r[0]?.c ?? 0);
    }

    /* -------------------- Apply -------------------- */
    async getApply(uuid: string): Promise<ApplyRow | null> {
        const rows = await this.q<ApplyRow>("SELECT * FROM Apply WHERE uuid = ? LIMIT 1", [uuid]);
        return rows[0] ?? null;
    }

    async scanApplies(filter?: QueryFilter): Promise<ApplyRow[]> {
        const {sql: where, params} = buildWhere(filter);
        return await this.q<ApplyRow>(`SELECT * FROM Apply${where}`, params);
    }

    async countApplies(filter?: QueryFilter): Promise<number> {
        const {sql: where, params} = buildWhere(filter);
        const r = await this.q<any>(`SELECT COUNT(*) AS c FROM Apply${where}`, params);
        return Number(r[0]?.c ?? 0);
    }

    async listApplySummaries(filter?: QueryFilter, page?: Pagination) {
        const {sql: where, params} = buildWhere(filter);
        const c = await this.q<any>(`SELECT COUNT(*) AS c FROM Apply${where}`, params);
        const total = Number(c[0]?.c ?? 0);
        const rows = await this.q<ApplySummaryRow>(
            "SELECT uuid, mail, sign, type, auto, flag, time, next, main, `list`, text, " +
            "(cert IS NOT NULL AND cert != '') AS has_cert, " +
            "(keys IS NOT NULL AND keys != '') AS has_keys " +
            `FROM Apply${where}${buildPage(page)}`,
            params
        );
        return {rows, total};
    }

    async insertApply(row: ApplyRow): Promise<void> {
        const cols = Object.keys(row);
        await this.q(
            `INSERT INTO Apply(${cols.map(c => `\`${c}\``).join(",")}) VALUES(${cols.map(() => "?").join(",")})`,
            Object.values(row) as any[]
        );
    }

    async updateApply(uuid: string, patch: Partial<ApplyRow>): Promise<void> {
        const cols = Object.keys(patch);
        if (cols.length === 0) return;
        const set = cols.map(c => `\`${c}\` = ?`).join(", ");
        await this.q(`UPDATE Apply SET ${set} WHERE uuid = ?`, [...Object.values(patch), uuid]);
    }

    async deleteApply(uuid: string): Promise<void> {
        await this.q("DELETE FROM Apply WHERE uuid = ?", [uuid]);
    }

    async deleteAppliesByMail(mail: string): Promise<number> {
        const pool = await this.getPool();
        const [r]: any = await pool.query("DELETE FROM Apply WHERE mail = ?", [mail]);
        return Number(r?.affectedRows ?? 0);
    }

    async countAppliesByMailInRange(mail: string, startMs: number, endMs: number): Promise<number> {
        const r = await this.q<any>(
            "SELECT COUNT(*) AS c FROM Apply WHERE mail = ? AND time >= ? AND time < ?",
            [mail, startMs, endMs]
        );
        return Number(r[0]?.c ?? 0);
    }

    async countActiveAppliesByMail(mail: string): Promise<number> {
        const r = await this.q<any>(
            "SELECT COUNT(*) AS c FROM Apply WHERE mail = ? AND flag = 5 AND (next = 0 OR next > ?)",
            [mail, Date.now()]
        );
        return Number(r[0]?.c ?? 0);
    }

    /* -------------------- Confs -------------------- */
    async getConf(name: string): Promise<string | null> {
        const r = await this.q<any>("SELECT data FROM Confs WHERE name = ? LIMIT 1", [name]);
        return r[0] ? (r[0].data ?? null) : null;
    }

    async listConfs(): Promise<ConfRow[]> {
        return await this.q<ConfRow>("SELECT name, data, time FROM Confs");
    }

    async upsertConf(name: string, data: string, time: number): Promise<void> {
        await this.q(
            "INSERT INTO Confs(`name`,`data`,`time`) VALUES(?,?,?) " +
            "ON DUPLICATE KEY UPDATE `data`=VALUES(`data`),`time`=VALUES(`time`)",
            [name, data, time]
        );
    }

    async deleteConf(name: string): Promise<void> {
        await this.q("DELETE FROM Confs WHERE name = ?", [name]);
    }
}
