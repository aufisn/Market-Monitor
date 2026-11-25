/**
 * Golden-text tests for the DG-3 layout (Alternative A "Glance Line"): sample values and expected
 * texts come from ux/alternatives.md. Also: the 38-character rule, HTML escaping, silent vs notifying.
 */
import { describe, expect, it } from "vitest";
import { decodeCallback } from "../../src/adapters/callbacks";
import { cleanDashboardUrl, glanceWidth, widest } from "../../src/adapters/glance-fmt";
import {
  renderHelp, renderSetConfirm, renderSetDone, renderStatus, renderTicker, renderToday, renderWatchlist, renderWhy,
} from "../../src/adapters/render-commands";
import {
  alertKeyboard, chooserKeyboard, moveBy, renderAckConfirm, renderBriefingDetails, renderDetails, renderGlance, renderGlanceAll, renderMovePrompt, renderSeen,
  type GlanceCtx,
} from "../../src/adapters/render-glance";
import type { Baseline, MarketState, OutboundEvent, RuleState, StockConfig } from "../../src/core/ports";
import { et } from "../core/memory";

const D = "2026-11-30"; // Mon 30 Nov 2026 (EST: Muscat = ET + 9 h)
const URL_ = "https://example.com/dashboard";
const ctxAt = (hhmm: string, extra: Partial<GlanceCtx> = {}): GlanceCtx => ({ nowMs: et(D, hhmm), dashboardUrl: URL_, ...extra });

const rs = (symbol: string, rule: RuleState["rule"], o: Partial<RuleState> = {}): RuleState => ({
  date: D, symbol, rule, state: "TRIGGERED", cycle: 1, remindersSent: 0, version: 1, ...o,
});
const mk = (symbol: string, o: Partial<MarketState> = {}): MarketState => ({ symbol, date: D, ...o });
const prev = (close: number, high: number, low: number, volume: number) => ({ symbol: "X", date: "2026-11-27", close, high, low, volume });

/** Baseline whose average cumulative volume is k * (bucket + 1) per 5-minute bucket. */
const linearBaseline = (symbol: string, k: number, avgFullDay = 1e6): Baseline => ({
  symbol, builtFor: D, barMinutes: 5, sessions: 20, avgFullDay, status: "OK", avgCum: Array.from({ length: 78 }, (_, i) => k * (i + 1)),
});

const lines = (r: { text: string }) => r.text.split("\n");
const rowsOf = (b: { text: string }[][] | undefined) => (b ?? []).map((row) => row.map((x) => x.text));

// ------------------------------------------------------------ more alerts (design step 7)
describe("more alerts: fast move, averages, market note", () => {
  const tsla = (o: Partial<MarketState> = {}) => mk("TSLA", { last: { t: 1, p: 236.4, s: 1 }, prev: prev(245.95, 250, 240, 1e6), ...o });
  it("FAST: move and window in the head, price and day change, market line only when attached", () => {
    const ev: OutboundEvent = { type: "FIRST_ALERT", threshold: 244.7, rule: rs("TSLA", "FAST", { t0Ms: et(D, "10:42"), t0Value: 236.4, thresholdAtT0: 244.7 }), market: tsla({ marketMovePct: -1.6 }) };
    const r = renderGlance(ev, ctxAt("10:42", { stocks: [{ symbol: "TSLA", enabled: true, fast: { pct: 3, minutes: 15 } }] }));
    expect(lines(r)).toEqual(["🚨 NEW ⚡ <b>TSLA FAST</b> ▼3.4% in 15 min", "236.40 · day ▼3.9%", "Market: SPY ▼1.6%", "10:42 ET / 19:42 Muscat"]);
    expect(rowsOf(r.buttons)[1]).toEqual(["ℹ️ Details"]);
    expect(renderGlance({ ...ev, market: tsla() }, ctxAt("10:42")).text).not.toContain("Market");
  });
  it("200D: crossing direction from the price at the crossing", () => {
    const ev: OutboundEvent = { type: "FIRST_ALERT", threshold: 236.1, rule: rs("TSLA", "MA200", { t0Ms: et(D, "10:44"), t0Value: 236.05, thresholdAtT0: 236.1 }), market: tsla() };
    const r = renderGlance(ev, ctxAt("10:44"));
    expect(lines(r)[0]).toBe("🚨 NEW 〰️ <b>TSLA 200D</b> 236.05");
    expect(r.text).toContain("Crossed below the 200-day avg 236.10");
    expect(widest(r.text)).toBeLessThanOrEqual(38);
  });
  it("reminders show a FAST move as a percent, not as a price", () => {
    const r = renderGlance({ type: "REMINDER", backInside: false, market: tsla(), rules: [rs("TSLA", "FAST", { t0Ms: et(D, "10:42"), t0Value: 236.4, thresholdAtT0: 244.7, remindersSent: 1, state: "REPEATING" })] }, ctxAt("10:52"));
    expect(r.text).toContain("TSLA FAST ▼3.4%");
  });
});

