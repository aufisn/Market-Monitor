import { describe, expect, it } from "vitest";
import { acknowledge, acknowledgeAll, rearmAfterEdit } from "../../src/core/alerts";
import { CALL_BUDGET, runPreOpen, runScheduled, runTick } from "../../src/core/engine";
import type { Ports } from "../../src/core/engine";
import type { StockConfig } from "../../src/core/ports";
import { MIN } from "../../src/core/time";
import { DAY1, et, flatBaseline, rig, snap } from "./memory";
import type { Rig } from "./memory";

const D = DAY1;
const at = (hhmm: string) => et(D, hhmm);

/** Set AAA's snapshot to a price at time t and run one poll. */
async function go(r: Rig, t: number, price: number, extra: Parameters<typeof snap>[3] = {}, sym = "AAA") {
  r.market.snaps[sym] = snap(sym, price, t, extra);
  return runTick(r.ports as Ports, t);
}
const alertsOf = (r: Rig) => r.store.count("FIRST_ALERT") + r.store.count("LATE_ALERT");

describe("AT-1 first alert in the same run", () => {
  it("price at HIGH or LOW alerts at once; inside the band sends nothing", async () => {
    const r = rig();
    await go(r, at("10:00:00"), 105);
    expect(alertsOf(r)).toBe(0);
    const s = await go(r, at("10:00:15"), 110);
    expect(s.events).toBe(1);
    const [e] = r.store.events("FIRST_ALERT");
    expect(e).toMatchObject({ threshold: 110, rule: { rule: "HIGH", state: "TRIGGERED", cycle: 1, t0Ms: at("10:00:15"), t0Value: 110 } });
    expect(e!.market.last?.p).toBe(110);
    await go(r, at("10:00:30"), 90);
    expect(r.store.events("FIRST_ALERT")[1]).toMatchObject({ threshold: 90, rule: { rule: "LOW" } });
  });
  it("percent thresholds resolve from Previous Close", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, high: { mode: "percent", value: 5 } }]);
    await go(r, at("10:00"), 104.9);
    expect(alertsOf(r)).toBe(0);
    await go(r, at("10:01"), 105);
    expect(r.store.events("FIRST_ALERT")[0]!.threshold).toBe(105);
  });
  it("stocks without thresholds never alert (FR-3.1); muted and paused stocks stay quiet", async () => {
    const r = rig([{ symbol: "AAA", enabled: true }, { symbol: "BBB", enabled: true, high: { mode: "dollar", value: 10 }, mutedUntilMs: at("11:00") }]);
    r.market.snaps.BBB = snap("BBB", 50, at("10:00"));
    await go(r, at("10:00"), 500);
    expect(alertsOf(r)).toBe(0);
  });
  it("a flagged (extended-hours) trade never alerts", async () => {
    const r = rig();
    await go(r, at("10:00"), 120, { conditions: ["T"], hi: 100, prevHi: 100 });
    expect(alertsOf(r)).toBe(0);
  });
  it("a spike is held until the next poll confirms it (FR-3.4)", async () => {
    const r = rig();
    for (let i = 0; i < 7; i++) await go(r, at("10:00") + i * MIN, 100); // builds 5 minute closes
    await go(r, at("10:08"), 130, { hi: 130, prevHi: 100 });
    expect(alertsOf(r)).toBe(0);
    expect(r.store.rule(D, "AAA", "HIGH")?.heldPrice).toBe(130);
    await go(r, at("10:08:15"), 129, { hi: 130, prevHi: 130 });
    expect(alertsOf(r)).toBe(1);
  });
});

describe("AT-2 bar high/low crossing, labelled touched-at", () => {
  it("detects a spike inside the previous minute although the trade moved back", async () => {
    const r = rig();
    await go(r, at("10:00:10"), 105, { prevHi: 111 });
    const [e] = r.store.events("FIRST_ALERT");
    expect(e!.rule.touchedAtMs).toBe(at("09:59:00"));
    expect(e!.rule.t0Value).toBe(111);
  });
  it("low bar of the current minute", async () => {
    const r = rig();
    await go(r, at("10:00:10"), 95, { lo: 89.5 });
    expect(r.store.events("FIRST_ALERT")[0]).toMatchObject({ threshold: 90, rule: { rule: "LOW", touchedAtMs: at("10:00") } });
  });
});

