/**
 * Store port on Cloudflare D1 (FR-4.9..4.11, FR-5.8, FR-11, FR-2.5).
 *
 * Call economy: every D1 round trip (run / first / all / batch) is counted in
 * `counter` so the engine can stay within 45 calls per run. Reads that the
 * engine repeats on every poll (settings, watchlist) are cached for a few
 * seconds; market-state writes are skipped when nothing changed.
 */
import {
  DEFAULT_SETTINGS,
  type Baseline,
  type LogEntry,
  type MarketState,
  type OutboundEvent,
  type RuleKind,
  type RuleState,
  type Settings,
  type Store,
  type StockConfig,
  type Symbol,
  type TradingDate,
} from "../core/ports";
import { CallCounter } from "./util";

export interface D1StoreOptions {
  now?: () => number;
  counter?: CallCounter;
  /** Cache lifetime for settings and watchlist reads (ms). 0 disables. */
  cacheTtlMs?: number;
}

export interface LogRow {
  id: number;
  tMs: number;
  kind: string;
  symbol: string | null;
  rule: string | null;
  detail: unknown;
}

export interface AuthRow {
  fails: number;
  window_start_ms: number;
  locked_until_ms: number;
}

const PURGE_LOG_MS = 90 * 86_400_000;

export class D1Store implements Store {
  readonly counter: CallCounter;
  /** True once something was enqueued in this instance (lets the worker skip empty queue reads). */
  queueDirty = false;
  private readonly now: () => number;
  private readonly ttl: number;
  private settingsCache?: { at: number; v: Settings };
  private stocksCache?: { at: number; v: StockConfig[] };
  private readonly lastMarketJson = new Map<string, string>();

  constructor(private readonly db: D1Database, opts: D1StoreOptions = {}) {
    this.counter = opts.counter ?? new CallCounter();
    this.now = opts.now ?? Date.now;
    this.ttl = opts.cacheTtlMs ?? 10_000;
  }

  // ------------------------------------------------------------ primitives
  private async run(stmt: D1PreparedStatement): Promise<number> {
    this.counter.spend();
    const r = await stmt.run();
    return r.meta?.changes ?? 0;
  }
  private async first<T>(stmt: D1PreparedStatement): Promise<T | null> {
    this.counter.spend();
    return (await stmt.first<T>()) ?? null;
  }
  private async all<T>(stmt: D1PreparedStatement): Promise<T[]> {
    this.counter.spend();
    const r = await stmt.all<T>();
    return r.results ?? [];
  }
  /** One round trip for many statements (atomic in D1). */
  private async batch(stmts: D1PreparedStatement[]): Promise<D1Result[]> {
    if (stmts.length === 0) return [];
    this.counter.spend();
    return this.db.batch(stmts);
  }
  private p(sql: string, ...args: unknown[]): D1PreparedStatement {
    return this.db.prepare(sql).bind(...args);
  }

  // ------------------------------------------------------------ settings
  async getSettings(): Promise<Settings> {
    const t = this.now();
    if (this.settingsCache && t - this.settingsCache.at < this.ttl) return this.settingsCache.v;
    const row = await this.first<{ json: string }>(this.p("SELECT json FROM settings WHERE id = 1"));
    const v: Settings = { ...DEFAULT_SETTINGS, ...(row ? safeParse<Partial<Settings>>(row.json, {}) : {}) };
    this.settingsCache = { at: t, v };
    return v;
  }

  async putSettings(s: Settings): Promise<void> {
    const json = JSON.stringify(s);
    const t = this.now();
    await this.batch([
      this.p(
        "INSERT INTO config_log (t_ms, kind, key, prev, next) SELECT ?, 'settings', 'settings', (SELECT json FROM settings WHERE id = 1), ? WHERE NOT EXISTS (SELECT 1 FROM settings WHERE id = 1 AND json = ?)",
        t, json, json,
      ),
      this.p(
        "INSERT INTO settings (id, json, updated_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_ms = excluded.updated_ms WHERE settings.json != excluded.json",
        json, t,
      ),
    ]);
    this.settingsCache = { at: t, v: s };
  }

  // ------------------------------------------------------------ stocks
  async listStocks(): Promise<StockConfig[]> {
    const t = this.now();
    if (this.stocksCache && t - this.stocksCache.at < this.ttl) return this.stocksCache.v;
    const rows = await this.all<{ json: string }>(this.p("SELECT json FROM stocks ORDER BY symbol"));
    const v = rows.map((r) => safeParse<StockConfig | null>(r.json, null)).filter((x): x is StockConfig => !!x);
    this.stocksCache = { at: t, v };
    return v;
  }

