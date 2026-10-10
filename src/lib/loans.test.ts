import { strict as assert } from "node:assert";
import { test } from "node:test";

import { deriveLoanState } from "./loans.ts";
import type { LoanRow } from "./types.ts";

function loan(
  fields: Partial<LoanRow>,
): Pick<LoanRow, "amount_cents" | "repaid_cents" | "due_date"> {
  return { amount_cents: 100_000, repaid_cents: 0, due_date: null, ...fields };
}

test("deriveLoanState: open when nothing repaid and no due date (§2.3)", () => {
  assert.equal(deriveLoanState(loan({}), "2026-10-10"), "open");
});

test("deriveLoanState: overdue beats partial (due date < today, not closed)", () => {
  assert.equal(
    deriveLoanState(
      loan({ repaid_cents: 40_000, due_date: "2026-10-01" }),
      "2026-10-10",
    ),
    "overdue",
  );
  assert.equal(
    deriveLoanState(loan({ due_date: "2026-10-01" }), "2026-10-10"),
    "overdue",
  );
});

test("deriveLoanState: partial when partly repaid and not overdue", () => {
  assert.equal(
    deriveLoanState(
      loan({ repaid_cents: 40_000, due_date: "2026-11-01" }),
      "2026-10-10",
    ),
    "partial",
  );
});

test("deriveLoanState: closed when fully repaid, even past the due date", () => {
  assert.equal(
    deriveLoanState(
      loan({ repaid_cents: 100_000, due_date: "2026-10-01" }),
      "2026-10-10",
    ),
    "closed",
  );
  assert.equal(
    deriveLoanState(loan({ repaid_cents: 150_000 }), "2026-10-10"),
    "closed",
  );
});