// ------------------------------------------------------------ first alerts
describe("A · first alerts", () => {
  it("52W HIGH (NVDA): own label and icon, old level shown, no Ack + move, callback round-trips", () => {
    const ev: OutboundEvent = {
      type: "FIRST_ALERT", threshold: 145,
      rule: rs("NVDA", "HIGH52", { t0Ms: et(D, "10:22"), t0Value: 145.6, thresholdAtT0: 145 }),
      market: mk("NVDA", { last: { t: 1, p: 145.6, s: 1 }, prev: prev(138.2, 139.4, 136.8, 6.1e6), w52: { date: D, sessions: 251, high: 145, highDate: "2026-03-12", low: 90, lowDate: "2026-06-01" } }),
    };
    const r = renderGlance(ev, ctxAt("10:22"));
    expect(lines(r)[0]).toBe("🚨 NEW 🏔 <b>NVDA 52W HIGH</b> 145.60");
    expect(r.text).toContain("Old 52W high 145.00 (Thu 12 Mar)");
    expect(widest(r.text)).toBeLessThanOrEqual(38);
    expect(rowsOf(r.buttons)).toEqual([["✅ Acknowledge"], ["ℹ️ Details"], ["🔕 Mute 1h", "📊 Dashboard"]]);
    expect(decodeCallback(r.buttons![0]![0]!.data!)).toEqual({ type: "ack", symbol: "NVDA", rule: "HIGH52", cycle: 1 });
  });

  it("HIGH (NVDA)", () => {
    const ev: OutboundEvent = {
      type: "FIRST_ALERT", threshold: 145,
      rule: rs("NVDA", "HIGH", { t0Ms: et(D, "10:22"), t0Value: 145.6, thresholdAtT0: 145 }),
      market: mk("NVDA", { last: { t: 1, p: 145.6, s: 1 }, prev: prev(138.2, 139.4, 136.8, 6.1e6), open: 141.05, cumVolume: 1_620_000 }),
    };
    const r = renderGlance(ev, ctxAt("10:22", { baselines: [linearBaseline("NVDA", 120_000)] }));
    expect(r.text).toBe("🚨 NEW 📈 <b>NVDA HIGH</b> 145.60\n+5.35% · IEX vol 1.3x\n10:22 ET / 19:22 Muscat");
    expect(r.silent).toBeUndefined(); // 🔔 notifies
    expect(rowsOf(r.buttons)).toEqual([["✅ Acknowledge"], ["ℹ️ Details", "↗ Ack + move"], ["🔕 Mute 1h", "📊 Dashboard"]]);
    expect(r.buttons![0]![0]!.data).toBe("a|NVDA|HIGH|1");
    expect(r.buttons![2]![1]!.url).toBe(URL_);
  });

  it("LOW (AMZN)", () => {
    const ev: OutboundEvent = {
      type: "FIRST_ALERT", threshold: 200,
      rule: rs("AMZN", "LOW", { t0Ms: et(D, "13:15"), t0Value: 199.85, thresholdAtT0: 200 }),
      market: mk("AMZN", { prev: prev(207.5, 209, 205.2, 1.7e6), cumVolume: 1_100_000 }),
    };
    const r = renderGlance(ev, ctxAt("13:15", { baselines: [linearBaseline("AMZN", 1_100_000 / 1.2 / 33.4)] }));
    expect(lines(r)[0]).toBe("🚨 NEW 📉 <b>AMZN LOW</b> 199.85");
    expect(lines(r)[1]).toMatch(/^-3\.69% · IEX vol \d\.\dx$/);
    expect(lines(r)[2]).toBe("13:15 ET / 22:15 Muscat");
  });

  it("VOLUME (JPM) has no Ack + move button (v1 assumption)", () => {
    const ev: OutboundEvent = {
      type: "FIRST_ALERT", threshold: 620_000,
      rule: rs("JPM", "VOLUME", { t0Ms: et(D, "10:42"), t0Value: 620_000, thresholdAtT0: 620_000 }),
      market: mk("JPM", { cumVolume: 620_000 }),
    };
    const r = renderGlance(ev, ctxAt("10:42", { baselines: [linearBaseline("JPM", 310_000 / 14.4)] }));
    expect(r.text).toBe("🚨 NEW 📊 <b>JPM VOLUME</b> 2.0x\nIEX volume 0.62M · avg 0.31M\n10:42 ET / 19:42 Muscat");
    expect(rowsOf(r.buttons)).toEqual([["✅ Acknowledge"], ["ℹ️ Details"], ["🔕 Mute 1h", "📊 Dashboard"]]);
  });

  it("omits the Dashboard button when no URL is configured", () => {
    const k = alertKeyboard({ symbol: "NVDA", rule: "HIGH", cycle: 1 }, {});
    expect(rowsOf(k)).toEqual([["✅ Acknowledge"], ["ℹ️ Details", "↗ Ack + move"], ["🔕 Mute 1h"]]);
  });
});