  async putStock(s: StockConfig): Promise<void> {
    const json = JSON.stringify(s);
    const t = this.now();
    await this.batch([
      this.p(
        "INSERT INTO config_log (t_ms, kind, key, prev, next) SELECT ?, 'stock', ?, (SELECT json FROM stocks WHERE symbol = ?), ? WHERE NOT EXISTS (SELECT 1 FROM stocks WHERE symbol = ? AND json = ?)",
        t, s.symbol, s.symbol, json, s.symbol, json,
      ),
      this.p(
        "INSERT INTO stocks (symbol, enabled, json, updated_ms) VALUES (?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET enabled = excluded.enabled, json = excluded.json, updated_ms = excluded.updated_ms WHERE stocks.json != excluded.json",
        s.symbol, s.enabled ? 1 : 0, json, t,
      ),
    ]);
    this.stocksCache = undefined;
  }

  async deleteStock(symbol: Symbol): Promise<void> {
    const t = this.now();
    await this.batch([
      this.p("INSERT INTO config_log (t_ms, kind, key, prev, next) SELECT ?, 'stock_delete', symbol, json, NULL FROM stocks WHERE symbol = ?", t, symbol),
      this.p("DELETE FROM stocks WHERE symbol = ?", symbol),
    ]);
    this.stocksCache = undefined;
  }

  /** Import / restore (FR-2.6): replace settings and the whole watchlist in one atomic batch. */
  async replaceConfig(settings: Settings, stocks: StockConfig[]): Promise<void> {
    const t = this.now();
    const sj = JSON.stringify(settings);
    const stmts: D1PreparedStatement[] = [
      this.p(
        "INSERT INTO config_log (t_ms, kind, key, prev, next) VALUES (?, 'import', 'config', (SELECT '[' || COALESCE(group_concat(json), '') || ']' FROM stocks), ?)",
        t, JSON.stringify({ settings, stocks }),
      ),
      this.p("DELETE FROM stocks"),
      this.p("INSERT INTO settings (id, json, updated_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_ms = excluded.updated_ms", sj, t),
    ];
    for (const s of stocks) {
      stmts.push(this.p("INSERT INTO stocks (symbol, enabled, json, updated_ms) VALUES (?, ?, ?, ?)", s.symbol, s.enabled ? 1 : 0, JSON.stringify(s), t));
    }
    await this.batch(stmts);
    this.settingsCache = undefined;
    this.stocksCache = undefined;
  }

  // ------------------------------------------------------------ lease
  /** Single conditional upsert: succeeds if free, expired, or already ours (renewal). */
  async acquireLease(name: string, holder: string, nowMs: number, ttlMs: number): Promise<boolean> {
    const changes = await this.run(
      this.p(
        "INSERT INTO leases (name, holder, expires_ms) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, expires_ms = excluded.expires_ms WHERE leases.expires_ms <= ? OR leases.holder = ?",
        name, holder, nowMs + ttlMs, nowMs, holder,
      ),
    );
    return changes === 1;
  }

  async releaseLease(name: string, holder: string): Promise<void> {
    await this.run(this.p("DELETE FROM leases WHERE name = ? AND holder = ?", name, holder));
  }

  // ------------------------------------------------------------ market + baseline
  async getMarketStates(date: TradingDate): Promise<MarketState[]> {
    const rows = await this.all<{ json: string }>(this.p("SELECT json FROM market_state WHERE date = ?", date));
    const out: MarketState[] = [];
    for (const r of rows) {
      const m = safeParse<MarketState | null>(r.json, null);
      if (m) {
        out.push(m);
        this.lastMarketJson.set(`${m.date}|${m.symbol}`, r.json);
      }
    }
    return out;
  }

