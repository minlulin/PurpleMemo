import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { DataDriver } from "../data/driver.ts";
import type { MockDriver } from "../data/mock-driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import { at, gatedQueryDriver, tick } from "../test-utils.ts";
import {
  cleanName,
  createBudgetRepo,
  limitDisplayRows,
  limitStatus,
  monthSummaryDisplay,
  prospectiveStatus,
  recurringDisplay,
  resolveEntryDate,
  yearDisplay,
} from "./budget.ts";

/** Args of the first recorded call to `method` (tests always call it once). */
function argsOf(driver: MockDriver, method: keyof DataDriver): unknown[] {
  const call = driver.callsTo(method)[0];
  assert.ok(call, `expected a ${method} call`);
  return call.args;
}

test("limitStatus: ok under 80%, warn at 80%, exceeded at 100%", () => {
  assert.equal(limitStatus(0, 10_000), "ok");
  assert.equal(limitStatus(7_999, 10_000), "ok");
  assert.equal(limitStatus(8_000, 10_000), "warn");
  assert.equal(limitStatus(9_999, 10_000), "warn");
  assert.equal(limitStatus(10_000, 10_000), "exceeded");
  assert.equal(limitStatus(12_000, 10_000), "exceeded");
  assert.equal(limitStatus(5_000, null), "ok", "no limit set -> always ok");
  assert.equal(limitStatus(5_000, 0), "ok", "zero limit -> ok");
});

test("walletBalanceCents sums income minus expense for the wallet", async () => {
  const driver = createMockDriver({ results: [[{ balance_cents: 23_500 }]] });
  const budget = createBudgetRepo(driver);
  assert.equal(await budget.walletBalanceCents(1), 23_500);
  const [sql, params] = argsOf(driver, "query") as [string, unknown[]];
  assert.match(sql, /SUM\(amount_cents\)/);
  assert.match(sql, /income_entries/);
  assert.match(sql, /expense_entries/);
  assert.deepEqual(params, [1, 1]);
});

test("listWalletBalances: every wallet in ONE query, capped only on request", async () => {
  // The per-wallet form above costs one IPC round trip per wallet; the share
  // ticker and the Budget page's first paint both need every balance, and both
  // used to fan out. One grouped statement replaces N of them.
  const driver = createMockDriver({
    results: [
      [
        { id: 1, name: "Cash", balance_cents: 5_000 },
        { id: 2, name: "Bank", balance_cents: -1_200 },
      ],
    ],
  });
  const budget = createBudgetRepo(driver);
  const rows = await budget.listWalletBalances();
  assert.deepEqual(rows, [
    { id: 1, name: "Cash", balanceCents: 5_000 },
    { id: 2, name: "Bank", balanceCents: -1_200 },
  ]);
  assert.equal(
    driver.callsTo("query").length,
    1,
    "two wallets must cost one query, not two",
  );
  const [sql, params] = argsOf(driver, "query") as [string, unknown[]];
  assert.match(sql, /SUM\(amount_cents\)/);
  assert.doesNotMatch(sql, /LIMIT/, "uncapped means no LIMIT clause");
  assert.deepEqual(params, [], "no cap -> no bound parameter");
});

test("listWalletBalances: a cap travels as one bound parameter", async () => {
  const driver = createMockDriver({
    results: [[{ id: 1, name: "Cash", balance_cents: 0 }]],
  });
  const budget = createBudgetRepo(driver);
  await budget.listWalletBalances(20);
  const [sql, params] = argsOf(driver, "query") as [string, unknown[]];
  assert.match(sql, /LIMIT \?/);
  assert.deepEqual(params, [20]);
});

