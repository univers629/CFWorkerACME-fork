/**
 * DAO - Prisma 实现
 * -------------------------------------------------------------------------
 * 仅在 DB_SOURCE = "prisma" 时实例化。
 * 复用 prisma/schema.prisma 中声明的 Users / Apply / Confs 模型。
 *
 * ⚠️ PrismaClient 体积较大，生产构建时需显式安装 @prisma/client。
 */

import type {
    Dao, UserRow, ApplyRow, ConfRow, QueryFilter, Pagination
} from "./dao";

export class PrismaDao implements Dao {
    private client: any = null;

    constructor(private readonly datasourceUrl?: string) {}

    private async getClient(): Promise<any> {
        if (this.client) return this.client;
        let mod: any;
        try {
            mod = await import(/* webpackIgnore: true */ "@prisma/client" as any);
        } catch (e) {
            throw new Error("[PrismaDao] 未能加载 @prisma/client，请先 npm i @prisma/client 并执行 prisma generate");
        }
        this.client = new mod.PrismaClient(
            this.datasourceUrl ? {datasources: {db: {url: this.datasourceUrl}}} : undefined
        );
        return this.client;
    }

    /* --------- where 工具：把 DAO 过滤条件翻译为 Prisma where --------- */
    private where(filter?: QueryFilter): Record<string, any> {
        if (!filter) return {};
        const AND: any[] = [];
        for (const [k, v] of Object.entries(filter.eq ?? {})) AND.push({[k]: v});
        for (const [k, v] of Object.entries(filter.neq ?? {})) AND.push({[k]: {not: v}});
        for (const [k, v] of Object.entries(filter.like ?? {})) AND.push({[k]: {contains: v}});
        for (const [k, v] of Object.entries(filter.gte ?? {})) AND.push({[k]: {gte: v}});
        for (const [k, v] of Object.entries(filter.lte ?? {})) AND.push({[k]: {lte: v}});
        for (const [k, v] of Object.entries(filter.in ?? {})) AND.push({[k]: {in: v}});
        return AND.length > 0 ? {AND} : {};
    }

    private orderBy(page?: Pagination): any {
        if (!page?.orderBy) return undefined;
        return {[page.orderBy]: page.orderDesc ? "desc" : "asc"};
    }

    private pageArgs(page?: Pagination): { skip?: number; take?: number } {
        if (!page?.pageSize) return {};
        const take = Math.min(page.pageSize, 200);
        const skip = Math.max(0, ((page.page ?? 1) - 1) * take);
        return {skip, take};
    }

    async ping(): Promise<{ ok: boolean; error?: string }> {
        try {
            const c = await this.getClient();
            await c.$queryRawUnsafe("SELECT 1");
            const k = `__ping_${Date.now()}`;
            await c.confs.upsert({
                where: {name: k},
                update: {data: "1", time: BigInt(Date.now())},
                create: {name: k, data: "1", time: BigInt(Date.now())},
            });
            await c.confs.delete({where: {name: k}});
            return {ok: true};
        } catch (e: any) {
            return {ok: false, error: e?.message ?? String(e)};
        }
    }

    async columns(table: string): Promise<string[]> {
        // Prisma 无统一内省 API；按模型名回退到固定字段集合。
        const map: Record<string, string[]> = {
            Users: ["mail", "flag", "code", "keys", "pass", "apis", "time", "is_admin", "quota"],
            Apply: ["uuid", "mail", "sign", "type", "auto", "flag", "time", "next",
                    "main", "list", "keys", "cert", "data", "text", "notified", "pending_keys"],
            Confs: ["name", "data", "time"],
        };
        return map[table] ?? [];
    }

    async exec(_sql: string): Promise<void> {
        // Prisma 建议通过 migrate deploy 管理 schema，这里不执行原始 DDL。
        // 若上层需要运行迁移脚本，请在部署阶段 `prisma migrate deploy`。
    }

    /* -------------------- Users -------------------- */
    async getUser(mail: string): Promise<UserRow | null> {
        const c = await this.getClient();
        const r = await c.users.findUnique({where: {mail}});
        return r ? this.fromUser(r) : null;
    }

    async listUsers(filter?: QueryFilter, page?: Pagination) {
        const c = await this.getClient();
        const where = this.where(filter);
        const [rows, total] = await Promise.all([
            c.users.findMany({where, orderBy: this.orderBy(page), ...this.pageArgs(page)}),
            c.users.count({where}),
        ]);
        return {rows: rows.map((r: any) => this.fromUser(r)), total};
    }

    async insertUser(row: Partial<UserRow> & { mail: string }): Promise<void> {
        const c = await this.getClient();
        await c.users.create({data: this.toUser(row as UserRow)});
    }

