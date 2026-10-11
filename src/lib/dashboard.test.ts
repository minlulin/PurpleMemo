// Dashboard helpers (§2.8): today-at-a-glance pure computations. Pages load
// rows through the repos and hand them here — no driver, no SQL.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import type { DayEntry } from "./budget.ts";
import { dayMoneyTotals, expiringWarranties } from "./dashboard.ts";

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
  test("sums income and expense separately; empty day is zero (§2.8)", () => {
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
  test("open jobs whose warranty ends within the window, soonest first (§2.8)", () => {
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