/** Alert at 10:00:00 with price 111, ready for reminder tests. */
async function alerted(): Promise<Rig> {
  const r = rig();
  await go(r, at("10:00:00"), 111);
  return r;
}

describe("AT-4 reminders every 10 minutes until acknowledged", () => {
  it("T0+10, +20, +30 at the first tick at or after due, also while back inside the band", async () => {
    const r = await alerted();
    await go(r, at("10:09:45"), 111);
    expect(r.store.count("REMINDER")).toBe(0);
    await go(r, at("10:10:20"), 111); // first tick at/after due
    await go(r, at("10:15:00"), 100);
    expect(r.store.count("REMINDER")).toBe(1);
    await go(r, at("10:20:05"), 100); // back inside the band: still reminds (I-3)
    await go(r, at("10:30:00"), 100);
    const rem = r.store.events("REMINDER");
    expect(rem.map((e) => e.rules[0]!.remindersSent)).toEqual([1, 2, 3]);
    expect(rem.map((e) => e.backInside)).toEqual([false, true, true]);
    expect(r.store.queue.filter((q) => q.event.type === "REMINDER").map((q) => q.tMs)).toEqual([at("10:10:20"), at("10:20:05"), at("10:30:00")]);
    expect(r.store.rule(D, "AAA", "HIGH")).toMatchObject({ state: "REPEATING", nextReminderMs: at("10:40:00") });
  });
  it("no double reminder when several polls run inside the same minute", async () => {
    const r = await alerted();
    for (const s of ["10:10:00", "10:10:15", "10:10:30", "10:10:45"]) await go(r, at(s), 111);
    expect(r.store.count("REMINDER")).toBe(1);
  });
  it("after a long outage one reminder is sent and numbering skips missed ones", async () => {
    const r = await alerted();
    await go(r, at("10:45:00"), 111);
    expect(r.store.events("REMINDER").map((e) => e.rules[0]!.remindersSent)).toEqual([4]);
    expect(r.store.rule(D, "AAA", "HIGH")!.nextReminderMs).toBe(at("10:50:00"));
  });
  it("custom interval and per-stock override", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 110 }, overrides: { reminderIntervalMin: 2 } }]);
    await go(r, at("10:00"), 111);
    await go(r, at("10:02"), 111);
    await go(r, at("10:04"), 111);
    expect(r.store.count("REMINDER")).toBe(2);
  });
  it("auto-clear ON re-arms silently once back inside (I-3)", async () => {
    const r = rig();
    r.store.settings.autoClear = true;
    await go(r, at("10:00"), 111);
    await go(r, at("10:05"), 100);
    expect(r.store.rule(D, "AAA", "HIGH")!.state).toBe("ARMED");
    await go(r, at("10:10"), 100);
    expect(r.store.count("REMINDER")).toBe(0);
  });
  it("reminders for one stock due in the same tick are combined (FR-4.13)", async () => {
    const r = rig();
    await go(r, at("10:00"), 111, { lo: 89 }); // HIGH and LOW both fire
    expect(r.store.count("FIRST_ALERT")).toBe(2);
    await go(r, at("10:10"), 100);
    expect(r.store.count("REMINDER")).toBe(1);
    expect(r.store.events("REMINDER")[0]!.rules.map((x) => x.rule).sort()).toEqual(["HIGH", "LOW"]);
  });
});

describe("AT-5 acknowledge by any channel stops reminders", () => {
  for (const by of ["telegram", "dashboard", "command"] as const) {
    it(`ack by ${by}`, async () => {
      const r = await alerted();
      expect(await acknowledge(r.store, D, "AAA", "HIGH", by, at("10:03"))).toBe(true);
      expect(r.store.rule(D, "AAA", "HIGH")).toMatchObject({ state: "ACKNOWLEDGED", ackBy: by, ackMs: at("10:03") });
      expect(r.store.events("ACK_CONFIRM")).toHaveLength(1);
      await go(r, at("10:10"), 111);
      await go(r, at("10:20"), 111);
      expect(r.store.count("REMINDER")).toBe(0);
      expect(await acknowledge(r.store, D, "AAA", "HIGH", by, at("10:21"))).toBe(false); // nothing left to ack
    });
  }
  it("acknowledge all", async () => {
    const r = rig();
    await go(r, at("10:00"), 111, { lo: 89 });
    expect(await acknowledgeAll(r.store, D, "ackall", at("10:01"))).toBe(2);
    await go(r, at("10:10"), 111);
    expect(r.store.count("REMINDER")).toBe(0);
    expect(r.store.events("ACK_CONFIRM")).toHaveLength(2);
  });
});