    async updateUser(mail: string, patch: Partial<UserRow>): Promise<void> {
        const c = await this.getClient();
        await c.users.update({where: {mail}, data: this.toUser(patch as UserRow)});
    }

    async deleteUser(mail: string): Promise<void> {
        const c = await this.getClient();
        await c.users.delete({where: {mail}});
    }

    async countAdmins(): Promise<number> {
        const c = await this.getClient();
        return c.users.count({where: {is_admin: 1}});
    }

    private fromUser(r: any): UserRow {
        return {
            mail: r.mail, flag: String(r.flag ?? "0"),
            code: r.code ?? null, keys: r.keys ?? null, pass: r.pass ?? null,
            apis: r.apis ?? null,
            time: r.time != null ? Number(r.time) : null,
            is_admin: Number(r.is_admin ?? 0),
            quota: Number(r.quota ?? -1),
        };
    }

    private toUser(r: Partial<UserRow>): any {
        const d: any = {...r};
        if (r.time !== undefined) d.time = r.time == null ? null : BigInt(r.time);
        return d;
    }

    /* -------------------- Apply -------------------- */
    async getApply(uuid: string): Promise<ApplyRow | null> {
        const c = await this.getClient();
        const r = await c.apply.findUnique({where: {uuid}});
        return r ? this.fromApply(r) : null;
    }

    async listApplies(filter?: QueryFilter, page?: Pagination) {
        const c = await this.getClient();
        const where = this.where(filter);
        const [rows, total] = await Promise.all([
            c.apply.findMany({where, orderBy: this.orderBy(page), ...this.pageArgs(page)}),
            c.apply.count({where}),
        ]);
        return {rows: rows.map((r: any) => this.fromApply(r)), total};
    }

    async insertApply(row: ApplyRow): Promise<void> {
        const c = await this.getClient();
        await c.apply.create({data: this.toApply(row)});
    }

    async updateApply(uuid: string, patch: Partial<ApplyRow>): Promise<void> {
        const c = await this.getClient();
        await c.apply.update({where: {uuid}, data: this.toApply(patch as ApplyRow)});
    }

    async deleteApply(uuid: string): Promise<void> {
        const c = await this.getClient();
        await c.apply.delete({where: {uuid}});
    }

    async deleteAppliesByMail(mail: string): Promise<number> {
        const c = await this.getClient();
        const r = await c.apply.deleteMany({where: {mail}});
        return Number(r.count ?? 0);
    }

    async countAppliesByMailInRange(mail: string, startMs: number, endMs: number): Promise<number> {
        const c = await this.getClient();
        return c.apply.count({where: {mail, time: {gte: BigInt(startMs), lt: BigInt(endMs)}}});
    }

    async countActiveAppliesByMail(mail: string): Promise<number> {
        const c = await this.getClient();
        const now = BigInt(Date.now());
        return c.apply.count({
            where: {mail, flag: 5, OR: [{next: 0n}, {next: {gt: now}}]},
        });
    }

    private fromApply(r: any): ApplyRow {
        return {
            uuid: r.uuid, mail: r.mail,
            sign: r.sign == null ? null : Number(r.sign),
            type: r.type == null ? null : Number(r.type),
            auto: Number(r.auto ?? 0),
            flag: Number(r.flag ?? 0),
            time: r.time == null ? 0 : Number(r.time),
            next: r.next == null ? 0 : Number(r.next),
            main: r.main, list: r.list,
            keys: r.keys ?? null, cert: r.cert ?? null,
            data: r.data ?? null, text: r.text ?? null,
        };
    }

    private toApply(r: Partial<ApplyRow>): any {
        const d: any = {...r};
        if (r.time !== undefined) d.time = r.time == null ? null : BigInt(r.time);
        if (r.next !== undefined) d.next = r.next == null ? null : BigInt(r.next);
        return d;
    }

    /* -------------------- Confs -------------------- */
    async getConf(name: string): Promise<string | null> {
        const c = await this.getClient();
        const r = await c.confs.findUnique({where: {name}});
        return r ? (r.data ?? null) : null;
    }

    async listConfs(): Promise<ConfRow[]> {
        const c = await this.getClient();
        const rows = await c.confs.findMany();
        return rows.map((r: any) => ({
            name: r.name,
            data: r.data ?? null,
            time: r.time == null ? null : Number(r.time),
        }));
    }

    async upsertConf(name: string, data: string, time: number): Promise<void> {
        const c = await this.getClient();
        await c.confs.upsert({
            where: {name},
            update: {data, time: BigInt(time)},
            create: {name, data, time: BigInt(time)},
        });
    }

    async deleteConf(name: string): Promise<void> {
        const c = await this.getClient();
        try {
            await c.confs.delete({where: {name}});
        } catch {
            /* 不存在时忽略 */
        }
    }
}
