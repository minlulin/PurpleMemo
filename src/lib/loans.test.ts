import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createMockDriver } from "../data/mock-driver.ts";
import { createLoansRepo, deriveLoanState } from "./loans.ts";
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

test("updateLoan writes only the provided fields (no NULL wipe)", async () => {
  const driver = createMockDriver();
  const loans = createLoansRepo(driver);
  await loans.updateLoan(5, { note: "called" });
  const call = driver.lastCall();
  assert.ok(call);
  assert.equal(call.method, "execute");
  const [sql, params] = call.args as [string, unknown[]];
  assert.match(sql, /UPDATE loans SET note = \? WHERE id = \?/);
  assert.deepEqual(params, ["called", 5]);
});

test("updateLoan with explicit null clears a nullable field", async () => {
  const driver = createMockDriver();
  const loans = createLoansRepo(driver);
  await loans.updateLoan(5, { dueDate: null });
  const call = driver.lastCall();
  assert.ok(call);
  const [sql, params] = call.args as [string, unknown[]];
  assert.match(sql, /UPDATE loans SET due_date = \? WHERE id = \?/);
  assert.deepEqual(params, [null, 5]);
});

test("updateLoan with no fields writes nothing", async () => {
  const driver = createMockDriver();
  const loans = createLoansRepo(driver);
  await loans.updateLoan(5, {});
  assert.equal(driver.callsTo("execute").length, 0);
});

test("updateLoan: the amount may not drop below what is already repaid", async () => {
  // The schema checks `amount_cents > 0` and `repaid_cents >= 0`
  // independently, so lowering the amount under the repayments would leave
  // remaining_cents negative on the Lent/Borrowed figures and in
  // deriveLoanState. Refused, not clamped — the same rule updateJob carries.
  const row = {
    id: 5,
    counterparty: "U Kyaw",
    direction: "lent",
    amount_cents: 100_000,
    repaid_cents: 60_000,
    due_date: null,
    note: "",
    created_at: "2026-10-01",
  };
  const driver = createMockDriver({ results: [[row]] });
  await assert.rejects(
    () => createLoansRepo(driver).updateLoan(5, { amountCents: 50_000 }),
    /already been repaid/,
  );
  assert.deepEqual(driver.callsTo("execute"), [], "nothing written on refusal");
});

test("updateLoan: a non-positive amount is refused, and an unknown loan too", async () => {
  const zero = createMockDriver();
  await assert.rejects(
    () => createLoansRepo(zero).updateLoan(5, { amountCents: 0 }),
    /greater than zero/,
  );
  assert.deepEqual(zero.callsTo("execute"), []);

  const missing = createMockDriver({ results: [[]] });
  await assert.rejects(
    () => createLoansRepo(missing).updateLoan(99, { amountCents: 100 }),
    /not found/,
  );
});

test("updateLoan: raising the amount above what is repaid is fine", async () => {
  const row = {
    id: 5,
    counterparty: "U Kyaw",
    direction: "lent",
    amount_cents: 100_000,
    repaid_cents: 60_000,
    due_date: null,
    note: "",
    created_at: "2026-10-01",
  };
  const driver = createMockDriver({ results: [[row]] });
  await createLoansRepo(driver).updateLoan(5, { amountCents: 200_000 });
  const call = driver.callsTo("execute")[0];
  assert.ok(call);
  assert.match(call.args[0] as string, /UPDATE loans SET amount_cents = \?/);
  assert.deepEqual(call.args[1], [200_000, 5]);
});
