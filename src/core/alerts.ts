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

// ---- batched helpers (one round trip when the store supports it, else one call per item)
export async function putMany(store: Store, items: { next: RuleState; expected: number }[]): Promise<boolean[]> {
  if (!items.length) return [];
  const w = items.map((i) => ({ state: { ...i.next, version: i.expected + 1 }, expectedVersion: i.expected }));
  if (store.putRuleStates) return store.putRuleStates(w);
  const r: boolean[] = [];
  for (const i of w) r.push(await store.putRuleState(i.state, i.expectedVersion));
  return r;
}

export async function emitMany(store: Store, out: Out, events: OutboundEvent[], nowMs: number): Promise<void> {
  if (!events.length) return;
  if (store.enqueueMany) await store.enqueueMany(events.map((event) => ({ event, priority: EVENT_PRIORITY[event.type], nowMs })));
  else for (const e of events) await store.enqueue(e, EVENT_PRIORITY[e.type], nowMs);
  out.events += events.length;
}

export interface FireItem {
  s: RuleState;
  o: Obs;
  market: MarketState;
  set: Settings;
  late?: { barTimeMs: number; barPrice: number };
}

/**
 * First alerts (FR-4.1) and late alerts (FR-9.3) for many rules at once:
 * claim ids (FR-4.10) -> write states -> enqueue events, one batched call each.
 * Returns the stored TRIGGERED states; rules whose id another run already owns are left out.
 */
export async function fireAlerts(store: Store, out: Out, items: FireItem[], nowMs: number): Promise<Map<string, RuleState>> {
  const done = new Map<string, RuleState>();
  if (!items.length) return done;
  const ids = items.map((i) => ({ date: i.s.date, symbol: i.s.symbol, rule: i.s.rule, cycle: i.s.cycle + 1 }));
  let claims: boolean[];
  if (store.claimAlertIds) claims = await store.claimAlertIds(ids);
  else {
    claims = [];
    for (const i of ids) claims.push(await store.claimAlertId(i.date, i.symbol, i.rule, i.cycle));
  }
  const won = items.filter((_, k) => {
    if (!claims[k]) out.logs.push({ tMs: nowMs, kind: "SUPPRESSED", symbol: ids[k]!.symbol, rule: ids[k]!.rule, detail: { reason: "duplicate alert id", cycle: ids[k]!.cycle } });
    return claims[k];
  });
  const nexts = won.map((i) => triggered(i.s, i.o.crossing!.value, i.o.threshold, i.o.crossing!.touchedAtMs, !!i.late, nowMs, i.set));
  const oks = await putMany(store, won.map((i, k) => ({ next: nexts[k]!, expected: i.s.version })));
  const events: OutboundEvent[] = [];
  for (let k = 0; k < won.length; k++) {
    const i = won[k]!;
    let base = i.s.version;
    if (!oks[k]) {
      // Rare: the row moved under us. Retry once if it is still the same ARMED cycle.
      const cur = await store.getRuleState(i.s.date, i.s.symbol, i.s.rule);
      if (!cur || cur.state !== "ARMED" || cur.cycle !== i.s.cycle) continue;
      base = cur.version;
      if (!(await persist(store, nexts[k]!, base))) continue;
    }
    const stored = { ...nexts[k]!, version: base + 1 };
    done.set(ruleKey(i.s.symbol, i.s.rule), stored);
    events.push(
      i.late
        ? { type: "LATE_ALERT", rule: stored, market: i.market, threshold: i.o.threshold, barTimeMs: i.late.barTimeMs, barPrice: i.late.barPrice }
        : { type: "FIRST_ALERT", rule: stored, market: i.market, threshold: i.o.threshold },
    );
    out.logs.push({
      tMs: nowMs, kind: i.late ? "LATE_ALERT" : "FIRST_ALERT", symbol: i.s.symbol, rule: i.s.rule,
      detail: { value: i.o.crossing!.value, threshold: i.o.threshold, touchedAtMs: i.o.crossing!.touchedAtMs, cycle: stored.cycle },
    });
    bump(out, i.late ? "lateAlerts" : "alerts");
  }
  await emitMany(store, out, events, nowMs);
  return done;
}

/**
 * Reminders for rules found due (FR-4.2). FR-4.5: the stored rows are re-read in
 * one query right before sending and written with a version check, so an
 * acknowledgment that landed first wins. FR-4.13: one message per stock.
 */
export async function sendDueReminders(
  store: Store, out: Out, due: RuleState[], markets: Map<string, MarketState>,
  backInside: Map<string, boolean>, nowMs: number, settingsFor: (symbol: string) => Settings,
): Promise<void> {
  if (!due.length) return;
  const fresh = new Map((await store.getRuleStates(due[0]!.date)).map((r) => [ruleKey(r.symbol, r.rule), r]));
  const cands: { f: RuleState; next: RuleState }[] = [];
  for (const r of due) {
    const f = fresh.get(ruleKey(r.symbol, r.rule));
    if (f && reminderDue(f, nowMs)) cands.push({ f, next: advanceReminder(f, nowMs, settingsFor(f.symbol)) }); // else acknowledged, closed, or already sent
  }
  const oks = await putMany(store, cands.map((c) => ({ next: c.next, expected: c.f.version })));
  const bySymbol = new Map<string, RuleState[]>();
  cands.forEach((c, k) => {
    if (oks[k]) bySymbol.set(c.f.symbol, [...(bySymbol.get(c.f.symbol) ?? []), { ...c.next, version: c.f.version + 1 }]);
  });
  const events: OutboundEvent[] = [];
  for (const [symbol, sent] of bySymbol) {
    const inside = sent.every((r) => backInside.get(ruleKey(r.symbol, r.rule)) === true);
    events.push({ type: "REMINDER", rules: sent, market: markets.get(symbol) ?? { symbol, date: sent[0]!.date }, backInside: inside });
    for (const r of sent) out.logs.push({ tMs: nowMs, kind: "REMINDER", symbol, rule: r.rule, detail: { n: r.remindersSent, backInside: inside } });
    bump(out, "reminders", sent.length);
  }
  await emitMany(store, out, events, nowMs);
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
  const live = states.filter(isActive);
  const nexts = live.map((s) => ({ ...s, state: "UNACKNOWLEDGED_AT_CLOSE" as AlertState, nextReminderMs: undefined }));
  const oks = await putMany(store, live.map((s, k) => ({ next: nexts[k]!, expected: s.version })));
  return nexts.map((n, k) => ({ ...n, version: live[k]!.version + 1 })).filter((_, k) => oks[k]);
}
