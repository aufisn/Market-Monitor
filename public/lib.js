/* Pure helpers for the dashboard: formatting, time zones, threshold maths, status rules.
   No DOM access here, so it can be checked from Node (test/ui/lib-check.mjs). */

export const TZ_ET = "America/New_York";
export const TZ_MU = "Asia/Muscat";
export const FRESH_AMBER_S = 60; // FR-8.3 / PRD 5.3
export const FRESH_RED_S = 300;
export const POLL_LIVE_S = 90; // server poll older than this = DELAYED

/* ---------------------------------------------------------------- time */
const dtfCache = new Map();
function dtf(tz, opts) {
  const key = tz + "|" + Object.keys(opts).map((k) => k + opts[k]).join(",");
  let f = dtfCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hourCycle: "h23", ...opts });
    dtfCache.set(key, f);
  }
  return f;
}
export function hm(ms, tz, sec) {
  const o = { hour: "2-digit", minute: "2-digit" };
  if (sec) o.second = "2-digit";
  return dtf(tz, o).format(ms);
}
export function dateKey(ms, tz) {
  const p = parts(ms, tz);
  return p.year + "-" + p.month + "-" + p.day;
}
export function parts(ms, tz) {
  const out = {};
  for (const p of dtf(tz, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" }).formatToParts(ms)) out[p.type] = p.value;
  return out;
}
/** "10:42 ET / 19:42 Muscat" (FR-1.6). Adds "+1" when Muscat is already on the next calendar day. */
export function both(ms, sec) {
  if (!Number.isFinite(ms)) return "n/a";
  const nextDay = dateKey(ms, TZ_MU) !== dateKey(ms, TZ_ET);
  return hm(ms, TZ_ET, sec) + " ET / " + hm(ms, TZ_MU, sec) + (nextDay ? "+1" : "") + " Muscat";
}
export function bothWithDate(ms, sec) {
  if (!Number.isFinite(ms)) return "n/a";
  return dateKey(ms, TZ_ET) + " " + both(ms, sec);
}
/** Epoch ms of a New York wall-clock time on a YYYY-MM-DD date (handles the clock change). */
export function etWallToMs(date, h, m) {
  const [y, mo, d] = date.split("-").map(Number);
  const target = Date.UTC(y, mo - 1, d, h, m, 0);
  let guess = target;
  for (let i = 0; i < 2; i++) {
    const p = parts(guess, TZ_ET);
    const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
    guess = target - (wall - Math.floor(guess / 1000) * 1000);
  }
  return guess;
}
export function ageText(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + " s";
  if (sec < 3600) return Math.floor(sec / 60) + " min" + (sec % 60 ? " " + (sec % 60) + " s" : "");
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  if (h < 48) return h + " h" + (m ? " " + m + " min" : "");
  return Math.floor(h / 24) + " d";
}
export function countdownText(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s < 90) return s + " s";
  if (s < 3600) return Math.floor(s / 60) + " min " + (s % 60) + " s";
  return Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " min";
}

/* ---------------------------------------------------------------- market clock (FR-1.7) */
/** Uses the server's `market` object when present, else estimates from New York clock time (holidays unknown). */
export function marketClock(nowMs, serverMarket, todayDate) {
  if (serverMarket && typeof serverMarket.status === "string") {
    const open = serverMarket.status === "OPEN" || serverMarket.status === "EARLY_CLOSE";
    return {
      open,
      status: serverMarket.status,
      reason: serverMarket.reason || "",
      nextMs: open ? serverMarket.closesMs ?? serverMarket.nextCloseMs : serverMarket.opensMs ?? serverMarket.nextOpenMs,
      nextKind: open ? "close" : "open",
      estimated: false,
    };
  }
  const p = parts(nowMs, TZ_ET);
  const wd = p.weekday; // Mon..Sun
  const weekday = !(wd === "Sat" || wd === "Sun");
  const date = p.year + "-" + p.month + "-" + p.day;
  const openMs = etWallToMs(date, 9, 30), closeMs = etWallToMs(date, 16, 0);
  if (weekday && nowMs >= openMs && nowMs < closeMs) return { open: true, status: "OPEN", reason: "", nextMs: closeMs, nextKind: "close", estimated: true };
  // next weekday open
  let d = date, next = openMs;
  if (!(weekday && nowMs < openMs)) {
    let t = Date.UTC(+p.year, +p.month - 1, +p.day, 12);
    for (let i = 0; i < 5; i++) {
      t += 86400000;
      const q = parts(t, TZ_ET);
      if (q.weekday !== "Sat" && q.weekday !== "Sun") { d = q.year + "-" + q.month + "-" + q.day; break; }
    }
    next = etWallToMs(d, 9, 30);
  }
  const reason = !weekday ? "weekend" : nowMs < openMs ? "before the open" : "after the close";
  return { open: false, status: "CLOSED", reason, nextMs: next, nextKind: "open", estimated: true };
}

/** FR-8.2 data status. Only meaningful while the market is open. */
export function dataStatus(nowMs, lastPollMs, marketOpen) {
  if (lastPollMs === null || lastPollMs === undefined) return { key: "NODATA", label: "NO DATA", icon: "⛔", ageS: null };
  const ageS = Math.max(0, (nowMs - lastPollMs) / 1000);
  if (!marketOpen) return { key: "IDLE", label: "IDLE (market closed)", icon: "○", ageS };
  if (ageS <= POLL_LIVE_S) return { key: "LIVE", label: "LIVE", icon: "●", ageS };
  return { key: "DELAYED", label: "DELAYED", icon: "⏱", ageS };
}

/* ---------------------------------------------------------------- numbers */
export const money = (n) => (Number.isFinite(n) ? n.toFixed(Math.abs(n) < 1 ? 4 : 2) : "n/a");
export function signed(n, d = 2) {
  if (!Number.isFinite(n)) return "n/a";
  return (n >= 0 ? "+" : "−") + Math.abs(n).toFixed(d);
}
export function pctOf(v, base, d = 2) {
  if (!Number.isFinite(v) || !Number.isFinite(base) || base === 0) return "n/a";
  return signed(((v - base) / base) * 100, d) + "%";
}
export function compact(n) {
  if (!Number.isFinite(n)) return "n/a";
  if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e4) return (n / 1e3).toFixed(1) + "K";
  return Math.round(n).toLocaleString("en-US");
}
/** Parses what a person types: "$148.5", "7,5%", "-3". Returns NaN when it is not a plain number. */
export function parseNum(s) {
  if (typeof s !== "string") return NaN;
  const t = s.trim().replace(/[$%\s]/g, "").replace(/,/g, ".").replace(/−/g, "-");
  if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return NaN;
  return Number(t);
}

