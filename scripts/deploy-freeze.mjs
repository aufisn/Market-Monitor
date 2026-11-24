// Deploy freeze (FR-14.2, AT-22): blocks deploys 08:30-16:30 New York time on weekdays
// unless MM_EMERGENCY_DEPLOY=1. Weekday check only (holidays are treated as trading days: conservative).
import { pathToFileURL } from "node:url";

export function nyClock(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return { weekday: get("weekday"), minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

export function isFrozen(date, env = {}) {
  if (env.MM_EMERGENCY_DEPLOY === "1") return false;
  const { weekday, minutes } = nyClock(date);
  if (weekday === "Sat" || weekday === "Sun") return false;
  return minutes >= 8 * 60 + 30 && minutes < 16 * 60 + 30;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  if (isFrozen(new Date(), process.env)) {
    console.error("DEPLOY FROZEN: 08:30-16:30 New York time on weekdays. Set MM_EMERGENCY_DEPLOY=1 for an emergency.");
    process.exit(1);
  }
  console.log("Deploy freeze: clear.");
}
