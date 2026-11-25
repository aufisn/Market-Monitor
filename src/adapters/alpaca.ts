/**
 * MarketData port on Alpaca Market Data v2 REST (free IEX feed). PRD section 5.
 *
 * Credentials travel only in the APCA-API-KEY-ID / APCA-API-SECRET-KEY headers
 * and never appear in URLs, errors or logs. Only the fields the engine needs
 * are copied out of each response (CPU budget, PRD 1b).
 *
 * Everything not confirmed against live responses is tagged [UNVERIFIED-PHASE0].
 */
import type { Bar, DailyRef, MarketData, Snapshot, Symbol, TradingDate } from "../core/ports";
import { CallCounter, nyDate, parseTime, realSleep, type Sleep } from "./util";

export type AlpacaErrorKind = "AUTH" | "RATE_LIMIT" | "SERVER" | "TIMEOUT" | "NETWORK" | "BAD_REQUEST" | "PARSE" | "TOO_MANY_PAGES";

/** Typed provider error (FR-3.9). `message` is safe to show: no keys, no URLs. */
export class AlpacaError extends Error {
  override name = "AlpacaError";
  constructor(readonly kind: AlpacaErrorKind, message: string, readonly status?: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

export interface AlpacaConfig {
  keyId: string;
  secretKey: string;
  fetch?: typeof fetch;
  baseUrl?: string; // default https://data.alpaca.markets
  feed?: "iex" | "sip"; // live + intraday feed; default iex (free)
  timeoutMs?: number; // per attempt, default 4000
  maxRetryWaitMs?: number; // longest Retry-After we are willing to sit out inside a run, default 2500
  maxPages?: number; // pagination cap per call, default 12
  sleep?: Sleep;
  now?: () => number;
  counter?: CallCounter;
}

interface RawBar { t?: string; o?: number; h?: number; l?: number; c?: number; v?: number }
interface RawTrade { t?: string; p?: number; s?: number; c?: string[] }
interface RawSnapshot { latestTrade?: RawTrade; minuteBar?: RawBar; dailyBar?: RawBar; prevDailyBar?: RawBar }
interface RawBarsPage { bars?: Record<string, RawBar[] | null> | null; next_page_token?: string | null }

const MIN = 60_000;

export class AlpacaMarketData implements MarketData {
  private readonly f: typeof fetch;
  private readonly base: string;
  private readonly feed: "iex" | "sip";
  private readonly timeoutMs: number;
  private readonly maxRetryWaitMs: number;
  private readonly maxPages: number;
  private readonly sleep: Sleep;
  private readonly now: () => number;
  private readonly counter?: CallCounter;
  private readonly headers: Record<string, string>;

  private readonly lastMinute = new Map<string, Bar>();
  private readonly prevOfMinute = new Map<string, Bar>();

  constructor(cfg: AlpacaConfig) {
    this.f = cfg.fetch ?? ((input, init) => fetch(input, init));
    this.base = (cfg.baseUrl ?? "https://data.alpaca.markets").replace(/\/+$/, "");
    this.feed = cfg.feed ?? "iex";
    this.timeoutMs = cfg.timeoutMs ?? 4000;
    this.maxRetryWaitMs = cfg.maxRetryWaitMs ?? 2500;
    this.maxPages = cfg.maxPages ?? 12;
    this.sleep = cfg.sleep ?? realSleep;
    this.now = cfg.now ?? Date.now;
    this.counter = cfg.counter;
    this.headers = { "APCA-API-KEY-ID": cfg.keyId, "APCA-API-SECRET-KEY": cfg.secretKey, accept: "application/json" };
  }

  // ---------------------------------------------------------------- port
  async snapshots(symbols: Symbol[]): Promise<Record<Symbol, Snapshot>> {
    const out: Record<Symbol, Snapshot> = {};
    if (symbols.length === 0) return out;
    const raw = await this.get<Record<string, RawSnapshot> & { snapshots?: Record<string, RawSnapshot> }>("/v2/stocks/snapshots", {
      symbols: symbols.join(","),
      feed: this.feed,
    });
    // [UNVERIFIED-PHASE0] The multi-symbol response is a map keyed by symbol. Older docs
    // wrapped it in {"snapshots": {...}}; both shapes are accepted.
    const map = (raw.snapshots && typeof raw.snapshots === "object" ? raw.snapshots : raw) as Record<string, RawSnapshot | undefined>;
    const nowMs = this.now();
    const today = nyDate(nowMs);
    for (const sym of symbols) {
      const s = map[sym];
      if (!s || typeof s !== "object") continue; // unknown symbol: absent from result
      const snap: Snapshot = { symbol: sym };
      const lt = s.latestTrade;
      const tt = lt ? parseTime(lt.t) : NaN;
      if (lt && typeof lt.p === "number" && Number.isFinite(tt)) {
        // [UNVERIFIED-PHASE0] "c" = array of condition codes, "s" = size.
        snap.latestTrade = { t: tt, p: lt.p, s: typeof lt.s === "number" ? lt.s : 0, ...(Array.isArray(lt.c) ? { conditions: lt.c } : {}) };
      }
      const mb = mapBar(s.minuteBar);
      // [UNVERIFIED-PHASE0] It is undocumented whether minuteBar is the minute in progress or the
      // last completed one. It is passed through as-is; prevMinuteBar is filled from the
      // minuteBar seen on an earlier poll of this run when the minute has changed (the engine
      // also keeps its own stored copy). The snapshot itself has no previous-minute bar.
      if (mb) {
        snap.minuteBar = mb;
        const seen = this.lastMinute.get(sym);
        if (seen && seen.t < mb.t) snap.prevMinuteBar = seen;
        else if (seen && seen.t === mb.t) {
          const keep = this.prevOfMinute.get(sym);
          if (keep) snap.prevMinuteBar = keep;
        }
        if (!seen || seen.t !== mb.t) {
          if (seen && seen.t < mb.t) this.prevOfMinute.set(sym, seen);
        }
        this.lastMinute.set(sym, mb);
      }
      const db = mapBar(s.dailyBar);
      // [UNVERIFIED-PHASE0] Before the first trade of a day dailyBar may still be the previous
      // session's bar; its timestamp date is checked so yesterday is never shown as "today".
      if (db && typeof s.dailyBar?.t === "string" && s.dailyBar.t.slice(0, 10) === today) snap.dailyBar = db;
      out[sym] = snap;
    }
    return out;
  }

  async bars(symbol: Symbol, timeframe: "1Min" | "5Min" | "15Min", startMs: number, endMs: number): Promise<Bar[]> {
    const m = await this.barsMulti([symbol], timeframe, startMs, endMs);
    return m[symbol] ?? [];
  }

  async minuteBarsMulti(symbols: Symbol[], startMs: number, endMs: number): Promise<Record<Symbol, Bar[]>> {
    return this.barsMulti(symbols, "1Min", startMs, endMs);
  }

  async previousDaily(symbol: Symbol, beforeDate: TradingDate): Promise<DailyRef | null> {
    const endMs = Date.parse(`${beforeDate}T00:00:00Z`);
    if (!Number.isFinite(endMs)) throw new AlpacaError("BAD_REQUEST", "invalid date");
    // [UNVERIFIED-PHASE0] Daily bars are stamped at midnight New York (04:00Z/05:00Z) of the
    // session date, so "t < beforeDate 00:00Z" selects sessions strictly before beforeDate.
    // [UNVERIFIED-PHASE0] feed=sip is allowed on the free plan for data older than 15 minutes.
    const raw = await this.get<RawBarsPage>("/v2/stocks/bars", {
      symbols: symbol,
      timeframe: "1Day",
      start: new Date(endMs - 12 * 86_400_000).toISOString(),
      end: new Date(endMs).toISOString(),
      limit: "1",
      sort: "desc", // [UNVERIFIED-PHASE0] sort=desc honoured on multi-symbol bars
      feed: "sip",
      adjustment: "raw",
    });
    const rb = raw.bars?.[symbol]?.[0];
    const b = mapBar(rb);
    if (!b || typeof rb?.t !== "string") return null;
    return { symbol, date: rb.t.slice(0, 10), close: b.c, high: b.h, low: b.l, volume: b.v };
  }

  /**
   * Official daily bars (consolidated SIP feed) for many symbols in one request (paginated).
   * [UNVERIFIED-PHASE0] Free plan: SIP is served only when `end` is at least 15 minutes old
   * (otherwise HTTP 403, mapped to AUTH). [UNVERIFIED-PHASE0] The bar of the current day is
   * returned while the day is closed and covers the whole day up to `end`.
   */
  async officialDailyBars(symbols: Symbol[], startMs: number, endMs: number, opts: { splitAdjusted?: boolean } = {}): Promise<Record<Symbol, Bar[]>> {
    return this.barsMulti(symbols, "1Day", startMs, endMs, "sip", opts.splitAdjusted ? "split" : "raw");
  }

  // ---------------------------------------------------------------- bars with pagination
  private async barsMulti(
    symbols: Symbol[], tf: string, startMs: number, endMs: number, feed: "iex" | "sip" = this.feed, adjustment: "raw" | "split" = "raw",
  ): Promise<Record<Symbol, Bar[]>> {
    const out: Record<Symbol, Bar[]> = {};
    if (symbols.length === 0 || endMs <= startMs) return out;
    let token: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= this.maxPages) throw new AlpacaError("TOO_MANY_PAGES", "too many pages of bars; range too large");
      const raw = await this.get<RawBarsPage>("/v2/stocks/bars", {
        symbols: symbols.join(","),
        timeframe: tf,
        start: new Date(startMs).toISOString(),
        end: new Date(endMs).toISOString(),
        limit: "10000",
        feed,
        adjustment,
        sort: "asc",
        ...(token ? { page_token: token } : {}),
      });
      const bars = raw.bars ?? {};
      for (const sym of Object.keys(bars)) {
        const list = bars[sym];
        if (!Array.isArray(list)) continue;
        const dst = (out[sym] ??= []);
        for (const rb of list) {
          const b = mapBar(rb);
          if (b && b.t >= startMs && b.t < endMs) dst.push(b);
        }
      }
      token = raw.next_page_token || undefined;
      if (!token) break;
    }
    return out;
  }

