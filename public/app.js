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
const mqWide = window.matchMedia("(min-width: 62rem)");
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
  openMore: new Set(),
  wide: mqWide.matches,
  settings: null,
  log: { rows: [], more: false, loading: false, error: "", kind: "", symbol: "" },
  hist: { rows: [], error: "" },
  wlSig: "",
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
  const had = S.codeSaved;
  S.code = ""; S.codeSaved = false; store.del("mm.code");
  S.auth = "need"; S.data = null;
  S.gateMsg = had ? "The server did not accept the saved access code. Enter it again." : "That access code was not accepted.";
  stopPolling(); ensureScreen(); updateHeader();
}
function onLocked(secs, kind) {
  S.lockKind = kind; S.auth = "locked"; S.lockedUntil = Date.now() + secs * 1000; S.data = null;
  stopPolling(); ensureScreen(); updateHeader();
}
function onUnconfigured(msg) {
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
  return (d.stocks || []).map((s) => L.buildVM(s, byId.get(s.symbol), d.rules || [], d.settings, nowMs(), mc.open, { offline: S.conn === "offline", pausedAll: !!d.pausedAll }));
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
  S.shown = key; S.update = null; S.updaters = []; S.wlSig = ""; S.alSig = ""; S.brSig = "";
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
  MUTED: ["\u{1f507}", "MUTED"], PAUSED: ["⏸", "PAUSED"], NODATA: ["—", "NO DATA"], BUILDING: ["◌", "BUILDING"], NOBASELINE: ["◌", "NO BASELINE"],
};
function statusChip(v) {
  if (v.pausedAll && v.status === "CROSSED") { const f = document.createDocumentFragment(); f.append(statusChip({ ...v, pausedAll: false }), h("span", { class: "chip st-PAUSED", text: "\u23f8 PAUSED (ALL ALERTS)" })); return f; }
  const [i, t] = STATUS[v.status];
  let extra = "";
  if (v.status === "ACK" && v.ackMs) extra = " " + L.hm(v.ackMs, L.TZ_MU) + " Muscat";
  if (v.status === "PAUSED" && v.pausedAll) extra = " (ALL ALERTS)";
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
function thrBtn(v, which) {
  const t = v[which], p = which === "high" ? v.hiP : v.loP, R = which.toUpperCase();
  const fk = v.sym + ":" + which;
  if (!t) return h("button", { type: "button", class: "edit unset", "data-fk": fk, "aria-label": "Set " + R + " threshold for " + v.sym + ", not set", onclick: () => editThreshold(v.sym, which) }, h("span", { class: "ev", text: "Not set" }), h("span", { class: "pen", "aria-hidden": "true", text: "+" }));
  const pct = p === undefined ? "needs Prev Close" : L.pctOf(p, v.prev, 1);
  return h("button", { type: "button", class: "edit", "data-fk": fk, "aria-label": "Edit " + R + " threshold for " + v.sym + ", now " + (p === undefined ? L.signed(t.value) + " percent" : "$" + L.money(p) + ", " + pct + " from Previous Close"), onclick: () => editThreshold(v.sym, which) },
    h("span", { class: "ev", text: p === undefined ? L.signed(t.value) + "%" : "$" + L.money(p) }), h("span", { class: "ep", text: pct }), h("span", { class: "pen", "aria-hidden": "true", text: "✎" }));
}
function volBtn(v) {
  const fk = v.sym + ":vol";
  const label = v.vol ? L.volumeText(v.vol) : "Not set";
  return h("button", { type: "button", class: "edit" + (v.vol ? "" : " unset"), "data-fk": fk, "aria-label": (v.vol ? "Edit" : "Set") + " volume threshold for " + v.sym + ", now " + label, onclick: () => editVolume(v.sym) },
    h("span", { class: "ev", text: label }), h("span", { class: "pen", "aria-hidden": "true", text: v.vol ? "✎" : "+" }));
}
function volLine(v) {
  const bits = ["IEX volume " + L.compact(v.cumVolume)];
  if (Number.isFinite(v.volAvgMultiple)) bits.push(v.volAvgMultiple.toFixed(1) + "x the usual at this time");
  else bits.push("average not available");
  if (v.baseline?.status === "BUILDING") bits.push("baseline building");
  if (v.baseline?.status === "NO_BASELINE") bits.push("no baseline yet");
  if (Number.isFinite(v.baseline?.thresholdShares)) bits.push("= " + L.compact(v.baseline.thresholdShares) + " shares now");
  if (v.vol && v.vol.mode === "absolute" && Number.isFinite(v.cumVolume)) bits.push(Math.round((v.cumVolume / v.vol.value) * 100) + "% of threshold");
  return h("p", { class: "vol" }, bits.join(" · ") + " · alert at ", volBtn(v));
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
    h("p", { class: "gkey", "aria-hidden": "true", text: "P = Previous Close · O = Opening (IEX) · ▲ = Last" }));
}
function ackBtn(v, label) {
  return h("button", { type: "button", class: "btn pri", "data-fk": v.sym + ":ack", text: label || "Acknowledge " + v.sym, onclick: () => act(() => api("/api/ack", { method: "POST", body: { symbol: v.sym } }), (r) => "Acknowledged " + v.sym + " (" + r.acknowledged + " rule" + (r.acknowledged === 1 ? "" : "s") + ")") });
}
function moveBtn(v) {
  const r = v.active.find((x) => x.rule === "HIGH" || x.rule === "LOW");
  if (!r) return null;
  return h("button", { type: "button", class: "btn", "data-fk": v.sym + ":move", text: "Ack + move…", onclick: () => editThreshold(v.sym, r.rule.toLowerCase(), { move: r }) });
}
function moreBlock(v) {
  const open = S.openMore.has(v.sym);
  const d = h("details", { class: "more", ...(open ? { open: true } : {}) }, h("summary", { text: "More: mute, pause, remove", "data-fk": v.sym + ":more" }),
    h("div", { class: "cact" },
      h("button", { type: "button", class: "btn", text: v.muted ? "Unmute" : "Mute…", onclick: () => (v.muted ? act(() => api("/api/mute", { method: "POST", body: { symbol: v.sym, minutes: null } }), () => v.sym + " unmuted") : muteSheet(v)) }),
      h("button", { type: "button", class: "btn", text: v.stock.paused ? "Resume" : "Pause", onclick: () => act(() => api("/api/stocks/" + encodeURIComponent(v.sym), { method: "PUT", body: { paused: !v.stock.paused } }), () => v.sym + (v.stock.paused ? " resumed" : " paused")) }),
      h("button", { type: "button", class: "btn danger", text: "Remove…", onclick: () => removeSheet(v) })));
  d.addEventListener("toggle", () => { if (d.open) S.openMore.add(v.sym); else S.openMore.delete(v.sym); });
  return d;
}

