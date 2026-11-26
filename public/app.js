/* Market Monitor dashboard (DG-3: Alternative A, "Glance Line").
   Plain ES modules, no build step. All server and user text goes in with textContent. The page does no monitoring itself (FR-8.8). */
import * as L from "./lib.js";

const POLL_MS = 15000;
const OFFLINE_RETRY_MS = 5000;
const CODE_RE = /^[\x21-\x7e]{32,256}$/;
const LOG_KINDS = ["FIRST_ALERT", "REMINDER", "ACK", "LATE_ALERT", "SETTINGS_CHANGE", "ERROR", "SUPPRESSED", "HEALTH"];
const ALERT_KINDS = new Set(["FIRST_ALERT", "REMINDER", "ACK", "LATE_ALERT"]);

/* ------------------------------------------------------------ tiny helpers */
const $ = (s, r = document) => r.querySelector(s);
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const k in props || {}) {
    const v = props[k];
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k === "value") e.value = v;
    else if (k === "checked") e.checked = !!v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? "" : String(v));
  }
  add(e, kids);
  return e;
}
function add(e, kids) {
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) add(e, c);
    else e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode: the page still works */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

/* ------------------------------------------------------------ app state */
const mqWide = window.matchMedia("(min-width: 47.5rem)");
const S = {
  code: store.get("mm.code") || "",
  codeSaved: !!store.get("mm.code"),
  auth: store.get("mm.code") ? "ok" : "need", // need | ok | locked | unconfigured
  gateMsg: "",
  lockedUntil: 0,
  conn: "ok", // ok | offline
  lastOkMs: 0,
  data: null,
  skew: 0,
  tab: store.get("mm.tab") || "watchlist",
  shown: "",
  update: null,
  updaters: [],
  wide: mqWide.matches,
  settings: null,
  log: { rows: [], more: false, loading: false, error: "", kind: "", symbol: "" },
  hist: { rows: [], error: "" },
  stack: { order: [], focus: "", crossed: null, banners: new Set() },
  stackApi: null,
  canDisableAll: false,
  pend: new Map(),
  alSig: "",
  brSig: "",
};
const nowMs = () => Date.now() + S.skew;

class NetError extends Error {}
class ApiError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra || {}; }
}

/* ------------------------------------------------------------ API (same origin, Bearer code) */
async function api(path, opt = {}) {
  let res;
  try {
    res = await fetch(path, {
      method: opt.method || "GET",
      headers: { Authorization: "Bearer " + S.code, ...(opt.body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: opt.body !== undefined ? JSON.stringify(opt.body) : undefined,
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    throw new NetError("No connection");
  }
  if (res.status === 401) { onUnauthorized(); throw new ApiError(401, "UNAUTHORIZED", "Access code missing or wrong."); }
  if (res.status === 429) {
    let d = null;
    try { d = await res.json(); } catch { /* header only */ }
    if (d?.error === "GLOBAL_LOCK") onLocked(Math.ceil((Number(d.retryAfterMs) || 900000) / 1000), "global");
    else onLocked(Number(res.headers.get("retry-after")) || 900, "client");
    throw new ApiError(429, "LOCKED", "Too many wrong attempts.");
  }
  if (res.status === 503) {
    let m = "The server is not configured.";
    try { m = (await res.json()).message || m; } catch { /* keep default */ }
    onUnconfigured(m);
    throw new ApiError(503, "NOT_CONFIGURED", m);
  }
  if (opt.raw && res.ok) return res;
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(res.status, data?.error || "ERROR", data?.message || "The server said no (" + res.status + ").", data || {});
  return data;
}
function onUnauthorized() {
  closeSheet();
  const had = S.codeSaved;
  S.code = ""; S.codeSaved = false; store.del("mm.code");
  S.auth = "need"; S.data = null;
  S.gateMsg = had ? "The server did not accept the saved access code. Enter it again." : "That access code was not accepted.";
  stopPolling(); ensureScreen(); updateHeader();
}
function onLocked(secs, kind) {
  closeSheet();
  S.lockKind = kind; S.auth = "locked"; S.lockedUntil = Date.now() + secs * 1000; S.data = null;
  stopPolling(); ensureScreen(); updateHeader();
}
function onUnconfigured(msg) {
  closeSheet();
  S.auth = "unconfigured"; S.gateMsg = msg; S.data = null;
  stopPolling(); ensureScreen(); updateHeader();
  schedule(30000);
}

/* ------------------------------------------------------------ polling (every 15 s while visible) */
let timer = 0, seq = 0;
function stopPolling() { clearTimeout(timer); timer = 0; }
function schedule(ms) {
  clearTimeout(timer);
  if (document.hidden || S.auth === "need" || S.auth === "locked") { timer = 0; return; }
  timer = setTimeout(() => poll(), ms);
}
async function poll() {
  if (!S.code) return;
  const mine = ++seq;
  try {
    const st = await api("/api/state");
    if (mine !== seq) return;
    S.data = st;
    S.skew = Number.isFinite(st.serverTimeMs) ? st.serverTimeMs - Date.now() : 0;
    S.conn = "ok"; S.auth = "ok"; S.lastOkMs = Date.now();
    if (!S.codeSaved) { store.set("mm.code", S.code); S.codeSaved = true; }
    S.gateMsg = "";
    ensureScreen();
    if (S.tab === "alerts") await loadHistory();
    refreshAll();
    schedule(POLL_MS);
  } catch (e) {
    if (mine !== seq) return;
    if (e instanceof NetError) {
      S.conn = "offline"; ensureScreen(); refreshAll(); schedule(OFFLINE_RETRY_MS);
    } else if (e instanceof ApiError && (e.status === 401 || e.status === 429 || e.status === 503)) {
      /* handled where it was raised */
    } else {
      S.conn = "ok";
      toast(e.message || "Something went wrong.", true);
      schedule(POLL_MS);
    }
  }
}
document.addEventListener("visibilitychange", () => { if (document.hidden) stopPolling(); else if (S.code) poll(); });
window.addEventListener("offline", () => { S.conn = "offline"; ensureScreen(); refreshAll(); });
window.addEventListener("online", () => { if (S.code) poll(); });

/* ------------------------------------------------------------ toast */
let toastTimer = 0;
function toast(msg, bad) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.toggle("bad", !!bad);
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), bad ? 8000 : 4500);
}

/* ------------------------------------------------------------ view models */
function marketNow() { return L.marketClock(nowMs(), S.data?.marketStatus, S.data?.date); }
function buildAll() {
  const d = S.data;
  if (!d) return [];
  const mc = marketNow();
  const byId = new Map((d.market || []).map((m) => [m.symbol, m]));
  return (d.stocks || []).map((s0) => { const s = S.pend.has(s0.symbol) ? { ...s0, paused: S.pend.get(s0.symbol) } : s0; return L.buildVM(s, byId.get(s.symbol), d.rules || [], d.settings, nowMs(), mc.open, { offline: S.conn === "offline", pausedAll: !!d.pausedAll }); });
}
const getVM = (sym) => buildAll().find((v) => v.sym === sym);
const activeRules = () => (S.data?.rules || []).filter(L.isActiveRule);

/* ------------------------------------------------------------ header (FR-8.2, FR-10.6) */
function updateHeader() {
  const d = S.data, now = nowMs();
  const hMarket = $("#hMarket"), hNote = $("#hMarketNote"), hData = $("#hData"), hPoll = $("#hPoll"), hUn = $("#hUnack"), hRem = $("#hReminder"), hHealth = $("#hHealth");
  $("#tabs").hidden = S.auth !== "ok";
  const setChip = (el, cls, text) => { el.className = "chip " + cls; el.textContent = text; };
  if (S.auth !== "ok") {
    hMarket.className = "mk-closed";
    hMarket.textContent = S.auth === "locked" ? "Locked" : S.auth === "unconfigured" ? "Server not configured" : "Sign in required";
    hNote.textContent = ""; hData.hidden = true; hPoll.textContent = ""; hUn.hidden = true; hRem.textContent = ""; hHealth.textContent = "";
    return;
  }
  hData.hidden = false; hUn.hidden = false;
  const off = $("#offline");
  off.hidden = S.conn !== "offline";
  $("#main").classList.toggle("stale", S.conn === "offline");
  if (!off.hidden) off.textContent = "\u26d4 NO CONNECTION. " + (d ? "What you see is the last good data from " + L.both(S.lastOkMs, true) + ". It is NOT live. Your unsaved entries are kept." : "Retrying every 5 seconds.");
  if (!d) {
    hMarket.className = "mk-closed"; hMarket.textContent = S.conn === "offline" ? "NO CONNECTION" : "Loading"; hNote.textContent = "";
    setChip(hData, S.conn === "offline" ? "bad solid" : "", S.conn === "offline" ? "\u26d4 NO CONNECTION" : "Loading ...");
    hPoll.textContent = S.lastOkMs ? "Last good update " + L.both(S.lastOkMs, true) : "";
    hUn.hidden = true; hRem.textContent = ""; hHealth.textContent = "";
    return;
  }
  const mc = marketNow();
  hMarket.className = mc.open ? "mk-open" : "mk-closed";
  hMarket.textContent = "Market " + (mc.status === "EARLY_CLOSE" ? "OPEN (EARLY CLOSE TODAY)" : mc.status === "OPEN" ? "OPEN" : "CLOSED" + (mc.reason ? " (" + mc.reason + ")" : ""));
  const nextTxt = Number.isFinite(mc.nextMs) ? (mc.nextKind === "close" ? "closes " : "opens ") + L.both(mc.nextMs) + " · in " + L.countdownText(mc.nextMs - now) : "";
  hNote.textContent = nextTxt + (mc.estimated ? " (estimated from the clock; holidays not checked)" : "");
  const ds = S.conn === "offline" ? { key: "OFF", label: "NO CONNECTION (not live)", icon: "\u26d4", ageS: null } : L.dataStatus(now, d.lastPollMs, mc.open);
  const cls = ds.key === "LIVE" ? "ok" : ds.key === "DELAYED" ? "warn" : ds.key === "NODATA" || ds.key === "OFF" ? "bad solid" : "";
  setChip(hData, cls, ds.icon + " Data " + ds.label + (ds.ageS !== null && ds.key !== "IDLE" ? " · " + L.ageText(ds.ageS) + " old" : ""));
  hPoll.textContent = S.conn === "offline" ? "Last good update " + L.both(S.lastOkMs, true) : d.lastPollMs === null ? "Server has not polled yet" : "Server last poll " + L.ageText(ds.ageS) + " ago";
  const act = activeRules();
  hUn.className = "chip " + (act.length ? "bad solid" : "ok");
  hUn.textContent = (act.length ? "⚠ " : "✓ ") + act.length + " unacknowledged";
  const next = act.map((r) => r.nextReminderMs).filter(Number.isFinite).sort((a, b) => a - b)[0];
  hRem.textContent = act.length === 0 ? "No reminders pending" : next === undefined ? "Next reminder: none scheduled" : next <= now ? "Reminder due now" : "Next reminder in " + L.countdownText(next - now) + " (" + L.both(next) + ")";
  hHealth.textContent = "Version " + (d.version || "?") + " · " + (d.stocks?.length ?? 0) + " of " + (d.maxStocks ?? "?") + " stocks · now " + L.both(now);
  document.title = (act.length ? "(" + act.length + ") " : "") + "Market Monitor";
  const badge = $("#alertBadge");
  badge.hidden = act.length === 0;
  badge.textContent = String(act.length);
}

/* ------------------------------------------------------------ screens */
function setTab(name) {
  S.tab = name; store.set("mm.tab", name);
  S.shown = ""; ensureScreen();
  if (name === "alerts" && S.data) loadHistory().then(refreshAll).catch(() => poll());
}
function ensureScreen() {
  const root = $("#main");
  const key = S.auth !== "ok" ? "gate:" + S.auth : !S.data ? (S.conn === "offline" ? "offline" : "loading") : S.tab;
  for (const t of document.querySelectorAll(".tab")) {
    const on = t.dataset.tab === S.tab;
    t.setAttribute("aria-selected", on ? "true" : "false");
    t.tabIndex = on ? 0 : -1;
  }
  if (key === S.shown) return;
  S.shown = key; S.update = null; S.updaters = []; S.stackApi = null; S.alSig = ""; S.brSig = "";
  root.replaceChildren();
  root.setAttribute("aria-labelledby", "tab-" + S.tab);
  if (key.startsWith("gate:")) S.update = gateScreen(root, key.slice(5));
  else if (key === "offline") offlineScreen(root);
  else if (key === "loading") put(root, h("p", { class: "empty", text: "Loading ..." }));
  else S.update = TABS[key](root);
  updateHeader();
  if (S.update) S.update();
}
function refreshAll() { updateHeader(); if (S.update) S.update(); for (const f of S.updaters) f(); }
setInterval(() => { if (document.hidden) return; refreshAll(); }, 1000);

/* gate: access code, lockout, server not configured */
function gateScreen(root, kind) {
  if (kind === "need") {
    const inp = h("input", { class: "in", id: "code", type: "password", autocomplete: "off", autocapitalize: "off", spellcheck: "false", "aria-describedby": "codeHelp codeErr", required: true });
    const codeErr = h("p", { class: "err", id: "codeErr", role: "alert", text: S.gateMsg });
    const count = h("span", { class: "sm", id: "codeCount", text: "0 characters" });
    inp.addEventListener("input", () => { count.textContent = inp.value.length + " characters (at least 32)"; });
    const show = h("input", { type: "checkbox", id: "showCode", onchange: () => { inp.type = show.checked ? "text" : "password"; } });
    const form = h("form", { class: "panel login", novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault();
      const v = inp.value.trim();
      if (!CODE_RE.test(v)) { codeErr.textContent = "The access code is 32 or more visible characters with no spaces."; inp.focus(); return; }
      codeErr.textContent = ""; btn.disabled = true; btn.textContent = "Checking ...";
      S.code = v; S.codeSaved = false; S.gateMsg = "";
      await poll();
      if (S.auth === "need") { btn.disabled = false; btn.textContent = "Open dashboard"; codeErr.textContent = S.conn === "offline" ? "No connection. Check the network and try again." : S.gateMsg; }
    } },
      h("h2", { text: "Enter the access code" }),
      h("p", { id: "codeHelp", text: "This is the long code you set on the server. It is kept only on this phone, and you can forget it from Settings." }),
      h("div", { class: "field" }, h("label", { for: "code", text: "Access code" }), inp, count),
      h("label", { class: "check", for: "showCode" }, show, "Show the code"),
      codeErr,
    );
    const btn = h("button", { class: "btn pri", type: "submit", text: "Open dashboard" });
    form.append(btn);
    put(root, form);
    inp.focus();
    return null;
  }
  if (kind === "locked") {
    const msg = h("p", { class: "big2", role: "status" });
    const global = S.lockKind === "global";
    put(root, h("section", { class: "notice bad login" }, h("h2", { text: global ? "Dashboard login paused" : "Too many wrong attempts" }), msg,
      h("p", { class: "sm", text: global ? "Telegram alerts and commands keep working." : "The server locks this phone for 15 minutes after 10 wrong codes. Waiting is the only way in." }),
      h("button", { class: "btn", type: "button", text: "Use a different code later", onclick: () => forgetCode() })));
    return () => {
      const left = S.lockedUntil - Date.now();
      if (left <= 0) { S.auth = "ok"; S.shown = ""; S.conn = "ok"; poll(); return; }
      msg.textContent = global ? "Too many wrong codes from the internet. Dashboard login paused for " + Math.max(1, Math.ceil(left / 60000)) + " min. Telegram still works." : "Try again in " + L.countdownText(left) + ".";
    };
  }
  put(root, h("section", { class: "notice warn login" }, h("h2", { text: "The server is not configured" }),
    h("p", { text: S.gateMsg }),
    h("p", { class: "sm", text: "The dashboard access code must be set on the server (32 or more characters). Set it with wrangler secret put DASHBOARD_ACCESS_CODE, then try again." }),
    h("button", { class: "btn pri", type: "button", text: "Try again", onclick: () => poll() })));
  return null;
}
function offlineScreen(root) {
  put(root, h("section", { class: "notice bad", role: "alert" },
    h("h2", { text: "⛔ NO CONNECTION" }),
    h("p", { text: "Prices and alerts cannot be checked, so none are shown. Nothing here is live." }),
    S.lastOkMs ? h("p", { class: "sm", text: "Last good update: " + L.both(S.lastOkMs, true) + ". Retrying every 5 seconds." }) : null,
    h("button", { class: "btn pri", type: "button", text: "Retry now", onclick: () => poll() })));
}
function forgetCode() {
  stopPolling(); store.del("mm.code");
  S.code = ""; S.codeSaved = false; S.data = null; S.auth = "need"; S.gateMsg = "The access code was removed from this phone.";
  S.shown = ""; ensureScreen(); updateHeader();
}