/* ---------------------------------------------------------------- thresholds */
export function resolveThreshold(t, prev) {
  if (!t) return undefined;
  if (t.mode === "dollar") return t.value;
  return Number.isFinite(prev) && prev > 0 ? prev * (1 + t.value / 100) : undefined;
}
export function crossedBy(rule, price, last) {
  if (!Number.isFinite(price) || !Number.isFinite(last)) return false;
  return rule === "HIGH" ? last >= price : last <= price;
}
export function thresholdText(t, prev) {
  const p = resolveThreshold(t, prev);
  if (p === undefined) return t.mode === "percent" ? signed(t.value, 2) + "% (needs Previous Close)" : "n/a";
  return "$" + money(p) + " (" + pctOf(p, prev, 1) + ")";
}
export function volumeText(v) {
  if (!v) return "not set";
  return v.mode === "multiple" ? v.value + "x usual" : compact(v.value) + " shares";
}

/* ---------------------------------------------------------------- per-stock view model */
export function freshness(ageS, marketOpen, offline) {
  if (!Number.isFinite(ageS)) return "none";
  if (offline) return "offline";
  if (!marketOpen) return "closed";
  return ageS > FRESH_RED_S ? "red" : ageS > FRESH_AMBER_S ? "amber" : "fresh";
}
export const FRESH_LABEL = {
  fresh: "● FRESH",
  amber: "⏱ SLOW (over 60 s)",
  red: "⛔ STALE (over 5 min)",
  closed: "○ MARKET CLOSED",
  offline: "⛔ NOT LIVE (no connection)",
  none: "— NO TRADE",
};

const ACTIVE = new Set(["TRIGGERED", "REPEATING"]);
export const isActiveRule = (r) => ACTIVE.has(r.state);
/** How a rule is named on screen. */
export const ruleLabel = (r) => ({ HIGH52: "52W HIGH", LOW52: "52W LOW" })[r] || r;