// ------------------------------------------------------------ reminders
describe("A · reminders", () => {
  const nvdaRem = (n: number, r: "HIGH" | "LOW" = "HIGH", thr = 145): RuleState =>
    rs("NVDA", r, { state: "REPEATING", remindersSent: n, t0Ms: et(D, "10:22"), thresholdAtT0: thr });
  const market = mk("NVDA", { last: { t: 1, p: 144.8, s: 1 }, prev: prev(138.2, 139.4, 136.8, 6.1e6) });

  it("Reminder 3, back inside the band", () => {
    const r = renderGlance({ type: "REMINDER", rules: [nvdaRem(3)], market, backInside: true }, ctxAt("10:52"));
    expect(r.text).toBe(
      "🔁 <b>REMINDER 3</b> · not a new alert\n📈 NVDA HIGH 145.00 · 30 min open\nNow 144.80 · +4.78%\nPrice now back inside your band\n10:52 ET / 19:52 Muscat",
    );
    expect(rowsOf(r.buttons)[0]).toEqual(["✅ Acknowledge"]);
    expect(r.silent).toBeUndefined();
  });

  it("does not claim 'back inside' when the price is still beyond the limit", () => {
    const r = renderGlance({ type: "REMINDER", rules: [nvdaRem(1)], market, backInside: false }, ctxAt("10:32"));
    expect(r.text).not.toContain("back inside");
  });

  it("combined reminder: one Ack per rule plus Ack all, oldest first (FR-4.13)", () => {
    const low = { ...nvdaRem(1, "LOW", 130), t0Ms: et(D, "10:12") };
    const r = renderGlance({ type: "REMINDER", rules: [nvdaRem(3), low], market, backInside: false }, ctxAt("10:52"));
    expect(r.text).toBe(
      "🔁 <b>REMINDERS</b> · not new alerts\n<b>NVDA</b> · Now 144.80 · +4.78%\n📉 LOW 130.00 · #1 · 40 min open\n📈 HIGH 145.00 · #3 · 30 min open\n10:52 ET / 19:52 Muscat",
    );
    expect(rowsOf(r.buttons)).toEqual([["✅ Ack LOW"], ["✅ Ack HIGH"], ["✅ Ack all NVDA"], ["ℹ️ Details", "🔕 Mute 1h"], ["📊 Dashboard"]]);
    expect(r.buttons![2]![0]!.data).toBe("k|NVDA|LOW:1,HIGH:1"); // exactly the rules listed in the message
  });
});

// ------------------------------------------------------------ late, ack, close
describe("A · LATE, acknowledged, unacknowledged at close", () => {
  it("LATE (XOM HIGH)", () => {
    const r = renderGlance(
      { type: "LATE_ALERT", threshold: 115, barTimeMs: et(D, "14:07"), barPrice: 115.2, market: mk("XOM"), rule: rs("XOM", "HIGH", { late: true, t0Ms: et(D, "14:11") }) },
      ctxAt("14:11"),
    );
    expect(r.text).toBe("⏱ <b>LATE</b> 📈 <b>XOM HIGH</b> 115.00\nTouched 14:07 ET · bar high 115.20\nFound 14:11 ET · runs were missed\n14:07 ET / 23:07 Muscat");
    expect(r.silent).toBeUndefined();
  });

  it("ACK_CONFIRM edit has no buttons", () => {
    const r = renderGlance({ type: "ACK_CONFIRM", rule: rs("NVDA", "HIGH", { state: "ACKNOWLEDGED", ackMs: et(D, "10:52") }) }, ctxAt("10:52"));
    expect(r.text).toBe("✅ <b>NVDA HIGH</b> acknowledged\nAcknowledged 10:52 ET / 19:52 Muscat\nNo more reminders for this alert.");
    expect(r.buttons).toBeUndefined();
  });

  it("ack + move text", () => {
    const r = renderAckConfirm(rs("NVDA", "HIGH", { state: "ACKNOWLEDGED", ackMs: et(D, "10:52") }), 0, { from: 145, to: 146.45 });
    expect(r.text).toBe("✅ <b>NVDA HIGH</b> acknowledged\nAcknowledged 10:52 ET / 19:52 Muscat\nHIGH moved 145.00 → 146.45 (+1%)\nRe-armed. Quiet until crossed again.");
    const low = renderAckConfirm(rs("AMZN", "LOW", { ackMs: et(D, "13:16") }), 0, { from: 200, to: 198 });
    expect(low.text).toContain("LOW moved 200.00 → 198.00 (-1%)");
  });

  it("UNACKNOWLEDGED AT CLOSE", () => {
    const r = renderGlance(
      {
        type: "UNACK_AT_CLOSE", date: D,
        rules: [rs("XOM", "HIGH", { late: true, t0Ms: et(D, "14:11") }), rs("AMZN", "LOW", { t0Ms: et(D, "13:15") })],
      },
      ctxAt("16:00"),
    );
    expect(r.text).toBe(
      "🔕 <b>UNACKNOWLEDGED AT CLOSE</b>\n2 alerts · no more reminders\n📉 AMZN LOW · since 13:15 ET\n📈 XOM HIGH · since 14:11 ET (late)\nClosed 16:00 ET / 01:00 Muscat\nThey re-arm fresh at the next open.",
    );
    expect(rowsOf(r.buttons)).toEqual([["✅ Mark all seen"], ["📊 Dashboard"]]);
    expect(renderSeen(Date.parse("2026-11-30T21:02:00Z")).text).toBe("🔕 <b>UNACKNOWLEDGED AT CLOSE</b>\nMarked as seen 01:02 Muscat\nNothing was sent after the close.");
  });
});

