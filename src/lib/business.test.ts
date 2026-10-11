import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DataDriver } from "../data/driver.ts";
import type { MockDriver } from "../data/mock-driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import { at, first } from "../test-utils.ts";
import {
  createBusinessRepo,
  inWarranty,
  payableDueStatus,
  shopReceivableRows,
  warrantyEndDate,
} from "./business.ts";

/** Args of the first recorded call to `method` (tests always call it once). */
function argsOf(driver: MockDriver, method: keyof DataDriver): unknown[] {
  const call = driver.callsTo(method)[0];
  assert.ok(call, `expected a ${method} call`);
  return call.args;
}

test("recordJobPayment: partial payment keeps the job open and records income (cash basis, §2.1)", async () => {
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
  assert.deepEqual(result, { fullyPaid: false, appliedCents: 40_000 });
  const batch = argsOf(driver, "batch")[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(batch.length, 2, "job update + income entry on every receipt");
  const jobUpdate = at(batch, 0, "batch");
  assert.match(jobUpdate.sql, /UPDATE jobs SET paid_cents = \?, status = \?/);
  assert.deepEqual(jobUpdate.params, [40_000, "open", 1]);
  const income = at(batch, 1, "batch");
  assert.match(income.sql, /INSERT INTO income_entries/);
  assert.deepEqual(income.params, [
    40_000,
    4,
    2,
    "2026-10-10",
    "Job: Fix roof",
    income.params[5],
  ]);
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

test("markPayablePaid is idempotent: re-paying writes no duplicate expense", async () => {
  const driver = createMockDriver({
    results: [[{ id: 3, title: "Wood", amount_cents: 80_000, paid: 1 }]],
  });
  const business = createBusinessRepo(driver);
  await business.markPayablePaid({
    payableId: 3,
    walletId: 1,
    categoryId: 7,
    date: "2026-10-10",
  });
  assert.equal(driver.callsTo("batch").length, 0);
  assert.equal(driver.callsTo("execute").length, 0);
});

test("recordJobPayment: concurrent double-submit creates only one income entry", async () => {
  const openJob = {
    id: 1,
    title: "Fix roof",
    total_cents: 100_000,
    paid_cents: 0,
    status: "open",
  };
  const paidJob = { ...openJob, paid_cents: 100_000, status: "paid" };
  const driver = createMockDriver({
    // call 1: getJob -> open; businessCategoryId; call 2: getJob -> paid
    results: [[openJob], [{ id: 9 }], [paidJob]],
  });
  const business = createBusinessRepo(driver);
  const pay = {
    jobId: 1,
    amountCents: 100_000,
    walletId: 2,
    date: "2026-10-10",
  };
  const [r1, r2] = await Promise.all([
    business.recordJobPayment(pay),
    business.recordJobPayment(pay),
  ]);
  assert.deepEqual(r1, { fullyPaid: true, appliedCents: 100_000 });
  assert.deepEqual(r2, { fullyPaid: true, appliedCents: 0 });
  const batches = driver.callsTo("batch");
  assert.equal(batches.length, 1);
  const statements = batches[0]?.args[0] as { sql: string }[];
  assert.equal(statements.length, 2); // UPDATE + one income INSERT
  const incomeInserts = statements.filter((s) =>
    /INSERT INTO income_entries/.test(s.sql),
  );
  assert.equal(incomeInserts.length, 1);
});

test("shopReceivableRows joins totals onto shops; deleted shop's total survives under a label (§2.2)", () => {
  const shops = [
    {
      id: 1,
      name: "Alpha",
      phone: "",
      address: "",
      notes: "",
      created_at: "2026-10-10",
    },
    {
      id: 2,
      name: "Beta",
      phone: "",
      address: "",
      notes: "",
      created_at: "2026-10-10",
    },
  ];
  const rows = shopReceivableRows(shops, [
    { shop_id: 1, remaining_cents: 5_000 },
    { shop_id: 3, remaining_cents: 900 },
  ]);
  assert.equal(rows.length, 3);
  const alpha = rows.find((r) => r.name === "Alpha");
  assert.equal(alpha?.remaining_cents, 5_000);
  const beta = rows.find((r) => r.name === "Beta");
  assert.equal(beta?.remaining_cents, 0, "shop without totals is 0");
  const orphan = rows.find((r) => r.remaining_cents === 900);
  assert.equal(orphan?.name, "Deleted shop #3", "orphaned total keeps a label");
  // Deterministic order: with a balance first (largest first), then no-balance alphabetically.
  assert.deepEqual(
    rows.map((r) => r.name),
    ["Alpha", "Deleted shop #3", "Beta"],
  );
});

test("warrantyEndDate: null without warranty, else job_date + warranty_days (§2.2)", () => {
  assert.equal(
    warrantyEndDate({ job_date: "2026-10-10", warranty_days: null }),
    null,
  );
  assert.equal(
    warrantyEndDate({ job_date: "2026-10-10", warranty_days: 0 }),
    null,
  );
  assert.equal(
    warrantyEndDate({ job_date: "2026-10-10", warranty_days: 30 }),
    "2026-11-09",
  );
  assert.equal(
    warrantyEndDate({ job_date: "2026-12-20", warranty_days: 30 }),
    "2027-01-19",
  );
  assert.equal(
    warrantyEndDate({ job_date: "2026-02-28", warranty_days: 1 }),
    "2026-03-01",
  );
});

test("inWarranty: true while today is on or before the warranty end (§2.2)", () => {
  const job = { job_date: "2026-10-10", warranty_days: 30 as number | null };
  assert.equal(inWarranty(job, "2026-11-09"), true, "end day still covered");
  assert.equal(inWarranty(job, "2026-11-10"), false);
  assert.equal(
    inWarranty({ job_date: "2026-10-10", warranty_days: null }, "2026-10-11"),
    false,
  );
});

test("payableDueStatus: overdue past due date, due on the day, none without (§2.2)", () => {
  assert.equal(payableDueStatus(null, "2026-10-11"), "none");
  assert.equal(payableDueStatus("2026-10-10", "2026-10-11"), "overdue");
  assert.equal(payableDueStatus("2026-10-11", "2026-10-11"), "due");
  assert.equal(payableDueStatus("2026-10-12", "2026-10-11"), "upcoming");
});

test("shopReceivableRows: jobs without a shop group under 'No shop', not an orphan (§2.2)", () => {
  const shops = [
    {
      id: 1,
      name: "Alpha",
      phone: "",
      address: "",
      notes: "",
      created_at: "2026-10-10",
    },
  ];
  const rows = shopReceivableRows(shops, [
    { shop_id: null, remaining_cents: 700 },
    { shop_id: 1, remaining_cents: 100 },
  ]);
  assert.equal(rows.length, 2);
  const loose = rows.find((r) => r.name === "No shop");
  assert.equal(loose?.remaining_cents, 700, "shopless jobs get a sane label");
  assert.equal(
    rows.find((r) => r.name.startsWith("Deleted")),
    undefined,
    "null shop_id must never become 'Deleted shop #null'",
  );
});

test("deleteShop: nulls out job/payable references before deleting (§2.2)", async () => {
  const driver = createMockDriver({ results: [] });
  const business = createBusinessRepo(driver);
  await business.deleteShop(7);
  const batch = argsOf(driver, "batch")[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(batch.length, 3);
  assert.match(at(batch, 0, "batch").sql, /UPDATE jobs SET shop_id = NULL/);
  assert.deepEqual(at(batch, 0, "batch").params, [7]);
  assert.match(at(batch, 1, "batch").sql, /UPDATE payables SET shop_id = NULL/);
  assert.deepEqual(at(batch, 1, "batch").params, [7]);
  assert.match(at(batch, 2, "batch").sql, /DELETE FROM shops/);
  assert.deepEqual(at(batch, 2, "batch").params, [7]);
});