/** 52-week range bar: position 0..100 of the last price, or null. "Range since listing" when under a year of history. */
export function range52Model(w52, last) {
  if (!w52 || !(w52.high > 0) || !(w52.low > 0) || w52.high < w52.low) return null;
  const span = w52.high - w52.low;
  const pos = Number.isFinite(last) ? (span > 0 ? Math.max(0, Math.min(100, ((last - w52.low) / span) * 100)) : 50) : null;
  return { low: w52.low, high: w52.high, lowDate: w52.lowDate, highDate: w52.highDate, pos, short: (w52.sessions || 0) < 240, beyond: Number.isFinite(last) && (last > w52.high || last < w52.low) };
}
/** Sentence under the 52-week switch in the form. */
export function range52Sentence(on, w52) {
  if (!on) return "No 52-week alert";
  const m = range52Model(w52);
  if (!m) return "Alert when the price passes the 52-week high or low. The levels are loaded from the official daily prices within a few minutes.";
  return "Alert when the price goes above the 52-week high $" + money(m.high) + " or below the 52-week low $" + money(m.low) + (m.short ? " (less than a year of history)" : "");
}

/** Builds everything the screen needs for one stock, from /api/state data. */
export function buildVM(stock, market, rules, settings, nowMs, marketOpen, flags = {}) {
  const prev = market?.prev?.close;
  const last = market?.last?.p;
  const lastT = market?.last?.t;
  const hi = stock.high, lo = stock.low;
  const hiP = resolveThreshold(hi, prev), loP = resolveThreshold(lo, prev);
  const mine = (rules || []).filter((r) => r.symbol === stock.symbol);
  const active = mine.filter(isActiveRule);
  const acked = mine.filter((r) => r.state === "ACKNOWLEDGED");
  const atClose = mine.filter((r) => r.state === "UNACKNOWLEDGED_AT_CLOSE");
  const paused = !!stock.paused || stock.enabled === false || !!flags.pausedAll;
  const muted = Number.isFinite(stock.mutedUntilMs) && stock.mutedUntilMs > nowMs;
  const ageS = Number.isFinite(lastT) ? Math.max(0, (nowMs - lastT) / 1000) : NaN;

  // nearest threshold
  let nearest = null;
  for (const [which, p] of [["HIGH", hiP], ["LOW", loP]]) {
    if (p === undefined || !Number.isFinite(last)) continue;
    const dist = which === "HIGH" ? p - last : last - p; // negative = already beyond
    if (!nearest || Math.abs(dist) < Math.abs(nearest.dist)) nearest = { which, price: p, dist, pct: (dist / last) * 100 };
  }
  // NEAR: within nearPct of the way from Previous Close to a threshold (FR-8.3)
  let near = false;
  if (nearest && Number.isFinite(prev)) {
    const span = Math.abs(nearest.price - prev);
    if (span > 0 && nearest.dist >= 0 && nearest.dist / span <= (settings?.nearPct ?? 20) / 100) near = true;
  }
  let status;
  const noData = !market || !Number.isFinite(last);
  if (active.length) status = "CROSSED";
  else if (paused) status = "PAUSED";
  else if (muted) status = "MUTED";
  else if (market?.baseline?.status === "BUILDING" && stock.volume) status = "BUILDING";
  else if (market?.baseline?.status === "NO_BASELINE" && stock.volume) status = "NOBASELINE";
  else if (noData) status = "NODATA";
  else if (acked.length) status = "ACK";
  else if (near) status = "NEAR";
  else status = "OK";

  const fr = freshness(ageS, marketOpen, flags.offline);
  return {
    sym: stock.symbol, stock, status, near, muted, paused, pausedAll: !!flags.pausedAll, notes: stock.notes || "",
    last, lastT, ageS, fresh: fr, prev, open: market?.open, dayHigh: market?.dayHigh, dayLow: market?.dayLow, cumVolume: market?.cumVolume,
    high: hi, low: lo, hiP, loP, vol: stock.volume, range52: !!stock.range52, w52: market?.w52, volAvgMultiple: market?.baseline?.multiple, baseline: market?.baseline,
    changeAbs: Number.isFinite(last) && Number.isFinite(prev) ? last - prev : NaN,
    changePct: Number.isFinite(last) && Number.isFinite(prev) && prev !== 0 ? ((last - prev) / prev) * 100 : NaN,
    nearest, active, acked, atClose,
    ackMs: acked.reduce((m, r) => Math.max(m, r.ackMs || 0), 0) || undefined,
  };
}

