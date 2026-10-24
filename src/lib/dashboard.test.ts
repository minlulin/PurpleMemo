// Dashboard helpers: today-at-a-glance pure computations. Pages load
// rows through the repos and hand them here — no driver, no SQL.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DayEntry } from "./budget.ts";
import {
  dayMoneyTotals,
  expiringWarranties,
  TODAY_HORIZON_DAYS,
  upcomingRecurring,
} from "./dashboard.ts";

const entry = (kind: "income" | "expense", cents: number): DayEntry => ({
  kind,
  id: cents,
  amount_cents: cents,
  category_id: 1,
  wallet_id: 1,
  entry_date: "2026-10-11",
  note: "",
  created_at: "2026-10-11",
});

describe("dayMoneyTotals", () => {
  test("sums income and expense separately; empty day is zero", () => {
    assert.deepEqual(dayMoneyTotals([]), { incomeCents: 0, expenseCents: 0 });
    assert.deepEqual(
      dayMoneyTotals([
        entry("income", 5000_00),
        entry("expense", 1200_00),
        entry("income", 300_00),
      ]),
      { incomeCents: 5300_00, expenseCents: 1200_00 },
    );
  });
});

describe("expiringWarranties", () => {
  test("open jobs whose warranty ends within the window, soonest first", () => {
    const jobs = [
      {
        id: 1,
        title: "Far",
        job_date: "2026-10-01",
        warranty_days: 60 as number | null,
      },
      {
        id: 2,
        title: "Soon",
        job_date: "2026-10-01",
        warranty_days: 12 as number | null,
      },
      {
        id: 3,
        title: "None",
        job_date: "2026-10-01",
        warranty_days: null,
      },
      {
        id: 4,
        title: "Lapsed",
        job_date: "2026-09-01",
        warranty_days: 10 as number | null,
      },
    ];
    const out = expiringWarranties(jobs, "2026-10-11", 14);
    assert.deepEqual(
      out.map((j) => j.title),
      ["Soon"],
    );
    assert.equal(out[0]?.endDate, "2026-10-13");
  });
});

describe("upcomingRecurring", () => {
  test("keeps overdue and in-horizon rules, soonest first", () => {
    // The approved horizon is 14 days (decision 1); overdue is inside it on
    // purpose — a bill due last week is the most urgent row on Today.
    assert.equal(TODAY_HORIZON_DAYS, 14);
    const rules = [
      { id: 1, title: "Internet", next_due_date: "2026-10-20" },
      { id: 2, title: "Rent", next_due_date: "2026-10-01" },
      { id: 3, title: "Far off", next_due_date: "2026-11-15" },
      { id: 4, title: "Horizon edge", next_due_date: "2026-10-25" },
    ];
    const out = upcomingRecurring(rules, "2026-10-11");
    assert.deepEqual(
      out.map((r) => r.title),
      ["Rent", "Internet", "Horizon edge"],
      "overdue first, then soonest due; beyond the horizon is out",
    );
  });

  test("does not mutate its input", () => {
    const rules = [
      { id: 1, next_due_date: "2026-10-20" },
      { id: 2, next_due_date: "2026-10-01" },
    ];
    const before = rules.map((r) => r.id);
    upcomingRecurring(rules, "2026-10-11");
    assert.deepEqual(
      rules.map((r) => r.id),
      before,
      "the repo's row order must survive the helper",
    );
  });
});