// ------------------------------------------------------------ READY, ENDED, ops, test
describe("A · session and health messages", () => {
  it("READY is silent", () => {
    const r = renderGlance(
      { type: "READY", date: D, info: { stocksActive: 8, baselinesDone: 8, baselinesTotal: 8, calendarDaysLeft: 400, noBaseline: [], missingPrevClose: [] } },
      ctxAt("09:00"),
    );
    expect(r.text).toBe("🟢 <b>READY</b> · Mon 30 Nov\n8 stocks active · Baselines 8/8\nCalendar OK\nOpen 09:30 ET / 18:30 Muscat\nClose 16:00 ET / 01:00 Muscat");
    expect(r.silent).toBe(true);
  });

  it("SESSION ENDED is silent", () => {
    const r = renderGlance({ type: "SESSION_ENDED", date: D, counts: { alerts: 4, lateAlerts: 1, reminders: 11, acks: 3, unacked: 2 } }, ctxAt("16:05"));
    expect(r.text).toBe("🏁 <b>SESSION ENDED</b> · Mon 30 Nov\nClosed 16:00 ET / 01:00 Muscat\nAlerts 5 (1 late) · reminders 11\nAcknowledged 3 · open at close 2");
    expect(r.silent).toBe(true);
  });

  it("data problem notice notifies", () => {
    const r = renderGlance({ type: "OPS_NOTICE", code: "DATA_ERROR", detail: "Market data request failed twice." }, ctxAt("11:41"));
    expect(r.text).toBe(
      "⚠️ <b>DATA PROBLEM</b> · provider error\nMarket data request failed twice.\nAlerts may be late, not lost.\nGap scan runs when data returns.\nSince 11:41 ET / 20:41 Muscat\nNext notice of this type: 30 min",
    );
    expect(r.silent).toBeUndefined();
    expect(rowsOf(r.buttons)).toEqual([["📊 Dashboard"]]);
  });

  it("TEST alert is labelled and notifies", () => {
    const r = renderGlance({ type: "TEST_ALERT" }, ctxAt("11:00"));
    expect(r.text).toContain("TEST ALERT");
    expect(r.silent).toBeUndefined();
    expect(r.buttons![0]![0]!.data).toBe("a|TEST|HIGH|0");
  });
});