/** Sort: crossed first, then stale, slow, NEAR, the rest (UX decision A). */
export function rank(vm) {
  if (vm.status === "CROSSED") return 0;
  if (vm.fresh === "red" || vm.fresh === "offline") return 1;
  if (vm.fresh === "amber") return 2;
  if (vm.status === "NEAR") return 3;
  if (vm.status === "NODATA") return 4;
  if (vm.status === "OK" || vm.status === "BUILDING") return 5;
  return 6;
}
export const sortVMs = (list) => list.slice().sort((a, b) => rank(a) - rank(b) || a.sym.localeCompare(b.sym));

/** Gauge positions 0..100 for P(revious), O(pen), L(ast) between LOW and HIGH; null if not drawable. */
export function gaugeModel(vm) {
  if (vm.loP === undefined || vm.hiP === undefined || vm.hiP <= vm.loP) return null;
  const span = vm.hiP - vm.loP;
  const pos = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(100, ((v - vm.loP) / span) * 100)) : null);
  return {
    p: pos(vm.prev), o: pos(vm.open), l: pos(vm.last),
    beyond: Number.isFinite(vm.last) && (vm.last <= vm.loP || vm.last >= vm.hiP),
  };
}

/** Briefing rows computed from the state: gap vs Previous Close, levels vs Opening. */
export function briefingRows(vms) {
  return vms
    .filter((v) => Number.isFinite(v.open) && Number.isFinite(v.prev))
    .map((v) => ({ ...v, gapPct: ((v.open - v.prev) / v.prev) * 100 }))
    .sort((a, b) => Math.abs(b.gapPct) - Math.abs(a.gapPct));
}

/** One-line plain text for a log detail object (shown with textContent). */
export function detailText(d) {
  if (d === null || d === undefined) return "";
  if (typeof d !== "object") return String(d).slice(0, 300);
  return Object.entries(d).map(([k, v]) => k + ": " + (typeof v === "object" ? JSON.stringify(v) : String(v))).join(" · ").slice(0, 400);
}

/* ---------------------------------------------------------------- edit-in-place maths (FR-8.5) */
/** Checks what was typed into the LOW/HIGH editor and builds the live preview. */
export function evalThreshold({ which, mode, text, prev, last, otherPrice }) {
  if (!text.trim()) return { state: "empty" };
  const n = parseNum(text);
  if (!Number.isFinite(n)) return { state: "error", err: "Type a number, for example 148.50." };
  let price, value = n;
  if (mode === "dollar") {
    if (n <= 0 || n > 1e6) return { state: "error", err: "A price must be above 0 and at most 1,000,000." };
    value = Number(n.toFixed(4));
    price = value;
  } else {
    if (n <= -100 || n > 1000) return { state: "error", err: "Percent must be above -100 and at most 1000." };
    if (!(prev > 0)) return { state: "error", err: "Previous Close is not known yet. Enter dollars instead." };
    value = Number(n.toFixed(4));
    price = prev * (1 + value / 100);
  }
  if (otherPrice !== undefined) {
    if (which === "high" && price <= otherPrice) return { state: "error", err: "HIGH must be above LOW ($" + money(otherPrice) + ")." };
    if (which === "low" && price >= otherPrice) return { state: "error", err: "LOW must be below HIGH ($" + money(otherPrice) + ")." };
  }
  const bits = ["= $" + money(price)];
  if (prev > 0) bits.push(pctOf(price, prev, 1) + " from Prev Close " + money(prev));
  if (Number.isFinite(last)) bits.push(pctOf(price, last, 1) + " from Last " + money(last));
  return { state: "ok", mode, value, price, crossed: crossedBy(which.toUpperCase(), price, last), preview: bits.join(" \u00b7 ") };
}
export function evalVolume({ mode, text, cum }) {
  if (!text.trim()) return { state: "empty" };
  const n = parseNum(text);
  if (!Number.isFinite(n)) return { state: "error", err: "Type a number." };
  if (mode === "multiple") {
    if (n <= 0 || n > 1000) return { state: "error", err: "The multiple must be above 0 and at most 1000." };
    return { state: "ok", mode, value: Number(n.toFixed(2)), preview: "= alert when IEX volume reaches " + n + "x the average at this time of day" };
  }
  if (!Number.isInteger(n) || n <= 0 || n > 1e12) return { state: "error", err: "Shares must be a whole number above 0." };
  const sofar = Number.isFinite(cum) ? " \u00b7 now " + compact(cum) + " (" + ((cum / n) * 100).toFixed(0) + "% of the way)" : "";
  return { state: "ok", mode, value: n, preview: "= alert at " + n.toLocaleString("en-US") + " IEX shares" + sofar };
}