  async putMarketStates(states: MarketState[]): Promise<void> {
    const t = this.now();
    const stmts: D1PreparedStatement[] = [];
    const staged: [string, string][] = [];
    for (const m of states) {
      const key = `${m.date}|${m.symbol}`;
      const json = JSON.stringify(m);
      if (this.lastMarketJson.get(key) === json) continue; // write only on change
      staged.push([key, json]);
      stmts.push(
        this.p(
          "INSERT INTO market_state (date, symbol, json, updated_ms) VALUES (?, ?, ?, ?) ON CONFLICT(date, symbol) DO UPDATE SET json = excluded.json, updated_ms = excluded.updated_ms",
          m.date, m.symbol, json, t,
        ),
      );
    }
    await this.batch(stmts);
    for (const [k, j] of staged) this.lastMarketJson.set(k, j);
  }

  async getBaseline(symbol: Symbol): Promise<Baseline | null> {
    const row = await this.first<{ json: string }>(this.p("SELECT json FROM baselines WHERE symbol = ?", symbol));
    return row ? safeParse<Baseline | null>(row.json, null) : null;
  }

  /** All baselines in one call (optional port method used by the engine). */
  async getBaselines(): Promise<Baseline[]> {
    const rows = await this.all<{ json: string }>(this.p("SELECT json FROM baselines"));
    return rows.map((r) => safeParse<Baseline | null>(r.json, null)).filter((x): x is Baseline => !!x);
  }

  async putBaseline(b: Baseline): Promise<void> {
    await this.run(
      this.p(
        "INSERT INTO baselines (symbol, built_for, status, json) VALUES (?, ?, ?, ?) ON CONFLICT(symbol) DO UPDATE SET built_for = excluded.built_for, status = excluded.status, json = excluded.json",
        b.symbol, b.builtFor, b.status, JSON.stringify(b),
      ),
    );
  }

  // ------------------------------------------------------------ alert state
  async getRuleStates(date: TradingDate): Promise<RuleState[]> {
    const rows = await this.all<{ json: string; version: number }>(this.p("SELECT json, version FROM rule_state WHERE date = ?", date));
    const out: RuleState[] = [];
    for (const r of rows) {
      const s = safeParse<RuleState | null>(r.json, null);
      if (s) out.push({ ...s, version: r.version });
    }
    return out;
  }

  async getRuleState(date: TradingDate, symbol: Symbol, rule: RuleKind): Promise<RuleState | null> {
    const r = await this.first<{ json: string; version: number }>(
      this.p("SELECT json, version FROM rule_state WHERE date = ? AND symbol = ? AND rule = ?", date, symbol, rule),
    );
    const s = r ? safeParse<RuleState | null>(r.json, null) : null;
    return s && r ? { ...s, version: r.version } : null;
  }

  /**
   * Optimistic write. `expectedVersion` 0 means "no row yet". The stored version
   * is max(s.version, expectedVersion + 1), so callers may pass the state either
   * unchanged or already bumped. Returns false when someone else wrote first.
   */
  async putRuleState(s: RuleState, expectedVersion: number): Promise<boolean> {
    const version = Math.max(s.version, expectedVersion + 1);
    const json = JSON.stringify({ ...s, version });
    const t = this.now();
    const sql =
      expectedVersion === 0
        ? this.p(
            "INSERT INTO rule_state (date, symbol, rule, version, json, updated_ms) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(date, symbol, rule) DO UPDATE SET version = excluded.version, json = excluded.json, updated_ms = excluded.updated_ms WHERE rule_state.version = 0",
            s.date, s.symbol, s.rule, version, json, t,
          )
        : this.p(
            "UPDATE rule_state SET version = ?, json = ?, updated_ms = ? WHERE date = ? AND symbol = ? AND rule = ? AND version = ?",
            version, json, t, s.date, s.symbol, s.rule, expectedVersion,
          );
    return (await this.run(sql)) === 1;
  }

  async claimAlertId(date: TradingDate, symbol: Symbol, rule: RuleKind, cycle: number): Promise<boolean> {
    const changes = await this.run(
      this.p("INSERT OR IGNORE INTO alert_ids (date, symbol, rule, cycle, created_ms) VALUES (?, ?, ?, ?, ?)", date, symbol, rule, cycle, this.now()),
    );
    return changes === 1;
  }

  // ------------------------------------------------------------ run bookkeeping
  async getMeta(k: string): Promise<string | null> {
    const r = await this.first<{ v: string }>(this.p("SELECT v FROM run_meta WHERE k = ?", k));
    return r ? r.v : null;
  }
  async setMeta(k: string, v: string): Promise<void> {
    await this.run(
      this.p("INSERT INTO run_meta (k, v, updated_ms) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_ms = excluded.updated_ms", k, v, this.now()),
    );
  }
  async getLastSuccessfulPollMs(): Promise<number | null> {
    const v = await this.getMeta("last_poll_ms");
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  }
  async setLastSuccessfulPollMs(ms: number): Promise<void> {
    await this.setMeta("last_poll_ms", String(ms));
  }

