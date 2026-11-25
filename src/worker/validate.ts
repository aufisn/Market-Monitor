/**
 * Input validation for everything that arrives from outside (dashboard API,
 * Telegram commands, imported files). FR-2.3, FR-2.4, FR-12.1.
 */
import { DEFAULT_SETTINGS, type FastInput, type RuleKind, type Settings, type StockConfig, type ThresholdInput, type VolumeInput } from "../core/ports";
import { SYMBOL_RE } from "../adapters/callbacks";

export const MAX_STOCKS = 30; // FR-2.2 default; raise only after Phase 0 measures 50

export class ApiError extends Error {
  override name = "ApiError";
  constructor(readonly status: number, readonly code: string, message: string, readonly extra?: Record<string, unknown>) {
    super(message);
  }
}
const bad = (field: string, why: string): never => {
  throw new ApiError(400, "INVALID_INPUT", `${field}: ${why}`);
};

export function validateSymbol(v: unknown): string {
  if (typeof v !== "string") return bad("symbol", "must be text");
  const s = v.trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) return bad("symbol", "must be 1-5 letters or digits, optionally .X or -X");
  return s;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) bad(where, `unknown field "${k.slice(0, 30)}"`);
}
function finite(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return bad(field, "must be a number");
  return v;
}

export function validateThreshold(v: unknown, field: string): ThresholdInput {
  if (!isObj(v)) return bad(field, "must be {mode, value}");
  onlyKeys(v, ["mode", "value"], field);
  const value = finite(v.value, `${field}.value`);
  if (v.mode === "dollar") {
    if (value <= 0 || value > 1_000_000) return bad(field, "dollar value must be above 0 and at most 1,000,000");
    return { mode: "dollar", value };
  }
  if (v.mode === "percent") {
    if (value <= -100 || value > 1000) return bad(field, "percent must be above -100 and at most 1000");
    return { mode: "percent", value };
  }
  return bad(field, 'mode must be "dollar" or "percent"');
}

export function validateFast(v: unknown): FastInput {
  if (!isObj(v)) return bad("fast", "must be {pct, minutes}");
  onlyKeys(v, ["pct", "minutes"], "fast");
  const pct = finite(v.pct, "fast.pct");
  if (pct < 0.5 || pct > 50) return bad("fast.pct", "must be between 0.5 and 50");
  const minutes = finite(v.minutes, "fast.minutes");
  if (minutes !== 5 && minutes !== 10 && minutes !== 15 && minutes !== 30) return bad("fast.minutes", "must be 5, 10, 15 or 30");
  return { pct, minutes };
}

export function validateVolume(v: unknown, field: string): VolumeInput {
  if (!isObj(v)) return bad(field, "must be {mode, value}");
  onlyKeys(v, ["mode", "value"], field);
  const value = finite(v.value, `${field}.value`);
  if (v.mode === "multiple") {
    if (value <= 0 || value > 1000) return bad(field, "multiple must be above 0 and at most 1000");
    return { mode: "multiple", value };
  }
  if (v.mode === "absolute") {
    if (!Number.isInteger(value) || value <= 0 || value > 1e12) return bad(field, "share count must be a whole number above 0");
    return { mode: "absolute", value };
  }
  return bad(field, 'mode must be "multiple" or "absolute"');
}

type SettingRule = { kind: "int" | "num" | "bool"; min?: number; max?: number };
const SETTING_RULES: Record<keyof Settings, SettingRule> = {
  reminderIntervalMin: { kind: "int", min: 1, max: 60 },
  autoClear: { kind: "bool" },
  rearmBufferPricePct: { kind: "num", min: 0, max: 20 },
  rearmBufferVolumePct: { kind: "num", min: 0, max: 100 },
  volumeNoAlertFirstMin: { kind: "int", min: 0, max: 60 },
  volumeMinAvgCum: { kind: "num", min: 0, max: 1e9 },
  volumeMinSessions: { kind: "int", min: 0, max: 60 },
  baselineSessions: { kind: "int", min: 10, max: 60 },
  nearPct: { kind: "num", min: 1, max: 100 },
  reminderTidyUp: { kind: "bool" },
  spikeHoldPct: { kind: "num", min: 1, max: 100 },
};
const SETTING_KEYS = Object.keys(SETTING_RULES);