// ------------------------------------------------------------ briefing
describe("A · opening briefing", () => {
  const stocks: MarketState[] = [
    mk("XOM", { open: 111.55, prev: prev(111.3, 112.4, 110.4, 1.0e6) }),
    mk("NVDA", { open: 141.05, prev: prev(138.2, 139.4, 136.8, 6.1e6) }),
    mk("AMZN", { open: 206.9, prev: prev(207.5, 209, 205.2, 1.7e6) }),
    mk("MSFT", { open: 418.6, prev: prev(421.8, 424.3, 419.1, 1.3e6) }),
    mk("AAPL", { open: 237.15, prev: prev(236.4, 238.1, 234.9, 1.9e6) }),
    mk("JPM", { open: 240.2, prev: prev(241.1, 243, 239.2, 0.8e6) }),
  ];
  const cfg = (symbol: string, low: number, high: number): StockConfig => ({ symbol, enabled: true, low: { mode: "dollar", value: low }, high: { mode: "dollar", value: high } });
  const configs = [cfg("NVDA", 130, 145), cfg("MSFT", 420, 435), cfg("JPM", 235, 250), cfg("AAPL", 230, 245), cfg("AMZN", 200, 215), cfg("XOM", 108, 115)];

  it("collapsed text: crossed-at-open first (FR-7.3), then by absolute gap", () => {
    const parts = renderGlanceAll({ type: "BRIEFING", date: D, stocks }, ctxAt("09:31", { stocks: configs }));
    expect(parts).toHaveLength(1);
    expect(parts[0]!.text).toBe(
      [
        "☀️ <b>OPENING BRIEFING</b>",
        "Mon 30 Nov · 09:31 ET / 18:31 Muscat",
        "Close 16:00 ET / 01:00 Muscat",
        "Crossed first, then by gap · IEX",
        "PC = Previous Close",
        "",
        "⚠️ <b>MSFT</b> -0.76% Open(IEX) 418.60",
        "PC 421.80 · yHigh 424.30",
        "<b>LOW 420.00 crossed at open</b>",
        "",
        "<b>NVDA</b> +2.06% Open(IEX) 141.05",
        "PC 138.20 · yHigh 139.40",
        "",
        "<b>JPM</b> -0.37% Open(IEX) 240.20",
        "PC 241.10 · yHigh 243.00",
        "",
        "<b>AAPL</b> +0.32% Open(IEX) 237.15",
        "PC 236.40 · yHigh 238.10",
        "",
        "<b>AMZN</b> -0.29% Open(IEX) 206.90",
        "PC 207.50 · yHigh 209.00",
        "",
        "<b>XOM</b> +0.22% Open(IEX) 111.55",
        "PC 111.30 · yHigh 112.40",
        "",
        "<i>Tap Details for volume levels.</i>",
      ].join("\n"),
    );
    expect(parts[0]!.silent).toBeUndefined(); // the briefing notifies
    expect(rowsOf(parts[0]!.buttons)).toEqual([["ℹ️ Details", "📊 Dashboard"]]);
  });

  it("expanded Details block for NVDA matches the mock-up and goes out silent", () => {
    // 2x of the average cumulative volume: 2.31M at 10:00, 4.08M at 11:00, 7.48M at 13:00
    const b = linearBaseline("NVDA", 1, 6.8e6);
    b.avgCum[5] = 1_155_000;
    b.avgCum[17] = 2_040_000;
    b.avgCum[41] = 3_740_000;
    const parts = renderBriefingDetails({ type: "BRIEFING", date: D, stocks }, ctxAt("09:31", { stocks: configs, baselines: [b] }));
    expect(parts.every((p) => p.silent)).toBe(true);
    const nvda = parts[0]!.text.split("\n\n").find((x) => x.includes("<b>NVDA</b>"))!;
    expect(nvda).toBe(
      [
        "<b>NVDA</b> +2.06% Open(IEX) 141.05",
        "PC 138.20 · yHigh 139.40 · yLow 136.80",
        "Yesterday IEX volume 6.10M",
        "LOW 130.00 (-7.8% vs open)",
        "HIGH 145.00 (+2.8% vs open)",
        "IEX avg/day 6.80M · 2x = 13.6M",
        "2x IEX by 10:00 2.31M · 11:00 4.08M",
        "2x IEX by 13:00 7.48M",
      ].join("\n"),
    );
    expect(parts[0]!.text).toContain("<b>LOW crossed at open - alert follows</b>");
  });

  it("splits a long briefing under 4096 characters", () => {
    const many = Array.from({ length: 30 }, (_, i) => mk(`S${i}`, { open: 100 + i, prev: prev(99, 101, 98, 1e6) }));
    const cfgs = many.map((m) => cfg(m.symbol, 80, 120));
    const bs = many.map((m) => linearBaseline(m.symbol, 50_000, 3e6));
    const exp = renderBriefingDetails({ type: "BRIEFING", date: D, stocks: many }, ctxAt("09:31", { stocks: cfgs, baselines: bs }));
    expect(exp.length).toBeGreaterThan(1);
    for (const p of exp) expect(p.text.length).toBeLessThanOrEqual(4096);
    const col = renderGlanceAll({ type: "BRIEFING", date: D, stocks: many }, ctxAt("09:31", { stocks: cfgs }));
    for (const p of col) expect(p.text.length).toBeLessThanOrEqual(4096);
    expect(col.slice(1).every((p) => p.silent)).toBe(true);
  });
});