  // ------------------------------------------------------------ outbound queue
  async enqueue(event: OutboundEvent, priority: number, nowMs: number): Promise<void> {
    await this.run(this.p("INSERT INTO outbound_queue (priority, created_ms, event) VALUES (?, ?, ?)", priority, nowMs, JSON.stringify(event)));
    this.queueDirty = true;
  }
  async dequeueBatch(limit: number): Promise<{ id: number; event: OutboundEvent }[]> {
    const rows = await this.all<{ id: number; event: string }>(
      this.p("SELECT id, event FROM outbound_queue WHERE sent_ms IS NULL ORDER BY priority, id LIMIT ?", Math.max(1, Math.min(50, limit | 0))),
    );
    this.queueDirty = rows.length >= Math.max(1, Math.min(50, limit | 0)); // maybe more waiting
    const out: { id: number; event: OutboundEvent }[] = [];
    for (const r of rows) {
      const e = safeParse<OutboundEvent | null>(r.event, null);
      if (e) out.push({ id: r.id, event: e });
    }
    return out;
  }
  async markSent(id: number): Promise<void> {
    await this.run(this.p("UPDATE outbound_queue SET sent_ms = ? WHERE id = ?", this.now(), id));
  }
  async bumpAttempts(id: number): Promise<void> {
    await this.run(this.p("UPDATE outbound_queue SET attempts = attempts + 1 WHERE id = ?", id));
  }

  // ------------------------------------------------------------ log
  async log(entries: LogEntry[]): Promise<void> {
    await this.batch(
      entries.map((e) =>
        this.p("INSERT INTO log (t_ms, kind, symbol, rule, detail) VALUES (?, ?, ?, ?, ?)", e.tMs, e.kind, e.symbol ?? null, e.rule ?? null, JSON.stringify(e.detail ?? {})),
      ),
    );
  }