/** Validates a partial settings object (only known keys, in range). */
export function validateSettingsPartial(v: unknown, where = "settings"): Partial<Settings> {
  if (!isObj(v)) return bad(where, "must be an object");
  onlyKeys(v, SETTING_KEYS, where);
  const out: Record<string, unknown> = {};
  for (const [k, raw] of Object.entries(v)) {
    const r = SETTING_RULES[k as keyof Settings];
    if (r.kind === "bool") {
      if (typeof raw !== "boolean") return bad(`${where}.${k}`, "must be true or false");
      out[k] = raw;
    } else {
      const n = finite(raw, `${where}.${k}`);
      if (r.kind === "int" && !Number.isInteger(n)) return bad(`${where}.${k}`, "must be a whole number");
      if (n < (r.min ?? -Infinity) || n > (r.max ?? Infinity)) return bad(`${where}.${k}`, `must be between ${r.min} and ${r.max}`);
      out[k] = n;
    }
  }
  return out as Partial<Settings>;
}

export function validateSettings(v: unknown, base: Settings = DEFAULT_SETTINGS): Settings {
  return { ...base, ...validateSettingsPartial(v) };
}

const STOCK_KEYS = ["symbol", "enabled", "high", "low", "volume", "range52", "fast", "averages", "halt", "mutedUntilMs", "paused", "notes", "overrides"] as const;

/**
 * Merge a patch onto `existing` (or build new) and validate. `null` clears an
 * optional field. Control fields like `confirm` are handled by the caller.
 */
export function validateStockInput(body: unknown, existing?: StockConfig, opts: { allowNoAlert?: boolean } = {}): StockConfig {
  if (!isObj(body)) return bad("body", "must be an object");
  onlyKeys(body, [...STOCK_KEYS, "confirm"], "stock");
  const symbol = existing ? existing.symbol : validateSymbol(body.symbol);
  if (existing && body.symbol !== undefined && validateSymbol(body.symbol) !== existing.symbol) bad("symbol", "cannot be changed");
  const out: StockConfig = { ...(existing ?? { symbol, enabled: true }), symbol };
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== "boolean") bad("enabled", "must be true or false");
    out.enabled = body.enabled as boolean;
  }
  for (const k of ["high", "low"] as const) {
    if (body[k] === undefined) continue;
    if (body[k] === null) delete out[k];
    else out[k] = validateThreshold(body[k], k);
  }
  if (body.volume !== undefined) {
    if (body.volume === null) delete out.volume;
    else out.volume = validateVolume(body.volume, "volume");
  }
  if (body.range52 !== undefined) {
    if (body.range52 === null || body.range52 === false) delete out.range52;
    else if (body.range52 === true) out.range52 = true;
    else bad("range52", "must be true or false");
  }
  for (const k of ["averages", "halt"] as const) {
    if (body[k] === undefined) continue;
    if (body[k] === null || body[k] === false) delete out[k];
    else if (body[k] === true) out[k] = true;
    else bad(k, "must be true or false");
  }
  if (body.fast !== undefined) {
    if (body.fast === null) delete out.fast;
    else out.fast = validateFast(body.fast);
  }
  if (body.mutedUntilMs !== undefined) {
    if (body.mutedUntilMs === null) delete out.mutedUntilMs;
    else {
      const n = finite(body.mutedUntilMs, "mutedUntilMs");
      if (n < 0 || n > 4e12) bad("mutedUntilMs", "out of range");
      out.mutedUntilMs = n;
    }
  }
  if (body.paused !== undefined) {
    if (typeof body.paused !== "boolean") bad("paused", "must be true or false");
    out.paused = body.paused as boolean;
  }
  if (body.notes !== undefined) {
    if (body.notes === null || body.notes === "") delete out.notes;
    else if (typeof body.notes !== "string" || body.notes.length > 200) bad("notes", "must be text of at most 200 characters");
    else out.notes = body.notes.replace(/[\u0000-\u001f\u007f]/g, " ");
  }
  if (body.overrides !== undefined) {
    if (body.overrides === null) delete out.overrides;
    else out.overrides = validateSettingsPartial(body.overrides, "overrides");
  }
  // At least one alert (LOW, HIGH, Volume or one of the "More alerts"). The halt notice is information only and does not count. Import may carry older stocks without one (opts.allowNoAlert).
  // A legacy stock that already has none can still change notes/enabled/paused; touching the rules is checked.
  const has = (c?: StockConfig) => !!(c?.high || c?.low || c?.volume || c?.range52 || c?.fast || c?.averages);
  const touched = ["high", "low", "volume", "range52", "fast", "averages"].some((k) => body[k] !== undefined);
  if (!opts.allowNoAlert && !has(out) && (!existing || has(existing) || touched)) {
    throw new ApiError(422, "NO_ALERT", "Set at least one alert: LOW, HIGH, Volume or one of More alerts.");
  }
  return out;
}

