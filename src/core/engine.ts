/**
 * Per-run orchestration used by the Worker (and by a Mac-mini host later).
 * One runTick = one poll. Nothing is held in memory between runs (FR-4.9).
 * Every port call is counted; optional work stops before 45 calls (PRD 1c).
 */
import { applyObservation, bump, closeActiveRules, emit, fireAlert, flush, freshState, newOut, persist, reminderDue, ruleKey, sendDueReminders } from "./alerts";
import { baselineProgress, baselineWindow, buildBaseline, pickNextBaseline } from "./baseline";
import { calendarStatus, sessionFor } from "./calendar";
import type { Session } from "./calendar";
import { gapWindow, scanGap } from "./gapscan";
import type { GapRule } from "./gapscan";
import { EVENT_PRIORITY } from "./ports";
import type { Baseline, MarketData, MarketState, OutboundEvent, Settings, Snapshot, StockConfig, Store, TradingDate } from "./ports";
import { evaluatePrice, evaluateVolume, isFlaggedTrade, priceInsideBuffer, resolveThreshold, volumeInsideBuffer } from "./rules";
import { MIN, nyDate, nyParts } from "./time";

export interface Ports {
  store: Store;
  market: MarketData;
}
export interface TickOptions {
  holder?: string;
  /** Tests only: skip the lease to prove that alert-id de-duplication alone is enough (FR-4.10). */
  skipLease?: boolean;
}
export interface TickSummary {
  status: "idle" | "skipped" | "ok" | "data_error" | "expired" | "pre_open" | "closing";
  polled: number;
  events: number;
  writes: number;
  calls: number;
}

export const CALL_BUDGET = 45;
const TAIL = 6; // calls reserved for the final writes, flush and lease release
const LEASE = "run";
const LEASE_TTL_MS = 50_000;
const MARKET_WRITE_EVERY_MS = 30_000;
const BRIEFING_DELAY_MS = 60_000;
const BRIEFING_WAIT_MS = 10 * MIN;
const READY_BEFORE_OPEN_MS = 30 * MIN; // 09:00 ET
const PRE_OPEN_WINDOW_MS = 150 * MIN; // 07:00 ET
const ENDED_AFTER_CLOSE_MS = 5 * MIN;
const POST_CLOSE_WINDOW_MS = 30 * MIN;
const PREV_CLOSE_PER_RUN = 12;

