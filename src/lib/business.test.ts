import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
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

test("recordJobPayment: partial payment keeps the job open and records income (cash basis)", async () => {
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

test("recordJobPayment: paid in full -> status paid + Business income entry", async () => {
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

test("recordJobPayment: overpayment is clamped — outstanding never negative", async () => {
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

test("listReceivable computes remaining per open job", async () => {
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

test("voucherText is plain text: shop, date, unpaid jobs, total", async () => {
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

test("markPayablePaid creates the expense entry", async () => {
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

test("shopReceivableRows joins totals onto shops; deleted shop's total survives under a label", () => {
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

test("warrantyEndDate: null without warranty, else job_date + warranty_days", () => {
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

test("inWarranty: true while today is on or before the warranty end", () => {
  const job = { job_date: "2026-10-10", warranty_days: 30 as number | null };
  assert.equal(inWarranty(job, "2026-11-09"), true, "end day still covered");
  assert.equal(inWarranty(job, "2026-11-10"), false);
  assert.equal(
    inWarranty({ job_date: "2026-10-10", warranty_days: null }, "2026-10-11"),
    false,
  );
});

test("payableDueStatus: overdue past due date, due on the day, none without", () => {
  assert.equal(payableDueStatus(null, "2026-10-11"), "none");
  assert.equal(payableDueStatus("2026-10-10", "2026-10-11"), "overdue");
  assert.equal(payableDueStatus("2026-10-11", "2026-10-11"), "due");
  assert.equal(payableDueStatus("2026-10-12", "2026-10-11"), "upcoming");
});

test("shopReceivableRows: jobs without a shop group under 'No shop', not an orphan", () => {
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

test("deleteShop: nulls out job/payable references before deleting", async () => {
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

// -- P2-9: the edit/delete escape hatches --------------------------------------------
// Without these, a mistyped amount or a test row is permanent: a job inflates
// Total Receivable and every customer voucher forever, a payable sits on the
// supplier list forever. The money rules below are the reason these are not just
// an UPDATE statement each.

test("updateJob: writes only the provided fields", async () => {
  const driver = createMockDriver();
  const business = createBusinessRepo(driver);
  await business.updateJob(4, { title: "Fix inverter", warrantyDays: 30 });
  const [sql, params] = argsOf(driver, "execute") as [string, unknown[]];
  assert.match(
    sql,
    /UPDATE jobs SET title = \?, warranty_days = \? WHERE id = \?/,
  );
  assert.deepEqual(params, ["Fix inverter", 30, 4]);
});

test("updateJob: an explicit null clears a nullable column", async () => {
  const driver = createMockDriver();
  await createBusinessRepo(driver).updateJob(4, { warrantyDays: null });
  const [sql, params] = argsOf(driver, "execute") as [string, unknown[]];
  assert.match(sql, /warranty_days = \?/);
  assert.deepEqual(params, [null, 4], "null clears; undefined would leave it");
});

test("updateJob: changing the total re-derives status from what is paid", async () => {
  // `status` is a stored column with no trigger, so an edit that changed
  // total_cents without recomputing it would leave a fully-paid job sitting in
  // the open list, or a paid one still owing money.
  const open = {
    id: 4,
    title: "t",
    shop_id: null,
    total_cents: 100_000,
    paid_cents: 100_000,
    status: "paid",
    job_date: "2026-10-01",
    warranty_days: null,
    note: "",
    created_at: "2026-10-01",
  };
  const raises = createMockDriver({ results: [[open]] });
  await createBusinessRepo(raises).updateJob(4, { totalCents: 200_000 });
  const [sql, params] = argsOf(raises, "execute") as [string, unknown[]];
  assert.match(sql, /total_cents = \?/);
  assert.match(sql, /status = \?/);
  assert.deepEqual(
    params,
    [200_000, "open", 4],
    "raising the total reopens it",
  );

  const lowers = createMockDriver({ results: [[open]] });
  await createBusinessRepo(lowers).updateJob(4, { totalCents: 100_000 });
  const [, lowerParams] = argsOf(lowers, "execute") as [string, unknown[]];
  assert.deepEqual(lowerParams, [100_000, "paid", 4]);
});

test("updateJob: the total may not drop below what is already paid", async () => {
  // The schema only checks total_cents > 0, so a lower total would leave
  // paid_cents > total_cents and remaining_cents — on the Dashboard and every
  // customer voucher — would go negative. Refused, not clamped: a clamp would
  // make the books agree with themselves and lie about the job.
  const paid = {
    id: 4,
    title: "t",
    shop_id: null,
    total_cents: 100_000,
    paid_cents: 60_000,
    status: "open",
    job_date: "2026-10-01",
    warranty_days: null,
    note: "",
    created_at: "2026-10-01",
  };
  const driver = createMockDriver({ results: [[paid]] });
  await assert.rejects(
    () => createBusinessRepo(driver).updateJob(4, { totalCents: 50_000 }),
    /already been paid/,
  );
  assert.deepEqual(driver.callsTo("execute"), [], "nothing written on refusal");
});

test("updateJob: a non-positive total is refused before any write", async () => {
  const driver = createMockDriver();
  await assert.rejects(
    () => createBusinessRepo(driver).updateJob(4, { totalCents: 0 }),
    /greater than zero/,
  );
  assert.deepEqual(driver.callsTo("execute"), []);
});

test("updateJob: an unknown job is refused rather than silently updating nothing", async () => {
  const driver = createMockDriver({ results: [[]] });
  await assert.rejects(
    () => createBusinessRepo(driver).updateJob(99, { totalCents: 100 }),
    /not found/,
  );
});

test("deleteJob: removes the job and its photo links in one batch", async () => {
  // photo_refs cascades on photo_id but nothing cascades its polymorphic
  // (entity_type, entity_id) pair, so the same helper a note or memory delete
  // uses applies here — the audit named this case when it was written.
  const driver = createMockDriver();
  await createBusinessRepo(driver).deleteJob(4);
  const statements = first(driver.callsTo("batch"), "batch").args[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(statements.length, 2);
  assert.match(statements[0]?.sql ?? "", /DELETE FROM photo_refs/);
  assert.deepEqual(statements[0]?.params, ["job", 4]);
  assert.match(statements[1]?.sql ?? "", /DELETE FROM jobs WHERE id = \?/);
  assert.deepEqual(statements[1]?.params, [4]);
});

test("deleteJob: leaves the income the job produced alone", async () => {
  // Cash basis: the money was received and is in the Budget as income.
  // Removing the job does not un-receive it, so there is no income_entries
  // delete here — only the row and its links.
  const driver = createMockDriver();
  await createBusinessRepo(driver).deleteJob(4);
  for (const call of driver.calls) {
    assert.doesNotMatch(
      JSON.stringify(call.args),
      /income_entries/,
      "a job delete must never touch the Budget",
    );
  }
});

test("updatePayable: writes only the provided fields", async () => {
  const driver = createMockDriver();
  await createBusinessRepo(driver).updatePayable(9, {
    title: "Rice",
    dueDate: null,
  });
  const [sql, params] = argsOf(driver, "execute") as [string, unknown[]];
  assert.match(
    sql,
    /UPDATE payables SET title = \?, due_date = \? WHERE id = \?/,
  );
  assert.deepEqual(params, ["Rice", null, 9]);
});

test("updatePayable: the amount is frozen once the payable is paid", async () => {
  // markPayablePaid booked the expense at that moment, so a later amount edit
  // would leave the Budget and the payable disagreeing with no way to tell
  // which is right — and the Budget is where the money actually is.
  const driver = createMockDriver({ results: [[{ id: 9, paid: 1 }]] });
  await assert.rejects(
    () => createBusinessRepo(driver).updatePayable(9, { amountCents: 50_000 }),
    /already paid/,
  );
  assert.deepEqual(driver.callsTo("execute"), []);
});

test("updatePayable: the amount may still change while it is unpaid", async () => {
  const driver = createMockDriver({ results: [[{ id: 9, paid: 0 }]] });
  await createBusinessRepo(driver).updatePayable(9, { amountCents: 50_000 });
  const [sql, params] = argsOf(driver, "execute") as [string, unknown[]];
  assert.match(sql, /amount_cents = \?/);
  assert.deepEqual(params, [50_000, 9]);
});

test("updatePayable: the paid-guard reads one column, typed to the projection (J1)", async () => {
  const driver = createMockDriver({ results: [[{ paid: 0 }]] });
  await createBusinessRepo(driver).updatePayable(9, { amountCents: 50_000 });
  const guard = first(driver.callsTo("query"), "paid-guard read");
  assert.equal(guard.args[0], "SELECT paid FROM payables WHERE id = ?");
  assert.deepEqual(guard.args[1], [9]);
  // The row is a ONE-column projection, and the cast must say so (a source
  // pin: `rows[0]?.paid` compiles under either type, so tsc cannot catch a
  // regression to the full-row cast that left seven columns undefined).
  const src = readFileSync(new URL("./business.ts", import.meta.url), "utf8");
  assert.match(
    src,
    /query<Pick<PayableRow, "paid">>/,
    "the guard must read `paid` as a one-column projection, not a full PayableRow",
  );
});

test("updatePayable: a non-positive amount is refused", async () => {
  const driver = createMockDriver();
  await assert.rejects(
    () => createBusinessRepo(driver).updatePayable(9, { amountCents: -1 }),
    /greater than zero/,
  );
  assert.deepEqual(driver.callsTo("execute"), []);
});

test("deletePayable: deletes the row, and no photo links (there are none to clear)", async () => {
  const driver = createMockDriver();
  await createBusinessRepo(driver).deletePayable(9);
  const [sql, params] = argsOf(driver, "execute") as [string, unknown[]];
  assert.equal(sql, "DELETE FROM payables WHERE id = ?");
  assert.deepEqual(params, [9]);
  assert.deepEqual(driver.callsTo("batch"), []);
});