  async queryLog(opts: { limit: number; beforeMs?: number; kind?: string; symbol?: string }): Promise<LogRow[]> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.beforeMs !== undefined) { where.push("t_ms < ?"); args.push(opts.beforeMs); }
    if (opts.kind) { where.push("kind = ?"); args.push(opts.kind); }
    if (opts.symbol) { where.push("symbol = ?"); args.push(opts.symbol); }
    args.push(Math.max(1, Math.min(500, opts.limit | 0)));
    const rows = await this.all<{ id: number; t_ms: number; kind: string; symbol: string | null; rule: string | null; detail: string }>(
      this.p(`SELECT id, t_ms, kind, symbol, rule, detail FROM log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY t_ms DESC, id DESC LIMIT ?`, ...args),
    );
    return rows.map((r) => ({ id: r.id, tMs: r.t_ms, kind: r.kind, symbol: r.symbol, rule: r.rule, detail: safeParse(r.detail, {}) }));
  }

  async queryConfigLog(limit: number): Promise<unknown[]> {
    return this.all(this.p("SELECT t_ms, kind, key, prev, next FROM config_log ORDER BY id DESC LIMIT ?", Math.max(1, Math.min(200, limit | 0))));
  }

  // ------------------------------------------------------------ counters
  async bumpCounters(date: TradingDate, deltas: Record<string, number>): Promise<void> {
    await this.batch(
      Object.entries(deltas)
        .filter(([, v]) => v !== 0)
        .map(([name, v]) =>
          this.p("INSERT INTO counters (date, name, value) VALUES (?, ?, ?) ON CONFLICT(date, name) DO UPDATE SET value = value + excluded.value", date, name, v),
        ),
    );
  }
  async getCounters(date: TradingDate): Promise<Record<string, number>> {
    const rows = await this.all<{ name: string; value: number }>(this.p("SELECT name, value FROM counters WHERE date = ?", date));
    const out: Record<string, number> = {};
    for (const r of rows) out[r.name] = r.value;
    return out;
  }

  // ------------------------------------------------------------ dashboard (one round trip)
  async dashboardSnapshot(date: TradingDate): Promise<{
    settings: Settings;
    stocks: StockConfig[];
    market: MarketState[];
    rules: RuleState[];
    counters: Record<string, number>;
    lastPollMs: number | null;
  }> {
    const res = await this.batch([
      this.p("SELECT json FROM settings WHERE id = 1"),
      this.p("SELECT json FROM stocks ORDER BY symbol"),
      this.p("SELECT json FROM market_state WHERE date = ?", date),
      this.p("SELECT json, version FROM rule_state WHERE date = ?", date),
      this.p("SELECT name, value FROM counters WHERE date = ?", date),
      this.p("SELECT v FROM run_meta WHERE k = 'last_poll_ms'"),
    ]);
    const rs = (i: number) => (res[i]?.results ?? []) as Record<string, unknown>[];
    const settingsRow = rs(0)[0] as { json: string } | undefined;
    const counters: Record<string, number> = {};
    for (const r of rs(4)) counters[String(r.name)] = Number(r.value);
    const lp = rs(5)[0] as { v: string } | undefined;
    const lastPoll = lp ? Number(lp.v) : NaN;
    return {
      settings: { ...DEFAULT_SETTINGS, ...(settingsRow ? safeParse<Partial<Settings>>(settingsRow.json, {}) : {}) },
      stocks: rs(1).map((r) => safeParse<StockConfig | null>(String(r.json), null)).filter((x): x is StockConfig => !!x),
      market: rs(2).map((r) => safeParse<MarketState | null>(String(r.json), null)).filter((x): x is MarketState => !!x),
      rules: rs(3).flatMap((r) => {
        const s = safeParse<RuleState | null>(String(r.json), null);
        return s ? [{ ...s, version: Number(r.version) }] : [];
      }),
      counters,
      lastPollMs: Number.isFinite(lastPoll) ? lastPoll : null,
    };
  }

  // ------------------------------------------------------------ dashboard login throttle (FR-8.10)
  async getAuthRow(client: string): Promise<AuthRow | null> {
    return this.first<AuthRow>(this.p("SELECT fails, window_start_ms, locked_until_ms FROM auth_failures WHERE client = ?", client));
  }
  /** One upsert: counts the failure, resets an old window, locks at `max` failures. */
  async recordAuthFailure(client: string, nowMs: number, max: number, windowMs: number, lockMs: number): Promise<void> {
    await this.run(
      this.p(
        `INSERT INTO auth_failures (client, fails, window_start_ms, locked_until_ms) VALUES (?, 1, ?, 0)
         ON CONFLICT(client) DO UPDATE SET
           locked_until_ms = CASE WHEN window_start_ms > ? - ? AND fails + 1 >= ? THEN ? + ? ELSE 0 END,
           fails = CASE WHEN window_start_ms <= ? - ? THEN 1 ELSE fails + 1 END,
           window_start_ms = CASE WHEN window_start_ms <= ? - ? THEN ? ELSE window_start_ms END`,
        client, nowMs,
        nowMs, windowMs, max, nowMs, lockMs,
        nowMs, windowMs,
        nowMs, windowMs, nowMs,
      ),
    );
  }
  async clearAuthFailures(client: string): Promise<void> {
    await this.run(this.p("DELETE FROM auth_failures WHERE client = ?", client));
  }

  // ------------------------------------------------------------ retention (FR-11.2)
  async purgeOld(nowMs: number): Promise<void> {
    const cut90 = nowMs - PURGE_LOG_MS;
    const cutDate = new Date(cut90).toISOString().slice(0, 10);
    const cutMarket = new Date(nowMs - 14 * 86_400_000).toISOString().slice(0, 10);
    await this.batch([
      this.p("DELETE FROM log WHERE t_ms < ?", cut90),
      this.p("DELETE FROM config_log WHERE t_ms < ?", nowMs - 365 * 86_400_000),
      this.p("DELETE FROM outbound_queue WHERE sent_ms IS NOT NULL AND sent_ms < ?", nowMs - 7 * 86_400_000),
      this.p("DELETE FROM market_state WHERE date < ?", cutMarket),
      this.p("DELETE FROM rule_state WHERE date < ?", cutDate),
      this.p("DELETE FROM alert_ids WHERE date < ?", cutDate),
      this.p("DELETE FROM counters WHERE date < ?", cutDate),
      this.p("DELETE FROM auth_failures WHERE locked_until_ms < ? AND window_start_ms < ?", nowMs, nowMs - 86_400_000),
    ]);
  }
}

function safeParse<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