/* ------------------------------------------------------------ shared pieces */
const STATUS = {
  OK: ["✓", "OK"], NEAR: ["◔", "NEAR"], CROSSED: ["⚠", "CROSSED – UNACKNOWLEDGED"], ACK: ["✔", "ACKNOWLEDGED"],
  MUTED: ["\u{1f507}", "MUTED"], PAUSED: ["⏸", "Alerts off"], NODATA: ["—", "NO DATA"], BUILDING: ["◌", "BUILDING"], NOBASELINE: ["◌", "NO BASELINE"],
};
function statusChip(v) {
  if (v.paused && v.status === "CROSSED") { const f = document.createDocumentFragment(); f.append(statusChip({ ...v, paused: false }), h("span", { class: "chip st-PAUSED", text: "\u23f8 Alerts off" })); return f; }
  const [i, t] = STATUS[v.status];
  let extra = "";
  if (v.status === "ACK" && v.ackMs) extra = " " + L.hm(v.ackMs, L.TZ_MU) + " Muscat";
  if (v.status === "MUTED") extra = " until " + L.both(v.stock.mutedUntilMs);
  return h("span", { class: "chip st-" + v.status, text: i + " " + t + extra });
}
function ageChip(v) {
  const el = h("span", { class: "chip f-" + v.fresh });
  const upd = () => {
    const a = Number.isFinite(v.lastT) ? (nowMs() - v.lastT) / 1000 : NaN;
    el.textContent = Number.isFinite(a) ? L.FRESH_LABEL[v.fresh] + " · " + L.ageText(a) + " old" : L.FRESH_LABEL.none;
  };
  upd(); S.updaters.push(upd);
  return el;
}
const lastTime = (v) => (Number.isFinite(v.lastT) ? "Last recorded " + L.both(v.lastT, true) : "No trade recorded today");
function changeEl(v) {
  if (!Number.isFinite(v.changeAbs)) return h("span", { class: "chg", text: "" });
  const up = v.changeAbs >= 0;
  return h("span", { class: "chg " + (up ? "up" : "down"), text: (up ? "▲ " : "▼ ") + L.signed(v.changeAbs, Math.abs(v.last) < 1 ? 4 : 2) + " (" + L.signed(v.changePct) + "%)" });
}
function distLine(v) {
  if (!v.nearest) return h("p", { class: "dist sm", text: "No LOW or HIGH set, so no distance to show." });
  const n = v.nearest;
  const d = Math.abs(n.dist);
  const txt = n.dist < 0
    ? n.which + " $" + L.money(n.price) + " is crossed by $" + L.money(d) + " (" + Math.abs(n.pct).toFixed(1) + "%)"
    : "Nearest: " + n.which + " $" + L.money(n.price) + ", $" + L.money(d) + " (" + Math.abs(n.pct).toFixed(1) + "%) away";
  return h("p", { class: "dist", text: txt });
}
function gaugeEl(v) {
  const g = L.gaugeModel(v);
  if (!g) return h("p", { class: "gkey", text: "Range gauge needs both LOW and HIGH." });
  const mk = (cls, pos, ch) => { if (pos === null) return null; const e = h("span", { class: "m " + cls, "aria-hidden": "true", text: ch }); e.style.left = pos + "%"; return e; };
  const label = "Range from LOW " + L.money(v.loP) + " to HIGH " + L.money(v.hiP) + ". Previous Close " + L.money(v.prev) + ", Opening " + L.money(v.open) + ", Last " + L.money(v.last) + (g.beyond ? ", outside the band" : "");
  return h("div", {}, h("div", { class: "gauge", role: "img", "aria-label": label },
    h("span", { class: "track" }), mk("p", g.p, "P"), mk("o", g.o, "O"), mk("l" + (g.beyond ? " beyond" : ""), g.l, "▲"),
    h("span", { class: "gl", "aria-hidden": "true" }, h("span", { text: "LOW " + L.money(v.loP) }), h("span", { text: "HIGH " + L.money(v.hiP) }))),
    h("p", { class: "gkey", "aria-hidden": "true", text: "P prev close · O open (IEX) · ▲ last" }));
}
/** 52-week range: a thin bar with the last price on it, the two levels and whether the 52-week alerts are on. */
/** The one coloured line at the top of a card, only while something needs attention. */
function attentionEl(v) {
  const a = L.attentionLine(v, nowMs());
  if (!a) return null;
  return h("div", { class: "say " + a.tone, role: a.tone === "red" ? "alert" : "status" },
    h("div", {}, h("b", { text: a.title }), a.sub ? h("span", { text: a.sub }) : null),
    a.tone === "red" ? ackBtn(v, "Acknowledge") : a.review ? h("button", { type: "button", class: "btn", "data-fk": v.sym + ":split", text: "Review", "aria-label": "Review the split for " + v.sym, onclick: () => splitSheet(v) }) : null);
}
function moreChips(v) {
  const on = L.moreOn(v.stock);
  return on.length ? h("div", { class: "chips dm", "aria-label": "More alerts on: " + on.join(", ") }, on.map((t) => h("span", { class: "mchip", text: t }))) : null;
}
function range52El(v) {
  const m = L.range52Model(v.w52, v.last);
  if (!m) return h("p", { class: "sm dm r52none", text: "52-week range: " + (v.w52 ? "no history" : "loading") + (v.range52 ? " · 52W alerts on" : "") });
  const mk = h("span", { class: "m" + (m.beyond ? " beyond" : ""), "aria-hidden": "true", text: "▲" });
  if (m.pos !== null) mk.style.left = m.pos + "%"; else mk.hidden = true;
  const label = "52-week range " + L.money(m.low) + " to " + L.money(m.high) + (Number.isFinite(v.last) ? ", last " + L.money(v.last) : "") + (m.beyond ? ", a new 52-week " + (v.last > m.high ? "high" : "low") : "");
  return h("div", { class: "dm r52" },
    h("div", { class: "r52h" }, h("span", { text: "52-week range" + (m.short ? " (under a year)" : "") }), h("span", { class: "r52s" + (v.range52 ? " on" : ""), text: v.range52 ? "🔔 alerts on" : "alerts off" })),
    h("div", { class: "r52bar", role: "img", "aria-label": label + (m.ma50 !== null ? ", 50-day average " + L.money(v.w52.ma50) : "") + (m.ma200 !== null ? ", 200-day average " + L.money(v.w52.ma200) : "") },
      h("span", { class: "track" }),
      [["50d", m.ma50, ""], ["200d", m.ma200, " lo"]].filter(([, p]) => p !== null).map(([t, p, c]) => { const g = h("span", { class: "tick" + c, "aria-hidden": "true" }, h("span", { class: "tl", text: t })); g.style.left = p + "%"; return g; }),
      mk),
    h("div", { class: "r52l num", "aria-hidden": "true" }, h("span", { text: "$" + L.money(m.low) }), h("span", { text: "$" + L.money(m.high) })));
}
function ackBtn(v, label) {
  return h("button", { type: "button", class: "btn pri", "data-fk": v.sym + ":ack", text: label || "Acknowledge", "aria-label": "Acknowledge " + v.sym, onclick: () => act(() => api("/api/ack", { method: "POST", body: { symbol: v.sym } }), (r) => "Acknowledged " + v.sym + " (" + r.acknowledged + " rule" + (r.acknowledged === 1 ? "" : "s") + ")") });
}
function moveBtn(v) {
  const r = v.active.find((x) => x.rule === "HIGH" || x.rule === "LOW");
  if (!r) return null;
  return h("button", { type: "button", class: "btn", "data-fk": v.sym + ":move", text: "Ack + move…", onclick: () => ackMoveSheet(v.sym, r.rule.toLowerCase(), r) });
}
/* ------------------------------------------------------------ WATCHLIST (card stack, steps 1 and 4) */
const dollars = (n) => (Number.isFinite(n) ? "$" + L.money(n) : "n/a");
const levelText = (t, p) => (!t ? "—" : p === undefined ? L.signed(t.value) + "% (needs Prev Close)" : "$" + L.money(p));
function volNowText(v) {
  return L.compact(v.cumVolume) + (Number.isFinite(v.volAvgMultiple) ? " · " + v.volAvgMultiple.toFixed(1) + "x usual" : " · usual n/a");
}
function volAlertText(v) {
  if (!v.vol) return "not set";
  const pct = v.vol.mode === "absolute" && Number.isFinite(v.cumVolume) ? " (" + Math.round((v.cumVolume / v.vol.value) * 100) + "% reached)" : "";
  return L.volumeText(v.vol) + pct;
}
function volUsualText(v) {
  const bits = ["IEX volume " + L.compact(v.cumVolume)];
  bits.push(Number.isFinite(v.volAvgMultiple) ? v.volAvgMultiple.toFixed(1) + "x the usual at this time" : "usual average not available");
  if (v.baseline?.status === "BUILDING") bits.push("baseline building");
  if (v.baseline?.status === "NO_BASELINE") bits.push("no baseline yet");
  if (Number.isFinite(v.baseline?.thresholdShares)) bits.push("= " + L.compact(v.baseline.thresholdShares) + " shares now");
  return bits.join(" · ");
}
function rw(label, val) { return h("div", { class: "rw" }, h("dt", { text: label }), h("dd", { class: "num", text: val })); }
function switchBtn(v, id) {
  const on = !v.paused;
  return h("button", { type: "button", class: "sw", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": "Alerts for " + v.sym, "data-fk": v.sym + ":sw", onclick: () => toggleAlerts(v.sym) },
    h("span", { text: "Alerts" }), h("span", { class: "t", "aria-hidden": "true" }));
}
function cardActions(v) {
  const crossed = v.status === "CROSSED";
  return h("div", { class: "cact" },
    crossed && moveBtn(v) ? h("div", { class: "arow" }, moveBtn(v)) : null, // Acknowledge sits in the attention line
    h("button", { type: "button", class: "btn", "data-fk": v.sym + ":edit", text: "Edit", onclick: () => stockSheet(v.sym) }),
    h("button", { type: "button", class: "btn", "data-fk": v.sym + ":mute", text: v.muted ? "Unmute" : "Mute…", onclick: () => (v.muted ? act(() => api("/api/mute", { method: "POST", body: { symbol: v.sym, minutes: null } }), () => v.sym + " unmuted") : muteSheet(v)) }),
    h("button", { type: "button", class: "btn danger", "data-fk": v.sym + ":remove", text: "Remove…", onclick: () => removeSheet(v) }));
}
function cardEl(v) {
  const wide = S.wide;
  const price = h("div", { class: "pr dm" }, h("span", { class: "big num", text: Number.isFinite(v.last) ? "$" + L.money(v.last) : "—" }), changeEl(v));
  const chip = h("div", { class: "stchip" }, statusChip(v));
  const age = h("div", { class: "dm age" }, h("span", { class: "lastt", text: lastTime(v) }), ageChip(v));
  const gblock = h("div", { class: "dm gblk" }, gaugeEl(v), distLine(v));
  const note = v.notes ? h("p", { class: "sm dm", text: "Note: " + v.notes }) : null;
  let body;
  if (wide) {
    body = [
      h("div", { class: "ctop" }, h("h3", { text: v.sym }), price, chip, switchBtn(v)),
      age, attentionEl(v),
      h("div", { class: "cols" },
        h("dl", { class: "rws dm" }, rw("Prev Close", dollars(v.prev)), rw("Open", dollars(v.open)), rw("Day high", dollars(v.dayHigh)), rw("Day low", dollars(v.dayLow))),
        h("dl", { class: "rws dm" }, rw("LOW alert", levelText(v.low, v.loP)), rw("HIGH alert", levelText(v.high, v.hiP)), rw("Volume alert", volAlertText(v)), rw("Volume now", L.compact(v.cumVolume))),
        h("div", {}, gblock, range52El(v), h("p", { class: "sm dm", text: volUsualText(v) }))),
      moreChips(v), note];
  } else {
    const hasVol = Number.isFinite(v.cumVolume);
    const shortM = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : L.compact(n));
    const volNow = hasVol ? shortM(v.cumVolume) : "n/a";
    const volAl = !v.vol ? "not set" : v.vol.mode === "absolute" ? shortM(v.vol.value) + " sh" + (hasVol ? " (" + Math.round((v.cumVolume / v.vol.value) * 100) + "%)" : "") : v.vol.value + "x usual";
    const lv = (t, p) => (!t ? "\u2014" : p === undefined ? L.signed(t.value) + "%" : "$" + L.money(p));
    body = [
      h("div", { class: "ctop" }, h("h3", { text: v.sym }), switchBtn(v)),
      h("div", { class: "prow" }, h("div", { class: "dm" }, h("div", { class: "big num", text: Number.isFinite(v.last) ? "$" + L.money(v.last) : "\u2014" }), changeEl(v)), chip),
      attentionEl(v),
      h("div", { class: "dm age", title: lastTime(v) }, h("span", { class: "lastt", text: Number.isFinite(v.lastT) ? "Last " + L.hm(v.lastT, L.TZ_ET, true) + " ET" : "No trade today" }), ageChip(v)),
      h("dl", { class: "rws g2 dm" }, rw("Prev Close", dollars(v.prev)), rw("Open", dollars(v.open)),
        rw("Day high", dollars(v.dayHigh)), rw("Day low", dollars(v.dayLow)),
        rw("LOW alert", lv(v.low, v.loP)), rw("HIGH alert", lv(v.high, v.hiP)),
        rw("Volume now", volNow), rw("Volume alert", volAl)),
      v.baseline?.status === "BUILDING" || v.baseline?.status === "NO_BASELINE" ? h("p", { class: "sm dm", text: "Usual-volume average: " + (v.baseline.status === "BUILDING" ? "building" : "not available yet") }) : null,
      h("div", { class: "dm" }, distLine(v)), range52El(v), Number.isFinite(v.volAvgMultiple) ? h("p", { class: "sm dm", text: "Volume is " + v.volAvgMultiple.toFixed(1) + "x the usual at this time" }) : null, moreChips(v), note];
  }
  return h("article", { class: "card cd st-" + v.status + " f-" + v.fresh + (v.paused ? " paused" : "") + (v.status === "CROSSED" ? " alert" : ""), "aria-label": v.sym }, body, cardActions(v));
}