/** Dollar value of a threshold, or undefined when a percent needs a Previous Close we lack. */
export function resolveThreshold(t: ThresholdInput | undefined, prevClose: number | undefined): number | undefined {
  if (!t) return undefined;
  if (t.mode === "dollar") return t.value;
  return prevClose && prevClose > 0 ? prevClose * (1 + t.value / 100) : undefined;
}

/** FR-2.4: LOW must be below HIGH. */
export function checkBand(s: StockConfig, prevClose: number | undefined): void {
  if (!s.high || !s.low) return;
  if (s.high.mode === s.low.mode) {
    if (s.low.value >= s.high.value) throw new ApiError(422, "LOW_NOT_BELOW_HIGH", "LOW must be below HIGH");
    return;
  }
  const hi = resolveThreshold(s.high, prevClose);
  const lo = resolveThreshold(s.low, prevClose);
  if (hi === undefined || lo === undefined) {
    throw new ApiError(422, "NEED_PREVIOUS_CLOSE", "Previous Close is not known yet: use the same unit (dollars or percent) for LOW and HIGH");
  }
  if (lo >= hi) throw new ApiError(422, "LOW_NOT_BELOW_HIGH", "LOW must be below HIGH");
}

/** Which price rules the latest price already satisfies (FR-2.4 confirmation). */
export function wouldAlertNow(s: StockConfig, last: number | undefined, prevClose: number | undefined): RuleKind[] {
  const out: RuleKind[] = [];
  if (last === undefined) return out;
  const hi = resolveThreshold(s.high, prevClose);
  const lo = resolveThreshold(s.low, prevClose);
  if (hi !== undefined && last >= hi) out.push("HIGH");
  if (lo !== undefined && last <= lo) out.push("LOW");
  return out;
}

/** Rules whose configured threshold differs between two versions (they get re-armed, I-5). */
export function changedRules(a: StockConfig | undefined, b: StockConfig): RuleKind[] {
  const out: RuleKind[] = [];
  if (JSON.stringify(a?.high) !== JSON.stringify(b.high)) out.push("HIGH");
  if (JSON.stringify(a?.low) !== JSON.stringify(b.low)) out.push("LOW");
  if (JSON.stringify(a?.volume) !== JSON.stringify(b.volume)) out.push("VOLUME");
  if (!!a?.range52 !== !!b.range52) out.push("HIGH52", "LOW52");
  if (JSON.stringify(a?.fast) !== JSON.stringify(b.fast)) out.push("FAST");
  if (!!a?.averages !== !!b.averages) out.push("MA50", "MA200");
  return out;
}