/* ---------------------------------------------------------------- card stack (watchlist) */
export const DRAG_SLOP = 8; // px before the direction of a drag is decided
export const DRAG_STEP = 50; // px of sideways drag that changes the card

/** Keeps the symbol order frozen while the page is in use: stays as before, new symbols go last, removed ones drop out.
    `sortedSyms` is the urgency order, used only the first time (prev empty). */
export function stackOrder(prev, sortedSyms) {
  if (!prev || prev.length === 0) return sortedSyms.slice();
  const have = new Set(sortedSyms);
  const kept = prev.filter((s) => have.has(s));
  const seen = new Set(kept);
  return kept.concat(sortedSyms.filter((s) => !seen.has(s)));
}
/** Which symbol is in focus after the order changed. If the focused one was removed, the next neighbour (else the previous). */
export function focusAfter(prevOrder, newOrder, focus) {
  if (newOrder.length === 0) return "";
  if (newOrder.includes(focus)) return focus;
  const i = prevOrder.indexOf(focus);
  if (i < 0) return newOrder[0];
  for (let k = i + 1; k < prevOrder.length; k++) if (newOrder.includes(prevOrder[k])) return prevOrder[k];
  for (let k = i - 1; k >= 0; k--) if (newOrder.includes(prevOrder[k])) return prevOrder[k];
  return newOrder[0];
}
/** "h" for a mostly sideways drag, "v" for a mostly vertical one, null while still under the slop. */
export function dragAxis(dx, dy, slop = DRAG_SLOP) {
  if (Math.abs(dx) <= slop && Math.abs(dy) <= slop) return null;
  return Math.abs(dx) > Math.abs(dy) ? "h" : "v";
}
/** Pixels the front card follows the finger: free in the middle, a quarter of the drag past either end (no wrap-around). */
export function dragOffset(dx, i, n) {
  return (i <= 0 && dx > 0) || (i >= n - 1 && dx < 0) ? dx / 4 : dx;
}
/** Card index after the finger lifts. Drag left = next card. */
export function dragSettle(dx, i, n, step = DRAG_STEP) {
  if (dx <= -step) return Math.min(n - 1, i + 1);
  if (dx >= step) return Math.max(0, i - 1);
  return i;
}
/** Symbols that are CROSSED now but were not in `prevCrossed` (a Set, or null on the first look: nothing is new then). */
export function newlyCrossed(prevCrossed, vms) {
  if (!prevCrossed) return [];
  return vms.filter((v) => v.status === "CROSSED" && !prevCrossed.has(v.sym)).map((v) => v.sym);
}
/** True when there is at least one stock and every one has its alerts off. */
export const allAlertsOff = (vms) => vms.length > 0 && vms.every((v) => v.paused);

/* ---------------------------------------------------------------- one form to add and edit a stock */
const WHICH = { low: "LOW", high: "HIGH" };
/** Like evalThreshold, but a percent value is accepted when Prev Close is not known yet (a new stock): only its range is checked. */
export function evalThresholdLoose(o) {
  if (o.mode === "percent" && !(o.prev > 0)) {
    if (!o.text.trim()) return { state: "empty" };
    const n = parseNum(o.text);
    if (!Number.isFinite(n)) return { state: "error", err: "Type a number, for example -5." };
    if (n <= -100 || n > 1000) return { state: "error", err: "Percent must be above -100 and at most 1000." };
    return { state: "ok", mode: "percent", value: Number(n.toFixed(4)), price: undefined, crossed: false };
  }
  return evalThreshold(o);
}
/** A plain sentence for what a LOW or HIGH value will do. `r` is an "ok" result from evalThresholdLoose. */
export function thresholdSentence(which, r, prev) {
  const up = which === "high";
  if (r.price === undefined) return "Alert when the price " + (up ? "rises to " : "falls to ") + signed(r.value, 2) + "% from Prev Close (worked out each day)";
  const base = "Alert when the price " + (up ? "rises to $" : "falls to $") + money(r.price);
  if (!(prev > 0)) return base;
  const pct = ((r.price - prev) / prev) * 100;
  return base + " (" + Math.abs(pct).toFixed(1) + "% " + (pct >= 0 ? "above" : "below") + " Prev Close $" + money(prev) + ")" + (r.crossed ? ". The latest price is already beyond this, so saving alerts at once" : "");
}
export function volumeSentence(r, cum) {
  if (r.mode === "multiple") return "Alert when volume reaches " + r.value + "x the usual for this time of day";
  return "Alert when volume today reaches " + r.value.toLocaleString("en-US") + " shares" + (Number.isFinite(cum) ? " (now " + compact(cum) + ")" : "");
}
export const USUAL_VOLUME_NOTE = "The usual-volume average is built before the next open, so this alert starts on the next trading day.";
/** True when a "x usual" alert will not work today: the stock is new or its baseline is not OK. */
export const usualVolumeWaits = (editing, baseline) => !editing || baseline?.status !== "OK";