describe("AT-6 acknowledgment race", () => {
  it("ack lands between the run's load and the pre-send re-read: no reminder", async () => {
    const r = await alerted();
    let calls = 0;
    r.store.beforeGetRuleStates = async () => {
      if (++calls !== 2) return; // 1 = the run's own load, 2 = the pre-send re-read
      r.store.beforeGetRuleStates = undefined;
      await acknowledge(r.store, D, "AAA", "HIGH", "telegram", at("10:10"));
    };
    await go(r, at("10:10:00"), 111);
    expect(r.store.count("REMINDER")).toBe(0);
    await go(r, at("10:20:00"), 111);
    expect(r.store.count("REMINDER")).toBe(0);
  });
  it("ack lands between the re-read and the write: version check blocks the reminder", async () => {
    const r = await alerted();
    let done = false;
    r.store.beforePutRuleState = async () => {
      if (done) return;
      done = true;
      r.store.beforePutRuleState = undefined;
      await acknowledge(r.store, D, "AAA", "HIGH", "dashboard", at("10:10"));
    };
    await go(r, at("10:10:00"), 111);
    expect(r.store.count("REMINDER")).toBe(0);
    expect(r.store.rule(D, "AAA", "HIGH")!.state).toBe("ACKNOWLEDGED");
  });
  it("reminder first, then ack: exactly one extra reminder and none afterwards", async () => {
    const r = await alerted();
    await go(r, at("10:10:00"), 111);
    await acknowledge(r.store, D, "AAA", "HIGH", "telegram", at("10:10:01"));
    await go(r, at("10:20:00"), 111);
    await go(r, at("10:30:00"), 111);
    expect(r.store.count("REMINDER")).toBe(1);
  });
});

describe("AT-7 re-arm after acknowledgment", () => {
  it("quiet until back inside by the buffer, then alerts again with a new cycle", async () => {
    const r = await alerted();
    await acknowledge(r.store, D, "AAA", "HIGH", "telegram", at("10:01"));
    await go(r, at("10:02"), 111); // still beyond
    await go(r, at("10:03"), 109.9); // inside the threshold but not by 0.2%
    await go(r, at("10:04"), 111);
    expect(alertsOf(r)).toBe(1);
    await go(r, at("10:05"), 109.5); // inside by the buffer: re-armed
    expect(r.store.rule(D, "AAA", "HIGH")!.state).toBe("ARMED");
    await go(r, at("10:06"), 110.5);
    expect(alertsOf(r)).toBe(2);
    expect(r.store.events("FIRST_ALERT")[1]!.rule.cycle).toBe(2);
  });
  it("zero buffer re-arms as soon as the price is back inside", async () => {
    const r = rig();
    r.store.settings.rearmBufferPricePct = 0;
    await go(r, at("10:00"), 111);
    await acknowledge(r.store, D, "AAA", "HIGH", "telegram", at("10:01"));
    await go(r, at("10:02"), 109.99);
    expect(r.store.rule(D, "AAA", "HIGH")!.state).toBe("ARMED");
  });
  it("editing a threshold re-arms immediately and re-evaluates at once", async () => {
    const r = await alerted();
    await acknowledge(r.store, D, "AAA", "HIGH", "telegram", at("10:01"));
    await go(r, at("10:02"), 111);
    expect(alertsOf(r)).toBe(1);
    await r.store.putStock({ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 108 }, low: { mode: "dollar", value: 90 } });
    expect(await rearmAfterEdit(r.store, D, "AAA", "HIGH")).toBe(true);
    await go(r, at("10:03"), 111);
    expect(alertsOf(r)).toBe(2);
    expect(r.store.events("FIRST_ALERT")[1]!.threshold).toBe(108);
  });
});