// ------------------------------------------------------------ ack + move maths, chooser
describe("Ack + move", () => {
  it("moves HIGH up and LOW down by a percent of the threshold's own value", () => {
    expect(moveBy("HIGH", 145, 1)).toBe(146.45);
    expect(moveBy("HIGH", 145, 2)).toBe(147.9);
    expect(moveBy("LOW", 200, 1)).toBe(198);
    expect(moveBy("LOW", 200, 2)).toBe(196);
  });
  it("chooser labels and callbacks", () => {
    const k = chooserKeyboard("NVDA", "HIGH", 145, 2);
    expect(rowsOf(k)).toEqual([["+1% → 146.45", "+2% → 147.90"], ["⌨ Type a value"], ["← Cancel"]]);
    expect(decodeCallback(k[0]![0]!.data)).toEqual({ type: "ackmove", symbol: "NVDA", rule: "HIGH", pct: 1, cycle: 2 });
    expect(rowsOf(chooserKeyboard("AMZN", "LOW", 200, 1))[0]).toEqual(["-1% → 198.00", "-2% → 196.00"]);
  });
  it("sub-$1 prices keep 4 decimals and a move never rounds to no change", () => {
    expect(moveBy("HIGH", 0.5, 1)).toBe(0.505);
    expect(moveBy("LOW", 0.5, 2)).toBe(0.49);
    expect(moveBy("HIGH", 0.4567, 1)).toBe(0.4613);
    expect(moveBy("HIGH", 0.0123, 1)).toBe(0.0124); // 1% of 0.0123 is below the 4-decimal step
    expect(moveBy("LOW", 0.0123, 1)).toBe(0.0122);
    expect(moveBy("HIGH", 10, 0.01)).toBe(10.01); // 2 decimals from $1 up; the smallest step still moves
    expect(moveBy("LOW", 1, 0.001)).toBe(0.99);
    expect(rowsOf(chooserKeyboard("PENNY", "HIGH", 0.4567, 1))[0]).toEqual(["+1% → 0.4613", "+2% → 0.4658"]);
    const ev: OutboundEvent = {
      type: "FIRST_ALERT", threshold: 0.45,
      rule: rs("PENNY", "HIGH", { t0Ms: et(D, "10:22"), t0Value: 0.4567, thresholdAtT0: 0.45 }),
      market: mk("PENNY", { prev: prev(0.4, 0.41, 0.39, 1e6) }),
    };
    expect(lines(renderGlance(ev, ctxAt("10:22")))[0]).toBe("🚨 NEW 📈 <b>PENNY HIGH</b> 0.4567");
    const d = renderDetails({ rule: rs("PENNY", "HIGH"), market: mk("PENNY", { last: { t: 1, p: 0.4567, s: 1 }, prev: prev(0.4, 0.41, 0.39, 1e6) }), high: 0.45, low: 0.3, nowMs: 0 });
    expect(d.text).toContain("Last 0.4567 · +0.0567 (+14.17%)");
    expect(d.text).toContain("HIGH 0.4500 · LOW 0.3000");
  });
  it("typed-value prompt is a ForceReply", () => {
    const p = renderMovePrompt("NVDA", "HIGH", 144.8);
    expect(p.text).toBe("⌨ Reply with the new NVDA HIGH:\na price (148.00) or a percent (+3%)\nMust be above last 144.80.");
    expect(p.forceReply).toBeTruthy();
  });
});

// ------------------------------------------------------------ details
describe("Details card (FR-5.5)", () => {
  it("is grouped Price / Levels / Volume / Time and silent", () => {
    const now = et(D, "10:52");
    const r = renderDetails({
      rule: rs("NVDA", "HIGH", { t0Ms: et(D, "10:22"), t0Value: 145.6, thresholdAtT0: 145, remindersSent: 3, state: "REPEATING" }),
      market: mk("NVDA", { last: { t: 1, p: 144.8, s: 1 }, prev: prev(138.2, 139.4, 136.8, 6.1e6), open: 141.05, cumVolume: 2_400_000, lastPollMs: now - 30_000 }),
      high: 145, low: 130, volume: { cum: 2_400_000, multiple: 1.3 }, nowMs: now, replyTo: 77,
    });
    expect(r.silent).toBe(true);
    expect(r.replyTo).toBe(77);
    const t = r.text;
    expect(t.indexOf("<b>Price</b>")).toBeLessThan(t.indexOf("<b>Levels</b>"));
    expect(t.indexOf("<b>Levels</b>")).toBeLessThan(t.indexOf("<b>Volume</b>"));
    expect(t.indexOf("<b>Volume</b>")).toBeLessThan(t.indexOf("<b>Time</b>"));
    for (const need of ["Last 144.80 · +6.60 (+4.78%)", "Prev Close 138.20", "Opening (IEX) 141.05", "HIGH 145.00 · LOW 130.00", "IEX volume 2.40M · 1.3x avg", "Crossed 10:22 ET / 19:22 Muscat", "Unacknowledged 30 min · alert #1", "Reminder 3 sent"]) {
      expect(t).toContain(need);
    }
    expect(t).not.toContain("Data "); // fresh data: no age line
    const old = renderDetails({ rule: rs("NVDA", "HIGH"), market: mk("NVDA", { lastPollMs: 1000 }), nowMs: 75_000, high: 1, low: 0.5 });
    expect(old.text).toContain("Data 74 s old");
  });
});

