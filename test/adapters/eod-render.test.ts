/** End-of-day summary text (ux/eod-mockup.html): layout, 38-character rule, alert lines, fallback marks, split. */
import { describe, expect, it } from "vitest";
import { widest } from "../../src/adapters/glance-fmt";
import { renderGlanceAll } from "../../src/adapters/render-glance";
import type { EodAlert, EodStock, OutboundEvent } from "../../src/core/ports";
import { et } from "../core/memory";

const D = "2026-11-25"; // Wed 25 Nov 2026
const ctx = { nowMs: et(D, "16:20") };
const counts = { alerts: 3, reminders: 5, acks: 3, unacked: 0 };
const A = (rule: EodAlert["rule"], hhmm: string, acked: boolean, o: Partial<EodAlert> = {}): EodAlert => ({ rule, tMs: et(D, hhmm), count: 1, acked, ...o });
const stock = (symbol: string, o: Partial<EodStock> = {}): EodStock => ({ symbol, alertsOff: false, source: "SIP", alerts: [], ...o });
const ev = (stocks: EodStock[]): OutboundEvent => ({ type: "SESSION_ENDED", date: D, counts, eod: { stocks } });
const render = (stocks: EodStock[]) => renderGlanceAll(ev(stocks), ctx);

const TSLA = stock("TSLA", { close: 241.8, prevClose: 251.6, open: 249.1, low: 240.95, high: 250.4, volume: 142_600_000, avgVolume: 142_600_000 / 1.6, alerts: [A("LOW", "10:42", true)] });
const NVDA = stock("NVDA", { close: 140.85, prevClose: 135.4, open: 136.1, low: 135.9, high: 141.3, volume: 318_400_000, avgVolume: 318_400_000 / 1.3, alerts: [A("HIGH", "15:21", true), A("VOLUME", "11:05", true, { multiple: 2.5 })] });
const AMZN = stock("AMZN", { alertsOff: true, close: 201.05, prevClose: 201.85, open: 202.3, low: 200.7, high: 203.1, volume: 38_900_000, avgVolume: 38_900_000 / 0.8 });

describe("end-of-day summary layout", () => {
  it("matches the mock-up: header, counts, blocks, footer, one silent message", () => {
    const [r, ...more] = render([TSLA, NVDA, AMZN]);
    expect(more).toHaveLength(0);
    expect(r!.silent).toBe(true);
    expect(r!.text).toBe(
      [
        "🏁 <b>SESSION ENDED</b> · Wed 25 Nov",
        "Closed 16:00 ET / 01:00 Muscat",
        "Alerts 3 · reminders 5",
        "Acknowledged 3 · open at close 0",
        "",
        "<b>TSLA</b> Close 241.80 ▼3.9%",
        "Prev Close 251.60 · Open 249.10",
        "Low 240.95 · High 250.40",
        "Volume 142.6M · 1.6x usual",
        "🔔 LOW 10:42 ET · acknowledged",
        "",
        "<b>NVDA</b> Close 140.85 ▲4.0%",
        "Prev Close 135.40 · Open 136.10",
        "Low 135.90 · High 141.30",
        "Volume 318.4M · 1.3x usual",
        "🔔 HIGH 15:21 ET · acknowledged",
        "🔔 Volume 2.5x 11:05 ET · ack'd",
        "",
        "<b>AMZN</b> Close 201.05 ▼0.4%  (alerts off)",
        "Prev Close 201.85 · Open 202.30",
        "Low 200.70 · High 203.10",
        "Volume 38.9M · 0.8x usual",
        "",
        "Official prices (all US exchanges)",
      ].join("\n"),
    );
  });
  it("every line is at most 38 wide, also with long prices, many alerts and every alert state", () => {
    const wide = stock("BRK.B", {
      alertsOff: true, source: "IEX", close: 712345.67, prevClose: 698765.43, open: 700000.01, low: 690000.5, high: 720000.25, volume: 1_234_567_890, avgVolume: 1e6,
      alerts: [A("VOLUME", "11:05", false, { multiple: 123.4, count: 12 }), A("HIGH", "10:42", false, { count: 3 }), A("LOW", "09:31", true, { count: 10 })],
    });
    const r = render([wide, TSLA, NVDA, AMZN, stock("NODATA")]);
    for (const m of r) expect(widest(m.text)).toBeLessThanOrEqual(38);
  });
  it("alert lines: not acked, repeat count, abbreviation when long", () => {
    const text = render([stock("X", { close: 10, prevClose: 10, alerts: [A("LOW", "10:42", false), A("HIGH", "10:50", true, { count: 2 }), A("VOLUME", "11:05", false, { multiple: 12.3, count: 4 })] })])[0]!.text;
    expect(text).toContain("🔔 LOW 10:42 ET · not acked");
    expect(text).toContain("🔔 HIGH #2 10:50 ET · acknowledged");
    expect(text).toContain("🔔 Volume 12.3x #4 11:05 ET · unacked");
    expect(text).toContain("▲0.0%");
  });
  it("missing values show n/a and a stock without any alert has no bell line", () => {
    const text = render([stock("ZZZ", { source: "IEX" })])[0]!.text;
    expect(text).toContain("<b>ZZZ</b> Close n/a  (IEX)");
    expect(text).toContain("Prev Close n/a · Open n/a");
    expect(text).toContain("Low n/a · High n/a");
    expect(text).toContain("Volume n/a");
    expect(text).not.toContain("🔔");
    expect(text).not.toContain("usual");
  });
  it("footer: official, all-IEX fallback, mixed", () => {
    expect(render([TSLA])[0]!.text.endsWith("Official prices (all US exchanges)")).toBe(true);
    expect(render([{ ...TSLA, source: "IEX" }])[0]!.text.endsWith("IEX prices (SIP unavailable)")).toBe(true);
    const mixed = render([TSLA, { ...NVDA, source: "IEX" }])[0]!.text;
    expect(mixed).toContain("Official prices (all US exchanges)\n(IEX) = official data unavailable");
    expect(mixed).toContain("<b>NVDA</b> Close 140.85 ▲4.0%  (IEX)");
  });
  it("escapes the symbol", () => {
    expect(render([stock("<b>&", { close: 1, prevClose: 1 })])[0]!.text).toContain("&lt;b&gt;&amp;");
  });
  it("without a per-stock summary it is the plain SESSION ENDED counts (old layout)", () => {
    const r = renderGlanceAll({ type: "SESSION_ENDED", date: D, counts }, ctx);
    expect(r).toHaveLength(1);
    expect(r[0]!.text).toBe("🏁 <b>SESSION ENDED</b> · Wed 25 Nov\nClosed 16:00 ET / 01:00 Muscat\nAlerts 3 · reminders 5\nAcknowledged 3 · open at close 0");
    expect(r[0]!.silent).toBe(true);
  });
  it("early close day shows the early close time", () => {
    const e = renderGlanceAll({ type: "SESSION_ENDED", date: "2026-11-27", counts, eod: { stocks: [TSLA] } }, ctx);
    expect(e[0]!.text).toContain("Closed 13:00 ET / 22:00 Muscat");
  });
});