describe("AT-8 volume", () => {
  const vol = (extra: Partial<StockConfig> = {}): StockConfig[] => [{ symbol: "AAA", enabled: true, volume: { mode: "multiple", value: 2 }, ...extra }];
  it("fires at the first poll where the multiple reaches the threshold; nothing in the first 5 minutes", async () => {
    const r = rig(vol());
    r.store.settings.volumeMinAvgCum = 0; // isolate the first-N-minutes guard
    r.store.baselines.set("AAA", flatBaseline("AAA", 2000));
    await go(r, at("09:32"), 100, { cum: 500_000 }); // huge, but inside the first 5 minutes
    await go(r, at("09:34:59"), 100, { cum: 500_000 });
    expect(alertsOf(r)).toBe(0);
    await go(r, at("09:36"), 100, { cum: 23_999 }); // 2 x AvgCum(6) = 24,000
    expect(alertsOf(r)).toBe(0);
    await go(r, at("09:36"), 100, { cum: 24_000 });
    expect(alertsOf(r)).toBe(1);
    expect(r.store.events("FIRST_ALERT")[0]).toMatchObject({ threshold: 24_000, rule: { rule: "VOLUME", t0Value: 24_000 } });
  });
  it("no baseline, thin baseline or failed baseline never alerts", async () => {
    for (const mk of [() => undefined, () => flatBaseline("AAA", 2000, D, 5), () => ({ ...flatBaseline("AAA", 2000), status: "NO_BASELINE" as const })]) {
      const r = rig(vol());
      const b = mk();
      if (b) r.store.baselines.set("AAA", b);
      await go(r, at("10:30"), 100, { cum: 99_999_999 });
      expect(alertsOf(r)).toBe(0);
    }
  });
  it("absolute share count alerts without a baseline", async () => {
    const r = rig(vol({ volume: { mode: "absolute", value: 1_000_000 } }));
    r.store.settings.volumeNoAlertFirstMin = 0;
    await go(r, at("09:31"), 100, { cum: 999_999 });
    await go(r, at("09:32"), 100, { cum: 1_000_000 });
    expect(alertsOf(r)).toBe(1);
  });
  it("re-arms only after volume falls 10% below the (moving) threshold", async () => {
    const r = rig(vol());
    r.store.baselines.set("AAA", flatBaseline("AAA", 2000));
    await go(r, at("10:00"), 100, { cum: 120_000 }); // threshold 2 x 60,000
    await acknowledge(r.store, D, "AAA", "VOLUME", "telegram", at("10:01"));
    await go(r, at("10:01"), 100, { cum: 121_000 }); // threshold now 2 x 62,000... still above
    expect(r.store.rule(D, "AAA", "VOLUME")!.state).toBe("ACKNOWLEDGED");
    await go(r, at("10:30"), 100, { cum: 122_000 }); // threshold 2 x 120,000 = 240,000: far below
    expect(r.store.rule(D, "AAA", "VOLUME")!.state).toBe("ARMED");
  });
});

describe("store without batched methods (fallbacks)", () => {
  it("alerts, reminders and close work with single-call stores only", async () => {
    const r = rig();
    for (const k of ["claimAlertIds", "putRuleStates", "enqueueMany"] as const) (r.store as unknown as Record<string, unknown>)[k] = undefined;
    await go(r, at("10:00"), 111, { lo: 89 });
    await go(r, at("10:10"), 111);
    await go(r, at("16:00"), 111);
    expect(r.store.count("FIRST_ALERT")).toBe(2);
    expect(r.store.count("REMINDER")).toBe(1);
    expect(r.store.count("UNACK_AT_CLOSE")).toBe(1);
  });
});

