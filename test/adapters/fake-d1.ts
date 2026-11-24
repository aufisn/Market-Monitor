/**
 * Fake D1 over Node's built-in SQLite (node:sqlite), running the REAL migration,
 * so SQL in the store is tested for real. Implements only what the adapters use.
 */
import { readFileSync } from "node:fs";

type Param = string | number | null;
interface SqliteStmt { run(...a: Param[]): { changes: number | bigint; lastInsertRowid: number | bigint }; all(...a: Param[]): Record<string, unknown>[]; get(...a: Param[]): Record<string, unknown> | undefined }
interface SqliteDb { exec(sql: string): void; prepare(sql: string): SqliteStmt }

class Stmt {
  args: Param[] = [];
  constructor(readonly db: SqliteDb, readonly sql: string) {}
  bind(...a: Param[]) { this.args = a; return this; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } }; }
  async all() { return { success: true, results: this.db.prepare(this.sql).all(...this.args), meta: {} }; }
  async first() { return this.db.prepare(this.sql).get(...this.args) ?? null; }
}

export class FakeD1 {
  queries = 0; // round trips, a batch counts once
  private db: SqliteDb;
  constructor() {
    const { DatabaseSync } = (globalThis as unknown as { process: { getBuiltinModule(n: string): { DatabaseSync: new (p: string) => SqliteDb } } }).process.getBuiltinModule("node:sqlite");
    this.db = new DatabaseSync(":memory:");
    this.db.exec(readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8"));
  }
  prepare(sql: string) { return new Stmt(this.db, sql); }
  async batch(stmts: Stmt[]) {
    this.db.exec("BEGIN");
    try {
      const out = [];
      for (const s of stmts) {
        const isRead = /^\s*SELECT/i.test(s.sql);
        out.push(isRead ? await s.all() : await s.run());
      }
      this.db.exec("COMMIT");
      return out;
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  rows(sql: string): Record<string, unknown>[] { return this.db.prepare(sql).all(); }
  asD1(): D1Database { return this as unknown as D1Database; }
}

/** Scriptable fetch: routes by URL substring. */
export type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
export function fakeFetch(routes: Record<string, Route | Route[]>): typeof fetch & { calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    for (const k of Object.keys(routes)) {
      if (url.includes(k)) {
        const r = routes[k] as Route | Route[];
        const fn = Array.isArray(r) ? (r.length > 1 ? r.shift()! : r[0]!) : r;
        return fn(url, init);
      }
    }
    return new Response("no route", { status: 599 });
  }) as typeof fetch & { calls: typeof calls };
  f.calls = calls;
  return f;
}
export const jsonRes = (o: unknown, status = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...h } });
