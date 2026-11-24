import { describe, expect, it } from "vitest";

const load = async () => (await import("../../scripts/deploy-freeze.mjs" as string)) as { isFrozen(d: Date, env?: Record<string, string>): boolean };

describe("deploy freeze (AT-22)", () => {
  it("blocks at 10:00 ET on a weekday (EST and EDT)", async () => {
    const { isFrozen } = await load();
    expect(isFrozen(new Date("2026-11-25T15:00:00Z"))).toBe(true); // Wed 10:00 EST
    expect(isFrozen(new Date("2026-07-15T14:00:00Z"))).toBe(true); // Wed 10:00 EDT
  });
  it("allows outside the window, on weekends and with the emergency override", async () => {
    const { isFrozen } = await load();
    expect(isFrozen(new Date("2026-11-25T13:29:00Z"))).toBe(false); // 08:29 ET
    expect(isFrozen(new Date("2026-11-25T21:30:00Z"))).toBe(false); // 16:30 ET
    expect(isFrozen(new Date("2026-11-28T15:00:00Z"))).toBe(false); // Saturday
    expect(isFrozen(new Date("2026-11-25T15:00:00Z"), { MM_EMERGENCY_DEPLOY: "1" })).toBe(false);
  });
  it("edges: 08:30 frozen", async () => {
    const { isFrozen } = await load();
    expect(isFrozen(new Date("2026-11-25T13:30:00Z"))).toBe(true);
  });
});