describe("AT-9 overlapping runs", () => {
  it("the lease stops the second run", async () => {
    const r = rig();
    r.market.snaps.AAA = snap("AAA", 111, at("10:00"));
    const [a, b] = await Promise.all([runTick(r.ports, at("10:00")), runTick(r.ports, at("10:00"))]);
    expect([a.status, b.status].sort()).toEqual(["ok", "skipped"]);
    expect(alertsOf(r)).toBe(1);
  });
  it("without the lease, alert-id de-duplication still prevents a second first alert", async () => {
    const r = rig();
    r.market.snaps.AAA = snap("AAA", 111, at("10:00"));
    await Promise.all([runTick(r.ports, at("10:00"), { skipLease: true }), runTick(r.ports, at("10:00"), { skipLease: true })]);
    expect(alertsOf(r)).toBe(1);
    expect(r.store.logs.some((l) => l.kind === "SUPPRESSED")).toBe(true);
  });
  it("overlapping runs send one reminder", async () => {
    const r = await alerted();
    r.market.snaps.AAA = snap("AAA", 111, at("10:10"));
    await Promise.all([runTick(r.ports, at("10:10"), { skipLease: true }), runTick(r.ports, at("10:10"), { skipLease: true })]);
    expect(r.store.count("REMINDER")).toBe(1);
  });
  it("lease expires after its time and is released after a run", async () => {
    const r = rig();
    await r.store.acquireLease("run", "ghost", at("10:00"), 50_000);
    expect((await go(r, at("10:00:30"), 100)).status).toBe("skipped");
    expect((await go(r, at("10:01:00"), 100)).status).toBe("ok");
    expect(r.store.leases.size).toBe(0);
  });
});

describe("AT-10 a full month including a holiday", () => {
  it("no alert and no reminder outside the session (November 2026)", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 110 } }], "x");
    // previous close for every day of the month
    for (let d = 1; d <= 30; d++) r.store.seedPrev(`2026-11-${String(d).padStart(2, "0")}`, "AAA", 100);
    const start = Date.parse("2026-11-01T00:00:00Z");
    const end = Date.parse("2026-12-01T00:00:00Z");
    for (let t = start; t < end; t += MIN) {
      r.market.snaps.AAA = snap("AAA", 111, t); // above HIGH around the clock
      await runTick(r.ports, t);
    }
    const tradingDays = ["02", "03", "04", "05", "06", "09", "10", "11", "12", "13", "16", "17", "18", "19", "20", "23", "24", "25", "27", "30"];
    const alerts = r.store.queue.filter((q) => q.event.type === "FIRST_ALERT" || q.event.type === "REMINDER");
    expect(alerts.length).toBeGreaterThan(100);
    for (const q of alerts) {
      const date = new Date(q.tMs - 5 * 3600_000).toISOString().slice(0, 10);
      expect(tradingDays).toContain(date.slice(8)); // never on a weekend or on Thanksgiving (26th)
      const open = et(date, "09:30");
      const close = date === "2026-11-27" ? et(date, "13:00") : et(date, "16:00");
      expect(q.tMs).toBeGreaterThanOrEqual(open);
      expect(q.tMs).toBeLessThan(close);
    }
    expect(r.store.count("FIRST_ALERT")).toBe(tradingDays.length); // one per trading day, fresh ARMED each open
    expect(r.store.count("UNACK_AT_CLOSE")).toBe(tradingDays.length);
    expect(r.store.count("SESSION_ENDED")).toBe(tradingDays.length);
  }, 60_000);
});

describe("AT-11 early close", () => {
  it("27 Nov 2026 closes at 13:00: reminders stop, alert listed as unacknowledged at close, session ended at 13:20", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 110 } }], "2026-11-27");
    const t = (hhmm: string) => et("2026-11-27", hhmm);
    await go(r, t("12:30"), 111);
    await go(r, t("12:40"), 111);
    await go(r, t("12:50"), 111);
    expect(r.store.count("REMINDER")).toBe(2);
    await go(r, t("12:59:30"), 111);
    await go(r, t("13:00:00"), 111);
    await go(r, t("13:01"), 111);
    await go(r, t("13:05"), 111);
    await go(r, t("13:10"), 111);
    await go(r, t("13:20"), 111);
    await go(r, t("14:00"), 111);
    await go(r, t("16:05"), 111);
    expect(r.store.count("REMINDER")).toBe(2); // 12:40 and 12:50; the one due at 13:00 is never sent
    expect(r.store.count("UNACK_AT_CLOSE")).toBe(1);
    expect(r.store.events("UNACK_AT_CLOSE")[0]!.rules[0]).toMatchObject({ state: "UNACKNOWLEDGED_AT_CLOSE", symbol: "AAA" });
    expect(r.store.queue.find((q) => q.event.type === "UNACK_AT_CLOSE")!.tMs).toBe(t("13:00"));
    expect(r.store.events("SESSION_ENDED")).toHaveLength(1);
    expect(r.store.queue.find((q) => q.event.type === "SESSION_ENDED")!.tMs).toBe(t("13:20"));
    expect(r.store.events("SESSION_ENDED")[0]!.counts).toMatchObject({ alerts: 1, reminders: 2, unacked: 1 });
  });
  it("normal day closes at 16:00 and the summary follows at 16:20; next day starts ARMED", async () => {
    const r = await alerted();
    await go(r, at("15:59:59"), 111);
    await go(r, at("16:00:00"), 111);
    await go(r, at("16:05:00"), 111);
    expect(r.store.rule(D, "AAA", "HIGH")!.state).toBe("UNACKNOWLEDGED_AT_CLOSE");
    r.store.seedPrev("2026-12-01", "AAA", 100);
    await go(r, et("2026-12-01", "09:45"), 105);
    expect(await r.store.getRuleStates("2026-12-01")).toEqual([]);
    await go(r, et("2026-12-01", "09:46"), 111);
    expect(alertsOf(r)).toBe(2);
  });
});

