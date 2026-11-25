/* Local test server for the dashboard: serves public/ with the production headers from public/_headers
   and a mock of the /api contract (src/worker/api.ts). Not part of the deployed app.
   Run:  node test/ui/serve.mjs   (port 8799)  then open http://127.0.0.1:8799/
   Access code for the mock: set MOCK_CODE, default is printed at start-up.
   Switch scenarios while running:  /mock/scenario?name=normal|closed|empty|delayed|locked|unconfigured|nomarket|slow|failswitch (PLTR switch fails with 500) */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.resolve(here, "../../public");
const PORT = Number(process.env.PORT || 8799);
const CODE = process.env.MOCK_CODE || "mock-code-for-local-testing-0123456789abcdef";

// ---- production headers, read from public/_headers
const secHeaders = {};
for (const line of fs.readFileSync(path.join(PUB, "_headers"), "utf8").split("\n")) {
  const m = /^\s+([A-Za-z-]+):\s*(.+)$/.exec(line);
  if (m) secHeaders[m[1]] = m[2].trim();
}
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml", ".png": "image/png" };

// ---- mock data
const MIN = 60000;
let scenario = "normal";
const T0 = Date.now();
const mk = (symbol, o) => ({ symbol, enabled: true, ...o });
const stocks = [
  mk("AAPL", { high: { mode: "dollar", value: 200 }, low: { mode: "dollar", value: 180 }, volume: { mode: "multiple", value: 2 } }),
  mk("JPM", { high: { mode: "percent", value: 5 }, low: { mode: "percent", value: -5 } }),
  mk("TSLA", { high: { mode: "dollar", value: 260 }, low: { mode: "dollar", value: 225 }, volume: { mode: "absolute", value: 30000000 } }),
  mk("AMZN", { high: { mode: "dollar", value: 190 }, low: { mode: "dollar", value: 170 } }),
  mk("NVDA", { high: { mode: "dollar", value: 145 }, low: { mode: "dollar", value: 130 }, volume: { mode: "multiple", value: 2 }, range52: true }),
  mk("MSFT", { high: { mode: "dollar", value: 435 }, low: { mode: "dollar", value: 420 } }),
  mk("XOM", { high: { mode: "dollar", value: 118 }, low: { mode: "dollar", value: 104 } }),
  mk("GOOGL", { high: { mode: "dollar", value: 185 }, low: { mode: "dollar", value: 165 } }),
  mk("PENNY", { low: { mode: "dollar", value: 0.38 }, high: { mode: "dollar", value: 0.5 } }),
  mk("PLTR", { low: { mode: "dollar", value: 20 } }),
];
const px = { PENNY: [0.4213, 0.4100, 0.4150, 10, 3e6],  AAPL: [190.2, 189.5, 189.9, 14, 41e6], JPM: [210.4, 209.2, 209.9, 9, 6.1e6], TSLA: [243.1, 240.2, 241, 20, 22e6], AMZN: [187.9, 181.0, 181.6, 30, 18e6], NVDA: [145.6, 138.2, 141.05, 6, 52e6], MSFT: [421.9, 421.8, 418.6, 10, 9e6], XOM: [111.2, 110.9, 111, 74, 5e6], GOOGL: [171.0, 170.2, 170.5, 360, 7e6] };
const market = () => Object.entries(px).map(([symbol, [last, prev, open, age, vol]]) => ({
  symbol, date: "2026-11-24", last: { t: Date.now() - age * 1000 * (scenario === "delayed" ? 1 : 1), p: last, s: 100 }, open, dayHigh: Math.max(last, open) + 0.6, dayLow: Math.min(last, open) - 0.7, cumVolume: vol,
  prev: { symbol, date: "2026-11-23", close: prev, high: prev + 1.4, low: prev - 1.9, volume: vol * 4 }, lastPollMs: Date.now() - 12000,
  ...(symbol === "XOM" ? {} : { w52: { date: "2026-11-24", sessions: symbol === "PLTR" ? 120 : 251, high: symbol === "NVDA" ? 145.3 : +(last * 1.25).toFixed(2), highDate: "2026-03-12", low: +(last * 0.7).toFixed(4), lowDate: "2026-06-02" } }),
  baseline: symbol === "TSLA" ? { status: "BUILDING" } : symbol === "XOM" ? { status: "NO_BASELINE" } : { status: "OK", multiple: 1.4, avgCumNow: vol / 1.4, thresholdShares: Math.round(vol / 1.4 * 2) },
}));
const initialRules = () => [
  { date: "2026-11-24", symbol: "NVDA", rule: "HIGH", state: "TRIGGERED", cycle: 1, t0Ms: Date.now() - 6 * MIN, t0Value: 145.2, thresholdAtT0: 145, remindersSent: 1, nextReminderMs: Date.now() + 4 * MIN, version: 3 },
  { date: "2026-11-24", symbol: "MSFT", rule: "LOW", state: "ACKNOWLEDGED", cycle: 1, t0Ms: Date.now() - 50 * MIN, t0Value: 419.9, thresholdAtT0: 420, remindersSent: 2, ackMs: Date.now() - 30 * MIN, ackBy: "telegram", version: 5 },
];
let rules = initialRules();
let settings = { reminderIntervalMin: 10, autoClear: false, rearmBufferPricePct: 0.2, rearmBufferVolumePct: 10, volumeNoAlertFirstMin: 5, volumeMinAvgCum: 10000, volumeMinSessions: 10, baselineSessions: 20, nearPct: 20, reminderTidyUp: true, spikeHoldPct: 10 };
const DEFAULTS = { ...settings };
let log = Array.from({ length: 40 }, (_, i) => ({ tMs: T0 - i * 7 * MIN, kind: ["FIRST_ALERT", "REMINDER", "ACK", "SUPPRESSED", "SETTINGS_CHANGE", "HEALTH"][i % 6], symbol: i % 6 === 5 ? undefined : ["NVDA", "MSFT", "AAPL"][i % 3], rule: i % 6 < 3 ? ["HIGH", "LOW"][i % 2] : undefined, detail: { price: 145.2 + i / 100, threshold: 145, reason: "<img src=x onerror=alert(1)> crossed" } }));