async function toggleAlerts(sym) {
  const v = getVM(sym);
  if (!v || S.pend.has(sym)) return;
  const nextPaused = !v.paused;
  S.pend.set(sym, nextPaused); // optimistic: the card changes now, and goes back if the server says no
  refreshAll();
  try {
    await api("/api/stocks/" + encodeURIComponent(sym), { method: "PUT", body: { paused: nextPaused } });
  } catch (e) {
    S.pend.delete(sym); refreshAll();
    if (e instanceof NetError) toast("No connection. Alerts for " + sym + " were not changed.", true);
    else if (e instanceof ApiError) { if (![401, 429, 503].includes(e.status)) toast(e.message, true); }
    else throw e;
    return;
  }
  if (!nextPaused && ((v.hiP !== undefined && L.crossedBy("HIGH", v.hiP, v.last)) || (v.loP !== undefined && L.crossedBy("LOW", v.loP, v.last)))) toast(sym + " alerts are on. The price is already beyond a level, so an alert will be sent right away.");
  await poll();
  S.pend.delete(sym); refreshAll();
}

function watchlistTab(root) {
  const st = S.stack;
  const recs = new Map(); // symbol -> { el, sig, ups }
  const chips = new Map(); // symbol -> { btn, dot, sr }
  const addBtn = h("button", { type: "button", class: "btn pri", text: "+ Add stock", "data-fk": "add", onclick: () => stockSheet() });
  const ackAll = h("button", { type: "button", class: "btn", "data-fk": "ackall", onclick: ackAllSheet });
  const more = h("button", { type: "button", class: "btn", text: "More\u2026", "data-fk": "more", onclick: moreSheet });
  const info = h("p", { class: "sm grow", id: "wlInfo" });
  const noteMarket = h("div", {});
  const noteOff = h("div", { role: "status" });
  const banners = h("div", { role: "status" });
  const strip = h("div", { class: "strip", role: "group", "aria-label": "Jump to a stock" });
  const stage = h("div", { class: "stage", role: "group", "aria-roledescription": "carousel", "aria-label": "Watchlist cards. Swipe sideways or use the left and right arrow keys." });
  const empty = h("div", { class: "panel empty", hidden: true }, h("p", { text: "No stocks yet. Add one to start watching it." }));
  const say = h("p", { class: "sr", "aria-live": "polite" });
  put(root, h("div", { class: "toolbar" }, addBtn, ackAll, more, info), noteMarket, noteOff, banners, empty, strip, stage, say);
  let drag = null; // { id, x0, y0, axis, dx }

  const idx = () => st.order.indexOf(st.focus);
  function lay() {
    const n = st.order.length, fi = idx();
    const dx = drag && drag.axis === "h" ? L.dragOffset(drag.dx, fi, n) : 0;
    st.order.forEach((sym, k) => {
      const el = recs.get(sym)?.el;
      if (!el) return;
      const off = k - fi, a = Math.abs(off);
      let t = "none", o = 1, z = 10;
      if (off === 0) { t = dx ? "translateX(" + dx + "px)" : "none"; }
      else if (a <= 2) { t = "translateX(" + off * 14 + "px) scale(" + (1 - a * 0.05) + ")"; o = a === 1 ? 0.9 : 0.6; z = 10 - a; }
      else { t = "scale(.85)"; o = 0; z = 0; }
      el.style.transform = t; el.style.opacity = String(o); el.style.zIndex = String(z);
      el.style.transition = dx && off === 0 ? "none" : "";
      el.style.visibility = a <= 2 ? "visible" : "hidden";
      el.inert = off !== 0;
    });
  }
  function updateStrip(byS) {
    for (const [sym, c] of chips) if (!st.order.includes(sym)) { c.btn.remove(); chips.delete(sym); }
    st.order.forEach((sym, k) => {
      let c = chips.get(sym);
      if (!c) {
        const dot = h("span", { class: "dot", "aria-hidden": "true", hidden: true });
        const sr = h("span", { class: "sr" });
        const btn = h("button", { type: "button", class: "chipb", onclick: () => go(sym) }, h("span", { text: sym }), dot, sr);
        c = { btn, dot, sr }; chips.set(sym, c);
      }
      if (strip.children[k] !== c.btn) strip.insertBefore(c.btn, strip.children[k] || null);
      const v = byS.get(sym);
      const alert = v?.status === "CROSSED";
      c.btn.classList.toggle("on", sym === st.focus);
      c.btn.classList.toggle("off", !!v?.paused);
      if (sym === st.focus) c.btn.setAttribute("aria-current", "true"); else c.btn.removeAttribute("aria-current");
      c.dot.hidden = !alert;
      if (sym === st.focus && !c.shown) { c.shown = true; c.btn.scrollIntoView({ inline: "nearest", block: "nearest" }); } else if (sym !== st.focus) c.shown = false;
      c.sr.textContent = (alert ? ", alert active" : "") + (v?.paused ? ", alerts off" : "");
    });
  }
  function renderBanners() {
    const key = [...st.banners].join(",");
    if (banners.dataset.k === key) return;
    banners.dataset.k = key;
    fill(banners, [...st.banners].map((sym) => h("div", { class: "notice bad banner" }, h("span", { text: sym + " crossed – " }),
      h("button", { type: "button", class: "btn", text: "Show", "aria-label": "Show " + sym, onclick: () => go(sym) }))));
  }
  function go(sym) {
    if (!recs.has(sym)) return;
    const changed = sym !== st.focus;
    st.focus = sym; st.banners.delete(sym);
    renderBanners(); lay();
    updateStrip(new Map(L.sortVMs(buildAll()).map((v) => [v.sym, v])));
    if (changed) say.textContent = "Showing " + sym;
  }
  function move(d) {
    const k = Math.max(0, Math.min(st.order.length - 1, idx() + d));
    if (st.order[k] && st.order[k] !== st.focus) go(st.order[k]);
  }
  S.stackApi = { move };

  /* pointer: only a mostly sideways drag changes the card; vertical gestures scroll the page (touch-action: pan-y) */
  stage.addEventListener("pointerdown", (e) => {
    if (drag || !e.isPrimary || (e.pointerType === "mouse" && e.button !== 0)) return;
    drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, axis: null, dx: 0 };
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0, dy = e.clientY - drag.y0;
    if (!drag.axis) {
      drag.axis = L.dragAxis(dx, dy);
      if (drag.axis === "h") { try { stage.setPointerCapture(e.pointerId); } catch { /* not capturable: the drag still works over the stage */ } }
    }
    if (drag.axis === "h") { drag.dx = dx; lay(); }
  });
  const endDrag = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag; drag = null;
    if (d.axis !== "h" || e.type === "pointercancel") { lay(); return; }
    const k = L.dragSettle(d.dx, idx(), st.order.length);
    if (st.order[k] !== st.focus) go(st.order[k]); else lay();
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  S.updaters.push(() => { for (const r of recs.values()) for (const f of r.ups) f(); });

  return () => {
    const vms = L.sortVMs(buildAll());
    const byS = new Map(vms.map((v) => [v.sym, v]));
    const act_ = activeRules().length;
    const allOff = L.allAlertsOff(vms);
    ackAll.textContent = "Acknowledge all (" + act_ + ")"; ackAll.disabled = act_ === 0;
    S.canDisableAll = vms.length > 0 && !allOff;
    info.textContent = vms.length + " stock" + (vms.length === 1 ? "" : "s");
    const mc = marketNow();
    if (noteMarket.dataset.k !== String(mc.open)) { noteMarket.dataset.k = String(mc.open); fill(noteMarket, mc.open ? null : h("p", { class: "notice warn", text: "The market is closed. Prices below are from the last session and are not moving." })); }
    if (noteOff.dataset.k !== String(allOff)) { noteOff.dataset.k = String(allOff); fill(noteOff, allOff ? h("p", { class: "notice bad", text: "All alerts are off. Turn stocks back on with the switch on each card." }) : null); }

    /* order is frozen while the page is in use: opens on the most urgent stock, new stocks go last */
    const prevOrder = st.order;
    st.order = L.stackOrder(prevOrder, vms.map((v) => v.sym));
    st.focus = L.focusAfter(prevOrder, st.order, st.focus);
    const nc = L.newlyCrossed(st.crossed, vms);
    st.crossed = new Set(vms.filter((v) => v.status === "CROSSED").map((v) => v.sym));
    for (const s of nc) if (s !== st.focus) st.banners.add(s);
    for (const s of [...st.banners]) if (!st.crossed.has(s) || s === st.focus || !byS.has(s)) st.banners.delete(s);
    renderBanners();

    empty.hidden = vms.length > 0;
    strip.hidden = stage.hidden = vms.length === 0;
    /* rebuild only the cards that changed, so the focused card, a drag and keyboard focus survive the 15 s poll */
    for (const sym of [...recs.keys()]) if (!byS.has(sym)) { recs.get(sym).el.remove(); recs.delete(sym); }
    for (const sym of st.order) {
      const v = byS.get(sym);
      const sig = S.wide + JSON.stringify(v, (k, x) => (k === "ageS" ? undefined : x));
      const old = recs.get(sym);
      if (old && old.sig === sig) continue;
      const fk = old && old.el.contains(document.activeElement) ? document.activeElement.dataset.fk : null;
      const saved = S.updaters; S.updaters = [];
      const el = cardEl(v);
      const ups = S.updaters; S.updaters = saved;
      for (const f of ups) f();
      if (old) old.el.replaceWith(el);
      recs.set(sym, { el, sig, ups });
      if (fk) el.querySelector('[data-fk="' + CSS.escape(fk) + '"]')?.focus();
    }
    st.order.forEach((sym, k) => { if (stage.children[k] !== recs.get(sym).el) stage.insertBefore(recs.get(sym).el, stage.children[k] || null); });
    updateStrip(byS);
    lay();
  };
}
mqWide.addEventListener("change", () => { S.wide = mqWide.matches; refreshAll(); });
document.addEventListener("keydown", (e) => {
  if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (!S.stackApi || S.tab !== "watchlist" || sheet.open) return;
  const t = e.target;
  if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
  e.preventDefault();
  S.stackApi.move(e.key === "ArrowRight" ? 1 : -1);
});


