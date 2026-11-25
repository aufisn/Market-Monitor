/* Quick checks for public/lib.js. Run: node test/ui/lib-check.mjs */
import assert from "node:assert/strict";
import * as L from "../../public/lib.js";
const T = Date.UTC(2026, 10, 24, 15, 42);
assert.equal(L.both(T), "10:42 ET / 19:42 Muscat");
assert.equal(L.both(L.etWallToMs("2026-11-24", 16, 0)), "16:00 ET / 01:00+1 Muscat");
assert.equal(L.etWallToMs("2026-07-01", 9, 30), Date.UTC(2026, 6, 1, 13, 30));
assert.equal(L.marketClock(T, null).status, "OPEN");
assert.equal(L.marketClock(Date.UTC(2026, 10, 28, 18, 0), null).reason, "weekend");
assert.equal(L.freshness(61, true), "amber"); assert.equal(L.freshness(301, true), "red"); assert.equal(L.freshness(10, true), "fresh"); assert.equal(L.freshness(999, false), "closed");
assert.equal(L.parseNum("$1,5"), 1.5); assert.ok(Number.isNaN(L.parseNum("1e3x")));
assert.equal(L.evalThreshold({ which: "high", mode: "dollar", text: "190", prev: 189.5, last: 190.2 }).crossed, true);
assert.equal(L.evalThreshold({ which: "low", mode: "percent", text: "-5", prev: 100, last: 99 }).price, 95);
assert.equal(L.evalThreshold({ which: "high", mode: "dollar", text: "90", prev: 100, last: 99, otherPrice: 95 }).state, "error");
const stock = { symbol: "X", enabled: true, high: { mode: "dollar", value: 110 }, low: { mode: "dollar", value: 90 } };
const mkt = { symbol: "X", last: { t: T - 5000, p: 108 }, prev: { close: 100 }, open: 101 };
assert.equal(L.buildVM(stock, mkt, [], { nearPct: 20 }, T, true).status, "NEAR");
assert.equal(L.buildVM(stock, undefined, [], {}, T, true).status, "NODATA");
assert.equal(L.buildVM({ ...stock, paused: true }, mkt, [], {}, T, true).status, "PAUSED");
assert.equal(L.buildVM(stock, mkt, [{ symbol: "X", rule: "HIGH", state: "TRIGGERED" }], {}, T, true).status, "CROSSED");
assert.equal(L.dataStatus(T, T - 200000, true).key, "DELAYED"); assert.equal(L.dataStatus(T, null, true).key, "NODATA");

// card stack
assert.deepEqual(L.stackOrder([], ["B", "A", "C"]), ["B", "A", "C"]);
assert.deepEqual(L.stackOrder(["B", "A", "C"], ["C", "D", "A"]), ["A", "C", "D"]); // frozen order, removed dropped, new appended
assert.equal(L.focusAfter(["A", "B", "C"], ["A", "C"], "B"), "C"); assert.equal(L.focusAfter(["A", "B", "C"], ["A", "B"], "C"), "B"); assert.equal(L.focusAfter(["A"], ["A"], "A"), "A");
assert.equal(L.dragAxis(5, 5), null); assert.equal(L.dragAxis(12, 3), "h"); assert.equal(L.dragAxis(3, -12), "v");
assert.equal(L.dragOffset(40, 0, 3), 10); assert.equal(L.dragOffset(-40, 2, 3), -10); assert.equal(L.dragOffset(-40, 0, 3), -40);
assert.equal(L.dragSettle(-60, 0, 3), 1); assert.equal(L.dragSettle(60, 0, 3), 0); assert.equal(L.dragSettle(-60, 2, 3), 2); assert.equal(L.dragSettle(30, 1, 3), 1); assert.equal(L.dragSettle(60, 2, 3), 1);
const crossedVm = (sym) => ({ sym, status: "CROSSED" });
assert.deepEqual(L.newlyCrossed(null, [crossedVm("A")]), []); assert.deepEqual(L.newlyCrossed(new Set(["A"]), [crossedVm("A"), crossedVm("B"), { sym: "C", status: "OK" }]), ["B"]);
assert.equal(L.allAlertsOff([]), false); assert.equal(L.allAlertsOff([{ paused: true }, { paused: true }]), true); assert.equal(L.allAlertsOff([{ paused: true }, { paused: false }]), false);
// stock form
const base = { editing: false, symbol: "nvda", on: true, low: { mode: "dollar", text: "" }, high: { mode: "dollar", text: "" }, vol: { mode: "multiple", text: "" }, notes: "", prev: NaN, last: NaN };
assert.match(L.checkStockForm(base).err, /at least one/);
assert.match(L.checkStockForm({ ...base, symbol: "TOOLONGX", vol: { mode: "multiple", text: "2" } }).err, /Symbol/);
assert.deepEqual(L.checkStockForm({ ...base, vol: { mode: "multiple", text: "2.5" }, notes: " hi ", on: false }).body, { symbol: "NVDA", volume: { mode: "multiple", value: 2.5 }, notes: "hi", paused: true });
assert.match(L.checkStockForm({ ...base, low: { mode: "dollar", text: "200" }, high: { mode: "dollar", text: "100" } }).err, /LOW must be below HIGH/);
assert.deepEqual(L.checkStockForm({ ...base, low: { mode: "percent", text: "-5" } }).body.low, { mode: "percent", value: -5 }); // percent is fine for a new stock
assert.equal(L.checkStockForm({ ...base, vol: { mode: "absolute", text: "1.5" } }).vol.state, "error");
const ex = { symbol: "NVDA", low: { mode: "dollar", value: 100 }, high: { mode: "dollar", value: 150 }, volume: { mode: "absolute", value: 5000000 }, notes: "n" };
const ed = { editing: true, existing: ex, symbol: "NVDA", on: true, low: { mode: "dollar", text: "100" }, high: { mode: "dollar", text: "150" }, vol: { mode: "absolute", text: "5000000" }, notes: "n", prev: 120, last: 120 };
assert.equal(L.checkStockForm(ed).changed, false);
assert.deepEqual(L.checkStockForm({ ...ed, high: { mode: "dollar", text: "" }, on: false }).body, { high: null, paused: true }); // null removes
assert.deepEqual(L.checkStockForm({ ...ed, low: { mode: "dollar", text: "110" }, notes: "" }).body, { low: { mode: "dollar", value: 110 }, notes: null });
assert.match(L.checkStockForm({ ...ed, low: { mode: "dollar", text: "" }, high: { mode: "dollar", text: "" }, vol: { mode: "absolute", text: "" } }).err, /at least one/);
assert.equal(L.checkStockForm({ ...ed, low: { mode: "dollar", text: "125" } }).low.crossed, true); // 125 is above the last price 120 for a LOW
assert.match(L.thresholdSentence("low", L.evalThresholdLoose({ which: "low", mode: "dollar", text: "242", prev: 251.6, last: 250 }), 251.6), /falls to \$242\.00 \(3\.8% below Prev Close \$251\.60\)/);
assert.equal(L.usualVolumeWaits(false, { status: "OK" }), true); assert.equal(L.usualVolumeWaits(true, { status: "OK" }), false); assert.equal(L.usualVolumeWaits(true, { status: "BUILDING" }), true);
console.log("lib-check ok");
