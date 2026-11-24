/**
 * Time helpers. New York local time without Intl (cheap on CPU): US DST runs
 * from the second Sunday of March 02:00 local to the first Sunday of November
 * 02:00 local. Muscat is UTC+4 all year.
 */
import type { TradingDate } from "./ports";

export const MIN = 60_000;
export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/** Day of month of the n-th Sunday (1-based) of a month (month0 = 0..11). */
function nthSunday(year: number, month0: number, n: number): number {
  const firstDow = new Date(Date.UTC(year, month0, 1)).getUTCDay();
  return 1 + ((7 - firstDow) % 7) + 7 * (n - 1);
}

const dstCache = new Map<number, [number, number]>();
/** [start, end) of DST for a year, as UTC epoch ms. */
function dstRange(year: number): [number, number] {
  let r = dstCache.get(year);
  if (!r) {
    r = [
      Date.UTC(year, 2, nthSunday(year, 2, 2), 7), // 02:00 EST = 07:00 UTC
      Date.UTC(year, 10, nthSunday(year, 10, 1), 6), // 02:00 EDT = 06:00 UTC
    ];
    dstCache.set(year, r);
  }
  return r;
}

/** New York offset from UTC in ms: -4h (EDT) or -5h (EST). */
export function nyOffsetMs(utcMs: number): number {
  const [s, e] = dstRange(new Date(utcMs).getUTCFullYear());
  return utcMs >= s && utcMs < e ? -4 * HOUR : -5 * HOUR;
}

export interface NyParts {
  date: TradingDate;
  hour: number;
  minute: number;
  minuteOfDay: number;
  dow: number; // 0 = Sunday
}

const p2 = (n: number) => (n < 10 ? "0" + n : "" + n);

export function nyParts(utcMs: number): NyParts {
  const d = new Date(utcMs + nyOffsetMs(utcMs));
  const hour = d.getUTCHours();
  const minute = d.getUTCMinutes();
  return {
    date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    hour,
    minute,
    minuteOfDay: hour * 60 + minute,
    dow: d.getUTCDay(),
  };
}

/** Trading date (New York calendar date) of an instant. */
export const nyDate = (utcMs: number): TradingDate => nyParts(utcMs).date;

const dateMs = (date: TradingDate) => Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10));

export const dayOfWeek = (date: TradingDate): number => new Date(dateMs(date)).getUTCDay();

export function addDays(date: TradingDate, n: number): TradingDate {
  const d = new Date(dateMs(date) + n * DAY);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** Whole days from a to b (b - a). */
export const daysBetween = (a: TradingDate, b: TradingDate): number => Math.round((dateMs(b) - dateMs(a)) / DAY);

/** UTC epoch ms of a New York local wall-clock time on a date (not for the 01:00-03:00 switch hours). */
export function nyLocalToUtc(date: TradingDate, hour: number, minute = 0): number {
  const local = dateMs(date) + hour * HOUR + minute * MIN;
  const edt = local + 4 * HOUR;
  return nyOffsetMs(edt) === -4 * HOUR ? edt : local + 5 * HOUR;
}

/** "10:42 ET / 19:42 Muscat" (FR-1.6). */
export function formatEtMuscat(utcMs: number): string {
  const et = nyParts(utcMs);
  const mu = new Date(utcMs + 4 * HOUR);
  return `${p2(et.hour)}:${p2(et.minute)} ET / ${p2(mu.getUTCHours())}:${p2(mu.getUTCMinutes())} Muscat`;
}