describe("AT-12 clock change and expired calendar", () => {
  it("session times follow the DST switch (8 March 2026)", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 110 } }], "2026-03-06");
    r.store.seedPrev("2026-03-09", "AAA", 100);
    r.market.snaps.AAA = snap("AAA", 111, Date.parse("2026-03-09T13:29:00Z"));
    expect((await runTick(r.ports, Date.parse("2026-03-09T13:29:00Z"))).status).toBe("idle"); // 09:29 EDT
    r.market.snaps.AAA = snap("AAA", 111, Date.parse("2026-03-09T13:30:00Z"));
    expect((await runTick(r.ports, Date.parse("2026-03-09T13:30:00Z"))).status).toBe("ok"); // 09:30 EDT
    r.store.seedPrev("2026-03-06", "AAA", 100);
    r.market.snaps.AAA = snap("AAA", 111, Date.parse("2026-03-06T14:29:00Z"));
    expect((await runTick(r.ports, Date.parse("2026-03-06T14:29:00Z"))).status).toBe("idle"); // 09:29 EST
    expect((await runTick(r.ports, Date.parse("2026-03-06T14:30:00Z"))).status).toBe("ok");
  });
  it("outside the table: no alerts, exactly one 'calendar expired' notice", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 110 } }], "2028-01-03");
    for (let m = 0; m < 30; m++) {
      const t = et("2028-01-03", "10:00") + m * MIN;
      r.market.snaps.AAA = snap("AAA", 111, t);
      expect((await runTick(r.ports, t)).status).toBe("expired");
    }
    await runTick(r.ports, et("2028-01-04", "10:00"));
    expect(alertsOf(r)).toBe(0);
    const notices = r.store.events("OPS_NOTICE").filter((e) => e.code === "CALENDAR_EXPIRED");
    expect(notices).toHaveLength(1);
    expect(r.market.calls.snapshots).toBe(0);
  });
  it("30 days before expiry READY is followed by one warning", async () => {
    const date = "2027-12-10";
    const r = rig([{ symbol: "AAA", enabled: true }], date);
    r.store.baselines.set("AAA", flatBaseline("AAA", 1, date));
    await runPreOpen(r.ports, et(date, "09:00"));
    await runPreOpen(r.ports, et(date, "09:01"));
    expect(r.store.events("OPS_NOTICE").map((e) => e.code)).toEqual(["CALENDAR_EXPIRING"]);
    expect(r.store.count("READY")).toBe(1);
  });
});

