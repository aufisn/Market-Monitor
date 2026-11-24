/**
 * Embedded NYSE calendar (FR-1). Edit NYSE_DAYS and CALENDAR_VALID_UNTIL once a
 * year. Outside [VALID_FROM, VALID_UNTIL] the calendar is "expired": no alerts,
 * one notice, never a guess (FR-1.3).
 *
 * Source: NYSE holiday & early-close schedule as known to the author; a
 * separate cross-check is pending. Weekends are handled in code, not listed.
 */
import type { TradingDate } from "./ports";
import { addDays, daysBetween, dayOfWeek, nyDate, nyLocalToUtc } from "./time";

export const CALENDAR_VALID_FROM: TradingDate = "2026-01-01";
export const CALENDAR_VALID_UNTIL: TradingDate = "2027-12-31";
export const CALENDAR_WARN_DAYS = 30;

export interface CalendarDay {
  date: TradingDate;
  kind: "closed" | "early"; // early = 13:00 ET close
  reason: string;
}

export const NYSE_DAYS: readonly CalendarDay[] = [
  // ---- 2026
  { date: "2026-01-01", kind: "closed", reason: "New Year's Day" },
  { date: "2026-01-19", kind: "closed", reason: "Martin Luther King Jr. Day" },
  { date: "2026-02-16", kind: "closed", reason: "Washington's Birthday" },
  { date: "2026-04-03", kind: "closed", reason: "Good Friday" },
  { date: "2026-05-25", kind: "closed", reason: "Memorial Day" },
  { date: "2026-06-19", kind: "closed", reason: "Juneteenth" },
  { date: "2026-07-03", kind: "closed", reason: "Independence Day (observed)" },
  { date: "2026-09-07", kind: "closed", reason: "Labor Day" },
  { date: "2026-11-26", kind: "closed", reason: "Thanksgiving Day" },
  { date: "2026-11-27", kind: "early", reason: "Day after Thanksgiving" },
  { date: "2026-12-24", kind: "early", reason: "Christmas Eve" },
  { date: "2026-12-25", kind: "closed", reason: "Christmas Day" },
  // ---- 2027
  { date: "2027-01-01", kind: "closed", reason: "New Year's Day" },
  { date: "2027-01-18", kind: "closed", reason: "Martin Luther King Jr. Day" },
  { date: "2027-02-15", kind: "closed", reason: "Washington's Birthday" },
  { date: "2027-03-26", kind: "closed", reason: "Good Friday" },
  { date: "2027-05-31", kind: "closed", reason: "Memorial Day" },
  { date: "2027-06-18", kind: "closed", reason: "Juneteenth (observed)" },
  { date: "2027-07-05", kind: "closed", reason: "Independence Day (observed)" },
  { date: "2027-09-06", kind: "closed", reason: "Labor Day" },
  { date: "2027-11-25", kind: "closed", reason: "Thanksgiving Day" },
  { date: "2027-11-26", kind: "early", reason: "Day after Thanksgiving" },
  { date: "2027-12-24", kind: "closed", reason: "Christmas Day (observed)" },
];

export type Session =
  | { kind: "open"; date: TradingDate; open: number; close: number; early: boolean }
  | { kind: "closed"; date: TradingDate; closedReason: string }
  | { kind: "expired"; date: TradingDate };

export function sessionFor(date: TradingDate): Session {
  if (date < CALENDAR_VALID_FROM || date > CALENDAR_VALID_UNTIL) return { kind: "expired", date };
  const dow = dayOfWeek(date);
  if (dow === 0 || dow === 6) return { kind: "closed", date, closedReason: "Weekend" };
  const day = NYSE_DAYS.find((d) => d.date === date);
  if (day?.kind === "closed") return { kind: "closed", date, closedReason: day.reason };
  const early = day?.kind === "early";
  return { kind: "open", date, open: nyLocalToUtc(date, 9, 30), close: early ? nyLocalToUtc(date, 13) : nyLocalToUtc(date, 16), early };
}

export function isOpen(nowMs: number): boolean {
  const s = sessionFor(nyDate(nowMs));
  return s.kind === "open" && nowMs >= s.open && nowMs < s.close;
}

/** Next session open strictly after nowMs, or null if the table runs out. */
export function nextOpen(nowMs: number): number | null {
  let d = nyDate(nowMs);
  for (let i = 0; i < 12; i++, d = addDays(d, 1)) {
    const s = sessionFor(d);
    if (s.kind === "expired") return null;
    if (s.kind === "open" && s.open > nowMs) return s.open;
  }
  return null;
}

/** Close of the session in progress, else of the next session. */
export function nextClose(nowMs: number): number | null {
  let d = nyDate(nowMs);
  for (let i = 0; i < 12; i++, d = addDays(d, 1)) {
    const s = sessionFor(d);
    if (s.kind === "expired") return null;
    if (s.kind === "open" && s.close > nowMs) return s.close;
  }
  return null;
}

export interface CalendarStatus {
  expired: boolean;
  validUntil: TradingDate;
  daysLeft: number;
  warn: boolean; // 30 days or fewer left (FR-1.3)
}

export function calendarStatus(nowMs: number): CalendarStatus {
  const today = nyDate(nowMs);
  const daysLeft = daysBetween(today, CALENDAR_VALID_UNTIL);
  const expired = today < CALENDAR_VALID_FROM || daysLeft < 0;
  return { expired, validUntil: CALENDAR_VALID_UNTIL, daysLeft, warn: !expired && daysLeft <= CALENDAR_WARN_DAYS };
}