// ------------------------------------------------------------ call metering
interface Meter {
  calls: number;
  writes: number;
  events: number;
  polled: number;
}
const WRITES = /^(put|enqueue|claim|bump|log|set|delete|mark|release)/;
function metered<T extends object>(obj: T, m: Meter): T {
  return new Proxy(obj, {
    get(t, k, r) {
      const v = Reflect.get(t, k, r);
      if (typeof v !== "function" || typeof k !== "string") return v;
      return (...a: unknown[]) => {
        m.calls++;
        if (WRITES.test(k)) m.writes++;
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  });
}
const summary = (status: TickSummary["status"], m: Meter): TickSummary => ({ status, polled: m.polled, events: m.events, writes: m.writes, calls: m.calls });
const newMeter = (): Meter => ({ calls: 0, writes: 0, events: 0, polled: 0 });

// ------------------------------------------------------------ helpers
async function loadBaselines(store: Store, stocks: StockConfig[], m: Meter): Promise<Map<string, Baseline>> {
  const out = new Map<string, Baseline>();
  if (store.getBaselines) {
    for (const b of await store.getBaselines()) out.set(b.symbol, b);
  } else {
    for (const s of stocks) {
      if (m.calls >= CALL_BUDGET - 12) break; // fallback is expensive; adapters should implement getBaselines
      const b = await store.getBaseline(s.symbol);
      if (b) out.set(s.symbol, b);
    }
  }
  return out;
}

/** Once-only marker through the counters table (scope = trading date, or "meta" for forever). */
async function once(store: Store, m: Meter, scope: string, key: string, ev: OutboundEvent, nowMs: number): Promise<boolean> {
  if ((await store.getCounters(scope))[key]) return false;
  await store.bumpCounters(scope, { [key]: 1 });
  await store.enqueue(ev, EVENT_PRIORITY[ev.type], nowMs);
  m.events++;
  return true;
}

/** FR-10.3: at most about one notice per code per 30 minutes. */
const noticeKey = (code: string, nowMs: number) => `notice:${code}:${Math.floor(nowMs / (30 * MIN))}`;

const effective = (set: Settings, s?: StockConfig): Settings => (s?.overrides ? { ...set, ...s.overrides } : set);
const quiet = (s: StockConfig, nowMs: number) => !!s.paused || (s.mutedUntilMs !== undefined && s.mutedUntilMs > nowMs);

/** Fold a snapshot into the stored market state (in memory). */
function refresh(prev: MarketState | undefined, symbol: string, date: TradingDate, snap: Snapshot, nowMs: number): MarketState {
  const ms: MarketState = { ...(prev ?? { symbol, date }) };
  if (snap.latestTrade && !isFlaggedTrade(snap.latestTrade)) ms.last = snap.latestTrade;
  const d = snap.dailyBar;
  if (d) {
    ms.open = d.o;
    ms.dayHigh = d.h;
    ms.dayLow = d.l;
    ms.cumVolume = d.v;
  }
  // New minute since the stored poll: remember the last completed minute's close for the FR-3.4 median.
  // prevMinuteBar is optional in the data; fall back to the last stored trade price as the proxy close.
  const minuteClose = snap.prevMinuteBar?.c ?? prev?.last?.p;
  if (minuteClose !== undefined && prev?.lastPollMs !== undefined && Math.floor(nowMs / MIN) > Math.floor(prev.lastPollMs / MIN)) {
    ms.recentMinuteCloses = [...(prev.recentMinuteCloses ?? []), minuteClose].slice(-5);
  }
  ms.lastPollMs = nowMs;
  return ms;
}

const sig = (m: MarketState | undefined) =>
  m ? `${m.last?.t}|${m.last?.p}|${m.open}|${m.dayHigh}|${m.dayLow}|${m.cumVolume}|${m.prev?.close}|${m.recentMinuteCloses?.length}` : "";

// ------------------------------------------------------------ runTick
export async function runTick(ports: Ports, nowMs: number, opts: TickOptions = {}): Promise<TickSummary> {
  const m = newMeter();
  const store = metered(ports.store, m);
  const market = metered(ports.market, m);
  const date = nyDate(nowMs);
  const session = sessionFor(date);

  if (session.kind === "expired") return handleExpired(store, m, nowMs);
  if (session.kind === "closed" || nowMs < session.open) return summary("idle", m); // FR-1.1, exits at once
  if (nowMs >= session.close) return closing(store, m, session, nowMs, opts);

  const holder = opts.holder ?? `run-${nowMs}-${Math.random().toString(36).slice(2, 8)}`;
  if (!opts.skipLease && !(await store.acquireLease(LEASE, holder, nowMs, LEASE_TTL_MS))) return summary("skipped", m);
  try {
    return await tick(store, market, session, date, nowMs, m);
  } finally {
    if (!opts.skipLease) await store.releaseLease(LEASE, holder);
  }
}

async function handleExpired(store: Store, m: Meter, nowMs: number): Promise<TickSummary> {
  const p = nyParts(nowMs);
  // Only look during weekday daytime so the check costs nothing the rest of the time.
  if (p.dow >= 1 && p.dow <= 5 && p.minuteOfDay >= 540 && p.minuteOfDay <= 990) {
    const st = calendarStatus(nowMs);
    await once(store, m, "meta", "calExpired", { type: "OPS_NOTICE", code: "CALENDAR_EXPIRED", detail: `Calendar valid until ${st.validUntil}; no alerts until it is updated.` }, nowMs);
  }
  return summary("expired", m);
}

async function tick(
  store: Store, market: MarketData, session: Extract<Session, { kind: "open" }>, date: TradingDate, nowMs: number, m: Meter,
): Promise<TickSummary> {
  const [set0, stocks, mstates, rstates, lastPoll] = await Promise.all([
    store.getSettings(), store.listStocks(), store.getMarketStates(date), store.getRuleStates(date), store.getLastSuccessfulPollMs(),
  ]);
  const out = newOut();
  const active = stocks.filter((s) => s.enabled);
  const byName = new Map(active.map((s) => [s.symbol, s]));
  const settingsFor = (sym: string) => effective(set0, byName.get(sym));
  const stored = new Map(mstates.map((s) => [s.symbol, s]));
  const rs = new Map(rstates.map((s) => [ruleKey(s.symbol, s.rule), s]));

  if (!active.length) {
    await store.setLastSuccessfulPollMs(nowMs);
    return summary("ok", m);
  }

  // --- poll (retry once, FR-3.9)
  let snaps: Record<string, Snapshot>;
  try {
    try {
      snaps = await market.snapshots(active.map((s) => s.symbol));
    } catch {
      snaps = await market.snapshots(active.map((s) => s.symbol));
    }
  } catch {
    await once(store, m, date, noticeKey("DATA_ERROR", nowMs), { type: "OPS_NOTICE", code: "DATA_ERROR", detail: "Market data request failed twice." }, nowMs);
    return summary("data_error", m);
  }

  // --- Previous Close for stocks that lack it (late additions); capped per run
  const missingPrev = active.filter((s) => !stored.get(s.symbol)?.prev && snaps[s.symbol]).slice(0, 3);
  const prevs = await Promise.all(missingPrev.map((s) => market.previousDaily(s.symbol, date).catch(() => null)));

  // --- fold snapshots into market states
  const mem = new Map<string, MarketState>();
  const toWrite: MarketState[] = [];
  active.forEach((s) => {
    const snap = snaps[s.symbol];
    const old = stored.get(s.symbol);
    if (!snap) {
      if (old) mem.set(s.symbol, old);
      return;
    }
    m.polled++;
    const ref = prevs[missingPrev.indexOf(s)];
    const base = ref ? { ...(old ?? { symbol: s.symbol, date }), prev: ref } : old;
    const ms = refresh(base, s.symbol, date, snap, nowMs);
    mem.set(s.symbol, ms);
    const due = !old?.lastPollMs || nowMs - old.lastPollMs >= MARKET_WRITE_EVERY_MS || !!ref;
    if (due && sig(ms) !== sig(old)) toWrite.push(ms);
  });

  // --- baselines (only if a volume rule exists)
  const volStocks = active.filter((s) => s.volume?.mode === "multiple");
  const baselines = volStocks.length ? await loadBaselines(store, volStocks, m) : new Map<string, Baseline>();
  const canSpend = () => m.calls < CALL_BUDGET - TAIL;

  // --- thresholds for this run
  const prevClose = (sym: string) => mem.get(sym)?.prev?.close;
  const priceThr = (s: StockConfig, kind: "HIGH" | "LOW") => resolveThreshold(kind === "HIGH" ? s.high : s.low, prevClose(s.symbol));
  const liveStocks = active.filter((s) => !quiet(s, nowMs) && mem.has(s.symbol));

  // --- gap scan (FR-9) BEFORE the normal evaluation, so late alerts own the rule first
  const win = gapWindow(lastPoll, nowMs, session.open, session.close);
  if (win && canSpend()) {
    const rules: GapRule[] = [];
    for (const s of liveStocks) {
      for (const kind of ["HIGH", "LOW"] as const) {
        const thr = priceThr(s, kind);
        if (thr !== undefined) rules.push({ symbol: s.symbol, rule: kind, threshold: thr, state: rs.get(ruleKey(s.symbol, kind)) });
      }
    }
    const armed = rules.filter((r) => !r.state || r.state.state === "ARMED");
    if (armed.length) {
      try {
        const syms = [...new Set(armed.map((r) => r.symbol))];
        const bars = await market.minuteBarsMulti(syms, win.startMs, win.endMs);
        const seeds = Object.fromEntries(syms.map((y) => [y, stored.get(y)?.recentMinuteCloses ?? []]));
        for (const hit of scanGap(armed, bars, set0.spikeHoldPct, seeds)) {
          if (!canSpend()) break;
          const key = ruleKey(hit.symbol, hit.rule);
          const cur = rs.get(key) ?? freshState(date, hit.symbol, hit.rule);
          const obs = { crossing: { value: hit.price, touchedAtMs: hit.barTimeMs }, threshold: hit.threshold, insideBuffer: false, held: null };
          const next = await fireAlert(store, out, cur, obs, mem.get(hit.symbol)!, nowMs, settingsFor(hit.symbol), { barTimeMs: hit.barTimeMs, barPrice: hit.price });
          if (next) rs.set(key, next);
        }
      } catch {
        await once(store, m, date, noticeKey("GAP_SCAN_ERROR", nowMs), { type: "OPS_NOTICE", code: "GAP_SCAN_ERROR", detail: "Gap scan could not fetch bars." }, nowMs);
      }
    }
  }

  // --- evaluate every rule (FR-3)
  const backInside = new Map<string, boolean>();
  const minutes = (nowMs - session.open) / MIN;
  for (const s of liveStocks) {
    const ms = mem.get(s.symbol)!;
    const snap = snaps[s.symbol]!;
    const set = settingsFor(s.symbol);
    const rules: { kind: "HIGH" | "LOW" | "VOLUME"; thr?: number; crossing: ReturnType<typeof evaluatePrice>["crossing"]; inside: boolean; held: number | null; back: boolean }[] = [];
    for (const kind of ["HIGH", "LOW"] as const) {
      const thr = priceThr(s, kind);
      if (thr === undefined) continue;
      const cur = rs.get(ruleKey(s.symbol, kind));
      const ev = evaluatePrice(kind, thr, snap, { sessionOpenMs: session.open, recentCloses: stored.get(s.symbol)?.recentMinuteCloses, spikeHoldPct: set.spikeHoldPct, heldPrice: cur?.heldPrice });
      const lp = ev.lastPrice;
      rules.push({
        kind, thr, crossing: ev.crossing, held: ev.held,
        inside: priceInsideBuffer(kind, lp, thr, set.rearmBufferPricePct),
        back: lp !== undefined && (kind === "HIGH" ? lp < thr : lp > thr),
      });
    }
    if (s.volume) {
      const ve = evaluateVolume(ms.cumVolume, s.volume, baselines.get(s.symbol), minutes, set);
      rules.push({
        kind: "VOLUME", thr: ve.threshold,
        crossing: ve.status === "CROSSED" ? { value: ms.cumVolume! } : null, held: null,
        inside: ve.threshold !== undefined && volumeInsideBuffer(ms.cumVolume, ve.threshold, set.rearmBufferVolumePct),
        back: ve.status !== "CROSSED",
      });
    }
    for (const r of rules) {
      if (r.thr === undefined) continue;
      const key = ruleKey(s.symbol, r.kind);
      backInside.set(key, r.back);
      const cur = rs.get(key) ?? freshState(date, s.symbol, r.kind);
      const obs = { crossing: r.crossing, threshold: r.thr, insideBuffer: r.inside, held: r.held };
      const step = applyObservation(cur, obs, set);
      if (step.fire) {
        if (!canSpend()) continue; // stays ARMED; next poll retries
        const next = await fireAlert(store, out, cur, obs, ms, nowMs, set);
        if (next) rs.set(key, next);
      } else if (step.next !== cur && (await persist(store, step.next, cur.version))) {
        rs.set(key, { ...step.next, version: cur.version + 1 });
      }
    }
  }

  // --- reminders (FR-4.2); re-read inside sendDueReminders (FR-4.5)
  const room = Math.max(0, Math.floor((CALL_BUDGET - TAIL - m.calls) / 3));
  const due = [...rs.values()]
    .filter((r) => reminderDue(r, nowMs) && liveStocks.some((x) => x.symbol === r.symbol))
    .sort((a, b) => (a.t0Ms ?? 0) - (b.t0Ms ?? 0))
    .slice(0, room);
  if (due.length) await sendDueReminders(store, out, due, mem, backInside, nowMs, settingsFor);

  // --- opening briefing (FR-7)
  await maybeBriefing(store, m, session, date, nowMs, active, mem);

  // --- writes
  if (toWrite.length) await store.putMarketStates(toWrite);
  await store.setLastSuccessfulPollMs(nowMs);
  m.events += out.events;
  await flush(store, out, date);
  return summary("ok", m);
}

async function maybeBriefing(
  store: Store, m: Meter, session: Extract<Session, { kind: "open" }>, date: TradingDate, nowMs: number, active: StockConfig[], mem: Map<string, MarketState>,
): Promise<void> {
  const since = nowMs - session.open;
  if (since < BRIEFING_DELAY_MS || since > 30 * MIN) return;
  const states = active.map((s) => mem.get(s.symbol)).filter((x): x is MarketState => !!x);
  const ready = active.every((s) => mem.get(s.symbol)?.open !== undefined);
  if (!ready && since < BRIEFING_WAIT_MS) return; // open prices missing: wait up to 10 minutes
  const gap = (x: MarketState) => (x.open !== undefined && x.prev ? Math.abs(x.open - x.prev.close) / x.prev.close : -1);
  states.sort((a, b) => gap(b) - gap(a)); // largest gap first (FR-7.4)
  await once(store, m, date, "briefing", { type: "BRIEFING", date, stocks: states }, nowMs);
}

// ------------------------------------------------------------ after the close
async function closing(store: Store, m: Meter, session: Extract<Session, { kind: "open" }>, nowMs: number, opts: TickOptions): Promise<TickSummary> {
  if (nowMs >= session.close + POST_CLOSE_WINDOW_MS) return summary("idle", m);
  const date = session.date;
  const holder = opts.holder ?? `close-${nowMs}`;
  if (!opts.skipLease && !(await store.acquireLease(LEASE, holder, nowMs, LEASE_TTL_MS))) return summary("skipped", m);
  try {
    const c = await store.getCounters(date);
    const out = newOut();
    if (!c.closed) {
      const closed = await closeActiveRules(store, await store.getRuleStates(date)); // FR-4.8 / I-6
      if (closed.length) await emit(store, out, { type: "UNACK_AT_CLOSE", date, rules: closed }, nowMs);
      bump(out, "closed");
      bump(out, "unacked", closed.length);
      c.unacked = (c.unacked ?? 0) + closed.length;
    }
    if (!c.ended && nowMs >= session.close + ENDED_AFTER_CLOSE_MS) {
      const counts: Record<string, number> = {};
      for (const k of ["alerts", "lateAlerts", "reminders", "acks", "unacked"]) counts[k] = c[k] ?? 0;
      await emit(store, out, { type: "SESSION_ENDED", date, counts }, nowMs);
      bump(out, "ended");
    }
    m.events += out.events;
    await flush(store, out, date);
    return summary("closing", m);
  } finally {
    if (!opts.skipLease) await store.releaseLease(LEASE, holder);
  }
}

// ------------------------------------------------------------ pre-open (FR-6.2, FR-6.3, FR-10.1)
export async function runPreOpen(ports: Ports, nowMs: number, opts: TickOptions = {}): Promise<TickSummary> {
  const m = newMeter();
  const store = metered(ports.store, m);
  const market = metered(ports.market, m);
  const date = nyDate(nowMs);
  const session = sessionFor(date);
  if (session.kind === "expired") return handleExpired(store, m, nowMs);
  if (session.kind !== "open" || nowMs >= session.open || nowMs < session.open - PRE_OPEN_WINDOW_MS) return summary("idle", m);

  const holder = opts.holder ?? `pre-${nowMs}`;
  if (!opts.skipLease && !(await store.acquireLease(LEASE, holder, nowMs, LEASE_TTL_MS))) return summary("skipped", m);
  try {
    const [set, stocks, mstates] = await Promise.all([store.getSettings(), store.listStocks(), store.getMarketStates(date)]);
    const active = stocks.filter((s) => s.enabled);
    const ms = new Map(mstates.map((x) => [x.symbol, x]));
    const baselines = await loadBaselines(store, active, m);

    // Previous Close, once per day (FR-6.3); a dozen per run
    const need = active.filter((s) => !ms.get(s.symbol)?.prev).slice(0, Math.min(PREV_CLOSE_PER_RUN, CALL_BUDGET - TAIL - 6 - m.calls));
    const refs = await Promise.all(need.map((s) => market.previousDaily(s.symbol, date).catch(() => null)));
    const fresh: MarketState[] = [];
    need.forEach((s, i) => {
      const ref = refs[i];
      if (!ref) return;
      const next = { ...(ms.get(s.symbol) ?? { symbol: s.symbol, date }), prev: ref };
      ms.set(s.symbol, next);
      fresh.push(next);
    });
    if (fresh.length) await store.putMarketStates(fresh);

    // One baseline per run (FR-6.2)
    const pick = pickNextBaseline(active, [...baselines.values()], date);
    if (pick) {
      try {
        const w = baselineWindow(date, set.baselineSessions);
        const bars = await market.bars(pick, "5Min", w.startMs, w.endMs);
        const b = buildBaseline(pick, date, bars, set.baselineSessions, 5);
        await store.putBaseline(b);
        baselines.set(pick, b);
      } catch {
        await once(store, m, date, noticeKey("BASELINE_ERROR", nowMs), { type: "OPS_NOTICE", code: "BASELINE_ERROR", detail: `Baseline build failed for ${pick}.` }, nowMs);
      }
    }

    // Silent READY from 09:00 ET (FR-10.1)
    if (nowMs >= session.open - READY_BEFORE_OPEN_MS) {
      const cal = calendarStatus(nowMs);
      const prog = baselineProgress(active, [...baselines.values()], date);
      const info = {
        stocksActive: active.length,
        baselinesDone: prog.done,
        baselinesTotal: prog.total,
        noBaseline: active.filter((s) => s.volume?.mode === "multiple" && baselines.get(s.symbol)?.status !== "OK").map((s) => s.symbol),
        missingPrevClose: active.filter((s) => !ms.get(s.symbol)?.prev).map((s) => s.symbol),
        calendarValidUntil: cal.validUntil,
        calendarDaysLeft: cal.daysLeft,
        closeMs: session.close,
        early: session.early,
      };
      await once(store, m, date, "ready", { type: "READY", date, info }, nowMs);
      if (cal.warn) {
        await once(store, m, "meta", `calWarn:${cal.validUntil}`, { type: "OPS_NOTICE", code: "CALENDAR_EXPIRING", detail: `Calendar valid until ${cal.validUntil} (${cal.daysLeft} days left). Update it.` }, nowMs);
      }
    }
    return summary("pre_open", m);
  } finally {
    if (!opts.skipLease) await store.releaseLease(LEASE, holder);
  }
}

/** Convenience for the Worker's cron: pick the right job for this minute. */
export async function runScheduled(ports: Ports, nowMs: number, opts: TickOptions = {}): Promise<TickSummary> {
  const s = sessionFor(nyDate(nowMs));
  if (s.kind === "open" && nowMs < s.open) return runPreOpen(ports, nowMs, opts);
  return runTick(ports, nowMs, opts);
}