/* ------------------------------------------------------------ actions */
async function act(fn, okMsg) {
  try {
    const r = await fn();
    if (okMsg) toast(okMsg(r));
    await poll();
    return r;
  } catch (e) {
    if (e instanceof ApiError) { if (![401, 429, 503].includes(e.status)) toast(e.message, true); }
    else if (e instanceof NetError) toast("No connection. Nothing was changed.", true);
    else throw e;
    return null;
  }
}

/* ------------------------------------------------------------ bottom sheet (step 2: only Cancel closes a form) */
const sheet = $("#sheet");
const SH = { ret: null, snap: "", dc: null, pane: null, keep: null, hist: false, skipPop: false, esc: 0, lastFocus: null };
/** Everything the person can change in the open sheet: field values, radio/checkbox state and switches. */
const snapshot = () => JSON.stringify(
  [...sheet.querySelectorAll("input,select,textarea")].map((e) => (e.type === "checkbox" || e.type === "radio" ? e.checked : e.value))
    .concat([...sheet.querySelectorAll('[role="switch"]')].map((e) => e.getAttribute("aria-checked"))));
function openSheet(returnFk, build) {
  SH.ret = returnFk;
  sheet.replaceChildren();
  const pane = h("div", { class: "pane" });
  const keep = h("button", { type: "button", class: "btn pri", text: "Keep editing", onclick: keepEditing });
  const dc = h("div", { class: "confirm", hidden: true, role: "alertdialog", "aria-labelledby": "dcT" },
    h("h3", { id: "dcT", text: "Discard your changes?" }), h("p", { text: "What you typed in this form will be lost." }),
    h("div", { class: "dact" }, keep, h("button", { type: "button", class: "btn danger", text: "Discard", onclick: closeSheet })));
  SH.pane = pane; SH.dc = dc; SH.keep = keep;
  sheet.append(pane, dc);
  build(pane);
  SH.snap = snapshot();
  if (!sheet.open) {
    sheet.showModal();
    try { history.pushState({ mmSheet: 1 }, ""); SH.hist = true; } catch { /* no history: the form still works */ }
  }
}
function showDiscard() {
  SH.lastFocus = document.activeElement;
  SH.pane.hidden = true; SH.dc.hidden = false; SH.keep.focus();
}
function keepEditing() {
  SH.dc.hidden = true; SH.pane.hidden = false;
  if (SH.lastFocus && SH.pane.contains(SH.lastFocus)) SH.lastFocus.focus(); else SH.pane.querySelector("input,select,textarea,button")?.focus();
}
/** Cancel, the phone's back gesture and Esc-less dismissals all end up here: close at once if nothing changed, else ask. */
function cancelSheet() {
  if (!sheet.open || !SH.dc || !SH.dc.hidden) return;
  if (snapshot() === SH.snap) closeSheet(); else showDiscard();
}
/** Closes for good (Save worked, Discard, nothing changed). */
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener("close", () => {
  if (sheet.open) return; // opened again before this event arrived: leave the new sheet alone
  sheet.replaceChildren();
  SH.dc = SH.pane = SH.keep = null;
  if (SH.hist) { SH.hist = false; SH.skipPop = true; try { if (history.state && history.state.mmSheet) history.back(); else SH.skipPop = false; } catch { SH.skipPop = false; } }
  if (SH.ret) { const el = document.querySelector('[data-fk="' + CSS.escape(SH.ret) + '"]'); if (el) el.focus(); }
});
/* Esc does nothing. A cancel event without a recent Esc is the phone's back gesture: treat it like Cancel. */
sheet.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); SH.esc = performance.now(); } });
sheet.addEventListener("cancel", (e) => { e.preventDefault(); if (performance.now() - SH.esc > 300) cancelSheet(); });
window.addEventListener("popstate", () => {
  if (SH.skipPop) { SH.skipPop = false; return; }
  if (!sheet.open || !SH.dc) return;
  SH.hist = false; // the browser already removed our entry
  if (!SH.dc.hidden || snapshot() !== SH.snap) {
    try { history.pushState({ mmSheet: 1 }, ""); SH.hist = true; } catch { /* ignore */ }
    if (SH.dc.hidden) showDiscard();
  } else sheet.close();
});
/** A confirm sheet's action: closes only when it worked; on an error the sheet stays and shows the message. */
async function sheetAct(fn, okMsg, err, btns) {
  btns.forEach((b) => b && (b.disabled = true)); err.textContent = "";
  try {
    const r = await fn();
    closeSheet();
    if (okMsg) toast(okMsg(r));
    poll();
  } catch (e) {
    btns.forEach((b) => b && (b.disabled = false));
    if (e instanceof NetError) err.textContent = "No connection. Nothing was changed.";
    else if (e instanceof ApiError) { if (![401, 429, 503].includes(e.status)) err.textContent = e.message; }
    else throw e;
  }
}
function seg(name, options, selected, onchange) {
  const wrap = h("div", { class: "seg" });
  for (const [val, text] of options) {
    wrap.append(h("label", {}, h("input", { type: "radio", name, value: val, checked: val === selected, onchange: () => onchange(val) }), text));
  }
  return wrap;
}
const fill = (el, ...kids) => { el.replaceChildren(); add(el, kids); };
const put = (el, ...kids) => add(el, kids);
const sheetTitle = (t) => h("h2", { id: "sheetTitle", text: t });