/* ------------------------------------------------------------ WATCHLIST */
function cardEl(v) {
  const crossed = v.status === "CROSSED";
  return h("article", { class: "card st-" + v.status + " f-" + v.fresh, "aria-label": v.sym },
    h("div", { class: "ctop" }, h("h3", { text: v.sym }), statusChip(v)),
    h("div", {}, h("div", { class: "lastv" }, h("span", { class: "big num", text: Number.isFinite(v.last) ? "$" + L.money(v.last) : "—" }), changeEl(v)), h("div", { class: "lastt", text: lastTime(v) })),
    h("div", {}, ageChip(v)),
    h("dl", { class: "nums" },
      cell("Prev Close", Number.isFinite(v.prev) ? "$" + L.money(v.prev) : "n/a"), cell("Opening (IEX)", Number.isFinite(v.open) ? "$" + L.money(v.open) : "n/a"),
      cell("LOW", thrBtn(v, "low")), cell("HIGH", thrBtn(v, "high"))),
    h("div", { class: "blk" }, gaugeEl(v), distLine(v), volLine(v),
      Number.isFinite(v.dayHigh) ? h("p", { class: "sm", text: "Day high / low (IEX): $" + L.money(v.dayHigh) + " / $" + L.money(v.dayLow) }) : null,
      v.notes ? h("p", { class: "sm", text: "Note: " + v.notes }) : null),
    crossed ? h("div", { class: "cact" }, ackBtn(v), moveBtn(v)) : null,
    moreBlock(v));
}
function cell(label, val) { return h("div", { class: "cell" }, h("dt", { text: label }), h("dd", {}, val)); }
function tableEl(vms) {
  const th = (t) => h("th", { scope: "col", text: t });
  return h("div", { class: "tblwrap" }, h("table", { class: "tbl" },
    h("caption", { class: "sr", text: "Watchlist, sorted by what needs action first" }),
    h("thead", {}, h("tr", {}, ["Symbol", "Last recorded", "Prev Close", "Opening (IEX)", "LOW", "HIGH", "Range (P prev, O open, \u25b2 last)", "Status", "IEX volume", "Actions"].map(th))),
    h("tbody", {}, vms.map((v) => h("tr", { class: "st-" + v.status },
      h("th", { scope: "row", text: v.sym }),
      h("td", {}, h("div", { class: "big2", text: Number.isFinite(v.last) ? "$" + L.money(v.last) : "—" }), changeEl(v), h("div", { class: "lastt", text: lastTime(v) }), ageChip(v)),
      h("td", { text: Number.isFinite(v.prev) ? "$" + L.money(v.prev) : "n/a" }), h("td", { text: Number.isFinite(v.open) ? "$" + L.money(v.open) : "n/a" }),
      h("td", {}, thrBtn(v, "low")), h("td", {}, thrBtn(v, "high")),
      h("td", {}, gaugeEl(v), h("div", { class: "sm", text: v.nearest ? (v.nearest.dist < 0 ? v.nearest.which + " crossed" : v.nearest.which + " " + Math.abs(v.nearest.pct).toFixed(1) + "% away") : "" })),
      h("td", {}, statusChip(v)),
      h("td", {}, h("div", { text: L.compact(v.cumVolume) }), h("div", { class: "sm", text: Number.isFinite(v.volAvgMultiple) ? v.volAvgMultiple.toFixed(1) + "x usual" : "avg n/a" }), volBtn(v)),
      h("td", {}, v.status === "CROSSED" ? h("div", { class: "cact" }, ackBtn(v, "Acknowledge"), moveBtn(v)) : null, moreBlock(v)))))));
}
function watchlistTab(root) {
  const addBtn = h("button", { type: "button", class: "btn pri", text: "+ Add stock", "data-fk": "add", onclick: addSheet });
  const ackAll = h("button", { type: "button", class: "btn", "data-fk": "ackall", onclick: ackAllSheet });
  const pauseAll = h("button", { type: "button", class: "btn", "data-fk": "pauseall", onclick: pauseAllSheet });
  const test = h("button", { type: "button", class: "btn", text: "Send test alert", onclick: () => act(() => api("/api/test", { method: "POST", body: {} }), () => "Test alert sent to Telegram.") });
  const info = h("p", { class: "sm grow", id: "wlInfo" });
  const note = h("div", {});
  const list = h("div", { id: "wl" });
  put(root, h("div", { class: "toolbar" }, addBtn, ackAll, pauseAll, test, info), note, list);
  return () => {
    const vms = L.sortVMs(buildAll());
    const act_ = activeRules().length;
    pauseAll.textContent = S.data?.pausedAll ? "Resume all alerts" : "Pause all alerts";
    ackAll.textContent = "Acknowledge all (" + act_ + ")"; ackAll.disabled = act_ === 0;
    info.textContent = vms.length + " stock" + (vms.length === 1 ? "" : "s") + ", most urgent first";
    const mc = marketNow();
    const nk = (mc.open ? "" : "closed") + (S.data?.pausedAll ? "P" : "");
    if (note.dataset.k !== nk) { note.dataset.k = nk; fill(note, S.data?.pausedAll ? h("p", { class: "notice bad", role: "status", text: "⏸ ALL ALERTS PAUSED. No alerts or reminders are sent until you resume." }) : null, mc.open ? null : h("p", { class: "notice warn", text: "The market is closed. Prices below are from the last session and are not moving." })); }
    const sig = S.wide + JSON.stringify(vms, (k, x) => (k === "ageS" ? undefined : x));
    if (sig === S.wlSig) return;
    S.wlSig = sig;
    const fk = document.activeElement?.closest?.("#wl") ? document.activeElement.dataset.fk : null;
    S.updaters = [];
    list.replaceChildren(vms.length === 0
      ? h("div", { class: "panel empty" }, h("p", { text: "No stocks yet. Add one to start watching it." }))
      : S.wide ? tableEl(vms) : h("div", { class: "list" }, vms.map(cardEl)));
    if (fk) list.querySelector('[data-fk="' + CSS.escape(fk) + '"]')?.focus();
    for (const f of S.updaters) f();
  };
}
mqWide.addEventListener("change", () => { S.wide = mqWide.matches; S.wlSig = ""; refreshAll(); });

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