function state() {
  const now = Date.now();
  const body = { version: "0.1.0", serverTimeMs: now, date: "2026-11-24", maxStocks: 30, settings, stocks: scenario === "empty" ? [] : stocks, market: scenario === "empty" ? [] : market(), rules: scenario === "empty" ? [] : rules, pausedAll: stocks.length > 0 && stocks.every((x) => x.paused), counters: { polls: 214, alpaca_calls: 214, telegram_sent: 7 }, lastPollMs: scenario === "delayed" ? now - 200000 : now - 12000 };
  // Optional field the dashboard can use when the server sends it (see report: API gap). "nomarket" tests the clock fallback.
  if (scenario === "closed") body.marketStatus = { status: "CLOSED", reason: "weekend", opensMs: now + 41 * 3600000, calendarValidUntil: "2027-12-31" };
  else if (scenario !== "nomarket") body.marketStatus = { status: "OPEN", closesMs: now + 5.3 * 3600000, calendarValidUntil: "2027-12-31" };
  return body;
}
const J = (res, code, data, extra = {}) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra }); res.end(JSON.stringify(data)); };
const body = (req) => new Promise((ok) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => { try { ok(JSON.parse(s || "{}")); } catch { ok({}); } }); });
const resolve = (t, prev) => (!t ? undefined : t.mode === "dollar" ? t.value : prev * (1 + t.value / 100));