/* Ack + move: its own small sheet. It still calls POST /api/ack-move. */
function ackMoveSheet(sym, which, rule) {
  const v = getVM(sym);
  if (!v) return;
  const R = which.toUpperCase();
  const cur = v[which];
  const otherP = which === "high" ? v.loP : v.hiP;
  let mode = cur?.mode || "dollar", value = cur ? String(cur.value) : "";
  const base = which === "high" ? v.hiP : v.loP;
  if (base !== undefined) { mode = "dollar"; value = (base * (which === "high" ? 1.01 : 0.99)).toFixed(2); }
  openSheet(sym + ":move", (root) => {
    const inp = h("input", { class: "in", id: "edVal", type: "text", inputmode: "decimal", autocomplete: "off", value, "aria-describedby": "edPrev edErr", autofocus: true });
    const prev = h("div", { class: "preview", id: "edPrev", "aria-live": "polite" });
    const err = h("p", { class: "err", id: "edErr", role: "alert" });
    const unitSeg = seg("unit", [["dollar", "$ price"], ["percent", "% from Previous Close"]], mode, (m) => { mode = m; calc(); inp.focus(); });
    const save = h("button", { type: "submit", class: "btn pri", text: "Save" });
    let last = null;
    function calc() {
      const r = L.evalThreshold({ which, mode, text: inp.value, prev: v.prev, last: v.last, otherPrice: otherP });
      last = r.state === "ok" ? r : null;
      err.textContent = r.state === "error" ? r.err : "";
      prev.textContent = r.state === "ok" ? r.preview : r.state === "empty" ? "Type a value to see what it means." : "";
    }
    inp.addEventListener("input", calc);
    async function doSave(r) {
      save.disabled = true;
      try {
        const vs = r.mode === "percent" ? r.value + "%" : String(r.value);
        const mv = await api("/api/ack-move", { method: "POST", body: { symbol: sym, rule: rule.rule, cycle: rule.cycle, value: vs } });
        closeSheet(); toast(R + " for " + sym + " acknowledged and moved" + (mv?.newThreshold ? " to " + (mv.newThreshold.mode === "percent" ? L.signed(mv.newThreshold.value) + "%" : "$" + L.money(mv.newThreshold.value)) : "") + "."); poll();
      } catch (e) {
        save.disabled = false;
        if (e instanceof NetError) err.textContent = "No connection. Nothing was changed.";
        else if (e instanceof ApiError) err.textContent = e.message;
        else throw e;
      }
    }
    const form = h("form", { novalidate: true, onsubmit: (ev) => {
      ev.preventDefault(); calc();
      if (!last) { if (!err.textContent) err.textContent = "Type a value first."; inp.focus(); return; }
      doSave(last);
    } },
      h("fieldset", { class: "field" }, h("legend", { text: "Enter it as" }), unitSeg),
      h("div", { class: "field" }, h("label", { for: "edVal", text: "New " + R }), inp, h("p", { class: "sm", text: "Dollars are a price per share. Percent is signed from Previous Close, so a LOW is usually negative." })), prev, err,
      h("div", { class: "dact" }, save, h("button", { type: "button", class: "btn", text: "Cancel", onclick: cancelSheet })));
    put(root, sheetTitle("Acknowledge and move " + R + " for " + sym),
      h("p", { class: "sm", text: "Now: " + (cur ? L.thresholdText(cur, v.prev) : "not set") + " · Previous Close " + (Number.isFinite(v.prev) ? L.money(v.prev) : "n/a") + " · Last " + (Number.isFinite(v.last) ? L.money(v.last) : "n/a") }),
      h("p", { class: "sm", text: "One step: the alert is acknowledged and the " + R + " moves 1% away. If the move is refused, the alert stays unacknowledged. Change the number if you want something else." }), form);
    calc();
    inp.select();
  });
}