describe("parts cut by the engine and the SIP notice", () => {
  it("worst-case blocks: 12 stocks with 3 long alerts each stay far under 4096 and 38 wide", () => {
    const worst = (i: number) => stock(`BR${i}.B`, {
      alertsOff: true, source: "IEX", close: 712345.67, prevClose: 698765.43, open: 700000.01, low: 690000.5, high: 720000.25, volume: 1_234_567_890, avgVolume: 1e6,
      alerts: [A("VOLUME", "11:05", false, { multiple: 123.4, count: 12 }), A("HIGH", "10:42", false, { count: 3 }), A("LOW", "09:31", true, { count: 10 })],
    });
    const stocks = Array.from({ length: 12 }, (_, i) => worst(i));
    const r = renderGlanceAll({ type: "SESSION_ENDED", date: D, counts, eod: { stocks, part: { n: 1, total: 2 }, footer: "MIXED" } }, ctx);
    expect(r).toHaveLength(1);
    expect(r[0]!.text.length).toBeLessThan(3500);
    expect(widest(r[0]!.text)).toBeLessThanOrEqual(38);
  });
  it("part 2 of 3: short header, no counts, no footer; last part has the footer from all parts", () => {
    const p2 = renderGlanceAll({ type: "SESSION_ENDED", date: D, counts, eod: { stocks: [TSLA], part: { n: 2, total: 3 }, footer: "IEX" } }, ctx)[0]!.text;
    expect(p2.split("\n")[0]).toBe("🏁 <b>SESSION ENDED</b> (2/3)");
    expect(p2).not.toContain("Alerts 3");
    expect(p2).not.toContain("prices");
    const p3 = renderGlanceAll({ type: "SESSION_ENDED", date: D, counts, eod: { stocks: [TSLA], part: { n: 3, total: 3 }, footer: "IEX" } }, ctx)[0]!.text;
    expect(p3.endsWith("IEX prices (SIP unavailable)")).toBe(true);
    const p1 = renderGlanceAll({ type: "SESSION_ENDED", date: D, counts, eod: { stocks: [TSLA], part: { n: 1, total: 3 } } }, ctx)[0]!.text;
    expect(p1).toContain("· Wed 25 Nov (1/3)");
    expect(p1).not.toContain("prices");
  });
  it("EOD_SIP_UNAVAILABLE notice fits 38 and promises no repeat", () => {
    const r = renderGlanceAll({ type: "OPS_NOTICE", code: "EOD_SIP_UNAVAILABLE", detail: "Official end-of-day prices failed. Retrying; IEX values if it keeps failing." }, ctx)[0]!;
    expect(widest(r.text)).toBeLessThanOrEqual(38);
    expect(r.text).toContain("OFFICIAL PRICES");
    expect(r.text).not.toContain("Next notice");
  });
});

describe("split over the Telegram limit", () => {
  const many = Array.from({ length: 70 }, (_, i) => ({ ...TSLA, symbol: `S${String(i).padStart(2, "0")}` }));
  it("splits into parts under 4096 characters, header on every part, footer only on the last, all silent", () => {
    const r = render(many);
    expect(r.length).toBeGreaterThanOrEqual(2);
    r.forEach((m, i) => {
      expect(m.text.length).toBeLessThan(4096);
      expect(m.silent).toBe(true);
      expect(m.text.startsWith("🏁 <b>SESSION ENDED</b>")).toBe(true);
      expect(m.text.includes("Official prices")).toBe(i === r.length - 1);
      expect(widest(m.text)).toBeLessThanOrEqual(38);
    });
    expect(r[0]!.text).toContain(`(1/${r.length})`);
    expect(r[1]!.text.split("\n")[0]).toBe(`🏁 <b>SESSION ENDED</b> (2/${r.length})`);
    expect(r.map((m) => m.text).join("\n").match(/<b>S\d\d<\/b>/g)).toHaveLength(70); // no stock lost or split
  });
  it("a short list stays one message", () => {
    expect(render(many.slice(0, 5))).toHaveLength(1);
  });
});