describe("AT-15 gap scan: 5 missed minutes", () => {
  const bar = (hhmm: string, h: number, l = 99) => ({ t: at(hhmm), o: 100, h, l, c: 100, v: 100 });
  it("a crossing inside the gap becomes a LATE alert with the right minute; reminders resume", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, high: { mode: "dollar", value: 105 } }]);
    await go(r, at("09:58"), 100);
    await go(r, at("09:59"), 100);
    // 10:00 .. 10:04 runs never happened; the price spiked at 10:03 and is back at 100
    r.market.bars1.AAA = [bar("10:00", 100), bar("10:01", 100), bar("10:02", 100), bar("10:03", 108), bar("10:04", 100)];
    await go(r, at("10:05:20"), 100);
    const late = r.store.events("LATE_ALERT");
    expect(late).toHaveLength(1);
    expect(late[0]).toMatchObject({ barTimeMs: at("10:03"), barPrice: 108, threshold: 105, rule: { rule: "HIGH", late: true, state: "TRIGGERED", t0Ms: at("10:05:20") } });
    expect(r.store.count("FIRST_ALERT")).toBe(0);
    expect(r.market.calls.multi).toBe(2); // first run of the day (from the open) + this gap
    // the ordinary polls afterwards do not alert twice, and reminders resume from T0
    await go(r, at("10:06"), 100);
    await go(r, at("10:15:20"), 100);
    expect(alertsOf(r)).toBe(1);
    expect(r.store.events("REMINDER")).toHaveLength(1);
  });
  it("skips rules already alerted or acknowledged; no scan without a gap", async () => {
    const r = await alerted();
    await go(r, at("10:01"), 111);
    await acknowledge(r.store, D, "AAA", "HIGH", "telegram", at("10:02"));
    r.market.bars1.AAA = [bar("10:03", 120)];
    await go(r, at("10:08"), 100);
    expect(r.store.count("LATE_ALERT")).toBe(0);
    const calls = r.market.calls.multi;
    await go(r, at("10:09"), 100);
    expect(r.market.calls.multi).toBe(calls);
  });
  it("the scan is clipped to the session and starts at the open", async () => {
    const r = rig();
    r.store.lastPoll = et("2026-11-27", "15:59"); // previous day
    r.market.bars1.AAA = [{ t: at("09:00"), o: 1, h: 200, l: 1, c: 1, v: 1 }, bar("09:31", 112)];
    await go(r, at("09:40"), 100);
    const late = r.store.events("LATE_ALERT");
    expect(late).toHaveLength(1);
    expect(late[0]!.barTimeMs).toBe(at("09:31")); // the pre-market spike is ignored
  });
  it("a one-bar spike in the gap is not alerted", async () => {
    const r = rig();
    await go(r, at("09:50"), 100);
    r.market.bars1.AAA = [0, 1, 2, 3, 4, 5].map((i) => ({ t: at("09:51") + i * MIN, o: 100, h: 100, l: 99, c: 100, v: 1 })).concat([{ t: at("09:57"), o: 100, h: 140, l: 99, c: 100, v: 1 }, { t: at("09:58"), o: 100, h: 101, l: 99, c: 100, v: 1 }]);
    await go(r, at("10:00"), 100);
    expect(alertsOf(r)).toBe(0);
  });
});

