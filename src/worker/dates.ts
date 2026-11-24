import { CALENDAR_VALID_FROM, CALENDAR_VALID_UNTIL } from "../core/calendar";

/** A real calendar date YYYY-MM-DD inside the calendar table (2026-01-01 .. valid-until). */
export function isValidTradingDate(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(+(m[1] as string), +(m[2] as string) - 1, +(m[3] as string)));
  if (d.toISOString().slice(0, 10) !== s) return false; // rejects 2026-02-31 and similar
  return s >= CALENDAR_VALID_FROM && s <= CALENDAR_VALID_UNTIL;
}
