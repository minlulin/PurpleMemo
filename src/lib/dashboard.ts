// Dashboard helpers: today-at-a-glance pure computations. Pages load
// rows through the repos and hand them here — no driver, no SQL.

import type { DayEntry } from "./budget.ts";
import { warrantyEndDate } from "./business.ts";
import { addDays } from "./dates.ts";

/** The upcoming horizon every "coming up" card shares. */
export const TODAY_HORIZON_DAYS = 14;

/**
 * Rules due on or before `today + days`, soonest due first.
 *
 * Overdue rules are included — a bill that was due yesterday is the most
 * urgent thing on Today, not something the horizon may exclude — so they sort
 * to the front. The caller passes rows from `listRecurring(false)`, which
 * already excludes inactive rules; this stays a pure function over them, like
 * everything else in this module.
 */
export function upcomingRecurring<T extends { next_due_date: string }>(
  rules: T[],
  today: string,
  days = TODAY_HORIZON_DAYS,
): T[] {
  const horizon = addDays(today, days);
  return rules
    .filter((r) => r.next_due_date <= horizon)
    .sort((a, b) =>
      a.next_due_date < b.next_due_date
        ? -1
        : a.next_due_date > b.next_due_date
          ? 1
          : 0,
    );
}

/** Today's money in/out from the daily entry list. */
export function dayMoneyTotals(entries: DayEntry[]): {
  incomeCents: number;
  expenseCents: number;
} {
  let incomeCents = 0;
  let expenseCents = 0;
  for (const e of entries) {
    if (e.kind === "income") incomeCents += e.amount_cents;
    else expenseCents += e.amount_cents;
  }
  return { incomeCents, expenseCents };
}

export interface ExpiringWarranty {
  id: number;
  title: string;
  endDate: string;
}

/**
 * Jobs whose warranty ends within `days` of today (still covered — lapsed
 * and warranty-less jobs excluded), soonest end first
 */
export function expiringWarranties(
  jobs: {
    id: number;
    title: string;
    job_date: string;
    warranty_days: number | null;
  }[],
  today: string,
  days = 14,
): ExpiringWarranty[] {
  const out: ExpiringWarranty[] = [];
  const horizon = addDays(today, days);
  for (const j of jobs) {
    const end = warrantyEndDate(j);
    if (end === null || end < today || end > horizon) continue;
    out.push({ id: j.id, title: j.title, endDate: end });
  }
  out.sort((a, b) =>
    a.endDate < b.endDate ? -1 : a.endDate > b.endDate ? 1 : 0,
  );
  return out;
}
