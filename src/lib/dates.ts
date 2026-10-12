// Date helpers (§4): local `yyyy-mm-dd` everywhere — "today" is the user's
// local date, never UTC.

/** Local date -> `yyyy-mm-dd` (zero-padded, no UTC shift). */
export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Today's local date as `yyyy-mm-dd`. */
export function todayLocal(): string {
  return toISODate(new Date());
}

/**
 * Local date-time as `yyyy-mm-ddTHH:mm` — the format `datetime-local`
 * inputs produce and the reminders table stores. Never UTC: a
 * `toISOString()` here would shift reminders by the timezone offset
 * (§4: local time everywhere).
 */
export function localISODateTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${toISODate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** `yyyy-mm-dd` -> `yyyy-mm` (month bucket for summaries). */
export function yearMonthOf(isoDate: string): string {
  return isoDate.slice(0, 7);
}

/** Add days to an ISO date, returning a new ISO date (local). */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00`);
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

/** Add months to an ISO date, clamping the day (Jan 31 + 1mo -> Feb 28). */
export function addMonths(isoDate: string, months: number): string {
  const d = new Date(`${isoDate}T00:00:00`);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return toISODate(d);
}

/**
 * Shift a `yyyy-mm` month bucket by `delta` months (e.g. "2026-01" + 1 ->
 * "2026-02"). Single shared copy — Budget, Habits, Journal and Memories all
 * month-navigate through this one function.
 *
 * Done with plain arithmetic rather than `new Date(y, m - 1 + delta, 1)`:
 * the Date constructor maps years 0-99 into the 1900s, so "0050-06" would
 * come back as 1950. Anything not shaped exactly `yyyy-mm` is returned
 * unchanged.
 */
export function shiftYearMonth(yearMonth: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(yearMonth);
  if (!match) return yearMonth;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const total = year * 12 + (month - 1) + delta;
  const nextYear = Math.floor(total / 12);
  const nextMonth = (((total % 12) + 12) % 12) + 1;
  return `${String(nextYear).padStart(4, "0")}-${String(nextMonth).padStart(2, "0")}`;
}

/**
 * Add days to a `yyyy-mm-ddTHH:mm` local datetime, keeping the same format.
 * Invalid input returns unchanged (never throws).
 */
export function addDaysToDateTime(isoDateTime: string, days: number): string {
  const d = new Date(isoDateTime);
  if (Number.isNaN(d.getTime())) return isoDateTime;
  d.setDate(d.getDate() + days);
  return localISODateTime(d);
}

/**
 * Add months to a `yyyy-mm-ddTHH:mm` local datetime, clamping the day
 * (Jan 31 + 1mo -> Feb 28). Invalid input returns unchanged (never throws).
 */
export function addMonthsToDateTime(
  isoDateTime: string,
  months: number,
): string {
  const d = new Date(isoDateTime);
  if (Number.isNaN(d.getTime())) return isoDateTime;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + months);
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return localISODateTime(d);
}

/** Frequency step in months (§2.1 recurring payments). */
export const FREQUENCY_MONTHS: Record<string, number> = {
  weekly: 0, // special-cased as days
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

/** Advance a due date by one frequency step (weekly = +7 days). */
export function advanceDate(isoDate: string, frequency: string): string {
  if (frequency === "weekly") return addDays(isoDate, 7);
  return addMonths(isoDate, FREQUENCY_MONTHS[frequency] ?? 1);
}

/** Whole-day difference a - b (positive when a is after b). */
export function daysBetween(a: string, b: string): number {
  const ms =
    new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime();
  return Math.round(ms / 86_400_000);
}

/** Inclusive list of ISO dates in the month of `yyyy-mm`, oldest first. */
export function datesInMonth(yearMonth: string): string[] {
  const [y, m] = yearMonth.split("-").map(Number);
  if (!y || !m) return [];
  const count = new Date(y, m, 0).getDate();
  const out: string[] = [];
  for (let d = 1; d <= count; d++) {
    out.push(`${yearMonth}-${String(d).padStart(2, "0")}`);
  }
  return out;
}
