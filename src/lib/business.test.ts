import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DataDriver } from "../data/driver.ts";
import type { MockDriver } from "../data/mock-driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import { at, first } from "../test-utils.ts";
import { createBusinessRepo } from "./business.ts";

/** Args of the first recorded call to `method` (tests always call it once). */
function argsOf(driver: MockDriver, method: keyof DataDriver): unknown[] {
  const call = driver.callsTo(method)[0];
  assert.ok(call, `expected a ${method} call`);
  return call.args;
}

test("recordJobPayment: partial payment keeps the job open, no income yet (cash basis, §2.2)", async () => {
  const driver = createMockDriver({
    results: [
      [
        {
          id: 1,
          title: "Fix roof",
          total_cents: 100_000,
          paid_cents: 0,
          status: "open",
        },
      ],
    ],
  });
  const business = createBusinessRepo(driver);
  const result = await business.recordJobPayment({
    jobId: 1,
    amountCents: 40_000,
    walletId: 2,
    date: "2026-10-10",
  });
  assert.deepEqual(result, { fullyPaid: false, appliedCents: 40_000 });
  const batch = argsOf(driver, "batch")[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(batch.length, 1, "no income entry until paid in full");
  const jobUpdate = at(batch, 0, "batch");
  assert.match(jobUpdate.sql, /UPDATE jobs SET paid_cents = \?, status = \?/);
  assert.deepEqual(jobUpdate.params, [40_000, "open", 1]);
});

test("recordJobPayment: paid in full -> status paid + Business income entry (§2.2)", async () => {
  const driver = createMockDriver({
    results: [
      [
        {
          id: 1,
          title: "Fix roof",
          total_cents: 100_000,
          paid_cents: 60_000,
          status: "open",
        },
      ],
      [{ id: 4, name: "Business" }],
    ],
  });
  const business = createBusinessRepo(driver);
  const result = await business.recordJobPayment({
    jobId: 1,
    amountCents: 40_000,
    walletId: 2,
    date: "2026-10-10",
  });
  assert.deepEqual(result, { fullyPaid: true, appliedCents: 40_000 });
  const batch = argsOf(driver, "batch")[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(batch.length, 2);
  assert.deepEqual(at(batch, 0, "batch").params, [100_000, "paid", 1]);
  const incomeInsert = at(batch, 1, "batch");
  assert.match(incomeInsert.sql, /INSERT INTO income_entries/);
  assert.deepEqual(incomeInsert.params, [
    40_000,
    4,
    2,
    "2026-10-10",
    "Job: Fix roof",
    incomeInsert.params[5],
  ]);
});

test("recordJobPayment: overpayment is clamped — outstanding never negative (§4)", async () => {
  const driver = createMockDriver({
    results: [
      [
        {
          id: 1,
          title: "Small job",
          total_cents: 10_000,
          paid_cents: 8_000,
          status: "open",
        },
      ],
      [{ id: 4, name: "Business" }],
    ],
  });
  const business = createBusinessRepo(driver);
  const result = await business.recordJobPayment({
    jobId: 1,
    amountCents: 50_000,
    walletId: 1,
    date: "2026-10-10",
  });
  assert.deepEqual(result, { fullyPaid: true, appliedCents: 2_000 });
  const batch = argsOf(driver, "batch")[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.deepEqual(at(batch, 0, "batch").params, [10_000, "paid", 1]);
  assert.equal(
    at(batch, 1, "batch").params[0],
    2_000,
    "income counts only the cash that arrived",
  );
});

test("recordJobPayment: unknown job throws", async () => {
  const driver = createMockDriver();
  const business = createBusinessRepo(driver);
  await assert.rejects(
    business.recordJobPayment({
      jobId: 999,
      amountCents: 100,
      walletId: 1,
      date: "2026-10-10",
    }),
    /not found/,
  );
});

test("listReceivable computes remaining per open job (§2.2)", async () => {
  const driver = createMockDriver({
    results: [
      [
        // remaining_cents is computed by the repo's SQL, so the mock supplies it.
        {
          id: 1,
          title: "A",
          total_cents: 100_000,
          paid_cents: 30_000,
          status: "open",
          shop_id: 5,
          remaining_cents: 70_000,
        },
        {
          id: 2,
          title: "B",
          total_cents: 50_000,
          paid_cents: 50_000,
          status: "open",
          shop_id: 5,
          remaining_cents: 0,
        },
      ],
    ],
  });
  const business = createBusinessRepo(driver);
  const rows = await business.listReceivable();
  assert.equal(rows.length, 2);
  assert.equal(first(rows, "receivable").remaining_cents, 70_000);
  assert.equal(
    at(rows, 1, "receivable").remaining_cents,
    0,
    "fully-paid open job shows 0, never negative",
  );
});

test("voucherText is plain text: shop, date, unpaid jobs, total (§2.2)", async () => {
  const driver = createMockDriver({
    results: [
      [{ id: 5, name: "Moe Shop" }],
      [
        {
          id: 1,
          title: "Fix roof",
          total_cents: 100_000,
          paid_cents: 30_000,
          status: "open",
          shop_id: 5,
          remaining_cents: 70_000,
        },
        {
          id: 2,
          title: "Paint",
          total_cents: 50_000,
          paid_cents: 0,
          status: "open",
          shop_id: 5,
          remaining_cents: 50_000,
        },
        {
          id: 3,
          title: "Gone",
          total_cents: 10_000,
          paid_cents: 0,
          status: "open",
          shop_id: 9,
          remaining_cents: 10_000,
        },
      ],
    ],
  });
  const business = createBusinessRepo(driver);
  const voucher = await business.voucherText(5);
  const lines = voucher.split("\n");
  assert.equal(lines[0], "PURPLE MEMO — PAYMENT VOUCHER");
  assert.equal(lines[1], "Shop: Moe Shop");
  assert.match(at(lines, 2, "voucher lines"), /^Date: \d{4}-\d{2}-\d{2}$/);
  assert.ok(voucher.includes("1. Fix roof — 700.00"), voucher);
  assert.ok(voucher.includes("2. Paint — 500.00"), voucher);
  assert.ok(!voucher.includes("Gone"), "other shops' jobs are excluded");
  assert.ok(voucher.includes("Total due: 1,200.00"), voucher);
});

test("markPayablePaid creates the expense entry (§2.2)", async () => {
  const driver = createMockDriver({
    results: [[{ id: 3, title: "Wood", amount_cents: 80_000 }]],
  });
  const business = createBusinessRepo(driver);
  await business.markPayablePaid({
    payableId: 3,
    walletId: 1,
    categoryId: 7,
    date: "2026-10-10",
  });
  const batch = argsOf(driver, "batch")[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(batch.length, 2);
  assert.match(at(batch, 0, "batch").sql, /UPDATE payables SET paid = 1/);
  const expenseInsert = at(batch, 1, "batch");
  assert.match(expenseInsert.sql, /INSERT INTO expense_entries/);
  assert.deepEqual(expenseInsert.params, [
    80_000,
    7,
    1,
    "2026-10-10",
    "Wood",
    expenseInsert.params[5],
  ]);
});
