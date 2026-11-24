/**
 * Per-rule alert state machine (FR-4):
 *   ARMED -> TRIGGERED -> REPEATING -> ACKNOWLEDGED -> ARMED, plus UNACKNOWLEDGED_AT_CLOSE.
 * Pure transitions first, then the store-backed actions around them.
 *
 * Versioning convention: every write passes `{...state, version: expected + 1}`
 * and `expected`. A row that does not exist yet has expected version 0.
 */
import { EVENT_PRIORITY } from "./ports";
import type { AlertState, LogEntry, MarketState, OutboundEvent, RuleKind, RuleState, Settings, Store, TradingDate } from "./ports";
import { MIN } from "./time";

export const ruleKey = (symbol: string, rule: RuleKind) => `${symbol}|${rule}`;
export const isActive = (s: RuleState): boolean => s.state === "TRIGGERED" || s.state === "REPEATING";

export function freshState(date: TradingDate, symbol: string, rule: RuleKind): RuleState {
  return { date, symbol, rule, state: "ARMED", cycle: 0, remindersSent: 0, version: 0 };
}

// ------------------------------------------------------------ pure transitions
export interface Obs {
  crossing: { value: number; touchedAtMs?: number } | null;
  threshold: number;
  /** Back inside the band by the re-arm buffer (I-5). */
  insideBuffer: boolean;
  /** Spike awaiting confirmation (FR-3.4) or null. */
  held: number | null;
}

const toArmed = (s: RuleState): RuleState => ({ ...s, state: "ARMED", nextReminderMs: undefined, heldPrice: undefined });

/** Non-alerting transitions. `fire` = a new crossing from ARMED (caller runs fireAlert). */
export function applyObservation(s: RuleState, o: Obs, set: Settings): { next: RuleState; fire: boolean } {
  switch (s.state) {
    case "ARMED":
      if (o.crossing) return { next: s, fire: true };
      return { next: (o.held ?? undefined) === s.heldPrice ? s : { ...s, heldPrice: o.held ?? undefined }, fire: false };
    case "ACKNOWLEDGED": // I-5: must return inside by the buffer before it can alert again
      return { next: o.insideBuffer ? toArmed(s) : s, fire: false };
    case "TRIGGERED":
    case "REPEATING":
      return { next: set.autoClear && o.insideBuffer ? toArmed(s) : s, fire: false };
    default:
      return { next: s, fire: false };
  }
}

export function triggered(
  s: RuleState, value: number, threshold: number, touchedAtMs: number | undefined, late: boolean, nowMs: number, set: Settings,
): RuleState {
  return {
    ...s, state: "TRIGGERED", cycle: s.cycle + 1, t0Ms: nowMs, t0Value: value, thresholdAtT0: threshold,
    touchedAtMs, late, remindersSent: 0, nextReminderMs: nowMs + set.reminderIntervalMin * MIN,
    ackMs: undefined, ackBy: undefined, heldPrice: undefined,
  };
}

export const reminderDue = (s: RuleState, nowMs: number): boolean => isActive(s) && s.nextReminderMs !== undefined && nowMs >= s.nextReminderMs;

/** Reminder k is due at T0 + k*interval; after a long gap, skip the missed numbers and send one. */
export function advanceReminder(s: RuleState, nowMs: number, set: Settings): RuleState {
  const interval = set.reminderIntervalMin * MIN;
  const k = Math.max(s.remindersSent + 1, Math.floor((nowMs - (s.t0Ms ?? nowMs)) / interval));
  return { ...s, state: "REPEATING", remindersSent: k, nextReminderMs: (s.t0Ms ?? nowMs) + (k + 1) * interval };
}

export const ackState = (s: RuleState, by: NonNullable<RuleState["ackBy"]>, nowMs: number): RuleState | null =>
  isActive(s) ? { ...s, state: "ACKNOWLEDGED", ackMs: nowMs, ackBy: by, nextReminderMs: undefined } : null;

// ------------------------------------------------------------ store-backed actions
export interface Out {
  logs: LogEntry[];
  counters: Record<string, number>;
  events: number;
}
export const newOut = (): Out => ({ logs: [], counters: {}, events: 0 });
export const bump = (out: Out, key: string, n = 1) => void (out.counters[key] = (out.counters[key] ?? 0) + n);

export async function emit(store: Store, out: Out, ev: OutboundEvent, nowMs: number): Promise<void> {
  await store.enqueue(ev, EVENT_PRIORITY[ev.type], nowMs);
  out.events++;
}

export async function flush(store: Store, out: Out, date: TradingDate): Promise<void> {
  if (out.logs.length) await store.log(out.logs);
  if (Object.keys(out.counters).length) await store.bumpCounters(date, out.counters);
  out.logs = [];
  out.counters = {};
}

export const persist = (store: Store, next: RuleState, expected: number): Promise<boolean> =>
  store.putRuleState({ ...next, version: expected + 1 }, expected);

