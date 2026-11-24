import { describe, expect, it } from "vitest";
import { calendarStatus, isOpen, nextClose, nextOpen, sessionFor } from "../../src/core/calendar";
import { formatEtMuscat, nyDate, nyLocalToUtc, nyOffsetMs, nyParts } from "../../src/core/time";

const utc = (s: string) => Date.parse(s);

describe("time", () => {
  it("US clock change in March 2026: 01:59 EST -> 03:00 EDT (AT-12)", () => {
    expect(nyParts(utc("2026-03-08T06:59:59Z"))).toMatchObject({ hour: 1, minute: 59, date: "2026-03-08" });
    expect(nyParts(utc("2026-03-08T07:00:00Z"))).toMatchObject({ hour: 3, minute: 0 });
    expect(nyOffsetMs(utc("2026-03-07T12:00:00Z"))).toBe(-5 * 3600_000);
    expect(nyOffsetMs(utc("2026-03-09T12:00:00Z"))).toBe(-4 * 3600_000);
  });
  it("US clock change in November 2026 (first Sunday = 1 Nov): 01:59 EDT -> 01:00 EST", () => {
    expect(nyParts(utc("2026-11-01T05:59:59Z"))).toMatchObject({ hour: 1, minute: 59 });
    expect(nyParts(utc("2026-11-01T06:00:00Z"))).toMatchObject({ hour: 1, minute: 0 });
  });
  it("2027 switch dates (14 Mar and 7 Nov)", () => {
    expect(nyOffsetMs(utc("2027-03-14T06:59:00Z"))).toBe(-5 * 3600_000);
    expect(nyOffsetMs(utc("2027-03-14T07:00:00Z"))).toBe(-4 * 3600_000);
    expect(nyOffsetMs(utc("2027-11-07T05:59:00Z"))).toBe(-4 * 3600_000);
    expect(nyOffsetMs(utc("2027-11-07T06:00:00Z"))).toBe(-5 * 3600_000);
  });
  it("local -> UTC across DST", () => {
    expect(nyLocalToUtc("2026-03-06", 9, 30)).toBe(utc("2026-03-06T14:30:00Z"));
    expect(nyLocalToUtc("2026-03-09", 9, 30)).toBe(utc("2026-03-09T13:30:00Z"));
  });
  it("trading date is the New York date", () => {
    expect(nyDate(utc("2026-12-01T02:00:00Z"))).toBe("2026-11-30");
  });
  it("formats ET and Muscat (FR-1.6)", () => {
    expect(formatEtMuscat(utc("2026-11-30T15:42:00Z"))).toBe("10:42 ET / 19:42 Muscat");
    expect(formatEtMuscat(utc("2026-06-01T14:42:00Z"))).toBe("10:42 ET / 18:42 Muscat");
  });
});

describe("calendar (FR-1.4)", () => {
  it("26 Nov 2026 closed, 27 Nov early close, 25 Dec closed, 24 Dec early", () => {
    expect(sessionFor("2026-11-26")).toMatchObject({ kind: "closed", closedReason: "Thanksgiving Day" });
    expect(sessionFor("2026-11-27")).toMatchObject({ kind: "open", early: true, close: utc("2026-11-27T18:00:00Z") });
    expect(sessionFor("2026-12-25").kind).toBe("closed");
    expect(sessionFor("2026-12-24")).toMatchObject({ kind: "open", early: true });
  });
  it("normal day 09:30-16:00 ET, weekends closed", () => {
    expect(sessionFor("2026-11-30")).toMatchObject({ kind: "open", early: false, open: utc("2026-11-30T14:30:00Z"), close: utc("2026-11-30T21:00:00Z") });
    expect(sessionFor("2026-11-28")).toMatchObject({ kind: "closed", closedReason: "Weekend" });
  });
  it("summer open is 13:30 UTC", () => {
    expect(sessionFor("2026-07-01")).toMatchObject({ kind: "open", open: utc("2026-07-01T13:30:00Z") });
  });
  it("isOpen / nextOpen / nextClose", () => {
    expect(isOpen(utc("2026-11-30T14:29:59Z"))).toBe(false);
    expect(isOpen(utc("2026-11-30T14:30:00Z"))).toBe(true);
    expect(isOpen(utc("2026-11-30T21:00:00Z"))).toBe(false);
    expect(nextOpen(utc("2026-11-25T22:00:00Z"))).toBe(utc("2026-11-27T14:30:00Z")); // skips Thanksgiving
    expect(nextClose(utc("2026-11-27T15:00:00Z"))).toBe(utc("2026-11-27T18:00:00Z"));
  });
  it("expired outside the table, and 30-day warning (FR-1.3)", () => {
    expect(sessionFor("2028-01-03").kind).toBe("expired");
    expect(sessionFor("2025-12-31").kind).toBe("expired");
    expect(nextOpen(utc("2027-12-31T22:00:00Z"))).toBeNull();
    expect(calendarStatus(utc("2027-12-10T15:00:00Z"))).toMatchObject({ expired: false, warn: true, daysLeft: 21 });
    expect(calendarStatus(utc("2026-11-30T15:00:00Z")).warn).toBe(false);
    expect(calendarStatus(utc("2028-01-03T15:00:00Z")).expired).toBe(true);
  });
});