// ------------------------------------------------------------ widths, escaping, silence
const HOSTILE = '<img src=x onerror=alert(1)>&"';
const big = (symbol: string): MarketState =>
  mk(symbol, { last: { t: 1, p: 12345.67, s: 1 }, open: 12000.5, prev: prev(11000.25, 12500.9, 10900.1, 123_456_789), cumVolume: 987_654_321, lastPollMs: 1 });

function allRendered(sym = "GOOGL", note = "a very long note that must wrap at the limit and never exceed it"): { name: string; text: string }[] {
  const ctx = ctxAt("10:22", {
    stocks: [{ symbol: sym, enabled: true, low: { mode: "dollar", value: 10000 }, high: { mode: "dollar", value: 12000.5 }, volume: { mode: "multiple", value: 2.5 } }],
    baselines: [linearBaseline(sym, 50_000, 9e8)],
  });
  const rule = (r: "HIGH" | "LOW" | "VOLUME") =>
    rs(sym, r, { t0Ms: et(D, "10:22"), t0Value: r === "VOLUME" ? 987_654_321 : 12345.67, thresholdAtT0: 12000.5, late: true, remindersSent: 12, ackMs: et(D, "10:30"), touchedAtMs: et(D, "10:20") });
  const out: { name: string; text: string }[] = [];
  const evs: OutboundEvent[] = [
    { type: "FIRST_ALERT", rule: rule("HIGH"), market: big(sym), threshold: 12000.5 },
    { type: "FIRST_ALERT", rule: rule("LOW"), market: big(sym), threshold: 10000 },
    { type: "FIRST_ALERT", rule: rule("VOLUME"), market: big(sym), threshold: 9e8 },
    { type: "REMINDER", rules: [rule("HIGH")], market: big(sym), backInside: true },
    { type: "REMINDER", rules: [rule("HIGH"), rule("LOW"), rule("VOLUME")], market: big(sym), backInside: true },
    { type: "LATE_ALERT", rule: rule("HIGH"), market: big(sym), threshold: 12000.5, barTimeMs: et(D, "10:20"), barPrice: 12345.67 },
    { type: "LATE_ALERT", rule: rule("VOLUME"), market: big(sym), threshold: 9e8, barTimeMs: et(D, "10:20"), barPrice: 1 },
    { type: "ACK_CONFIRM", rule: rule("HIGH") },
    { type: "BRIEFING", date: D, stocks: [big(sym), mk("NOPREV", { open: 1 }), mk("NOOPEN")] },
    { type: "UNACK_AT_CLOSE", date: D, rules: [rule("HIGH"), rule("LOW"), rule("VOLUME")] },
    { type: "READY", date: D, info: { stocksActive: 30, baselinesDone: 29, baselinesTotal: 30, calendarDaysLeft: 5, noBaseline: ["AAAAA", "BBBBB", "CCCCC", "DDDDD", "EEEEE", "FFFFF", "GGGGG"], missingPrevClose: ["ZZZZ"] } },
    { type: "SESSION_ENDED", date: D, counts: { alerts: 123, lateAlerts: 45, reminders: 6789, acks: 100, unacked: 12 } },
    { type: "OPS_NOTICE", code: "SOMETHING_NEW_AND_VERY_LONG_CODE_NAME", detail: note + " " + "x".repeat(80) },
    { type: "OPS_NOTICE", code: "MISSING_SECRETS", detail: "Alerting is stopped. Missing settings: ALPACA_KEY_ID, ALPACA_SECRET_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID" },
    { type: "TEST_ALERT" },
  ];
  evs.forEach((ev, i) => renderGlanceAll(ev, ctx).forEach((r, j) => out.push({ name: `${ev.type}#${i}.${j}`, text: r.text })));
  const lastMs = et(D, "10:22");
  out.push({
    name: "details",
    text: renderDetails({ rule: rule("HIGH"), market: big(sym), high: 12000.5, low: 10000, volume: { cum: 987_654_321, multiple: 12.3 }, nowMs: lastMs + 3_600_000 }).text,
  });
  for (const part of renderBriefingDetails({ type: "BRIEFING", date: D, stocks: [big(sym)] }, ctx)) out.push({ name: "briefing-details", text: part.text });
  out.push({ name: "seen", text: renderSeen(lastMs).text });
  out.push({ name: "prompt", text: renderMovePrompt(sym, "HIGH", 12345.67).text });
  out.push({ name: "help", text: renderHelp().text });
  out.push({
    name: "status",
    text: renderStatus({ version: "0.1.0", nowMs: lastMs, marketOpen: false, nextOpenMs: lastMs + 86_400_000, lastPollAgeSec: 4000, unack: 3, nextReminderMs: lastMs, baselinesDone: 12, baselinesTotal: 30, calendar: "expiring", sentToday: 120, failedToday: 3, pausedAll: true }).text,
  });
  out.push({ name: "watchlist", text: renderWatchlist([{ symbol: sym, last: 12345.67, high: 12000.5, low: 10000, alert: true, muted: true, paused: true, enabled: false }]).text });
  out.push({
    name: "ticker",
    text: renderTicker({ symbol: sym, nowMs: lastMs, last: 12345.67, prevClose: 11000.25, open: 12000.5, high: 12000.5, low: 10000, volumeText: "2.5x average", cumVolume: 987_654_321, multiple: 12.3, rules: [{ rule: "HIGH", state: "unacknowledged at close", since: lastMs }], mutedUntilMs: lastMs + 1e6, paused: true, enabled: true, notes: note + " " + "y".repeat(90) }).text,
  });
  out.push({ name: "today", text: renderToday({ date: D, counts: { alerts: 1, reminders: 2 }, events: [{ tMs: lastMs, text: `${sym} HIGH late alert ` + "z".repeat(60) }] }).text });
  out.push({ name: "why", text: renderWhy({ symbol: sym, atMs: lastMs, lines: ["No alert or reminder was logged within 3 min of that time.", note] }).text });
  out.push({ name: "setdone", text: renderSetDone({ symbol: sym, label: "HIGH", setText: "12345.67", fromPrevClose: { pct: "+12.2%", prevClose: 11000.25 }, was: "12000.50", last: 12345.67, rearmed: true, added: true }).text });
  out.push({ name: "setconfirm", text: renderSetConfirm(sym, "HIGH", 12000.5, 12345.67, "high").text });
  return out;
}