/* One form to add and edit a stock (step 3) */
const UNIT_OPTS = [["dollar", "$ price"], ["percent", "% from Prev Close"]];
function stockSheet(sym) {
  const v = sym ? getVM(sym) : null;
  if (sym && !v) return;
  const ex = v?.stock;
  const d = S.data;
  const full = !v && (d?.stocks?.length ?? 0) >= (d?.maxStocks ?? 30);
  openSheet(v ? sym + ":edit" : "add", (root) => {
    let on = ex ? !ex.paused : true;
    const sw = h("button", { type: "button", class: "sw", role: "switch", "aria-checked": on ? "true" : "false", "aria-label": "Alerts for this stock", onclick: () => { on = !on; sw.setAttribute("aria-checked", on ? "true" : "false"); } },
      h("span", { text: "Alerts" }), h("span", { class: "t", "aria-hidden": "true" }));
    const symIn = h("input", { class: "in", id: "sfSym", type: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxlength: "8", value: sym || "", readonly: !!v, autofocus: !v, placeholder: "NVDA" });
    const sel = (id, label, opts, val) => { const s = h("select", { class: "in", id, "aria-label": label }, opts.map(([k, t]) => h("option", { value: k, text: t }))); s.value = val; return s; };
    const lowIn = h("input", { class: "in", id: "sfLow", type: "text", inputmode: "decimal", autocomplete: "off", value: ex?.low ? String(ex.low.value) : "", "aria-describedby": "pvLow", autofocus: !!v });
    const highIn = h("input", { class: "in", id: "sfHigh", type: "text", inputmode: "decimal", autocomplete: "off", value: ex?.high ? String(ex.high.value) : "", "aria-describedby": "pvHigh" });
    const volIn = h("input", { class: "in", id: "sfVol", type: "text", inputmode: "decimal", autocomplete: "off", value: ex?.volume ? String(ex.volume.value) : "", "aria-describedby": "pvVol pvNote" });
    const lowU = sel("sfLowU", "LOW unit", UNIT_OPTS, ex?.low?.mode || "dollar");
    const highU = sel("sfHighU", "HIGH unit", UNIT_OPTS, ex?.high?.mode || "dollar");
    const volU = sel("sfVolU", "Volume unit", [["multiple", "x usual at this time"], ["absolute", "shares"]], ex?.volume?.mode || "multiple");
    const noteIn = h("textarea", { class: "in ta", id: "sfNote", maxlength: "200", rows: "2", value: ex?.notes || "" });
    // "More alerts" (design step 7): folded; one switch and one line each; only Fast move has settings.
    const more = { range52: !!ex?.range52, fast: !!ex?.fast, averages: !!ex?.averages, news: !!ex?.news };
    const mkSw = (id, key, label) => {
      const b = h("button", { type: "button", class: "sw", id, role: "switch", "aria-checked": more[key] ? "true" : "false", "aria-label": label, "aria-describedby": id + "H",
        onclick: () => { more[key] = !more[key]; b.setAttribute("aria-checked", more[key] ? "true" : "false"); err.textContent = ""; calc(); } },
        h("span", { class: "t", "aria-hidden": "true" }));
      return b;
    };
    const hint = (id) => h("p", { class: "hint", id: id + "H", "aria-live": "polite" });
    const h52 = hint("sf52"), hFast = hint("sfFast"), hAvg = hint("sfAvg"), hNews = hint("sfNews");
    const fastPct = h("input", { class: "in", id: "sfFastPct", type: "text", inputmode: "decimal", autocomplete: "off", value: String(ex?.fast?.pct ?? 3), "aria-label": "Fast move percent" });
    const fastMin = sel("sfFastMin", "Fast move minutes", L.FAST_MINUTES.map((m) => [String(m), String(m)]), String(ex?.fast?.minutes ?? 15));
    const fastCfg = h("div", { class: "mini" }, fastPct, "% in", fastMin, "min");
    const opt = (name, hintEl, sw, extra) => h("div", { class: "opt" }, h("div", { class: "txt" }, h("div", { class: "nm", text: name }), hintEl, extra || null), sw);
    const moreSum = h("span", { class: "s" });
    const moreBox = h("details", { class: "more" },
      h("summary", {}, h("span", {}, h("span", { text: "More alerts " }), moreSum), h("span", { class: "chev", "aria-hidden": "true", text: "›" })),
      opt("52-week high / low", h52, mkSw("sf52", "range52", "52-week high and low alerts")),
      opt("Fast move", hFast, mkSw("sfFast", "fast", "Fast move alert"), fastCfg),
      opt("50 / 200-day average", hAvg, mkSw("sfAvg", "averages", "50 and 200-day average alerts")),
      opt("News headlines", hNews, mkSw("sfNews", "news", "News headlines")),
      h("p", { class: "hint auto", text: "Always on, no switch: a warning before a stock split, with an offer to adjust your LOW and HIGH." }));
    const pvLow = h("p", { class: "pv", id: "pvLow", "aria-live": "polite" });
    const pvHigh = h("p", { class: "pv", id: "pvHigh", "aria-live": "polite" });
    const pvVol = h("p", { class: "pv", id: "pvVol", "aria-live": "polite" });
    const pvNote = h("p", { class: "pv note", id: "pvNote", "aria-live": "polite" });
    const err = h("p", { class: "err", id: "sfErr", role: "alert" });
    const save = h("button", { type: "submit", class: "btn pri", text: v ? "Save" : "Add stock" });
    const cfP = h("p", { id: "cfP" });
    const yes = h("button", { type: "button", class: "btn pri", text: "Yes, save and alert", onclick: () => doSave(pending, true) });
    const no = h("button", { type: "button", class: "btn", text: "No, go back", onclick: () => { confirmBox.hidden = true; form.hidden = false; lowIn.focus(); } });
    const confirmBox = h("div", { class: "confirm", hidden: true, role: "alertdialog", "aria-labelledby": "cfT" }, h("h3", { id: "cfT", text: "This will alert immediately. Save?" }), cfP, h("div", { class: "dact" }, yes, no));
    let pending = null;
    const read = () => ({ editing: !!v, existing: ex, symbol: symIn.value, on, low: { mode: lowU.value, text: lowIn.value }, high: { mode: highU.value, text: highIn.value }, vol: { mode: volU.value, text: volIn.value }, range52: more.range52, fast: { on: more.fast, pct: fastPct.value, minutes: fastMin.value }, averages: more.averages, news: more.news, notes: noteIn.value, prev: v?.prev, last: v?.last, cum: v?.cumVolume });
    function calc() {
      const r = L.checkStockForm(read());
      const line = (el, res, none, ok) => { el.textContent = res.state === "ok" ? ok : res.state === "error" ? res.err : none; el.classList.toggle("bad", res.state === "error"); };
      line(pvLow, r.low, "No LOW alert", r.low.state === "ok" ? L.thresholdSentence("low", r.low, v?.prev) : "");
      line(pvHigh, r.high, "No HIGH alert", r.high.state === "ok" ? L.thresholdSentence("high", r.high, v?.prev) : "");
      line(pvVol, r.vol, "No volume alert", r.vol.state === "ok" ? L.volumeSentence(r.vol, v?.cumVolume) : "");
      const w = v?.w52;
      const m52 = L.range52Model(w);
      h52.textContent = m52 ? "Above $" + L.money(m52.high) + " or below $" + L.money(m52.low) : "Levels load from the official daily prices";
      hFast.textContent = more.fast ? "Alert when the price moves " + (fastPct.value || "?") + "% up or down within " + fastMin.value + " minutes" : "Sudden moves between your levels";
      fastCfg.hidden = !more.fast;
      hAvg.textContent = Number.isFinite(w?.ma50) || Number.isFinite(w?.ma200)
        ? "Crosses " + [Number.isFinite(w?.ma50) ? "$" + L.money(w.ma50) + " (50-day)" : "", Number.isFinite(w?.ma200) ? "$" + L.money(w.ma200) + " (200-day)" : ""].filter(Boolean).join(" or ")
        : "Levels load from the official daily prices";
      hNews.textContent = more.news ? "Silent message, at most one every 15 min" : "Headlines for this stock, information only";
      const on = L.moreOn({ range52: more.range52, fast: more.fast ? { pct: fastPct.value, minutes: fastMin.value } : null, averages: more.averages, news: more.news });
      moreSum.textContent = on.length ? "· " + on.map((t) => t.split(" ")[0]).join(" · ") : "· none on";
      pvNote.textContent = r.vol.state === "ok" && r.vol.mode === "multiple" && L.usualVolumeWaits(!!v, v?.baseline) ? L.USUAL_VOLUME_NOTE : "";
      return r;
    }
    const busy = (b) => { save.disabled = b; yes.disabled = b; save.textContent = b && !v ? "Checking the symbol ..." : v ? "Save" : "Add stock"; };
    async function doSave(r, confirmed) {
      busy(true); err.textContent = "";
      const body = confirmed ? { ...r.body, confirm: true } : r.body;
      try {
        const res = v ? await api("/api/stocks/" + encodeURIComponent(sym), { method: "PUT", body }) : await api("/api/stocks", { method: "POST", body });
        closeSheet();
        toast(v ? sym + " saved" + (res?.rearmed?.length ? ". Re-armed " + res.rearmed.join(", ") + "." : ".") : r.body.symbol + " added.");
        poll();
      } catch (e) {
        busy(false);
        if (e instanceof ApiError && e.code === "CONFIRM_REQUIRED" && !confirmed) { askConfirm(r); return; }
        if (e instanceof NetError) err.textContent = "No connection. Nothing was saved.";
        else if (e instanceof ApiError) { if (![401, 429, 503].includes(e.status)) err.textContent = e.message; }
        else throw e;
      }
    }
    function askConfirm(r) {
      pending = r;
      cfP.textContent = "The latest price is already beyond a level you set, so an alert goes to Telegram now.";
      form.hidden = true; confirmBox.hidden = false; yes.focus();
    }
    const form = h("form", { novalidate: true, onsubmit: (ev) => {
      ev.preventDefault();
      const r = calc();
      if (r.err) {
        err.textContent = r.err;
        if (r.field === "fast") moreBox.open = true;
        ({ symbol: symIn, low: lowIn, high: highIn, vol: volIn, fast: fastPct }[r.field] || symIn).focus();
        return;
      }
      if (v && !r.changed) { closeSheet(); toast("No changes to save."); return; }
      if (["low", "high"].some((k) => r[k].state === "ok" && r[k].crossed && r.body[k])) askConfirm(r); else doSave(r, false);
    } },
      h("div", { class: "field" }, h("label", { for: "sfSym", text: "Symbol" }), symIn),
      h("div", { class: "field" }, h("label", { for: "sfLow", text: "LOW alert (optional)" }), h("div", { class: "frow" }, lowIn, lowU), pvLow),
      h("div", { class: "field" }, h("label", { for: "sfHigh", text: "HIGH alert (optional)" }), h("div", { class: "frow" }, highIn, highU), pvHigh),
      h("div", { class: "field" }, h("label", { for: "sfVol", text: "Volume alert (optional)" }), h("div", { class: "frow" }, volIn, volU), pvVol, pvNote),
      moreBox,
      h("div", { class: "field" }, h("label", { for: "sfNote", text: "Note (optional)" }), noteIn),
      h("p", { class: "sm", text: "Set at least one of LOW, HIGH, Volume or More alerts. LOW must be below HIGH." + (v ? "" : " The symbol is checked with the data source.") }),
      err, h("div", { class: "dact" }, save, h("button", { type: "button", class: "btn", text: "Cancel", onclick: cancelSheet })));
    form.addEventListener("input", () => { err.textContent = ""; calc(); });
    form.addEventListener("change", () => calc());
    put(root, h("div", { class: "shead" }, sheetTitle(v ? "Edit " + sym : "Add a stock"), sw),
      full ? h("p", { class: "notice warn", text: "The watchlist is full (" + (d?.maxStocks ?? 30) + " stocks). Remove one first." }) : null, form, confirmBox);
    if (full) save.disabled = true;
    calc();
  });
}
/** Split warning: old -> new levels, one tap schedules the change for the split day (never automatic). */
function splitSheet(v) {
  const sp = v.split;
  if (!sp) return;
  const rows = L.splitRows(v.stock, sp);
  const planned = L.sameSplit(v.stock.splitPlan, sp);
  const today = sp.exDate <= (S.data?.date || "");
  openSheet(v.sym + ":split", (root) => {
    const err = h("p", { class: "err", role: "alert" });
    const send = (adjust) => sheetAct(() => api("/api/split", { method: "POST", body: { symbol: v.sym, exDate: sp.exDate, adjust } }),
      (r) => r.choice === "planned" ? v.sym + ": levels adjust on " + L.dayLabel(sp.exDate) : r.choice === "applied" ? v.sym + ": levels adjusted" : v.sym + ": levels left as they are", err, btns);
    const yes = h("button", { type: "button", class: "btn pri", text: today ? "Adjust now" : "Adjust on " + L.dayLabel(sp.exDate).replace(/^\w+ /, ""), disabled: planned, onclick: () => send(true) });
    const no = h("button", { type: "button", class: "btn", text: planned ? "Don't adjust" : "Leave as is", onclick: () => send(false) });
    const btns = [yes, no];
    put(root, sheetTitle("Adjust " + v.sym + " for the split"), h("p", { class: "sm", text: L.splitSentence(sp) }),
      h("table", { class: "tbl" }, h("tbody", {}, rows.map((r) => h("tr", {}, h("td", { text: r.label }), h("td", { class: "num", text: r.from }), h("td", { class: "ar", "aria-label": "becomes", text: "→" }), h("td", { class: "num", text: r.to }))))),
      h("p", { class: "sm dm", text: planned ? "Scheduled: applied before the open on " + L.dayLabel(sp.exDate) + "." : today ? "Applied at once. % levels need no change." : "Applied before the open on " + L.dayLabel(sp.exDate) + ", only after this tap. % levels need no change." }),
      err, h("div", { class: "dact" }, yes, no),
      h("div", { class: "dact" }, h("button", { type: "button", class: "btn", text: "Close", onclick: cancelSheet })));
  });
}
function muteSheet(v) {
  const opts = [[30, "30 minutes"], [60, "1 hour"], [240, "4 hours"], [1440, "1 day"]];
  openSheet(v.sym + ":mute", (root) => {
    const err = h("p", { class: "err", role: "alert" });
    const btns = opts.map(([m, t]) => h("button", { type: "button", class: "btn", text: t, onclick: () => sheetAct(() => api("/api/mute", { method: "POST", body: { symbol: v.sym, minutes: m } }), () => v.sym + " muted for " + t, err, btns) }));
    put(root, sheetTitle("Mute " + v.sym), h("p", { class: "sm", text: "No alerts or reminders for this stock until the time is up. Unmute any time." }),
      h("div", { class: "cact" }, btns), err,
      h("div", { class: "dact" }, h("button", { type: "button", class: "btn", text: "Cancel", onclick: cancelSheet })));
  });
}
function moreSheet() {
  openSheet("more", (root) => {
    const err = h("p", { class: "err", role: "alert" });
    const test = h("button", { type: "button", class: "btn", text: "Send test alert", onclick: () => sheetAct(() => api("/api/test", { method: "POST", body: {} }), () => "Test alert sent to Telegram.", err, [test]) });
    put(root, sheetTitle("More"),
      h("div", { class: "cact stackc" }, S.canDisableAll ? h("button", { type: "button", class: "btn", text: "Disable all alerts", onclick: disableAllSheet }) : null, test), err,
      h("div", { class: "dact" }, h("button", { type: "button", class: "btn", text: "Close", onclick: cancelSheet })));
  });
}
function disableAllSheet() {
  openSheet("more", (root) => {
    const err = h("p", { class: "err", role: "alert" });
    const yes = h("button", { type: "button", class: "btn pri", text: "Yes, disable all", onclick: () => sheetAct(() => api("/api/pause-all", { method: "POST", body: { paused: true } }), () => "All alerts are off.", err, [yes]) });
    put(root, sheetTitle("Disable all alerts?"),
      h("p", { text: "No alerts or reminders will be sent for any stock. You turn stocks back on one by one, with the Alerts switch on each card." }), err,
      h("div", { class: "dact" }, yes, h("button", { type: "button", class: "btn", text: "Cancel", onclick: cancelSheet })));
  });
}
function removeSheet(v) {
  openSheet(v.sym + ":remove", (root) => {
    const err = h("p", { class: "err", role: "alert" });
    const yes = h("button", { type: "button", class: "btn danger", text: "Yes, remove " + v.sym, onclick: () => sheetAct(() => api("/api/stocks/" + encodeURIComponent(v.sym), { method: "DELETE" }), () => v.sym + " removed", err, [yes]) });
    put(root, sheetTitle("Remove " + v.sym + "?"), h("p", { text: "This stops all alerts for " + v.sym + " and deletes its LOW, HIGH and volume settings. It cannot be undone, but you can add the stock again." }), err,
      h("div", { class: "dact" }, yes, h("button", { type: "button", class: "btn", text: "No, keep it", onclick: cancelSheet })));
  });
}
function ackAllSheet() {
  const n = activeRules().length;
  if (!n) return;
  openSheet("ackall", (root) => {
    const err = h("p", { class: "err", role: "alert" });
    const yes = h("button", { type: "button", class: "btn pri", text: "Yes, acknowledge all", onclick: () => sheetAct(() => api("/api/ack", { method: "POST", body: { all: true } }), (r) => "Acknowledged " + r.acknowledged + " alert" + (r.acknowledged === 1 ? "" : "s"), err, [yes]) });
    put(root, sheetTitle("Acknowledge all?"), h("p", { text: n + " unacknowledged alert" + (n === 1 ? "" : "s") + " will be acknowledged and stop repeating." }), err,
      h("div", { class: "dact" }, yes, h("button", { type: "button", class: "btn", text: "Cancel", onclick: cancelSheet })));
  });
}