/** First alert (FR-4.1) or late alert (FR-9.3). Returns the stored TRIGGERED state, or null if another run owns this alert id. */
export async function fireAlert(
  store: Store, out: Out, s: RuleState, o: Obs, market: MarketState, nowMs: number, set: Settings,
  late?: { barTimeMs: number; barPrice: number },
): Promise<RuleState | null> {
  const cycle = s.cycle + 1;
  if (!(await store.claimAlertId(s.date, s.symbol, s.rule, cycle))) {
    out.logs.push({ tMs: nowMs, kind: "SUPPRESSED", symbol: s.symbol, rule: s.rule, detail: { reason: "duplicate alert id", cycle } });
    return null;
  }
  const next = triggered(s, o.crossing!.value, o.threshold, o.crossing!.touchedAtMs, !!late, nowMs, set);
  let base = s.version;
  let ok = await persist(store, next, base);
  if (!ok) {
    const cur = await store.getRuleState(s.date, s.symbol, s.rule);
    if (!cur || cur.state !== "ARMED" || cur.cycle !== s.cycle) return null;
    base = cur.version;
    if (!(await persist(store, next, base))) return null;
  }
  const stored = { ...next, version: base + 1 };
  const ev: OutboundEvent = late
    ? { type: "LATE_ALERT", rule: stored, market, threshold: o.threshold, barTimeMs: late.barTimeMs, barPrice: late.barPrice }
    : { type: "FIRST_ALERT", rule: stored, market, threshold: o.threshold };
  await emit(store, out, ev, nowMs);
  out.logs.push({
    tMs: nowMs, kind: late ? "LATE_ALERT" : "FIRST_ALERT", symbol: s.symbol, rule: s.rule,
    detail: { value: o.crossing!.value, threshold: o.threshold, touchedAtMs: o.crossing!.touchedAtMs, cycle },
  });
  bump(out, late ? "lateAlerts" : "alerts");
  return stored;
}

/**
 * Reminders for rules found due (FR-4.2). FR-4.5: each rule is re-read from the
 * store right before sending and written with a version check, so an
 * acknowledgment that landed first wins. FR-4.13: one message per stock.
 */
export async function sendDueReminders(
  store: Store, out: Out, due: RuleState[], markets: Map<string, MarketState>,
  backInside: Map<string, boolean>, nowMs: number, settingsFor: (symbol: string) => Settings,
): Promise<void> {
  const bySymbol = new Map<string, RuleState[]>();
  for (const s of due) bySymbol.set(s.symbol, [...(bySymbol.get(s.symbol) ?? []), s]);
  for (const [symbol, rules] of bySymbol) {
    const sent: RuleState[] = [];
    for (const r of rules) {
      const fresh = await store.getRuleState(r.date, r.symbol, r.rule);
      if (!fresh || !reminderDue(fresh, nowMs)) continue; // acknowledged, closed, or another run sent it
      const next = advanceReminder(fresh, nowMs, settingsFor(symbol));
      if (await persist(store, next, fresh.version)) sent.push({ ...next, version: fresh.version + 1 });
    }
    if (!sent.length) continue;
    const inside = sent.every((r) => backInside.get(ruleKey(r.symbol, r.rule)) === true);
    await emit(store, out, { type: "REMINDER", rules: sent, market: markets.get(symbol) ?? { symbol, date: sent[0]!.date }, backInside: inside }, nowMs);
    for (const r of sent) out.logs.push({ tMs: nowMs, kind: "REMINDER", symbol, rule: r.rule, detail: { n: r.remindersSent, backInside: inside } });
    bump(out, "reminders", sent.length);
  }
}

/** Acknowledge one rule (any channel). Retries on version conflicts; false if nothing active to acknowledge. */
export async function acknowledge(
  store: Store, date: TradingDate, symbol: string, rule: RuleKind, by: NonNullable<RuleState["ackBy"]>, nowMs: number, known?: RuleState,
): Promise<boolean> {
  let s: RuleState | null = known ?? null;
  for (let i = 0; i < 3; i++) {
    if (!s || i > 0) s = await store.getRuleState(date, symbol, rule);
    if (!s) return false;
    const next = ackState(s, by, nowMs);
    if (!next) return false;
    if (await persist(store, next, s.version)) {
      const out = newOut();
      await emit(store, out, { type: "ACK_CONFIRM", rule: { ...next, version: s.version + 1 } }, nowMs);
      out.logs.push({ tMs: nowMs, kind: "ACK", symbol, rule, detail: { by } });
      bump(out, "acks");
      await flush(store, out, date);
      return true;
    }
  }
  return false;
}

export async function acknowledgeAll(store: Store, date: TradingDate, by: NonNullable<RuleState["ackBy"]>, nowMs: number): Promise<number> {
  let n = 0;
  for (const s of await store.getRuleStates(date)) {
    if (isActive(s) && (await acknowledge(store, date, s.symbol, s.rule, by, nowMs, s))) n++;
  }
  return n;
}

/** Editing a threshold re-arms an acknowledged / closed rule at once (I-5). A live unacknowledged alert keeps reminding. */
export async function rearmAfterEdit(store: Store, date: TradingDate, symbol: string, rule: RuleKind): Promise<boolean> {
  const s = await store.getRuleState(date, symbol, rule);
  if (!s || (s.state !== "ACKNOWLEDGED" && s.state !== "UNACKNOWLEDGED_AT_CLOSE")) return false;
  return persist(store, toArmed(s), s.version);
}

/** FR-4.8 / I-6: at the close, live alerts become UNACKNOWLEDGED_AT_CLOSE and stop reminding. */
export async function closeActiveRules(store: Store, states: RuleState[]): Promise<RuleState[]> {
  const closed: RuleState[] = [];
  for (const s of states) {
    if (!isActive(s)) continue;
    const next: RuleState = { ...s, state: "UNACKNOWLEDGED_AT_CLOSE" as AlertState, nextReminderMs: undefined };
    if (await persist(store, next, s.version)) closed.push({ ...next, version: s.version + 1 });
  }
  return closed;
}
