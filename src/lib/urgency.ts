// Dashboard urgency rule (plan §A.2): fixed thresholds on local calendar
// days. Deliberately not a setting — a threshold preference is scope creep
// for a first version, and the number is one constant if it ever changes.

import { addDays } from "./dates.ts";

export type Urgency = "overdue" | "soon" | "ok" | "none";

/** Due within this many days (inclusive) counts as `soon`. */
export const SOON_DAYS = 3;

/**
 * Urgency of a task's due date relative to `today` — both `yyyy-mm-dd`
 * local calendar days, compared as strings (zero-padded ISO dates sort
 * lexicographically). Calendar-day based, not 24-hour based: a task due
 * "today" is soon at any hour of today.
 *
 * - overdue: due before today
 * - soon:    due today through today + 3 days
 * - ok:      due after that horizon
 * - none:    no due date at all
 */
export function urgencyFor(dueDate: string | null, today: string): Urgency {
  if (dueDate === null) return "none";
  if (dueDate < today) return "overdue";
  if (dueDate <= addDays(today, SOON_DAYS)) return "soon";
  return "ok";
}

/**
 * Complete class string for each urgency (plan §A.2 table): the base
 * `.badge` carries layout, the color classes are modifiers of it, and
 * `none` stays the plain badge.
 */
export function badgeFor(urgency: Urgency): string {
  if (urgency === "overdue") return "badge badge-danger";
  if (urgency === "soon") return "badge badge-warn";
  if (urgency === "ok") return "badge badge-success";
  return "badge";
}