/* ------------------------------------------------------------ ALERTS */
async function loadHistory() {
  try {
    const r = await api("/api/log?limit=200");
    S.hist = { rows: (r.log || []).filter((x) => ALERT_KINDS.has(x.kind)), error: "" };
  } catch (e) {
    if (e instanceof NetError) throw e;
    S.hist.error = e.message || "Could not load history.";
  }
}
function alertRow(r, v) {
  const R = L.ruleLabel(r.rule);
  const price = Number.isFinite(r.t0Value) ? " at " + L.money(r.t0Value) : "";
  const limit = Number.isFinite(r.thresholdAtT0) ? " (limit " + L.money(r.thresholdAtT0) + ")" : "";
  return h("li", { class: "row" + (L.isActiveRule(r) ? " crossed" : "") },
    h("div", { class: "b1" }, h("span", { class: "sym", text: r.symbol }), h("span", { class: "chip " + (L.isActiveRule(r) ? "st-CROSSED" : "st-ACK"), text: (L.isActiveRule(r) ? "⚠ " : "✔ ") + R + (L.isActiveRule(r) ? " UNACKNOWLEDGED" : " acknowledged")}),
      r.late ? h("span", { class: "chip warn", text: "LATE (found by gap scan)" }) : null),
    h("div", { class: "num", text: "Crossed" + price + limit + (Number.isFinite(r.t0Ms) ? " at " + L.both(r.t0Ms) : "") + (Number.isFinite(r.touchedAtMs) ? " (touched at " + L.hm(r.touchedAtMs, L.TZ_ET) + " ET)" : "") }),
    L.isActiveRule(r)
      ? h("div", { class: "sm", text: "Reminders sent: " + (r.remindersSent || 0) + (Number.isFinite(r.nextReminderMs) ? " · next " + L.both(r.nextReminderMs) : "") })
      : h("div", { class: "sm", text: Number.isFinite(r.ackMs) ? "Acknowledged " + L.both(r.ackMs) + (r.ackBy ? " by " + r.ackBy : "") : "" }),
    L.isActiveRule(r) ? h("div", { class: "cact" }, h("button", { type: "button", class: "btn pri", text: "Acknowledge " + R + " " + r.symbol, "data-fk": "al:" + r.symbol + r.rule, onclick: () => act(() => api("/api/ack", { method: "POST", body: { symbol: r.symbol, rule: r.rule, cycle: r.cycle } }), () => "Acknowledged " + r.symbol + " " + R) }),
      v && (R === "HIGH" || R === "LOW") ? h("button", { type: "button", class: "btn", text: "Ack + move…", onclick: () => ackMoveSheet(r.symbol, R.toLowerCase(), r) }) : null) : null);
}
function alertsTab(root) {
  const unack = h("section", { class: "panel" });
  const today = h("section", { class: "panel" });
  const hist = h("section", { class: "panel" });
  put(root, h("div", { class: "toolbar" }, h("button", { type: "button", class: "btn", text: "Acknowledge all", "data-fk": "ackall2", onclick: ackAllSheet })), unack, today, hist);
  return () => {
    const rules = S.data?.rules || [];
    const sig = JSON.stringify([rules, S.hist]);
    if (sig === S.alSig) return;
    S.alSig = sig;
    const vmBy = new Map(buildAll().map((v) => [v.sym, v]));
    const act_ = rules.filter(L.isActiveRule), ack_ = rules.filter((r) => r.state === "ACKNOWLEDGED"), close_ = rules.filter((r) => r.state === "UNACKNOWLEDGED_AT_CLOSE");
    fill(unack, h("h2", { text: "Unacknowledged (" + act_.length + ")" }), act_.length ? h("ul", { class: "rows" }, act_.map((r) => alertRow(r, vmBy.get(r.symbol)))) : h("p", { class: "empty", text: "✓ Nothing needs you right now." }));
    fill(today, h("h2", { text: "Today, already handled" }),
      close_.length ? h("ul", { class: "rows" }, close_.map((r) => h("li", { class: "row" }, h("div", { class: "b1" }, h("span", { class: "sym", text: r.symbol }), h("span", { class: "chip warn", text: "⏸ " + L.ruleLabel(r.rule) + " unacknowledged at close" }))))) : null,
      ack_.length ? h("ul", { class: "rows" }, ack_.map((r) => alertRow(r))) : (close_.length ? null : h("p", { class: "empty", text: "No alerts handled today yet." })));
    fill(hist, h("h2", { text: "History (latest first)" }), S.hist.error ? h("p", { class: "err", role: "alert", text: S.hist.error }) : null,
      S.hist.rows.length ? h("ul", { class: "rows" }, S.hist.rows.map(logRow)) : h("p", { class: "empty", text: "No alert history yet." }));
  };
}
function logRow(r) {
  return h("li", { class: "row log-row" },
    h("div", { class: "b1" }, h("span", { class: "chip" + (r.kind === "ERROR" ? " bad" : r.kind === "FIRST_ALERT" || r.kind === "LATE_ALERT" ? " bad solid" : ""), text: r.kind }), r.symbol ? h("span", { class: "sym", text: r.symbol }) : null, r.rule ? h("span", { class: "chip", text: L.ruleLabel(r.rule) }) : null),
    h("div", { class: "num sm", text: L.bothWithDate(r.tMs, true) }),
    h("div", { class: "d", text: L.detailText(r.detail) }));
}

/* ------------------------------------------------------------ BRIEFING */
function briefingTab(root) {
  const box = h("div", {});
  put(root, h("div", { class: "panel" }, h("h2", { text: "Opening briefing" }), h("p", { class: "sm", text: "Worked out on this page from the server's numbers. Sorted by the size of the opening gap. All volume is IEX volume." })), box);
  return () => {
    const rows = L.briefingRows(buildAll());
    const sig = JSON.stringify(rows, (k, x) => (k === "ageS" ? undefined : x));
    if (sig === S.brSig) return;
    S.brSig = sig;
    if (!rows.length) { box.replaceChildren(h("p", { class: "panel empty", text: "The briefing appears after the open, when the first price is in (about 09:31 ET)." })); return; }
    box.replaceChildren(h("div", { class: "panel" }, h("ul", { class: "rows" }, rows.map((v) => {
      const lines = [];
      lines.push("Previous Close " + L.money(v.prev) + " → Opening (IEX) " + L.money(v.open));
      const y = S.data?.market?.find((m) => m.symbol === v.sym)?.prev;
      if (y) lines.push("Yesterday high " + L.money(y.high) + ", low " + L.money(y.low) + ", volume " + L.compact(y.volume) + " (consolidated)");
      lines.push("LOW " + (v.loP !== undefined ? L.money(v.loP) + " (" + L.pctOf(v.loP, v.open, 1) + " vs open)" : "not set") + " · HIGH " + (v.hiP !== undefined ? L.money(v.hiP) + " (" + L.pctOf(v.hiP, v.open, 1) + " vs open)" : "not set"));
      lines.push("Volume alert: " + L.volumeText(v.vol) + " · average volume levels are not available from the server yet");
      return h("li", { class: "row" }, h("div", { class: "b1" }, h("span", { class: "sym", text: v.sym }), h("span", { class: "chip " + (v.gapPct >= 0 ? "ok" : "bad"), text: (v.gapPct >= 0 ? "▲ gap " : "▼ gap ") + L.signed(v.gapPct) + "%" }), statusChip(v)), lines.map((t) => h("div", { class: "num", text: t })));
    }))));
  };
}