const SYMBOL_RE = /^[A-Z0-9]{1,5}([.-][A-Z0-9])?$/;
const sameTh = (a, b) => (!a && !b) || (!!a && !!b && a.mode === b.mode && a.value === b.value);
/** Checks the whole stock form and builds the request body.
    f = { editing, existing, symbol, on, low:{mode,text}, high:{mode,text}, vol:{mode,text}, notes, prev, last, cum }
    Returns { low, high, vol, err, field, body, changed } where low/high/vol are the per-field evaluations (for the preview lines). */
export function checkStockForm(f) {
  const prev = f.prev, last = f.last;
  const lowRaw = evalThresholdLoose({ which: "low", mode: f.low.mode, text: f.low.text, prev, last });
  const highRaw = evalThresholdLoose({ which: "high", mode: f.high.mode, text: f.high.text, prev, last });
  const low = lowRaw.state === "ok" && highRaw.state === "ok" && highRaw.price !== undefined ? evalThresholdLoose({ which: "low", mode: f.low.mode, text: f.low.text, prev, last, otherPrice: highRaw.price }) : lowRaw;
  const high = lowRaw.state === "ok" && highRaw.state === "ok" && lowRaw.price !== undefined ? evalThresholdLoose({ which: "high", mode: f.high.mode, text: f.high.text, prev, last, otherPrice: lowRaw.price }) : highRaw;
  const vol = evalVolume({ mode: f.vol.mode, text: f.vol.text, cum: NaN });
  const out = { low, high, vol, err: "", field: "", body: null, changed: false };
  const fail = (field, err) => { if (!out.err) { out.err = err; out.field = field; } };
  const symbol = (f.symbol || "").trim().toUpperCase();
  if (!f.editing && !SYMBOL_RE.test(symbol)) fail("symbol", "Symbol: 1 to 5 letters or digits, for example NVDA or BRK.B.");
  for (const [k, r] of [["low", low], ["high", high], ["vol", vol]]) if (r.state === "error") fail(k, (k === "vol" ? "Volume" : WHICH[k]) + ": " + r.err);
  // both are percent or both are dollars: compare the numbers even when Prev Close is unknown
  if (low.state === "ok" && high.state === "ok" && low.mode === high.mode && low.value >= high.value) fail("low", "LOW must be below HIGH.");
  if (low.state !== "ok" && high.state !== "ok" && vol.state !== "ok" && !f.range52) fail("low", "Set at least one alert: LOW, HIGH, Volume or 52-week.");
  if (out.err) return out;
  const th = (r) => (r.state === "ok" ? { mode: r.mode, value: r.value } : null);
  const notes = (f.notes || "").trim();
  if (!f.editing) {
    const body = { symbol };
    if (low.state === "ok") body.low = th(low);
    if (high.state === "ok") body.high = th(high);
    if (vol.state === "ok") body.volume = th(vol);
    if (f.range52) body.range52 = true;
    if (notes) body.notes = notes;
    if (!f.on) body.paused = true;
    out.body = body; out.changed = true;
    return out;
  }
  const ex = f.existing || {};
  const body = {};
  for (const [key, r] of [["low", low], ["high", high], ["volume", vol]]) {
    const nv = th(r);
    if (!sameTh(nv, ex[key])) body[key] = nv; // null removes the alert
  }
  if (!!f.range52 !== !!ex.range52) body.range52 = !!f.range52;
  if (notes !== (ex.notes || "")) body.notes = notes || null;
  if (f.on === !!ex.paused) body.paused = !f.on;
  out.body = body; out.changed = Object.keys(body).length > 0;
  return out;
}
