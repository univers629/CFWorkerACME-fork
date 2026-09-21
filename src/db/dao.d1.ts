/**
 * DAO - Cloudflare D1 实现
 * -------------------------------------------------------------------------
 * 仅依赖 env.DB_CF（D1Database）。所有 SQL 走参数化查询。
 */

import type {
    Dao, UserRow, ApplyRow, ApplySummaryRow, ConfRow, QueryFilter, Pagination
} from "./dao";

/**
 * 将单个过滤节点翻译为 SQL 片段（不含 WHERE 关键字）+ 参数数组。
 * 节点内各条件之间为 AND；and / or 子节点分别以 AND / OR 连接。
 * 返回空字符串表示该节点无有效条件。
 */
function buildNode(filter: QueryFilter | undefined): { sql: string; params: any[] } {
    if (!filter) return {sql: "", params: []};
    const parts: string[] = [];
    const params: any[] = [];
    const push = (col: string, op: string, val: any) => {
        parts.push(`${col} ${op} ?`);
        params.push(val);
    };
    for (const [k, v] of Object.entries(filter.eq ?? {})) push(k, v === null ? "IS" : "=", v);
    for (const [k, v] of Object.entries(filter.neq ?? {})) push(k, "!=", v);
    for (const [k, v] of Object.entries(filter.like ?? {})) push(k, "LIKE", `%${v}%`);
    for (const [k, v] of Object.entries(filter.gte ?? {})) push(k, ">=", v);
    for (const [k, v] of Object.entries(filter.lte ?? {})) push(k, "<=", v);
    for (const [k, v] of Object.entries(filter.in ?? {})) {
        if (!v || v.length === 0) {
            parts.push("0 = 1"); // 命中空集
            continue;
        }
        parts.push(`${k} IN (${v.map(() => "?").join(",")})`);
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
    // OR 组整体作为一项并入 AND，避免与同级其它条件混淆优先级
    if (orParts.length === 1) parts.push(orParts[0]);
    else if (orParts.length > 1) parts.push("(" + orParts.join(" OR ") + ")");
    return {sql: parts.join(" AND "), params};
}

/** 将过滤条件翻译为 WHERE 片段 + 参数数组 */
function buildWhere(filter?: QueryFilter): { sql: string; params: any[] } {
    const {sql, params} = buildNode(filter);
    return sql ? {sql: " WHERE " + sql, params} : {sql: "", params: []};
}

/** 翻页 + 排序 */
function buildPage(page?: Pagination): string {
    if (!page) return "";
    let s = "";
    if (page.orderBy) s += ` ORDER BY ${page.orderBy} ${page.orderDesc ? "DESC" : "ASC"}`;
    if (page.pageSize && page.pageSize > 0) {
        const size = Math.min(page.pageSize, 200);
        const offset = Math.max(0, ((page.page ?? 1) - 1) * size);
        s += ` LIMIT ${size} OFFSET ${offset}`;
    }
    return s;
}

export class D1Dao implements Dao {
    constructor(private readonly db: D1Database) {}

    async ping(): Promise<{ ok: boolean; error?: string }> {
        try {
            await this.db.prepare("SELECT 1").first();
            // 读写双向连通性测试：写入并立刻删除一个临时 Confs 记录
            const k = `__ping_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
            await this.db.prepare(
                "CREATE TABLE IF NOT EXISTS Confs (name TEXT PRIMARY KEY, data TEXT, time INTEGER)"
            ).run();
            await this.db.prepare("INSERT OR REPLACE INTO Confs(name, data, time) VALUES(?, ?, ?)")
                .bind(k, "1", Date.now()).run();
            await this.db.prepare("DELETE FROM Confs WHERE name = ?").bind(k).run();
            return {ok: true};
        } catch (e: any) {
            return {ok: false, error: e?.message ?? String(e)};
        }
    }

    async columns(table: string): Promise<string[]> {
        const {results} = await this.db.prepare(`PRAGMA table_info(${table})`).all();
        return (results as any[]).map(r => String(r.name));
    }

    async exec(sql: string): Promise<void> {
        await this.db.prepare(sql).run();
    }

    /* -------------------- Users -------------------- */
    async getUser(mail: string): Promise<UserRow | null> {
        const row = await this.db.prepare("SELECT * FROM Users WHERE mail = ?")
            .bind(mail).first<UserRow>();
        return row ?? null;
    }

    async listUsers(filter?: QueryFilter, page?: Pagination) {
        const {sql: where, params} = buildWhere(filter);
        const countRow = await this.db.prepare(`SELECT COUNT(*) AS c FROM Users${where}`)
            .bind(...params).first<{ c: number }>();
        const total = Number(countRow?.c ?? 0);
        const {results} = await this.db.prepare(`SELECT * FROM Users${where}${buildPage(page)}`)
            .bind(...params).all();
        return {rows: results as unknown as UserRow[], total};
    }

    async insertUser(row: Partial<UserRow> & { mail: string }): Promise<void> {
        const cols = Object.keys(row);
        const ph = cols.map(() => "?").join(",");
        await this.db.prepare(
            `INSERT INTO Users(${cols.join(",")}) VALUES(${ph})`
        ).bind(...Object.values(row)).run();
    }

    async updateUser(mail: string, patch: Partial<UserRow>): Promise<void> {
        const cols = Object.keys(patch);
        if (cols.length === 0) return;
        const set = cols.map(c => `${c} = ?`).join(", ");
        await this.db.prepare(`UPDATE Users SET ${set} WHERE mail = ?`)
            .bind(...Object.values(patch), mail).run();
    }

    async deleteUser(mail: string): Promise<void> {
        await this.db.prepare("DELETE FROM Users WHERE mail = ?").bind(mail).run();
    }

    async countAdmins(): Promise<number> {
        const r = await this.db.prepare("SELECT COUNT(*) AS c FROM Users WHERE is_admin = 1")
            .first<{ c: number }>();
        return Number(r?.c ?? 0);
    }

    /* -------------------- Apply -------------------- */
    async getApply(uuid: string): Promise<ApplyRow | null> {
        const row = await this.db.prepare("SELECT * FROM Apply WHERE uuid = ?")
            .bind(uuid).first<ApplyRow>();
        return row ?? null;
    }

    async scanApplies(filter?: QueryFilter): Promise<ApplyRow[]> {
        const {sql: where, params} = buildWhere(filter);
        const {results} = await this.db.prepare(`SELECT * FROM Apply${where}`)
            .bind(...params).all();
        return results as unknown as ApplyRow[];
    }

    async countApplies(filter?: QueryFilter): Promise<number> {
        const {sql: where, params} = buildWhere(filter);
        const row = await this.db.prepare(`SELECT COUNT(*) AS c FROM Apply${where}`)
            .bind(...params).first<{ c: number }>();
        return Number(row?.c ?? 0);
    }

    async listApplySummaries(filter?: QueryFilter, page?: Pagination) {
        const {sql: where, params} = buildWhere(filter);
        const countRow = await this.db.prepare(`SELECT COUNT(*) AS c FROM Apply${where}`)
            .bind(...params).first<{ c: number }>();
        const total = Number(countRow?.c ?? 0);
        const {results} = await this.db.prepare(
            `SELECT uuid, mail, sign, type, auto, flag, time, next, main, list, text, ` +
            `(cert IS NOT NULL AND cert != '') AS has_cert, ` +
            `(keys IS NOT NULL AND keys != '') AS has_keys ` +
            `FROM Apply${where}${buildPage(page)}`
        ).bind(...params).all();
        return {rows: results as unknown as ApplySummaryRow[], total};
    }

    async insertApply(row: ApplyRow): Promise<void> {
        const cols = Object.keys(row);
        const ph = cols.map(() => "?").join(",");
        await this.db.prepare(
            `INSERT INTO Apply(${cols.join(",")}) VALUES(${ph})`
        ).bind(...Object.values(row)).run();
    }

    async updateApply(uuid: string, patch: Partial<ApplyRow>): Promise<void> {
        const cols = Object.keys(patch);
        if (cols.length === 0) return;
        const set = cols.map(c => `${c} = ?`).join(", ");
        await this.db.prepare(`UPDATE Apply SET ${set} WHERE uuid = ?`)
            .bind(...Object.values(patch), uuid).run();
    }

    async deleteApply(uuid: string): Promise<void> {
        await this.db.prepare("DELETE FROM Apply WHERE uuid = ?").bind(uuid).run();
    }

    async deleteAppliesByMail(mail: string): Promise<number> {
        const r = await this.db.prepare("DELETE FROM Apply WHERE mail = ?").bind(mail).run();
        return Number(r.meta?.changes ?? 0);
    }

    async countAppliesByMailInRange(mail: string, startMs: number, endMs: number): Promise<number> {
        const r = await this.db.prepare(
            "SELECT COUNT(*) AS c FROM Apply WHERE mail = ? AND time >= ? AND time < ?"
        ).bind(mail, startMs, endMs).first<{ c: number }>();
        return Number(r?.c ?? 0);
    }

    async countActiveAppliesByMail(mail: string): Promise<number> {
        const now = Date.now();
        const r = await this.db.prepare(
            "SELECT COUNT(*) AS c FROM Apply WHERE mail = ? AND flag = 5 AND (next = 0 OR next > ?)"
        ).bind(mail, now).first<{ c: number }>();
        return Number(r?.c ?? 0);
    }

    /* -------------------- Confs -------------------- */
    async getConf(name: string): Promise<string | null> {
        const row = await this.db.prepare("SELECT data FROM Confs WHERE name = ?")
            .bind(name).first<{ data: string | null }>();
        return row ? (row.data ?? null) : null;
    }

    async listConfs(): Promise<ConfRow[]> {
        const {results} = await this.db.prepare("SELECT name, data, time FROM Confs").all();
        return results as unknown as ConfRow[];
    }

    async upsertConf(name: string, data: string, time: number): Promise<void> {
        await this.db.prepare(
            "INSERT INTO Confs(name, data, time) VALUES(?, ?, ?) " +
            "ON CONFLICT(name) DO UPDATE SET data = excluded.data, time = excluded.time"
        ).bind(name, data, time).run();
    }

    async deleteConf(name: string): Promise<void> {
        await this.db.prepare("DELETE FROM Confs WHERE name = ?").bind(name).run();
    }
}