describe("opening briefing, ready, close, errors, budget", () => {
  it("briefing about 60 s after the open, once, largest gap first", async () => {
    const r = rig([{ symbol: "AAA", enabled: true }, { symbol: "BBB", enabled: true }]);
    r.store.seedPrev(D, "BBB", 100);
    r.market.snaps.AAA = snap("AAA", 101, at("09:30:30"), { open: 101 });
    r.market.snaps.BBB = snap("BBB", 95, at("09:30:30"), { open: 95 });
    await runTick(r.ports, at("09:30:30"));
    expect(r.store.count("BRIEFING")).toBe(0);
    await runTick(r.ports, at("09:31:00"));
    await runTick(r.ports, at("09:31:15"));
    const b = r.store.events("BRIEFING");
    expect(b).toHaveLength(1);
    expect(b[0]!.stocks.map((s) => s.symbol)).toEqual(["BBB", "AAA"]);
  });
  it("briefing waits for open prices up to 10 minutes", async () => {
    const r = rig();
    r.market.snaps.AAA = { symbol: "AAA", latestTrade: { t: at("09:31"), p: 100, s: 1 } };
    await runTick(r.ports, at("09:32"));
    expect(r.store.count("BRIEFING")).toBe(0);
    await runTick(r.ports, at("09:40:01"));
    expect(r.store.count("BRIEFING")).toBe(1);
  });
  it("pre-open: previous close, one baseline per run, READY at 09:00", async () => {
    const r = rig([{ symbol: "AAA", enabled: true, volume: { mode: "multiple", value: 2 } }, { symbol: "BBB", enabled: true }]);
    r.store.market.clear();
    for (const s of ["AAA", "BBB"]) r.market.prevDaily[s] = { symbol: s, date: "2026-11-27", close: 50, high: 51, low: 49, volume: 1000 };
    const bars = Array.from({ length: 78 }, (_, i) => ({ t: et("2026-11-23", "09:30") + i * 300_000, o: 1, h: 1, l: 1, c: 1, v: 100 }));
    r.market.barsByTf.AAA = bars;
    await runPreOpen(r.ports, at("07:00"));
    expect([...r.store.baselines.keys()]).toEqual(["AAA"]); // one stock per run, volume stock first
    expect(r.store.market.get(`${D}|AAA`)?.prev?.close).toBe(50);
    await runPreOpen(r.ports, at("07:01"));
    expect([...r.store.baselines.keys()].sort()).toEqual(["AAA", "BBB"]);
    expect(r.store.count("READY")).toBe(0);
    await runPreOpen(r.ports, at("09:00"));
    await runPreOpen(r.ports, at("09:01"));
    expect(r.store.events("READY")).toHaveLength(1);
    expect(r.store.events("READY")[0]!.info).toMatchObject({ stocksActive: 2, baselinesDone: 2, baselinesTotal: 2, missingPrevClose: [] });
    expect((await runPreOpen(r.ports, at("10:00"))).status).toBe("idle");
    expect((await runScheduled(r.ports, at("08:00"))).status).toBe("pre_open");
  });
  it("provider error: retried once, then one notice per 30 minutes, no last-poll update", async () => {
    const r = rig();
    r.market.failSnapshots = 1;
    expect((await go(r, at("10:00"), 100)).status).toBe("ok"); // retry succeeded
    r.market.failSnapshots = 99;
    for (const s of ["10:01", "10:02", "10:03"]) expect((await go(r, at(s), 100)).status).toBe("data_error");
    expect(r.store.events("OPS_NOTICE").filter((e) => e.code === "DATA_ERROR")).toHaveLength(1);
    expect(r.store.lastPoll).toBe(at("10:00"));
  });
  it("watchlist of 30 stocks with alerts stays within 45 calls and writes only what changed", async () => {
    const stocks: StockConfig[] = Array.from({ length: 30 }, (_, i) => ({ symbol: `S${i}`, enabled: true, high: { mode: "dollar", value: 110 }, low: { mode: "dollar", value: 90 }, volume: { mode: "multiple", value: 2 } }));
    const r = rig(stocks);
    for (const s of stocks) r.store.baselines.set(s.symbol, flatBaseline(s.symbol, 2000));
    const quiet = await (async () => {
      for (const s of stocks) r.market.snaps[s.symbol] = snap(s.symbol, 100, at("10:00"), { cum: 1000 });
      return runTick(r.ports, at("10:00"));
    })();
    expect(quiet.calls).toBeLessThanOrEqual(CALL_BUDGET);
    const again = await (async () => {
      for (const s of stocks) r.market.snaps[s.symbol] = snap(s.symbol, 100, at("10:00:15"), { cum: 1000 });
      return runTick(r.ports, at("10:00:15"));
    })();
    expect(again.writes).toBe(1); // only the last-poll row: nothing changed
    // everything fires at once: budget caps the work, the rest follows next poll
    for (const s of stocks) r.market.snaps[s.symbol] = snap(s.symbol, 111, at("10:01"), { cum: 1000 });
    const storm = await runTick(r.ports, at("10:01"));
    expect(storm.calls).toBeLessThanOrEqual(16); // batched claim/put/enqueue: a constant number of calls
    expect(storm.events).toBeGreaterThan(0);
    for (const s of stocks) r.market.snaps[s.symbol] = snap(s.symbol, 111, at("10:01:15"), { cum: 1000 });
    for (let i = 0; i < 12; i++) {
      const res = await runTick(r.ports, at("10:01:15") + i * 15_000);
      expect(res.calls).toBeLessThanOrEqual(CALL_BUDGET);
    }
    expect(r.store.count("FIRST_ALERT")).toBe(30); // every alert delivered once, across polls
  });
});
