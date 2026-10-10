import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DataDriver } from "../data/driver.ts";
import type { MockDriver } from "../data/mock-driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import { at } from "../test-utils.ts";
import { createBudgetRepo, limitStatus } from "./budget.ts";

/** Args of the first recorded call to `method` (tests always call it once). */
function argsOf(driver: MockDriver, method: keyof DataDriver): unknown[] {
  const call = driver.callsTo(method)[0];
  assert.ok(call, `expected a ${method} call`);
  return call.args;
}

test("limitStatus: ok under 80%, warn at 80%, exceeded at 100% (§2.1)", () => {
  assert.equal(limitStatus(0, 10_000), "ok");
  assert.equal(limitStatus(7_999, 10_000), "ok");
  assert.equal(limitStatus(8_000, 10_000), "warn");
  assert.equal(limitStatus(9_999, 10_000), "warn");
  assert.equal(limitStatus(10_000, 10_000), "exceeded");
  assert.equal(limitStatus(12_000, 10_000), "exceeded");
  assert.equal(limitStatus(5_000, null), "ok", "no limit set -> always ok");
  assert.equal(limitStatus(5_000, 0), "ok", "zero limit -> ok");
});

test("walletBalanceCents sums income minus expense for the wallet (§2.1)", async () => {
  const driver = createMockDriver({ results: [[{ balance_cents: 23_500 }]] });
  const budget = createBudgetRepo(driver);
  assert.equal(await budget.walletBalanceCents(1), 23_500);
  const [sql, params] = argsOf(driver, "query") as [string, unknown[]];
  assert.match(sql, /SUM\(amount_cents\)/);
  assert.match(sql, /income_entries/);
  assert.match(sql, /expense_entries/);
  assert.deepEqual(params, [1, 1]);
});

test("createExpenseEntry stores integer cents (§4)", async () => {
  const driver = createMockDriver();
  const budget = createBudgetRepo(driver);
  await budget.createExpenseEntry({
    amountCents: 1500,
    categoryId: 1,
    walletId: 2,
    entryDate: "2026-10-10",
    note: "lunch",
  });
  const [sql, params] = argsOf(driver, "execute") as [string, unknown[]];
  assert.match(sql, /INSERT INTO expense_entries/);
  assert.deepEqual(params, [1500, 1, 2, "2026-10-10", "lunch", params[5]]);
});

test("listDayEntries UNIONs both kinds for the daily view (§2.1)", async () => {
  const driver = createMockDriver();
  const budget = createBudgetRepo(driver);
  await budget.listDayEntries("2026-10-10");
  const [sql, params] = argsOf(driver, "query") as [string, unknown[]];
  assert.match(sql, /UNION ALL/);
  assert.match(sql, /'income' AS kind/);
  assert.match(sql, /'expense' AS kind/);
  assert.deepEqual(params, ["2026-10-10", "2026-10-10"]);
});

test("setLimit upserts on category (§2.1)", async () => {
  const driver = createMockDriver();
  const budget = createBudgetRepo(driver);
  await budget.setLimit(3, 500_000);
  const [sql, params] = argsOf(driver, "execute") as [string, unknown[]];
  assert.match(sql, /INSERT INTO expense_limits/);
  assert.match(sql, /ON CONFLICT\(category_id\) DO UPDATE/);
  assert.deepEqual(params, [3, 500_000]);
});

test("occurrencesDue lists due dates oldest first (§2.1)", () => {
  const budget = createBudgetRepo(createMockDriver());
  const rule = { frequency: "monthly" as const, next_due_date: "2026-08-15" };
  assert.deepEqual(budget.occurrencesDue(rule, "2026-10-20"), [
    "2026-08-15",
    "2026-09-15",
    "2026-10-15",
  ]);
  assert.deepEqual(budget.occurrencesDue(rule, "2026-10-14"), [
    "2026-08-15",
    "2026-09-15",
  ]);
});

test("occurrencesDue is hard-capped — never an unbounded loop (§2.1)", () => {
  const budget = createBudgetRepo(createMockDriver());
  const rule = { frequency: "weekly" as const, next_due_date: "2020-01-01" };
  const dates = budget.occurrencesDue(rule, "2026-10-10");
  assert.equal(dates.length, 60);
});