describe("38-character rule and HTML safety", () => {
  it("no rendered line is wider than 38 (emoji count 2), including awkward big values and long text", () => {
    const bad: string[] = [];
    for (const m of allRendered()) for (const l of m.text.split("\n")) if (glanceWidth(l) > 38) bad.push(`${m.name}: ${glanceWidth(l)} ${l}`);
    expect(bad).toEqual([]);
  });

  it("the golden mock-up samples are within the limit too", () => {
    expect(widest("🚨 NEW 📈 <b>NVDA HIGH</b> 145.60\n+5.35% · IEX vol 1.3x\n10:22 ET / 19:22 Muscat")).toBeLessThanOrEqual(38);
    expect(glanceWidth("PC 138.20 · yHigh 139.40 · yLow 136.80")).toBe(38);
  });

  function assertSafe(name: string, text: string): void {
    const stripped = text.replace(/<\/?(b|i)>/g, "");
    expect(stripped, name).not.toMatch(/[<>]/);
    expect(stripped.replace(/&(amp|lt|gt);/g, ""), name).not.toContain("&");
    expect(text.length, name).toBeLessThanOrEqual(4096);
  }

  it("hostile symbols, notes and notice text are escaped everywhere", () => {
    const rendered = allRendered(HOSTILE, HOSTILE);
    for (const m of rendered) assertSafe(m.name, m.text);
    const all = rendered.map((m) => m.text).join("\n");
    expect(all).toContain("&lt;img src=x onerror=alert(1)&gt;&amp;");
    expect(all).not.toContain("<img");
  });

  it("only the mock-up's 🔕 messages are silent: READY, SESSION ENDED, Details", () => {
    const ctx = ctxAt("10:00");
    const silentOf = (ev: OutboundEvent) => renderGlance(ev, ctx).silent === true;
    expect(silentOf({ type: "READY", date: D, info: {} })).toBe(true);
    expect(silentOf({ type: "SESSION_ENDED", date: D, counts: {} })).toBe(true);
    expect(silentOf({ type: "OPS_NOTICE", code: "DATA_ERROR", detail: "x" })).toBe(false);
    expect(silentOf({ type: "TEST_ALERT" })).toBe(false);
    expect(silentOf({ type: "UNACK_AT_CLOSE", date: D, rules: [rs("A", "HIGH")] })).toBe(false);
    expect(silentOf({ type: "BRIEFING", date: D, stocks: [mk("A", { open: 1 })] })).toBe(false);
    expect(renderDetails({ rule: rs("A", "HIGH"), market: mk("A"), nowMs: 0 }).silent).toBe(true);
  });

  it("dashboard URL must be a plain https address", () => {
    expect(cleanDashboardUrl("https://mm.example.workers.dev")).toBe("https://mm.example.workers.dev");
    for (const bad of ["", "http://x.example", "javascript:alert(1)", "https://u:p@x.example", "https://x.example/?code=abc", "https://x.example/a b", undefined, 5]) {
      expect(cleanDashboardUrl(bad)).toBeUndefined();
    }
  });
});