async function api(req, res, url) {
  if (scenario === "unconfigured") return J(res, 503, { error: "NOT_CONFIGURED", message: "The dashboard access code is not set on the server." });
  if (scenario === "global") return J(res, 429, { error: "GLOBAL_LOCK", message: "Too many wrong codes.", retryAfterMs: 7 * 60000 });
  if (scenario === "locked") return J(res, 429, { error: "LOCKED", message: "Too many wrong attempts. Try again later." }, { "retry-after": "125" });
  if (scenario === "offline500") return J(res, 500, { error: "INTERNAL", message: "Something went wrong on the server." });
  if ((req.headers.authorization || "") !== "Bearer " + CODE) return J(res, 401, { error: "UNAUTHORIZED", message: "Access code missing or wrong." });
  if (scenario === "slow") await new Promise((r) => setTimeout(r, 1500));
  const p = url.pathname.replace(/\/+$/, "");
  const m = req.method;
  if (p === "/api/state") {
    return J(res, 200, state());
  }
  if (p === "/api/stocks" && m === "POST") {
    const b = await body(req);
    if (stocks.find((s) => s.symbol === b.symbol)) return J(res, 409, { error: "DUPLICATE", message: b.symbol + " is already on the watchlist." });
    if (b.symbol === "ZZZZ") return J(res, 422, { error: "UNKNOWN_SYMBOL", message: "ZZZZ was not found in the data source." });
    if (!b.high && !b.low && !b.volume) return J(res, 422, { error: "INVALID_INPUT", message: "Set at least one of LOW, HIGH or volume." });
    stocks.push({ symbol: b.symbol, enabled: true, ...(b.high ? { high: b.high } : {}), ...(b.low ? { low: b.low } : {}), ...(b.volume ? { volume: b.volume } : {}), ...(b.notes ? { notes: b.notes } : {}), ...(b.paused ? { paused: true } : {}) });
    return J(res, 201, { stock: stocks.at(-1) });
  }
  let sm = /^\/api\/stocks\/([^/]+)$/.exec(p);
  if (sm) {
    const sym = decodeURIComponent(sm[1]);
    const i = stocks.findIndex((s) => s.symbol === sym);
    if (i < 0) return J(res, 404, { error: "NOT_FOUND", message: sym + " is not on the watchlist." });
    if (m === "DELETE") { stocks.splice(i, 1); return J(res, 200, { ok: true }); }
    const b = await body(req);
    const next = { ...stocks[i] };
    for (const k of ["high", "low", "volume"]) if (b[k] !== undefined) { if (b[k] === null) delete next[k]; else next[k] = b[k]; }
    if (b.paused !== undefined) next.paused = b.paused;
    if (b.notes !== undefined) { if (b.notes === null || b.notes === "") delete next.notes; else next.notes = b.notes; }
    if (sym === "PLTR" && b.paused !== undefined && scenario === "failswitch") return J(res, 500, { error: "INTERNAL", message: "Something went wrong on the server." });
    const prev = px[sym]?.[1], last = px[sym]?.[0];
    const hi = resolve(next.high, prev), lo = resolve(next.low, prev);
    if (hi !== undefined && lo !== undefined && lo >= hi) return J(res, 422, { error: "LOW_NOT_BELOW_HIGH", message: "LOW must be below HIGH" });
    const hits = [];
    if (b.confirm !== true) { if (b.high && hi !== undefined && last >= hi) hits.push("HIGH"); if (b.low && lo !== undefined && last <= lo) hits.push("LOW"); }
    if (hits.length) return J(res, 409, { error: "CONFIRM_REQUIRED", message: "This will alert immediately. Save?", rules: hits, confirmWith: { confirm: true } });
    stocks[i] = next;
    rules = rules.filter((r) => !(r.symbol === sym && ((b.high && r.rule === "HIGH") || (b.low && r.rule === "LOW"))));
    return J(res, 200, { stock: next, rearmed: ["high", "low"].filter((k) => b[k]).map((k) => k.toUpperCase()) });
  }
  if (p === "/api/ack" && m === "POST") {
    const b = await body(req);
    let n = 0;
    rules = rules.map((r) => { if ((r.state === "TRIGGERED" || r.state === "REPEATING") && (b.all || (r.symbol === b.symbol && (!b.rule || b.rule === r.rule)))) { n++; return { ...r, state: "ACKNOWLEDGED", ackMs: Date.now(), ackBy: "dashboard", nextReminderMs: undefined }; } return r; });
    return J(res, 200, { acknowledged: n });
  }
  if (p === "/api/mute" && m === "POST") {
    const b = await body(req); const s = stocks.find((x) => x.symbol === b.symbol);
    if (!s) return J(res, 404, { error: "NOT_FOUND", message: "Not on the watchlist." });
    if (b.minutes === null) delete s.mutedUntilMs; else s.mutedUntilMs = Date.now() + b.minutes * MIN;
    return J(res, 200, { ok: true });
  }
  if (p === "/api/settings") {
    if (m === "GET") return J(res, 200, { settings, defaults: DEFAULTS });
    const b = await body(req);
    if (b.reminderIntervalMin !== undefined && (b.reminderIntervalMin < 1 || b.reminderIntervalMin > 60)) return J(res, 400, { error: "INVALID_INPUT", message: "settings.reminderIntervalMin: must be between 1 and 60" });
    settings = { ...settings, ...b };
    return J(res, 200, { settings });
  }
  if (p === "/api/export") return J(res, 200, { format: "market-monitor-config", version: 1, exportedAt: new Date().toISOString(), settings, stocks }, { "content-disposition": 'attachment; filename="market-monitor-config.json"' });
  if (p === "/api/import" && m === "POST") { const b = await body(req); return J(res, 200, { ok: true, stocks: (b.stocks || []).length }); }
  if (p === "/api/log") {
    const lim = Number(url.searchParams.get("limit") || 100), before = url.searchParams.get("before"), kind = url.searchParams.get("kind"), sym = url.searchParams.get("symbol");
    const rows = log.filter((r) => (!before || r.tMs < Number(before)) && (!kind || r.kind === kind) && (!sym || r.symbol === sym)).slice(0, lim);
    if (url.searchParams.get("format") === "csv") { res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "cache-control": "no-store", "content-disposition": 'attachment; filename="market-monitor-log.csv"' }); return res.end("time_utc,kind,symbol,rule,detail\n" + rows.map((r) => [new Date(r.tMs).toISOString(), r.kind, r.symbol || "", r.rule || "", JSON.stringify(r.detail)].join(",")).join("\n") + "\n"); }
    return J(res, 200, { log: rows });
  }
  if (p === "/api/pause-all" && m === "POST") { const on = (await body(req)).paused === true; for (const x of stocks) x.paused = on; return J(res, 200, { ok: true, paused: on, changed: stocks.length }); }
  if (p === "/api/why") {
    const sym = url.searchParams.get("symbol"), t = url.searchParams.get("t");
    if (!sym || !/^\d{2}:\d{2}$/.test(t || "")) return J(res, 400, { error: "INVALID_INPUT", message: "t: use HH:MM" });
    if (t > "23:00") return J(res, 422, { error: "NOT_YET", message: "That time has not happened yet." });
    return J(res, 200, { symbol: sym, date: "2026-11-24", atMs: Date.now() - 3600000, lines: ["Alert HIGH sent at " + t + ": price 145.20 against limit 145.00.", "Limits then: HIGH 145.00, LOW 130.00.", "<b>not html</b> HIGH state: alert open."], price: null, limits: {}, states: [], sent: [], related: [], paused: false, mutedNow: false });
  }
  if (p === "/api/ack-move" && m === "POST") {
    const b = await body(req);
    const r = rules.find((x) => x.symbol === b.symbol && x.rule === b.rule && (x.state === "TRIGGERED" || x.state === "REPEATING"));
    if (!r) return J(res, 409, { error: "NOT_ACTIVE", message: "That alert is no longer open." });
    const raw = String(b.value ?? ""), pct = raw.endsWith("%"), n = Number(raw.replace("%", ""));
    if (!Number.isFinite(n) || n <= 0 && !pct) return J(res, 400, { error: "INVALID_INPUT", message: "value: must be a number such as 250 or 5%" });
    const s = stocks.find((x) => x.symbol === b.symbol), prev = px[b.symbol][1], last = px[b.symbol][0];
    const price = pct ? prev * (1 + n / 100) : n;
    if ((b.rule === "HIGH" && price <= last) || (b.rule === "LOW" && price >= last)) return J(res, 409, { error: "STILL_CROSSED", message: "The new " + b.rule + " would still be crossed by the latest price. Nothing was changed." });
    s[b.rule.toLowerCase()] = { mode: pct ? "percent" : "dollar", value: n };
    rules = rules.filter((x) => x !== r);
    return J(res, 200, { ok: true, newThreshold: s[b.rule.toLowerCase()] });
  }
  if (p === "/api/test" && m === "POST") return J(res, 200, { ok: true });
  return J(res, 404, { error: "NOT_FOUND", message: "No such endpoint." });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  try {
    if (url.pathname === "/mock/scenario") { scenario = url.searchParams.get("name") || "normal"; rules = initialRules(); for (const x of stocks) delete x.paused; res.writeHead(200, { "content-type": "text/plain" }); return res.end("scenario=" + scenario); }
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(PUB, rel);
    if (!file.startsWith(PUB) || path.basename(file) === "_headers" || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, secHeaders); return res.end("Not found"); }
    res.writeHead(200, { ...secHeaders, "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (e) { res.writeHead(500); res.end("mock error"); }
}).listen(PORT, "127.0.0.1", () => console.log("Mock dashboard on http://127.0.0.1:" + PORT + "/  access code: " + CODE));