test("markRecurringPaid creates one expense per occurrence + advances due, batched", async () => {
  const driver = createMockDriver({
    results: [
      [
        {
          id: 7,
          frequency: "monthly",
          amount_cents: 9000,
          category_id: 2,
          wallet_id: 3,
          next_due_date: "2026-09-10",
          title: "Net",
          note: "",
        },
      ],
    ],
  });
  const budget = createBudgetRepo(driver);
  const dates = await budget.markRecurringPaid(7, "2026-10-20", {
    categoryId: 5,
    walletId: 6,
  });
  assert.deepEqual(dates, ["2026-09-10", "2026-10-10"]);
  const batch = argsOf(driver, "batch")[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(batch.length, 3, "two inserts + one update");
  const firstInsert = at(batch, 0, "batch");
  const dueUpdate = at(batch, 2, "batch");
  assert.match(firstInsert.sql, /INSERT INTO expense_entries/);
  assert.deepEqual(firstInsert.params, [
    9000,
    2,
    3,
    "2026-09-10",
    "Net",
    firstInsert.params[5],
  ]);
  assert.match(dueUpdate.sql, /UPDATE recurring_payments SET next_due_date/);
  assert.deepEqual(
    dueUpdate.params,
    ["2026-11-10", 7],
    "due advances past the last paid",
  );
});

test("markRecurringPaid falls back for category/wallet when the rule has none", async () => {
  const driver = createMockDriver({
    results: [
      [
        {
          id: 8,
          frequency: "weekly",
          amount_cents: 1000,
          category_id: null,
          wallet_id: null,
          next_due_date: "2026-10-05",
          title: "Bus",
          note: "",
        },
      ],
    ],
  });
  const budget = createBudgetRepo(driver);
  const dates = await budget.markRecurringPaid(8, "2026-10-05", {
    categoryId: 5,
    walletId: 6,
  });
  assert.deepEqual(dates, ["2026-10-05"]);
  const batch = argsOf(driver, "batch")[0] as {
    sql: string;
    params: unknown[];
  }[];
  const insert = at(batch, 0, "batch");
  assert.deepEqual(insert.params, [
    1000,
    5,
    6,
    "2026-10-05",
    "Bus",
    insert.params[5],
  ]);
});

test("markRecurringPaid writes nothing when nothing is due", async () => {
  const driver = createMockDriver({
    results: [
      [
        {
          id: 9,
          frequency: "monthly",
          amount_cents: 1000,
          category_id: 1,
          wallet_id: 1,
          next_due_date: "2026-11-01",
          title: "Future",
          note: "",
        },
      ],
    ],
  });
  const budget = createBudgetRepo(driver);
  const dates = await budget.markRecurringPaid(9, "2026-10-10", {
    categoryId: 5,
    walletId: 6,
  });
  assert.deepEqual(dates, []);
  assert.equal(driver.callsTo("batch").length, 0);
});

test("monthlySummary keeps income/expense categories separate (ids collide)", async () => {
  const driver = createMockDriver({
    results: [
      [{ total: 500_000 }],
      [{ total: 120_000 }],
      [{ category_id: 1, total_cents: 500_000 }], // income cat 1 = "Business"
      [{ category_id: 1, total_cents: 120_000 }], // expense cat 1 = "Food"
    ],
  });
  const budget = createBudgetRepo(driver);
  const summary = await budget.monthlySummary("2026-10");
  assert.equal(summary.incomeCents, 500_000);
  assert.equal(summary.expenseCents, 120_000);
  assert.deepEqual(summary.incomeByCategory, [
    { category_id: 1, total_cents: 500_000 },
  ]);
  assert.deepEqual(summary.expenseByCategory, [
    { category_id: 1, total_cents: 120_000 },
  ]);
});

test("updateIncomeEntry writes only the provided fields", async () => {
  const driver = createMockDriver();
  const budget = createBudgetRepo(driver);
  await budget.updateIncomeEntry(4, { note: "bonus" });
  const call = driver.lastCall();
  assert.ok(call);
  const [sql, params] = call.args as [string, unknown[]];
  assert.match(sql, /UPDATE income_entries SET note = \? WHERE id = \?/);
  assert.deepEqual(params, ["bonus", 4]);
});