/* ------------------------------------------------------------ bottom sheet */
const sheet = $("#sheet");
let sheetReturn = null;
function openSheet(returnFk, build) {
  sheetReturn = returnFk;
  sheet.replaceChildren();
  build(sheet);
  if (!sheet.open) sheet.showModal();
}
function closeSheet() { if (sheet.open) sheet.close(); }
sheet.addEventListener("close", () => {
  sheet.replaceChildren();
  if (sheetReturn) { const el = document.querySelector('[data-fk="' + CSS.escape(sheetReturn) + '"]'); if (el) el.focus(); }
});
sheet.addEventListener("click", (e) => { if (e.target === sheet) closeSheet(); });
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

/* edit LOW / HIGH in place (FR-8.5, FR-2.4) */
function editThreshold(sym, which, opt = {}) {
  const v = getVM(sym);
  if (!v) return;
  const R = which.toUpperCase();
  const cur = v[which];
  const otherP = which === "high" ? v.loP : v.hiP;
  let mode = cur?.mode || "dollar", value = cur ? String(cur.value) : "", preset = null;
  if (opt.move) {
    const base = which === "high" ? v.hiP : v.loP;
    if (base !== undefined) { mode = "dollar"; value = (base * (which === "high" ? 1.01 : 0.99)).toFixed(2); preset = true; }
  }
  openSheet(sym + ":" + which, (root) => {
    const inp = h("input", { class: "in", id: "edVal", type: "text", inputmode: "decimal", autocomplete: "off", value, "aria-describedby": "edPrev edErr", autofocus: true });
    const prev = h("div", { class: "preview", id: "edPrev", "aria-live": "polite" });
    const err = h("p", { class: "err", id: "edErr", role: "alert" });
    const confirmBox = h("div", { class: "confirm", hidden: true, role: "alertdialog", "aria-labelledby": "cfT" },
      h("h3", { id: "cfT", text: "This will alert immediately. Save?" }), h("p", { id: "cfP" }));
    const unitSeg = seg("unit", [["dollar", "$ price"], ["percent", "% from Previous Close"]], mode, (m) => { mode = m; calc(); inp.focus(); });
    const lab = h("label", { for: "edVal", text: "New " + R });
    const save = h("button", { type: "submit", class: "btn pri", text: "Save" });
    const cancel = h("button", { type: "button", class: "btn", text: "Cancel", onclick: closeSheet });
    const remove = cur && !opt.move ? h("button", { type: "button", class: "btn danger", text: "Remove " + R, onclick: () => doSave(null, false) }) : null;
    const yes = h("button", { type: "button", class: "btn pri", text: "Yes, save and alert", onclick: () => doSave(last, true) });
    const no = h("button", { type: "button", class: "btn", text: "No, go back", onclick: () => { confirmBox.hidden = true; main.hidden = false; inp.focus(); } });
    confirmBox.append(h("div", { class: "dact" }, yes, no));
    let last = null;
    function calc() {
      const r = L.evalThreshold({ which, mode, text: inp.value, prev: v.prev, last: v.last, otherPrice: otherP });
      last = r.state === "ok" ? r : null;
      err.textContent = r.state === "error" ? r.err : "";
      prev.textContent = r.state === "ok" ? r.preview + (r.crossed ? ". The latest price is already beyond this level, so saving will alert at once." : "") : r.state === "empty" ? "Type a value to see what it means." : "";
    }
    inp.addEventListener("input", calc);
    async function doSave(r, confirmed) {
      [save, remove, yes].forEach((b) => b && (b.disabled = true));
      try {
        if (opt.move) {
          const vs = r.mode === "percent" ? r.value + "%" : String(r.value);
          const mv = await api("/api/ack-move", { method: "POST", body: { symbol: sym, rule: opt.move.rule, cycle: opt.move.cycle, value: vs } });
          closeSheet(); toast(R + " for " + sym + " acknowledged and moved" + (mv?.newThreshold ? " to " + (mv.newThreshold.mode === "percent" ? L.signed(mv.newThreshold.value) + "%" : "$" + L.money(mv.newThreshold.value)) : "") + "."); poll();
          return;
        }
        const body = { [which]: r ? { mode: r.mode, value: r.value } : null };
        if (confirmed) body.confirm = true;
        const res = await api("/api/stocks/" + encodeURIComponent(sym), { method: "PUT", body });
        closeSheet();
        toast(r ? R + " for " + sym + " saved: $" + L.money(r.price) + (res.rearmed?.length ? ". Re-armed " + res.rearmed.join(", ") + "." : ".") : R + " removed for " + sym + ".");
        poll();
      } catch (e) {
        [save, remove, yes].forEach((b) => b && (b.disabled = false));
        if (e instanceof ApiError && e.code === "CONFIRM_REQUIRED" && !opt.move) { showConfirm(); return; }
        if (e instanceof NetError) err.textContent = "No connection. Nothing was changed.";
        else if (e instanceof ApiError) err.textContent = e.message;
        else throw e;
      }
    }
    const main = h("div", {}, h("fieldset", { class: "field" }, h("legend", { text: "Enter it as" }), unitSeg),
      h("div", { class: "field" }, lab, inp, h("p", { class: "sm", text: "Dollars are a price per share. Percent is signed from Previous Close, so a LOW is usually negative." })), prev, err,
      h("div", { class: "dact" }, save, cancel, remove));
    function showConfirm() { document.getElementById("cfP").textContent = R + " $" + L.money(last?.price ?? NaN) + " is already crossed by the latest price. An alert goes to Telegram now."; main.hidden = true; confirmBox.hidden = false; yes.focus(); }
    const form = h("form", { novalidate: true, onsubmit: (ev) => {
      ev.preventDefault();
      calc();
      if (!last) { if (!err.textContent) err.textContent = "Type a value first."; inp.focus(); return; }
      if (last.crossed && !opt.move) showConfirm(); else doSave(last, false);
    } }, main, confirmBox);
    put(root, sheetTitle((opt.move ? "Acknowledge and move " : "Edit ") + R + " for " + sym),
      h("p", { class: "sm", text: "Now: " + (cur ? L.thresholdText(cur, v.prev) : "not set") + " · Previous Close " + (Number.isFinite(v.prev) ? L.money(v.prev) : "n/a") + " · Last " + (Number.isFinite(v.last) ? L.money(v.last) : "n/a") }),
      opt.move ? h("p", { class: "sm", text: "One step: the alert is acknowledged and the " + R + " moves 1% away. If the move is refused, the alert stays unacknowledged. Change the number if you want something else." }) : null, form);
    calc();
    inp.select();
  });
}
function editVolume(sym) {
  const v = getVM(sym);
  if (!v) return;
  let mode = v.vol?.mode || "multiple", last = null;
  openSheet(sym + ":vol", (root) => {
    const inp = h("input", { class: "in", id: "vVal", type: "text", inputmode: "decimal", autocomplete: "off", value: v.vol ? String(v.vol.value) : "", "aria-describedby": "vPrev vErr", autofocus: true });
    const prev = h("div", { class: "preview", id: "vPrev", "aria-live": "polite" });
    const err = h("p", { class: "err", id: "vErr", role: "alert" });
    const save = h("button", { type: "submit", class: "btn pri", text: "Save" });
    const remove = v.vol ? h("button", { type: "button", class: "btn danger", text: "Remove volume alert", onclick: () => doSave(null) }) : null;
    function calc() {
      const r = L.evalVolume({ mode, text: inp.value, cum: v.cumVolume });
      last = r.state === "ok" ? r : null;
      err.textContent = r.state === "error" ? r.err : "";
      prev.textContent = r.state === "ok" ? r.preview : "Type a value to see what it means.";
    }
    async function doSave(r) {
      save.disabled = true;
      try {
        await api("/api/stocks/" + encodeURIComponent(sym), { method: "PUT", body: { volume: r ? { mode: r.mode, value: r.value } : null } });
        closeSheet(); toast(r ? "Volume alert for " + sym + " saved." : "Volume alert removed for " + sym + "."); poll();
      } catch (e) {
        save.disabled = false;
        if (e instanceof NetError) err.textContent = "No connection. Nothing was changed.";
        else if (e instanceof ApiError) err.textContent = e.message;
        else throw e;
      }
    }
    inp.addEventListener("input", calc);
    const form = h("form", { novalidate: true, onsubmit: (ev) => { ev.preventDefault(); calc(); if (last) doSave(last); else inp.focus(); } },
      h("fieldset", { class: "field" }, h("legend", { text: "Alert when IEX volume reaches" }), seg("vunit", [["multiple", "x the usual at this time"], ["absolute", "a number of shares"]], mode, (m) => { mode = m; calc(); inp.focus(); })),
      h("div", { class: "field" }, h("label", { for: "vVal", text: "Value" }), inp), prev, err,
      h("div", { class: "dact" }, save, h("button", { type: "button", class: "btn", text: "Cancel", onclick: closeSheet }), remove));
    put(root, sheetTitle("Volume alert for " + sym), h("p", { class: "sm", text: "Volume is IEX volume only. Now: " + L.volumeText(v.vol) + " · so far " + L.compact(v.cumVolume) }), form);
    calc(); inp.select();
  });
}
function addSheet() {
  const d = S.data;
  openSheet("add", (root) => {
    const sym = h("input", { class: "in", id: "aSym", type: "text", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxlength: "8", autofocus: true, required: true });
    const lowIn = h("input", { class: "in", id: "aLow", type: "text", inputmode: "decimal", autocomplete: "off" });
    const highIn = h("input", { class: "in", id: "aHigh", type: "text", inputmode: "decimal", autocomplete: "off" });
    const lowU = h("select", { class: "in", id: "aLowU", "aria-label": "LOW unit" }, h("option", { value: "dollar", text: "$ price" }), h("option", { value: "percent", text: "% from Prev Close" }));
    const highU = h("select", { class: "in", id: "aHighU", "aria-label": "HIGH unit" }, h("option", { value: "dollar", text: "$ price" }), h("option", { value: "percent", text: "% from Prev Close" }));
    const err = h("p", { class: "err", role: "alert" });
    const save = h("button", { type: "submit", class: "btn pri", text: "Add stock" });
    const full = (d?.stocks?.length ?? 0) >= (d?.maxStocks ?? 30);
    const form = h("form", { novalidate: true, onsubmit: async (ev) => {
      ev.preventDefault(); err.textContent = "";
      const symbol = sym.value.trim().toUpperCase();
      if (!/^[A-Z0-9]{1,5}([.-][A-Z0-9])?$/.test(symbol)) { err.textContent = "Symbol: 1 to 5 letters or digits, for example NVDA or BRK.B."; sym.focus(); return; }
      const body = { symbol };
      for (const [which, i, u] of [["low", lowIn, lowU], ["high", highIn, highU]]) {
        if (!i.value.trim()) continue;
        const r = L.evalThreshold({ which, mode: u.value, text: i.value, prev: NaN, last: NaN });
        if (u.value === "percent") {
          const n = L.parseNum(i.value);
          if (!Number.isFinite(n) || n <= -100 || n > 1000) { err.textContent = which.toUpperCase() + ": percent must be a number above -100 and at most 1000."; i.focus(); return; }
          body[which] = { mode: "percent", value: n };
        } else if (r.state !== "ok") { err.textContent = which.toUpperCase() + ": " + (r.err || "type a number."); i.focus(); return; }
        else body[which] = { mode: "dollar", value: r.value };
      }
      save.disabled = true; save.textContent = "Checking the symbol ...";
      try {
        await api("/api/stocks", { method: "POST", body });
        closeSheet(); toast(symbol + " added."); poll();
      } catch (e) {
        save.disabled = false; save.textContent = "Add stock";
        if (e instanceof NetError) err.textContent = "No connection. Nothing was added.";
        else if (e instanceof ApiError) err.textContent = e.message;
        else throw e;
      }
    } },
      h("div", { class: "field" }, h("label", { for: "aSym", text: "Symbol" }), sym),
      h("div", { class: "field" }, h("label", { for: "aLow", text: "LOW alert (optional)" }), h("div", { class: "toolbar" }, h("div", { class: "grow" }, lowIn), lowU)),
      h("div", { class: "field" }, h("label", { for: "aHigh", text: "HIGH alert (optional)" }), h("div", { class: "toolbar" }, h("div", { class: "grow" }, highIn), highU)),
      h("p", { class: "sm", text: "LOW must be below HIGH. The symbol is checked with the data source. Volume alerts can be added on the stock afterwards." }),
      err, h("div", { class: "dact" }, save, h("button", { type: "button", class: "btn", text: "Cancel", onclick: closeSheet })));
    put(root, sheetTitle("Add a stock"), full ? h("p", { class: "notice warn", text: "The watchlist is full (" + (d?.maxStocks ?? 30) + " stocks). Remove one first." }) : null, form);
    if (full) save.disabled = true;
  });
}
function muteSheet(v) {
  const opts = [[30, "30 minutes"], [60, "1 hour"], [240, "4 hours"], [1440, "1 day"], [10080, "7 days"]];
  openSheet(v.sym + ":more", (root) => {
    put(root, sheetTitle("Mute " + v.sym), h("p", { class: "sm", text: "No alerts or reminders for this stock until the time is up. Unmute any time." }),
      h("div", { class: "cact" }, opts.map(([m, t]) => h("button", { type: "button", class: "btn", text: t, onclick: () => { closeSheet(); act(() => api("/api/mute", { method: "POST", body: { symbol: v.sym, minutes: m } }), () => v.sym + " muted for " + t); } }))),
      h("div", { class: "dact" }, h("button", { type: "button", class: "btn", text: "Cancel", onclick: closeSheet })));
  });
}
function pauseAllSheet() {
  const paused = !!S.data?.pausedAll;
  openSheet("pauseall", (root) => {
    put(root, sheetTitle(paused ? "Resume all alerts?" : "Pause all alerts?"),
      h("p", { text: paused ? "Alerts and reminders for every stock start again." : "No alerts or reminders will be sent for any stock until you resume. Use this only if you do not want to be disturbed." }),
      h("div", { class: "dact" },
        h("button", { type: "button", class: "btn pri", text: paused ? "Yes, resume all" : "Yes, pause all", onclick: () => { closeSheet(); act(() => api("/api/pause-all", { method: "POST", body: { paused: !paused } }), () => (paused ? "All alerts resumed." : "All alerts paused.")); } }),
        h("button", { type: "button", class: "btn", text: "Cancel", onclick: closeSheet })));
  });
}
function removeSheet(v) {
  openSheet(v.sym + ":more", (root) => {
    put(root, sheetTitle("Remove " + v.sym + "?"), h("p", { text: "This stops all alerts for " + v.sym + " and deletes its LOW, HIGH and volume settings. It cannot be undone, but you can add the stock again." }),
      h("div", { class: "dact" },
        h("button", { type: "button", class: "btn danger", text: "Yes, remove " + v.sym, onclick: () => { closeSheet(); act(() => api("/api/stocks/" + encodeURIComponent(v.sym), { method: "DELETE" }), () => v.sym + " removed"); } }),
        h("button", { type: "button", class: "btn", text: "No, keep it", onclick: closeSheet })));
  });
}
function ackAllSheet() {
  const n = activeRules().length;
  if (!n) return;
  openSheet("ackall", (root) => {
    put(root, sheetTitle("Acknowledge all?"), h("p", { text: n + " unacknowledged alert" + (n === 1 ? "" : "s") + " will be acknowledged and stop repeating." }),
      h("div", { class: "dact" },
        h("button", { type: "button", class: "btn pri", text: "Yes, acknowledge all", onclick: () => { closeSheet(); act(() => api("/api/ack", { method: "POST", body: { all: true } }), (r) => "Acknowledged " + r.acknowledged + " alert" + (r.acknowledged === 1 ? "" : "s")); } }),
        h("button", { type: "button", class: "btn", text: "Cancel", onclick: closeSheet })));
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
  const R = r.rule;
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
      v && (R === "HIGH" || R === "LOW") ? h("button", { type: "button", class: "btn", text: "Ack + move…", onclick: () => editThreshold(r.symbol, R.toLowerCase(), { move: r }) }) : null) : null);
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
      close_.length ? h("ul", { class: "rows" }, close_.map((r) => h("li", { class: "row" }, h("div", { class: "b1" }, h("span", { class: "sym", text: r.symbol }), h("span", { class: "chip warn", text: "⏸ " + r.rule + " unacknowledged at close" }))))) : null,
      ack_.length ? h("ul", { class: "rows" }, ack_.map((r) => alertRow(r))) : (close_.length ? null : h("p", { class: "empty", text: "No alerts handled today yet." })));
    fill(hist, h("h2", { text: "History (latest first)" }), S.hist.error ? h("p", { class: "err", role: "alert", text: S.hist.error }) : null,
      S.hist.rows.length ? h("ul", { class: "rows" }, S.hist.rows.map(logRow)) : h("p", { class: "empty", text: "No alert history yet." }));
  };
}
function logRow(r) {
  return h("li", { class: "row log-row" },
    h("div", { class: "b1" }, h("span", { class: "chip" + (r.kind === "ERROR" ? " bad" : r.kind === "FIRST_ALERT" || r.kind === "LATE_ALERT" ? " bad solid" : ""), text: r.kind }), r.symbol ? h("span", { class: "sym", text: r.symbol }) : null, r.rule ? h("span", { class: "chip", text: r.rule }) : null),
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
        h("button", { type: "button", class: "btn", text: "Cancel", onclick: closeSheet }))));
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
      h("div", { class: "dact" }, h("button", { type: "button", class: "btn danger", text: "Yes, forget it", onclick: () => { closeSheet(); forgetCode(); } }), h("button", { type: "button", class: "btn", text: "Cancel", onclick: closeSheet })))) })));
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