/* ------------------------------------------------------------ SETTINGS */
const SET_FIELDS = [
  ["reminderIntervalMin", "Reminder every", "minutes", 1, 60, 1],
  ["autoClear", "Clear an alert by itself when the price is back inside", "bool"],
  ["rearmBufferPricePct", "Re-arm buffer, price", "%", 0, 20, 0.1],
  ["rearmBufferVolumePct", "Re-arm buffer, volume", "%", 0, 100, 1],
  ["volumeNoAlertFirstMin", "No volume alerts in the first", "minutes", 0, 60, 1],
  ["volumeMinAvgCum", "Smallest average volume worth alerting on", "shares", 0, 1e9, 1],
  ["volumeMinSessions", "Smallest history for volume alerts", "sessions", 0, 60, 1],
  ["baselineSessions", "Sessions in the volume average", "sessions", 10, 60, 1],
  ["nearPct", "Show NEAR when within", "% of the way to a threshold", 1, 100, 1],
  ["reminderTidyUp", "Tidy up older reminders in the chat", "bool"],
  ["spikeHoldPct", "Hold a price jump bigger than", "% until confirmed", 1, 100, 1],
];
function download(blob, name) {
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
function settingsTab(root) {
  const holder = h("div", {});
  put(root, holder);
  const build = (cfg, defaults) => {
    const inputs = {};
    const err = h("p", { class: "err", role: "alert" });
    const grid = h("div", { class: "setgrid" });
    for (const [key, label, unit, min, max, step] of SET_FIELDS) {
      if (unit === "bool") {
        const c = h("input", { type: "checkbox", id: "s-" + key, checked: !!cfg[key] });
        inputs[key] = () => c.checked;
        grid.append(h("label", { class: "check", for: "s-" + key }, c, label));
      } else {
        const i = h("input", { class: "in", id: "s-" + key, type: "number", inputmode: "decimal", min, max, step, value: cfg[key] });
        inputs[key] = () => (i.value === "" ? NaN : Number(i.value));
        grid.append(h("div", { class: "field" }, h("label", { for: "s-" + key, text: label + " (" + unit + ")" }), i, h("span", { class: "sm", text: "Allowed " + min + " to " + max + " · default " + defaults[key] })));
      }
    }
    const save = h("button", { type: "submit", class: "btn pri", text: "Save settings" });
    const form = h("form", { class: "panel", novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault(); err.textContent = "";
      const patch = {};
      for (const [key, , unit, min, max] of SET_FIELDS) {
        const v = inputs[key]();
        if (unit !== "bool" && (!Number.isFinite(v) || v < min || v > max)) { err.textContent = key + ": enter a number from " + min + " to " + max + "."; $("#s-" + key).focus(); return; }
        if (v !== cfg[key]) patch[key] = v;
      }
      if (!Object.keys(patch).length) { toast("Nothing changed."); return; }
      save.disabled = true;
      try { const r = await api("/api/settings", { method: "PUT", body: patch }); S.settings = r; toast("Settings saved."); holder.replaceChildren(...sections(r.settings, defaults)); }
      catch (e) { if (e instanceof ApiError) err.textContent = e.message; else if (e instanceof NetError) err.textContent = "No connection. Nothing was saved."; else throw e; }
      save.disabled = false;
    } }, h("h2", { text: "Alert settings" }), grid, err, h("div", { class: "dact" }, save));
    return form;
  };
  const sections = (cfg, defaults) => [build(cfg, defaults), healthPanel(), backupPanel(), displayPanel()];
  const load = async () => {
    holder.replaceChildren(h("p", { class: "empty", text: "Loading settings ..." }));
    try { const r = await api("/api/settings"); S.settings = r; holder.replaceChildren(...sections(r.settings, r.defaults)); }
    catch (e) { holder.replaceChildren(h("p", { class: "err", role: "alert", text: e.message || "Could not load settings." }), h("button", { class: "btn", type: "button", text: "Try again", onclick: load })); }
  };
  load();
  return null;
}
function healthPanel() {
  const d = S.data;
  const dl = h("dl", { class: "kv" });
  const row = (k, v) => dl.append(h("dt", { text: k }), h("dd", { text: v }));
  row("Version", String(d?.version ?? "?"));
  row("Trading date", String(d?.date ?? "?"));
  row("Server last poll", d?.lastPollMs ? L.both(d.lastPollMs, true) : "never");
  row("Holiday calendar valid until", String(d?.marketStatus?.calendarValidUntil ?? "unknown"));
  row("Stocks", (d?.stocks?.length ?? 0) + " of " + (d?.maxStocks ?? "?"));
  row("Unacknowledged", String(activeRules().length));
  for (const [k, v] of Object.entries(d?.counters || {})) row(k, String(v));
  return h("section", { class: "panel" }, h("h2", { text: "Health today" }), dl);
}
function backupPanel() {
  const file = h("input", { type: "file", accept: "application/json,.json", class: "sr", id: "importFile", tabindex: "-1", "aria-hidden": "true" });
  file.addEventListener("change", async () => {
    const f = file.files?.[0]; file.value = "";
    if (!f) return;
    if (f.size > 262144) { toast("That file is too big for a Market Monitor export.", true); return; }
    let j;
    try { j = JSON.parse(await f.text()); } catch { toast("That file is not valid JSON.", true); return; }
    if (!j || j.format !== "market-monitor-config" || j.version !== 1 || !Array.isArray(j.stocks)) { toast("That is not a Market Monitor export file.", true); return; }
    openSheet("import", (root) => put(root, sheetTitle("Replace the watchlist?"),
      h("p", { text: "The file holds " + j.stocks.length + " stock" + (j.stocks.length === 1 ? "" : "s") + " and the settings. Importing replaces your current watchlist, thresholds and settings." }),
      h("div", { class: "dact" },
        h("button", { type: "button", class: "btn danger", text: "Yes, replace everything", onclick: () => { closeSheet(); act(() => api("/api/import", { method: "POST", body: j }), (r) => "Imported " + r.stocks + " stocks."); } }),
        h("button", { type: "button", class: "btn", text: "Cancel", onclick: cancelSheet }))));
  });
  return h("section", { class: "panel" }, h("h2", { text: "Backup" }), h("p", { class: "sm", text: "Watchlist, thresholds and settings as a JSON file. The access code and other secrets are never in it." }),
    h("div", { class: "cact" },
      h("button", { type: "button", class: "btn", text: "Export as JSON", onclick: () => exportFile("/api/export", "market-monitor-config.json") }),
      h("button", { type: "button", class: "btn", text: "Import from file…", onclick: () => file.click() })), file);
}
async function exportFile(path, name) {
  try { const res = await api(path, { raw: true }); download(await res.blob(), name); toast("Saved " + name); }
  catch (e) { if (e instanceof NetError) toast("No connection.", true); else if (e instanceof ApiError && ![401, 429, 503].includes(e.status)) toast(e.message, true); }
}
function displayPanel() {
  const cur = store.get("mm.theme") || "auto";
  const sel = h("select", { class: "in", id: "theme", onchange: () => { store.set("mm.theme", sel.value); applyTheme(); } },
    h("option", { value: "auto", text: "Follow the phone" }), h("option", { value: "light", text: "Light" }), h("option", { value: "dark", text: "Dark" }));
  sel.value = cur;
  return h("section", { class: "panel" }, h("h2", { text: "This phone" }),
    h("div", { class: "field" }, h("label", { for: "theme", text: "Theme" }), sel),
    h("p", { class: "sm", text: "The access code is stored only on this phone. Forgetting it signs this phone out." }),
    h("div", { class: "cact" }, h("button", { type: "button", class: "btn danger", text: "Forget code on this phone", onclick: () => openSheet("", (root) => put(root, sheetTitle("Forget the access code?"), h("p", { text: "You will need to type the code again to open the dashboard." }),
      h("div", { class: "dact" }, h("button", { type: "button", class: "btn danger", text: "Yes, forget it", onclick: () => { closeSheet(); forgetCode(); } }), h("button", { type: "button", class: "btn", text: "Cancel", onclick: cancelSheet })))) })));
}
function applyTheme() {
  const t = store.get("mm.theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t); else document.documentElement.removeAttribute("data-theme");
}

/* ------------------------------------------------------------ LOG (FR-11.3, FR-11.4) */
function logTab(root) {
  const kind = h("select", { class: "in", "aria-label": "Filter by kind" }, h("option", { value: "", text: "All kinds" }), LOG_KINDS.map((k) => h("option", { value: k, text: k })));
  const sym = h("input", { class: "in", type: "text", "aria-label": "Filter by symbol", placeholder: "Symbol", autocapitalize: "characters", maxlength: "8" });
  const status = h("p", { class: "sm", role: "status" });
  const list = h("ul", { class: "rows" });
  const more = h("button", { type: "button", class: "btn", text: "Load older", onclick: () => load(true) });
  const q = (extra) => "/api/log?limit=100" + (kind.value ? "&kind=" + kind.value : "") + (sym.value.trim() ? "&symbol=" + encodeURIComponent(sym.value.trim().toUpperCase()) : "") + (extra || "");
  async function load(older) {
    const L_ = S.log;
    if (L_.loading) return;
    L_.loading = true; status.textContent = "Loading ...";
    try {
      const before = older && L_.rows.length ? "&before=" + L_.rows[L_.rows.length - 1].tMs : "";
      const r = await api(q(before));
      L_.rows = older ? L_.rows.concat(r.log || []) : r.log || [];
      L_.more = (r.log || []).length >= 100;
      status.textContent = L_.rows.length ? L_.rows.length + " entries" : "No log entries match.";
    } catch (e) { status.textContent = e instanceof NetError ? "No connection." : e.message || "Could not load the log."; }
    L_.loading = false;
    list.replaceChildren(...L_.rows.map(logRow)); more.hidden = !L_.more;
  }
  const exportLog = async (fmt) => {
    if (fmt === "csv") return exportFile(q("&format=csv").replace("limit=100", "limit=500"), "market-monitor-log.csv");
    try { const r = await api(q().replace("limit=100", "limit=500")); download(new Blob([JSON.stringify(r.log, null, 2)], { type: "application/json" }), "market-monitor-log.json"); toast("Saved market-monitor-log.json"); }
    catch (e) { if (e instanceof NetError) toast("No connection.", true); else if (e instanceof ApiError && ![401, 429, 503].includes(e.status)) toast(e.message, true); }
  };
  const wSym = h("input", { class: "in", id: "wSym", type: "text", "aria-label": "Symbol for the why lookup", placeholder: "Symbol", autocapitalize: "characters", maxlength: "8" });
  const wTime = h("input", { class: "in", id: "wTime", type: "time", "aria-label": "Time in New York (ET)", step: "60" });
  const wOut = h("div", { class: "preview", role: "status", "aria-live": "polite", hidden: true });
  const why = h("form", { novalidate: true, onsubmit: async (ev) => {
    ev.preventDefault();
    const s_ = wSym.value.trim().toUpperCase();
    if (!s_ || !/^\d{2}:\d{2}$/.test(wTime.value)) { wOut.hidden = false; wOut.textContent = "Enter a symbol and a time (HH:MM, New York time)."; return; }
    wOut.hidden = false; wOut.textContent = "Looking ...";
    try {
      const r = await api("/api/why?symbol=" + encodeURIComponent(s_) + "&t=" + wTime.value);
      fill(wOut, h("strong", { text: r.symbol + " at " + L.both(r.atMs) }), h("ul", {}, (r.lines || []).map((t) => h("li", { text: t }))));
    } catch (e) { wOut.textContent = e instanceof NetError ? "No connection." : e.message || "Could not look that up."; }
  } }, h("h3", { text: "Why? Ask about one stock and time (New York time)" }), h("div", { class: "filters" }, wSym, wTime, h("button", { type: "submit", class: "btn pri", text: "Why?" })), wOut);
  kind.addEventListener("change", () => load(false));
  sym.addEventListener("change", () => load(false));
  put(root, h("div", { class: "panel" }, h("h2", { text: "Why did (or didn't) I get an alert?" }), why,
    h("p", { class: "sm", text: "Every alert, reminder, acknowledgement, settings change, error and suppressed event, with the reason the server recorded. Times in New York and Muscat." }),
    h("div", { class: "filters" }, kind, sym, h("button", { type: "button", class: "btn", text: "Refresh", onclick: () => load(false) })),
    h("div", { class: "cact" }, h("button", { type: "button", class: "btn", text: "Export CSV", onclick: () => exportLog("csv") }), h("button", { type: "button", class: "btn", text: "Export JSON", onclick: () => exportLog("json") })),
    status), h("div", { class: "panel" }, list, more));
  more.hidden = true;
  load(false);
  return null;
}

const TABS = { watchlist: watchlistTab, alerts: alertsTab, briefing: briefingTab, settings: settingsTab, log: logTab };

/* ------------------------------------------------------------ start up */
applyTheme();
if (!(S.tab in TABS)) S.tab = "watchlist";
const tabBtns = [...document.querySelectorAll(".tab")];
for (const t of tabBtns) {
  t.addEventListener("click", () => setTab(t.dataset.tab));
  t.addEventListener("keydown", (e) => {
    const i = tabBtns.indexOf(t);
    const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? tabBtns.length - 1 : -1;
    if (n < 0) return;
    e.preventDefault();
    const b = tabBtns[(n + tabBtns.length) % tabBtns.length];
    b.focus(); setTab(b.dataset.tab);
  });
}
ensureScreen();
updateHeader();
if (S.code) poll();
if ("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => undefined));