test("createExpenseEntry stores integer cents", async () => {
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

test("a cleared entry date saves and refreshes against the same local day", async () => {
  const driver = createMockDriver();
  const budget = createBudgetRepo(driver);
  const entryDate = resolveEntryDate("", "2026-10-11");

  await budget.createExpenseEntry({
    amountCents: 1500,
    categoryId: 1,
    walletId: 2,
    entryDate,
  });
  await budget.listDayEntries(entryDate);

  const [, insertParams] = argsOf(driver, "execute") as [string, unknown[]];
  assert.equal(insertParams[3], "2026-10-11");
  const dayQuery = driver.callsTo("query")[0];
  assert.ok(dayQuery);
  assert.deepEqual(dayQuery.args[1], ["2026-10-11", "2026-10-11"]);
});

test("listDayEntries UNIONs both kinds for the daily view", async () => {
  const driver = createMockDriver();
  const budget = createBudgetRepo(driver);
  await budget.listDayEntries("2026-10-10");
  const [sql, params] = argsOf(driver, "query") as [string, unknown[]];
  assert.match(sql, /UNION ALL/);
  assert.match(sql, /'income' AS kind/);
  assert.match(sql, /'expense' AS kind/);
  assert.deepEqual(params, ["2026-10-10", "2026-10-10"]);
});

test("setLimit upserts on category", async () => {
  const driver = createMockDriver();
  const budget = createBudgetRepo(driver);
  await budget.setLimit(3, 500_000);
  const [sql, params] = argsOf(driver, "execute") as [string, unknown[]];
  assert.match(sql, /INSERT INTO expense_limits/);
  assert.match(sql, /ON CONFLICT\(category_id\) DO UPDATE/);
  assert.deepEqual(params, [3, 500_000]);
});

test("occurrencesDue lists due dates oldest first", () => {
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

test("occurrencesDue is hard-capped — never an unbounded loop", () => {
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

test("cleanName trims input and rejects empty/whitespace names", () => {
  assert.equal(cleanName("  Kpay  "), "Kpay");
  assert.equal(cleanName("Wave"), "Wave");
  assert.equal(cleanName(""), null);
  assert.equal(cleanName("   "), null);
});

test("prospectiveStatus warns when a new entry crosses 80%/100%", () => {
  assert.equal(prospectiveStatus(0, 10_000, 7_999), "ok");
  assert.equal(prospectiveStatus(7_500, 10_000, 500), "warn");
  assert.equal(prospectiveStatus(9_500, 10_000, 600), "exceeded");
  assert.equal(prospectiveStatus(0, null, 99_999), "ok", "no limit -> ok");
  assert.equal(
    prospectiveStatus(50_000, 10_000, 1),
    "exceeded",
    "already over",
  );
});

test("monthSummaryDisplay sorts categories by total and labels unknown ids", () => {
  const display = monthSummaryDisplay(
    {
      incomeCents: 20_000,
      expenseCents: 20_500,
      incomeByCategory: [
        { category_id: 1, total_cents: 5_000 },
        { category_id: 2, total_cents: 15_000 },
      ],
      expenseByCategory: [
        { category_id: 1, total_cents: 20_000 },
        { category_id: 9, total_cents: 500 },
      ],
    },
    [
      { id: 2, name: "Business" },
      { id: 1, name: "Salary" },
    ],
    [{ id: 1, name: "Food" }],
  );
  assert.equal(display.netCents, -500);
  assert.deepEqual(display.incomeRows, [
    { name: "Business", totalCents: 15_000 },
    { name: "Salary", totalCents: 5_000 },
  ]);
  assert.deepEqual(display.expenseRows, [
    { name: "Food", totalCents: 20_000 },
    { name: "Category #9", totalCents: 500 },
  ]);
});

test("monthSummaryDisplay with no entries yields zeroed display", () => {
  const display = monthSummaryDisplay(
    {
      incomeCents: 0,
      expenseCents: 0,
      incomeByCategory: [],
      expenseByCategory: [],
    },
    [],
    [],
  );
  assert.equal(display.netCents, 0);
  assert.deepEqual(display.incomeRows, []);
  assert.deepEqual(display.expenseRows, []);
});

test("yearDisplay aggregates monthly totals and nets each month", () => {
  const months = Array.from({ length: 12 }, () => ({
    incomeCents: 0,
    expenseCents: 0,
  }));
  months[0] = { incomeCents: 10_000, expenseCents: 4_000 };
  months[11] = { incomeCents: 5_000, expenseCents: 7_000 };
  const d = yearDisplay("2026", months);
  assert.equal(d.totalIncomeCents, 15_000);
  assert.equal(d.totalExpenseCents, 11_000);
  assert.equal(d.netCents, 4_000);
  assert.equal(d.months.length, 12);
  assert.deepEqual(d.months[0], {
    yearMonth: "2026-01",
    incomeCents: 10_000,
    expenseCents: 4_000,
    netCents: 6_000,
  });
  assert.deepEqual(d.months[11], {
    yearMonth: "2026-12",
    incomeCents: 5_000,
    expenseCents: 7_000,
    netCents: -2_000,
  });
});

test("yearDisplay with no entries yields zeroed totals", () => {
  const d = yearDisplay(
    "2026",
    Array.from({ length: 12 }, () => ({ incomeCents: 0, expenseCents: 0 })),
  );
  assert.equal(d.totalIncomeCents, 0);
  assert.equal(d.totalExpenseCents, 0);
  assert.equal(d.netCents, 0);
});

test("limitDisplayRows joins statuses, computes percent, sorts by urgency", () => {
  const rows = limitDisplayRows(
    [
      { id: 1, name: "Food" },
      { id: 2, name: "Transport" },
      { id: 3, name: "Rent" },
    ],
    [
      { categoryId: 1, spentCents: 12_000, limitCents: 10_000 },
      { categoryId: 2, spentCents: 4_000, limitCents: 10_000 },
      { categoryId: 3, spentCents: 1_000, limitCents: null },
    ],
  );
  assert.deepEqual(
    rows.map((r) => r.name),
    ["Food", "Transport", "Rent"],
  );
  assert.equal(rows[0]?.status, "exceeded");
  assert.equal(rows[0]?.percent, 120);
  assert.equal(rows[1]?.status, "ok");
  assert.equal(rows[1]?.percent, 40);
  assert.equal(rows[2]?.limitCents, null);
  assert.equal(rows[2]?.percent, null);
});

test("limitDisplayRows handles categories without status and unknown ids", () => {
  const rows = limitDisplayRows(
    [{ id: 1, name: "Food" }],
    [{ categoryId: 7, spentCents: 500, limitCents: null }],
  );
  assert.deepEqual(
    rows.map((r) => [r.name, r.spentCents, r.status]),
    [
      ["Category #7", 500, "ok"],
      ["Food", 0, "ok"],
    ],
  );
});

test("recurringDisplay reports due occurrences and overdue state", () => {
  const notDue = recurringDisplay(
    { frequency: "monthly", next_due_date: "2026-11-01" },
    "2026-10-10",
  );
  assert.deepEqual(notDue.occurrences, []);
  assert.equal(notDue.overdue, false);

  const dueToday = recurringDisplay(
    { frequency: "weekly", next_due_date: "2026-10-10" },
    "2026-10-10",
  );
  assert.deepEqual(dueToday.occurrences, ["2026-10-10"]);
  assert.equal(dueToday.overdue, false, "due today is due, not overdue");

  const behind = recurringDisplay(
    { frequency: "monthly", next_due_date: "2026-08-01" },
    "2026-10-10",
  );
  assert.deepEqual(behind.occurrences, [
    "2026-08-01",
    "2026-09-01",
    "2026-10-01",
  ]);
  assert.equal(behind.overdue, true);
});

// -- P2-9: rename/delete escape hatches, and recurring edit/delete -----------------

test("renameWallet / renameCategory: one UPDATE, id-scoped", async () => {
  const driver = createMockDriver();
  const budget = createBudgetRepo(driver);
  await budget.renameWallet(2, "Cash");
  await budget.renameExpenseCategory(3, "Food");
  const renames = driver.callsTo("execute");
  assert.equal(renames[0]?.args[0], "UPDATE wallets SET name = ? WHERE id = ?");
  assert.deepEqual(renames[0]?.args[1], ["Cash", 2]);
  assert.equal(
    renames[1]?.args[0],
    "UPDATE expense_categories SET name = ? WHERE id = ?",
  );
  assert.deepEqual(renames[1]?.args[1], ["Food", 3]);
});

test("deleteWallet: refused while entries reference it, and says how many", async () => {
  // The FKs have no ON DELETE action so SQLite would refuse anyway; this turns
  // that into a sentence the user can act on instead of a constraint error.
  const driver = createMockDriver({ results: [[{ uses: 7 }]] });
  await assert.rejects(
    () => createBudgetRepo(driver).deleteWallet(2),
    /7 entries recorded against it/,
  );
  assert.deepEqual(driver.callsTo("execute"), [], "nothing deleted");
});

test("deleteWallet: singular wording for one entry", async () => {
  const driver = createMockDriver({ results: [[{ uses: 1 }]] });
  await assert.rejects(
    () => createBudgetRepo(driver).deleteWallet(2),
    /1 entry recorded against it/,
  );
});

test("deleteWallet: an unused wallet is deleted", async () => {
  const driver = createMockDriver({ results: [[{ uses: 0 }]] });
  await createBudgetRepo(driver).deleteWallet(2);
  // F1: a recurring rule can be the only row referencing the wallet, and its
  // FK has no ON DELETE action — so the reference is nulled in the SAME batch,
  // ahead of the DELETE. One batch: the two statements commit or roll back as
  // one, and nothing reaches the driver outside it.
  const batch = argsOf(driver, "batch")[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(batch.length, 2, "null the recurring reference, then delete");
  assert.equal(
    at(batch, 0, "batch").sql,
    "UPDATE recurring_payments SET wallet_id = NULL WHERE wallet_id = ?",
  );
  assert.deepEqual(at(batch, 0, "batch").params, [2]);
  assert.equal(at(batch, 1, "batch").sql, "DELETE FROM wallets WHERE id = ?");
  assert.deepEqual(at(batch, 1, "batch").params, [2]);
  assert.deepEqual(driver.callsTo("execute"), [], "no write outside the batch");
});

test("deleteExpenseCategory: refused while in use, allowed when not", async () => {
  const used = createMockDriver({ results: [[{ uses: 3 }]] });
  await assert.rejects(
    () => createBudgetRepo(used).deleteExpenseCategory(3),
    /3 expense entries in it/,
  );
  assert.deepEqual(used.callsTo("execute"), []);
  assert.deepEqual(used.callsTo("batch"), []);

  const unused = createMockDriver({ results: [[{ uses: 0 }]] });
  await createBudgetRepo(unused).deleteExpenseCategory(3);
  // Same F1 shape as `deleteWallet`: recurring rule reference nulled, then the
  // category deleted, in one batch.
  const batch = argsOf(unused, "batch")[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(batch.length, 2, "null the recurring reference, then delete");
  assert.equal(
    at(batch, 0, "batch").sql,
    "UPDATE recurring_payments SET category_id = NULL WHERE category_id = ?",
  );
  assert.deepEqual(at(batch, 0, "batch").params, [3]);
  assert.equal(
    at(batch, 1, "batch").sql,
    "DELETE FROM expense_categories WHERE id = ?",
  );
  assert.deepEqual(at(batch, 1, "batch").params, [3]);
  assert.deepEqual(unused.callsTo("execute"), [], "no write outside the batch");
});

test("deleteIncomeCategory: same usage rule on the income side", async () => {
  const used = createMockDriver({ results: [[{ uses: 2 }]] });
  await assert.rejects(
    () => createBudgetRepo(used).deleteIncomeCategory(3),
    /2 income entries in it/,
  );
  const unused = createMockDriver({ results: [[{ uses: 0 }]] });
  await createBudgetRepo(unused).deleteIncomeCategory(3);
  const call = at(unused.callsTo("execute"), 0, "execute");
  assert.equal(call.args[0], "DELETE FROM income_categories WHERE id = ?");
});

test("expenseCategoryUsage: reported so the UI can explain itself before a click", async () => {
  const driver = createMockDriver({ results: [[{ uses: 5 }]] });
  assert.equal(await createBudgetRepo(driver).expenseCategoryUsage(3), 5);
});

test("updateRecurring: writes only the provided fields", async () => {
  const driver = createMockDriver();
  await createBudgetRepo(driver).updateRecurring(6, {
    title: "Internet",
    frequency: "monthly",
    categoryId: null,
  });
  const call = at(driver.callsTo("execute"), 0, "execute");
  assert.match(
    call.args[0] as string,
    /UPDATE recurring_payments SET title = \?, category_id = \?, frequency = \? WHERE id = \?/,
  );
  assert.deepEqual(call.args[1], ["Internet", null, "monthly", 6]);
});

test("updateRecurring: a non-positive amount is refused before any write", async () => {
  const driver = createMockDriver();
  await assert.rejects(
    () => createBudgetRepo(driver).updateRecurring(6, { amountCents: 0 }),
    /greater than zero/,
  );
  assert.deepEqual(driver.callsTo("execute"), []);
});

test("deleteRecurring: removes the rule, and nothing else", async () => {
  const driver = createMockDriver();
  await createBudgetRepo(driver).deleteRecurring(6);
  const call = at(driver.callsTo("execute"), 0, "execute");
  assert.equal(call.args[0], "DELETE FROM recurring_payments WHERE id = ?");
  assert.deepEqual(call.args[1], [6]);
  assert.deepEqual(driver.callsTo("batch"), []);
});

test("the recurring mutators queue behind an in-flight markRecurringPaid (J3)", async () => {
  // All three share `recurring:${id}` with `markRecurringPaid`: the gate
  // parks the mark mid-read-compute-write, and a pause, an edit, or a
  // delete slipping in there would be clobbered by the mark's stale
  // `advanceDate` — or would let it book occurrences for a deleted rule.
  const rule = {
    id: 7,
    frequency: "monthly",
    amount_cents: 9000,
    category_id: 2,
    wallet_id: 3,
    next_due_date: "2026-09-10",
    title: "Net",
    note: "",
  };
  const base = createMockDriver({ results: [[rule]] });
  const { driver, release } = gatedQueryDriver(base);
  const budget = createBudgetRepo(driver);
  const marking = budget.markRecurringPaid(7, "2026-10-20", {
    categoryId: 5,
    walletId: 6,
  });
  await tick();
  const edits = Promise.all([
    budget.setRecurringActive(7, false),
    budget.updateRecurring(7, { note: "edited" }),
    budget.deleteRecurring(7),
  ]);
  await tick();
  assert.equal(
    base.callsTo("execute").length,
    0,
    "no recurring mutator may write while markRecurringPaid holds recurring:7",
  );
  release();
  await Promise.all([marking, edits]);
  assert.equal(base.callsTo("batch").length, 1, "the mark's own batch");
  const writes = base.callsTo("execute").map((call) => call.args[0] as string);
  assert.equal(writes.length, 3, "the three mutators ran, in queue order");
  assert.match(writes[0] ?? "", /UPDATE recurring_payments SET active = \?/);
  assert.match(writes[1] ?? "", /UPDATE recurring_payments SET note = \?/);
  assert.match(writes[2] ?? "", /DELETE FROM recurring_payments/);
});

test("convertEntry: the delete and the insert are ONE batch, in that order", async () => {
  // The whole point of the method. `db::batch` is a single transaction, so the
  // entry is never briefly absent from the day's totals and never momentarily
  // present in both tables — either would show a total that is wrong, which is
  // the one thing a money ledger may not do. Two separate calls would allow an
  // INSERT that succeeded beside a failed DELETE, which double-counts.
  const driver = createMockDriver();
  await createBudgetRepo(driver).convertEntry("income", 7, {
    amountCents: 12_000,
    categoryId: 2,
    walletId: 1,
    entryDate: "2026-10-17",
    note: "moved by mistake",
  });
  assert.deepEqual(
    driver.callsTo("execute"),
    [],
    "no statement outside the batch",
  );
  const batch = at(driver.callsTo("batch"), 0, "batch");
  const statements = batch.args[0] as { sql: string; params: unknown[] }[];
  assert.equal(statements.length, 2);
  assert.equal(statements[0]?.sql, "DELETE FROM income_entries WHERE id = ?");
  assert.deepEqual(statements[0]?.params, [7]);
  assert.match(
    statements[1]?.sql ?? "",
    /INSERT INTO expense_entries \(amount_cents, category_id, wallet_id, entry_date, note, created_at\)/,
  );
  assert.deepEqual(statements[1]?.params.slice(0, 5), [
    12_000,
    2,
    1,
    "2026-10-17",
    "moved by mistake",
  ]);
  // The stamp is the replacement's own — a conversion is a new row, not the old
  // one relabelled — and it is a local `yyyy-mm-dd`, never a UTC ISO string.
  const stamp = statements[1]?.params[5];
  assert.match(
    String(stamp),
    /^\d{4}-\d{2}-\d{2}$/,
    `created_at must be a local date, got ${String(stamp)}`,
  );
});

test("convertEntry: the other direction moves expense -> income", async () => {
  const driver = createMockDriver();
  await createBudgetRepo(driver).convertEntry("expense", 4, {
    amountCents: 1000,
    categoryId: 3,
    walletId: 1,
    entryDate: "2026-10-17",
    note: "",
  });
  const statements = at(driver.callsTo("batch"), 0, "batch").args[0] as {
    sql: string;
  }[];
  assert.match(statements[0]?.sql ?? "", /DELETE FROM expense_entries/);
  assert.match(statements[1]?.sql ?? "", /INSERT INTO income_entries/);
});
