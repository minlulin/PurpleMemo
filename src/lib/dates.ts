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