  // ---------------------------------------------------------------- HTTP
  /** Read-only GET on the market-data host for the one-time access check (news, corporate actions). Same headers, retries and errors. */
  async rawGet(path: "/v1beta1/news" | "/v1/corporate-actions", params: Record<string, string>): Promise<unknown> {
    return this.get<unknown>(path, params);
  }

  private async get<T>(path: string, params: Record<string, string>): Promise<T> {
    const url = `${this.base}${path}?${new URLSearchParams(params).toString()}`;
    let lastErr: AlpacaError | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      this.counter?.spend();
      let res: Response;
      try {
        res = await this.f(url, { headers: this.headers, signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        const n = (e as { name?: string } | null)?.name;
        lastErr = n === "TimeoutError" || n === "AbortError"
          ? new AlpacaError("TIMEOUT", "market data request timed out")
          : new AlpacaError("NETWORK", "market data request failed");
        if (attempt === 0) { await this.sleep(300); continue; }
        throw lastErr;
      }
      const st = res.status;
      if (st >= 200 && st < 300) {
        try {
          return (await res.json()) as T;
        } catch {
          throw new AlpacaError("PARSE", "market data response was not valid JSON", st);
        }
      }
      if (st === 401 || st === 403) {
        // 403 can also be "subscription does not permit querying recent SIP data" [UNVERIFIED-PHASE0]
        throw new AlpacaError("AUTH", `market data rejected the credentials or plan (HTTP ${st})`, st);
      }
      if (st === 429) {
        const ra = Number(res.headers.get("retry-after"));
        const wait = Number.isFinite(ra) && ra >= 0 ? ra * 1000 : 1000; // [UNVERIFIED-PHASE0] header present on 429
        lastErr = new AlpacaError("RATE_LIMIT", "market data rate limit reached", st, wait);
        if (attempt === 0 && wait <= this.maxRetryWaitMs) { await this.sleep(wait); continue; }
        throw lastErr;
      }
      if (st >= 500) {
        lastErr = new AlpacaError("SERVER", `market data server error (HTTP ${st})`, st);
        if (attempt === 0) { await this.sleep(500); continue; }
        throw lastErr;
      }
      throw new AlpacaError("BAD_REQUEST", `market data request refused (HTTP ${st})`, st);
    }
    throw lastErr ?? new AlpacaError("NETWORK", "market data request failed");
  }
}

function mapBar(b: RawBar | undefined | null): Bar | undefined {
  if (!b || typeof b.o !== "number" || typeof b.h !== "number" || typeof b.l !== "number" || typeof b.c !== "number") return undefined;
  const t = parseTime(b.t);
  if (!Number.isFinite(t)) return undefined;
  return { t, o: b.o, h: b.h, l: b.l, c: b.c, v: typeof b.v === "number" ? b.v : 0 };
}
