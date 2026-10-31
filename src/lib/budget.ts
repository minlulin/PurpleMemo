// Budget Tracker repository. Money is integer cents end to end; wallet
// balance = sum of income entries − sum of expense entries naming it. Expense
// limits warn at 80% and again when exceeded — they never block an entry.
// Recurring payments catch up to a date with a hard cap (never an unbounded
// loop).

import type { BatchStatement, DataDriver } from "../data/driver.ts";
import { advanceDate, monthRange, todayLocal, yearRange } from "./dates.ts";
import { createKeyedMutex } from "./mutex.ts";
import type {
  ExpenseCategoryRow,
  ExpenseEntryRow,
  ExpenseLimitRow,
  IncomeCategoryRow,
  RecurringFrequency,
  RecurringPaymentRow,
  WalletRow,
} from "./types.ts";

/** Hard cap on catch-up occurrences per mark-paid call. */
export const CATCHUP_MAX_OCCURRENCES = 60;

/**
 * Trim a user-supplied wallet/category name; empty or whitespace-only input
 * is invalid (`null`) so the UI never creates a nameless row.
 */
export function cleanName(raw: string): string | null {
  const name = raw.trim();
  return name.length > 0 ? name : null;
}

/** Resolve a cleared date input to the supplied local day before saving. */
export function resolveEntryDate(entryDate: string, today: string): string {
  return entryDate || today;
}

export interface EntryInput {
  amountCents: number;
  categoryId: number;
  walletId: number;
  entryDate: string;
  note?: string;
}

/** The two ledger tables. They share one column list on purpose. */
export type LedgerKind = "income" | "expense";

/** A ledger insert, ready for `driver.execute` or a `driver.batch` array. */
export interface LedgerInsert extends BatchStatement {
  /** amount, category, wallet, entry date, note, created_at. */
  params: (string | number)[];
}

/**
 * The single INSERT shape for both ledger tables.
 *
 * Five call sites used to spell this statement out separately (two entry
 * creates, recurring catch-up, job payment, payable payment — docs/AUDIT.md
 * DUP-05). A column added to one copy but not the others would silently write
 * defaults, so all of them go through here now.
 *
 * `createdAt` defaults to today's local date; batch callers pass one stamp for
 * every row they write so a multi-row catch-up cannot straddle midnight.
 */
export function ledgerInsertStatement(
  kind: LedgerKind,
  entry: EntryInput & { createdAt?: string },
): LedgerInsert {
  const table = kind === "income" ? "income_entries" : "expense_entries";
  return {
    sql: `INSERT INTO ${table} (amount_cents, category_id, wallet_id, entry_date, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
    params: [
      entry.amountCents,
      entry.categoryId,
      entry.walletId,
      entry.entryDate,
      entry.note ?? "",
      entry.createdAt ?? todayLocal(),
    ],
  };
}

/**
 * One day's ledger row: an `expense_entries` row (the two ledger tables share
 * a column list) plus which side it came from. The row type now comes from
 * `types.ts` like every other table's (docs/AUDIT.md SCHEMA-02).
 */
export type DayEntry = ExpenseEntryRow & { kind: LedgerKind };

/**
 * One day's money in and out, aggregated rather than listed (I3).
 *
 * The same two numbers `dayMoneyTotals` derives from a day's {@link DayEntry}
 * rows — for a caller that only ever publishes them, the rows themselves are
 * the waste.
 */
export interface DayTotals {
  incomeCents: number;
  expenseCents: number;
}

export interface CategoryTotal {
  category_id: number;
  total_cents: number;
}

export interface MonthSummary {
  incomeCents: number;
  expenseCents: number;
  /**
   * Per-category totals, kept separate by kind: income and expense
   * categories live in different tables with independently generated ids,
   * so merging them by id would combine unrelated categories.
   */
  incomeByCategory: CategoryTotal[];
  expenseByCategory: CategoryTotal[];
}

export type LimitStatus = "ok" | "warn" | "exceeded";

export interface SummaryCategoryRow {
  name: string;
  totalCents: number;
}

export interface MonthDisplay {
  incomeCents: number;
  expenseCents: number;
  netCents: number;
  /** Per-category income totals, largest first. */
  incomeRows: SummaryCategoryRow[];
  /** Per-category expense totals, largest first. */
  expenseRows: SummaryCategoryRow[];
}

function toDisplayRows(
  totals: CategoryTotal[],
  names: Map<number, string>,
): SummaryCategoryRow[] {
  return totals
    .map((t) => ({
      name: names.get(t.category_id) ?? `Category #${t.category_id}`,
      totalCents: t.total_cents,
    }))
    .sort(
      (a, b) => b.totalCents - a.totalCents || a.name.localeCompare(b.name),
    );
}

/**
 * Turn a MonthSummary into display rows (monthly view + per-category
 * totals). Income and expense categories are labelled from their own tables
 * (independent id spaces); a category deleted after use keeps its total under
 * a `Category #<id>` label rather than disappearing from the summary.
 */
export function monthSummaryDisplay(
  summary: MonthSummary,
  incomeCategories: Pick<IncomeCategoryRow, "id" | "name">[],
  expenseCategories: Pick<ExpenseCategoryRow, "id" | "name">[],
): MonthDisplay {
  return {
    incomeCents: summary.incomeCents,
    expenseCents: summary.expenseCents,
    netCents: summary.incomeCents - summary.expenseCents,
    incomeRows: toDisplayRows(
      summary.incomeByCategory,
      new Map(incomeCategories.map((c) => [c.id, c.name])),
    ),
    expenseRows: toDisplayRows(
      summary.expenseByCategory,
      new Map(expenseCategories.map((c) => [c.id, c.name])),
    ),
  };
}

/** Warning thresholds: warn at 80%, warn again when exceeded. */
export function limitStatus(
  spentCents: number,
  limitCents: number | null,
): LimitStatus {
  if (limitCents === null || limitCents <= 0) return "ok";
  const ratio = spentCents / limitCents;
  if (ratio >= 1) return "exceeded";
  if (ratio >= 0.8) return "warn";
  return "ok";
}

/**
 * Status the limit would reach if `additionalCents` were added to the spend
 * (entry-form warning: the 80%/exceeded warnings never block an entry,
 * they only tell the user before they save).
 */
export function prospectiveStatus(
  spentCents: number,
  limitCents: number | null,
  additionalCents: number,
): LimitStatus {
  return limitStatus(spentCents + Math.max(0, additionalCents), limitCents);
}

export interface LimitStatusInput {
  categoryId: number;
  spentCents: number;
  limitCents: number | null;
}

export interface LimitDisplayRow {
  categoryId: number;
  name: string;
  spentCents: number;
  limitCents: number | null;
  status: LimitStatus;
  /** Percent of limit spent, rounded; `null` when no limit is set. */
  percent: number | null;
}

const STATUS_RANK: Record<LimitStatus, number> = {
  exceeded: 0,
  warn: 1,
  ok: 2,
};

/**
 * Join expense categories with their per-month limit status into display
 * rows (limits view). Worst-offending categories sort first; categories
 * with no limit sink below limited ones; a category deleted after use keeps
 * its row under `Category #<id>`.
 */
export function limitDisplayRows(
  categories: Pick<ExpenseCategoryRow, "id" | "name">[],
  statuses: LimitStatusInput[],
): LimitDisplayRow[] {
  const byCategory = new Map(statuses.map((s) => [s.categoryId, s]));
  const seen = new Set<number>();
  const rows: LimitDisplayRow[] = categories.map((c) => {
    const s = byCategory.get(c.id);
    const limitCents = s?.limitCents ?? null;
    seen.add(c.id);
    return {
      categoryId: c.id,
      name: c.name,
      spentCents: s?.spentCents ?? 0,
      limitCents,
      status: limitStatus(s?.spentCents ?? 0, limitCents),
      percent:
        limitCents !== null && limitCents > 0
          ? Math.round(((s?.spentCents ?? 0) / limitCents) * 100)
          : null,
    };
  });
  for (const s of statuses) {
    if (seen.has(s.categoryId)) continue;
    rows.push({
      categoryId: s.categoryId,
      name: `Category #${s.categoryId}`,
      spentCents: s.spentCents,
      limitCents: s.limitCents,
      status:
        s.limitCents === null ? "ok" : limitStatus(s.spentCents, s.limitCents),
      percent:
        s.limitCents !== null && s.limitCents > 0
          ? Math.round((s.spentCents / s.limitCents) * 100)
          : null,
    });
  }
  return rows.sort((a, b) => {
    const pa = a.percent ?? -1;
    const pb = b.percent ?? -1;
    return (
      STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
      (a.limitCents === null ? 1 : 0) - (b.limitCents === null ? 1 : 0) ||
      pb - pa ||
      a.name.localeCompare(b.name)
    );
  });
}

export interface YearMonthTotals {
  yearMonth: string;
  incomeCents: number;
  expenseCents: number;
  netCents: number;
}

export interface YearDisplay {
  totalIncomeCents: number;
  totalExpenseCents: number;
  netCents: number;
  months: YearMonthTotals[];
}

/**
 * Aggregate per-month totals into the yearly view. `monthly` is
 * indexed by month (0 = January); a shorter array just means the later
 * months are not listed yet.
 */
export function yearDisplay(
  year: string,
  monthly: { incomeCents: number; expenseCents: number }[],
): YearDisplay {
  const months: YearMonthTotals[] = monthly.map((m, i) => ({
    yearMonth: `${year}-${String(i + 1).padStart(2, "0")}`,
    incomeCents: m.incomeCents,
    expenseCents: m.expenseCents,
    netCents: m.incomeCents - m.expenseCents,
  }));
  const totalIncomeCents = months.reduce((s, m) => s + m.incomeCents, 0);
  const totalExpenseCents = months.reduce((s, m) => s + m.expenseCents, 0);
  return {
    totalIncomeCents,
    totalExpenseCents,
    netCents: totalIncomeCents - totalExpenseCents,
    months,
  };
}

export interface RecurringDisplay {
  /** Due occurrences on/before `onDate`, oldest first, catch-up capped. */
  occurrences: string[];
  /** `next_due_date` is strictly before `onDate` — the same rule as  loans. */
  overdue: boolean;
}

/**
 * Display state for one recurring rule against a date: which occurrences
 * marking-paid would create (same capped walk `markRecurringPaid` performs)
 * and whether the rule is already overdue.
 */
export function recurringDisplay(
  rule: Pick<RecurringPaymentRow, "frequency" | "next_due_date">,
  onDate: string,
): RecurringDisplay {
  return {
    occurrences: dueOccurrences(rule, onDate),
    overdue: rule.next_due_date < onDate,
  };
}

/**
 * Occurrences due on/before `onDate`, oldest first, hard-capped at
 * CATCHUP_MAX_OCCURRENCES (— never an unbounded loop). Computed in
 * JS from the rule's frequency so the cap is explicit and testable.
 */
export function dueOccurrences(
  rule: Pick<RecurringPaymentRow, "frequency" | "next_due_date">,
  onDate: string,
): string[] {
  const out: string[] = [];
  let due = rule.next_due_date;
  while (due <= onDate && out.length < CATCHUP_MAX_OCCURRENCES) {
    out.push(due);
    due = advanceDate(due, rule.frequency);
  }
  return out;
}

export interface RecurringInput {
  title: string;
  amountCents: number;
  categoryId?: number | null;
  walletId?: number | null;
  frequency: RecurringFrequency;
  nextDueDate: string;
  note?: string;
}

export function createBudgetRepo(driver: DataDriver) {
  const mutex = createKeyedMutex();

  return {
    // -- Wallets ------------------------------------------------------
    async listWallets(): Promise<WalletRow[]> {
      return driver.query<WalletRow>("SELECT * FROM wallets ORDER BY id");
    },

    async createWallet(name: string): Promise<number> {
      const today = todayLocal();
      const r = await driver.execute(
        "INSERT INTO wallets (name, created_at) VALUES (?, ?)",
        [name, today],
      );
      return r.lastInsertRowid;
    },

    /**
     * Rename a wallet (review P2-9). The schema has `name TEXT NOT NULL
     * UNIQUE`, so a duplicate surfaces as a constraint error — reported to the
     * user by the page's normal error path rather than pre-checked here, so the
     * check cannot race the write.
     *
     * Entries reference the wallet by id, not by name, so a rename is safe and
     * rewrites nothing: the label on every past entry follows the id.
     */
    async renameWallet(id: number, name: string): Promise<void> {
      await driver.execute("UPDATE wallets SET name = ? WHERE id = ?", [
        name,
        id,
      ]);
    },

    /**
     * Delete a wallet, but only while nothing uses it (review P2-9).
     *
     * `income_entries.wallet_id` and `expense_entries.wallet_id` are plain
     * `REFERENCES` with no `ON DELETE` action, so SQLite would refuse the
     * delete — correctly. Rather than surface that as an opaque foreign-key
     * error, the usage is checked and named: a wallet with entries in it is
     * history, and deleting it would strand those entries.
     *
     * `recurring_payments.wallet_id` has no ON DELETE action either; null it
     * out first so deleting a wallet with only recurring rules attached does
     * not hit a foreign-key error.
     */
    async deleteWallet(id: number): Promise<void> {
      const rows = await driver.query<{ uses: number }>(
        `SELECT (SELECT COUNT(*) FROM income_entries  WHERE wallet_id = ?)
              + (SELECT COUNT(*) FROM expense_entries WHERE wallet_id = ?) AS uses`,
        [id, id],
      );
      const uses = rows[0]?.uses ?? 0;
      if (uses > 0) {
        throw new Error(
          `This wallet has ${uses} entr${uses === 1 ? "y" : "ies"} recorded against it. Rename it instead, or delete those entries first.`,
        );
      }
      await driver.batch([
        {
          sql: "UPDATE recurring_payments SET wallet_id = NULL WHERE wallet_id = ?",
          params: [id],
        },
        { sql: "DELETE FROM wallets WHERE id = ?", params: [id] },
      ]);
    },

    /** Balance = income − expense entries naming the wallet. */
    async walletBalanceCents(walletId: number): Promise<number> {
      const rows = await driver.query<{ balance_cents: number }>(
        `SELECT
           (SELECT COALESCE(SUM(amount_cents), 0) FROM income_entries  WHERE wallet_id = ?)
         - (SELECT COALESCE(SUM(amount_cents), 0) FROM expense_entries WHERE wallet_id = ?)
           AS balance_cents`,
        [walletId, walletId],
      );
      return rows[0]?.balance_cents ?? 0;
    },

    /**
     * Every wallet's balance in one query, optionally capped.
     *
     * `walletBalanceCents` is one IPC round-trip per wallet, which is fine for
     * the Budget page (it needs one wallet's detail) and wrong for the share
     * ticker, which wanted a list of 20 and paid 20 calls for it. Same
     * arithmetic, one statement.
     */
    async listWalletBalances(
      limit?: number,
    ): Promise<{ id: number; name: string; balanceCents: number }[]> {
      const rows = await driver.query<{
        id: number;
        name: string;
        balance_cents: number;
      }>(
        `SELECT w.id, w.name,
                (SELECT COALESCE(SUM(amount_cents), 0) FROM income_entries  WHERE wallet_id = w.id)
              - (SELECT COALESCE(SUM(amount_cents), 0) FROM expense_entries WHERE wallet_id = w.id)
                AS balance_cents
           FROM wallets w
          ORDER BY w.id${limit !== undefined ? " LIMIT ?" : ""}`,
        limit !== undefined ? [limit] : [],
      );
      return rows.map((r) => ({
        id: r.id,
        name: r.name,
        balanceCents: r.balance_cents,
      }));
    },

    // -- Categories ---------------------------------------------------
    async listIncomeCategories(): Promise<IncomeCategoryRow[]> {
      return driver.query<IncomeCategoryRow>(
        "SELECT * FROM income_categories ORDER BY id",
      );
    },

    async createIncomeCategory(name: string): Promise<number> {
      const r = await driver.execute(
        "INSERT INTO income_categories (name, created_at) VALUES (?, ?)",
        [name, todayLocal()],
      );
      return r.lastInsertRowid;
    },

    async listExpenseCategories(): Promise<ExpenseCategoryRow[]> {
      return driver.query<ExpenseCategoryRow>(
        "SELECT * FROM expense_categories ORDER BY id",
      );
    },

    async createExpenseCategory(name: string): Promise<number> {
      const r = await driver.execute(
        "INSERT INTO expense_categories (name, created_at) VALUES (?, ?)",
        [name, todayLocal()],
      );
      return r.lastInsertRowid;
    },

    /** Rename an income category — entries follow the id, not the name. */
    async renameIncomeCategory(id: number, name: string): Promise<void> {
      await driver.execute(
        "UPDATE income_categories SET name = ? WHERE id = ?",
        [name, id],
      );
    },

    /** Rename an expense category — entries follow the id, not the name. */
    async renameExpenseCategory(id: number, name: string): Promise<void> {
      await driver.execute(
        "UPDATE expense_categories SET name = ? WHERE id = ?",
        [name, id],
      );
    },

    /**
     * Delete an expense category, only while unused (review P2-9). Its limit
     * cascades (`expense_limits.category_id ... ON DELETE CASCADE`), but
     * entries do not — an expense entry naming a deleted category would leave
     * the Budget's totals unable to explain themselves.
     *
     * `recurring_payments.category_id` has no ON DELETE action; null it out
     * first so deleting a category with only recurring rules attached does
     * not hit a foreign-key error.
     */
    async deleteExpenseCategory(id: number): Promise<void> {
      const rows = await driver.query<{ uses: number }>(
        "SELECT COUNT(*) AS uses FROM expense_entries WHERE category_id = ?",
        [id],
      );
      const uses = rows[0]?.uses ?? 0;
      if (uses > 0) {
        throw new Error(
          `This category has ${uses} expense entr${uses === 1 ? "y" : "ies"} in it. Rename it instead, or delete those entries first.`,
        );
      }
      await driver.batch([
        {
          sql: "UPDATE recurring_payments SET category_id = NULL WHERE category_id = ?",
          params: [id],
        },
        { sql: "DELETE FROM expense_categories WHERE id = ?", params: [id] },
      ]);
    },

    /** Delete an income category, only while unused. */
    async deleteIncomeCategory(id: number): Promise<void> {
      const rows = await driver.query<{ uses: number }>(
        "SELECT COUNT(*) AS uses FROM income_entries WHERE category_id = ?",
        [id],
      );
      const uses = rows[0]?.uses ?? 0;
      if (uses > 0) {
        throw new Error(
          `This category has ${uses} income entr${uses === 1 ? "y" : "ies"} in it. Rename it instead, or delete those entries first.`,
        );
      }
      await driver.execute("DELETE FROM income_categories WHERE id = ?", [id]);
    },

    /**
     * How many entries name this category — the page shows this next to the
     * delete control, so an in-use category explains itself before it is
     * clicked rather than only in the error afterwards.
     */
    async expenseCategoryUsage(id: number): Promise<number> {
      const rows = await driver.query<{ uses: number }>(
        "SELECT COUNT(*) AS uses FROM expense_entries WHERE category_id = ?",
        [id],
      );
      return rows[0]?.uses ?? 0;
    },

    // -- Income / expense entries --------------------------------------
    async createIncomeEntry(input: EntryInput): Promise<number> {
      const stmt = ledgerInsertStatement("income", input);
      const r = await driver.execute(stmt.sql, stmt.params);
      return r.lastInsertRowid;
    },

    async createExpenseEntry(input: EntryInput): Promise<number> {
      const stmt = ledgerInsertStatement("expense", input);
      const r = await driver.execute(stmt.sql, stmt.params);
      return r.lastInsertRowid;
    },

    /**
     * Partial update: only the provided fields are written (`undefined`
     * leaves the column unchanged; explicit `null` clears a nullable one).
     */
    async updateIncomeEntry(
      id: number,
      fields: Partial<EntryInput>,
    ): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (fields.amountCents !== undefined) {
        sets.push("amount_cents = ?");
        params.push(fields.amountCents);
      }
      if (fields.categoryId !== undefined) {
        sets.push("category_id = ?");
        params.push(fields.categoryId);
      }
      if (fields.walletId !== undefined) {
        sets.push("wallet_id = ?");
        params.push(fields.walletId);
      }
      if (fields.entryDate !== undefined) {
        sets.push("entry_date = ?");
        params.push(fields.entryDate);
      }
      if (fields.note !== undefined) {
        sets.push("note = ?");
        params.push(fields.note);
      }
      if (sets.length === 0) return;
      params.push(id);
      await driver.execute(
        `UPDATE income_entries SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
    },

    /** Partial update: only the provided fields are written (see above). */
    async updateExpenseEntry(
      id: number,
      fields: Partial<EntryInput>,
    ): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (fields.amountCents !== undefined) {
        sets.push("amount_cents = ?");
        params.push(fields.amountCents);
      }
      if (fields.categoryId !== undefined) {
        sets.push("category_id = ?");
        params.push(fields.categoryId);
      }
      if (fields.walletId !== undefined) {
        sets.push("wallet_id = ?");
        params.push(fields.walletId);
      }
      if (fields.entryDate !== undefined) {
        sets.push("entry_date = ?");
        params.push(fields.entryDate);
      }
      if (fields.note !== undefined) {
        sets.push("note = ?");
        params.push(fields.note);
      }
      if (sets.length === 0) return;
      params.push(id);
      await driver.execute(
        `UPDATE expense_entries SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
    },

    async deleteIncomeEntry(id: number): Promise<void> {
      await driver.execute("DELETE FROM income_entries WHERE id = ?", [id]);
    },

    /**
     * Turn an entry into the other kind — income to expense, or back (review
     * P2-9). The Income/Expense toggle used to be disabled while editing, so an
     * entry logged as the wrong kind could only be fixed by deleting it and
     * retyping it, which loses the note and the date unless both are remembered.
     *
     * This carries them: the old row is removed and the new one inserted with
     * the amount, date, note and the newly chosen category and wallet. The two
     * tables are genuinely different facts, so the row cannot be `UPDATE`d
     * across — it has to be replaced — but "replace" here means "the same
     * transaction, counted the other way", not "a new transaction".
     *
     * **Both statements go in one `driver.batch`, and that is the whole point.**
     * `db::batch` is a single transaction, so the entry is never briefly absent
     * from the day's totals and never momentarily present in both tables —
     * either would show the user a total that is wrong, which is the one thing a
     * money ledger may not do. Two separate calls would allow exactly that: an
     * INSERT that succeeded beside a failed DELETE double-counts the
     * transaction.
     *
     * No id comes back, and deliberately: the replacement necessarily has a new
     * one, and the caller re-reads the day from the database rather than
     * tracking a row id across a kind change.
     */
    async convertEntry(
      from: "income" | "expense",
      id: number,
      input: EntryInput,
    ): Promise<void> {
      const fromTable =
        from === "income" ? "income_entries" : "expense_entries";
      const toTable = from === "income" ? "expense_entries" : "income_entries";
      await driver.batch([
        { sql: `DELETE FROM ${fromTable} WHERE id = ?`, params: [id] },
        {
          sql: `INSERT INTO ${toTable} (amount_cents, category_id, wallet_id, entry_date, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          params: [
            input.amountCents,
            input.categoryId,
            input.walletId,
            input.entryDate,
            input.note ?? "",
            todayLocal(),
          ],
        },
      ]);
    },

    async deleteExpenseEntry(id: number): Promise<void> {
      await driver.execute("DELETE FROM expense_entries WHERE id = ?", [id]);
    },

    /**
     * Both entry totals for one day, summed in SQL — one statement, always
     * one row (I3).
     *
     * `listDayEntries` returns every row of the day, which is what the Budget
     * page's list needs and what the 30-second LAN share publisher must not do:
     * the snapshot publishes two numbers, so the cost of that read used to
     * grow with the day's activity while its answer never changed size. This
     * is that sum pushed to the database; the rows stay where a list is
     * actually drawn.
     */
    async dayTotals(entryDate: string): Promise<DayTotals> {
      const rows = await driver.query<{
        income_cents: number;
        expense_cents: number;
      }>(
        `SELECT (SELECT COALESCE(SUM(amount_cents), 0) FROM income_entries  WHERE entry_date = ?)
                    AS income_cents,
                (SELECT COALESCE(SUM(amount_cents), 0) FROM expense_entries WHERE entry_date = ?)
                    AS expense_cents`,
        [entryDate, entryDate],
      );
      const row = rows[0];
      return {
        incomeCents: row?.income_cents ?? 0,
        expenseCents: row?.expense_cents ?? 0,
      };
    },

    /** Both entry kinds for one day — the daily list view. */
    async listDayEntries(entryDate: string): Promise<DayEntry[]> {
      const rows = await driver.query<DayEntry>(
        `SELECT 'income' AS kind, id, amount_cents, category_id, wallet_id, entry_date, note, created_at
           FROM income_entries WHERE entry_date = ?
         UNION ALL
         SELECT 'expense' AS kind, id, amount_cents, category_id, wallet_id, entry_date, note, created_at
           FROM expense_entries WHERE entry_date = ?
         ORDER BY kind, id`,
        [entryDate, entryDate],
      );
      return rows;
    },

    // -- Summaries (monthly / yearly / per-category) --------------------
    // Range predicates (`entry_date >= from AND entry_date < to`) rather than
    // `substr(entry_date, 1, 7) = ?`: a function of the column cannot use the
    // date indexes, so the substr form was a full scan (docs/AUDIT.md PERF-01).
    async monthlySummary(yearMonth: string): Promise<MonthSummary> {
      const { from, to } = monthRange(yearMonth);
      const [incomeRows, expenseRows, incomeByCat, expenseByCat] =
        await Promise.all([
          driver.query<{ total: number }>(
            "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM income_entries WHERE entry_date >= ? AND entry_date < ?",
            [from, to],
          ),
          driver.query<{ total: number }>(
            "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM expense_entries WHERE entry_date >= ? AND entry_date < ?",
            [from, to],
          ),
          driver.query<CategoryTotal>(
            "SELECT category_id, SUM(amount_cents) AS total_cents FROM income_entries WHERE entry_date >= ? AND entry_date < ? GROUP BY category_id",
            [from, to],
          ),
          driver.query<CategoryTotal>(
            "SELECT category_id, SUM(amount_cents) AS total_cents FROM expense_entries WHERE entry_date >= ? AND entry_date < ? GROUP BY category_id",
            [from, to],
          ),
        ]);
      return {
        incomeCents: incomeRows[0]?.total ?? 0,
        expenseCents: expenseRows[0]?.total ?? 0,
        incomeByCategory: incomeByCat,
        expenseByCategory: expenseByCat,
      };
    },

    async yearlySummary(
      year: string,
    ): Promise<{ incomeCents: number; expenseCents: number }> {
      const { from, to } = yearRange(year);
      const [incomeRows, expenseRows] = await Promise.all([
        driver.query<{ total: number }>(
          "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM income_entries WHERE entry_date >= ? AND entry_date < ?",
          [from, to],
        ),
        driver.query<{ total: number }>(
          "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM expense_entries WHERE entry_date >= ? AND entry_date < ?",
          [from, to],
        ),
      ]);
      return {
        incomeCents: incomeRows[0]?.total ?? 0,
        expenseCents: expenseRows[0]?.total ?? 0,
      };
    },

    /**
     * All twelve month buckets for one year in four statements, in month order.
     *
     * The Year view used to call {@link monthlySummary} twelve times (48
     * statements per render — docs/AUDIT.md PERF-04). Grouping by
     * `substr(entry_date, 1, 7)` in the *select list* is fine: the range
     * predicate has already narrowed the rows, so no index is bypassed.
     */
    async yearSummary(year: string): Promise<MonthSummary[]> {
      const { from, to } = yearRange(year);
      const [
        incomeByMonth,
        expenseByMonth,
        incomeCatByMonth,
        expenseCatByMonth,
      ] = await Promise.all([
        driver.query<{ ym: string; total: number }>(
          "SELECT substr(entry_date, 1, 7) AS ym, COALESCE(SUM(amount_cents), 0) AS total FROM income_entries WHERE entry_date >= ? AND entry_date < ? GROUP BY ym",
          [from, to],
        ),
        driver.query<{ ym: string; total: number }>(
          "SELECT substr(entry_date, 1, 7) AS ym, COALESCE(SUM(amount_cents), 0) AS total FROM expense_entries WHERE entry_date >= ? AND entry_date < ? GROUP BY ym",
          [from, to],
        ),
        driver.query<{ ym: string; category_id: number; total_cents: number }>(
          "SELECT substr(entry_date, 1, 7) AS ym, category_id, SUM(amount_cents) AS total_cents FROM income_entries WHERE entry_date >= ? AND entry_date < ? GROUP BY ym, category_id",
          [from, to],
        ),
        driver.query<{ ym: string; category_id: number; total_cents: number }>(
          "SELECT substr(entry_date, 1, 7) AS ym, category_id, SUM(amount_cents) AS total_cents FROM expense_entries WHERE entry_date >= ? AND entry_date < ? GROUP BY ym, category_id",
          [from, to],
        ),
      ]);
      const months: MonthSummary[] = [];
      for (let i = 1; i <= 12; i++) {
        const ym = `${year}-${String(i).padStart(2, "0")}`;
        months.push({
          incomeCents: incomeByMonth.find((r) => r.ym === ym)?.total ?? 0,
          expenseCents: expenseByMonth.find((r) => r.ym === ym)?.total ?? 0,
          incomeByCategory: incomeCatByMonth
            .filter((r) => r.ym === ym)
            .map((r) => ({
              category_id: r.category_id,
              total_cents: r.total_cents,
            })),
          expenseByCategory: expenseCatByMonth
            .filter((r) => r.ym === ym)
            .map((r) => ({
              category_id: r.category_id,
              total_cents: r.total_cents,
            })),
        });
      }
      return months;
    },

    // -- Expense limits -------------------------------------------------
    async getLimit(categoryId: number): Promise<ExpenseLimitRow | undefined> {
      const rows = await driver.query<ExpenseLimitRow>(
        "SELECT * FROM expense_limits WHERE category_id = ?",
        [categoryId],
      );
      return rows[0];
    },

    async setLimit(categoryId: number, limitCents: number): Promise<void> {
      await driver.execute(
        `INSERT INTO expense_limits (category_id, limit_cents) VALUES (?, ?)
         ON CONFLICT(category_id) DO UPDATE SET limit_cents = excluded.limit_cents`,
        [categoryId, limitCents],
      );
    },

    async deleteLimit(categoryId: number): Promise<void> {
      await driver.execute("DELETE FROM expense_limits WHERE category_id = ?", [
        categoryId,
      ]);
    },

    /** Spend so far this month + limit + status, for the 80%/exceeded warnings. */
    async limitStatusFor(
      categoryId: number,
      yearMonth: string,
    ): Promise<{
      spentCents: number;
      limitCents: number | null;
      status: LimitStatus;
    }> {
      const { from, to } = monthRange(yearMonth);
      const [spentRows, limit] = await Promise.all([
        driver.query<{ total: number }>(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM expense_entries
           WHERE category_id = ? AND entry_date >= ? AND entry_date < ?`,
          [categoryId, from, to],
        ),
        this.getLimit(categoryId),
      ]);
      const spentCents = spentRows[0]?.total ?? 0;
      const limitCents = limit?.limit_cents ?? null;
      return {
        spentCents,
        limitCents,
        status: limitStatus(spentCents, limitCents),
      };
    },

    /**
     * Spend + limit for every expense category in one statement.
     *
     * The Limits view used to call {@link limitStatusFor} once per category
     * (2N+1 statements per render — docs/AUDIT.md PERF-03). This keeps the
     * same numbers with a fixed cost, and reports categories with no
     * `expense_limits` row as `limitCents: null` so the UI still lists them.
     */
    async limitStatuses(yearMonth: string): Promise<LimitStatusInput[]> {
      const { from, to } = monthRange(yearMonth);
      const rows = await driver.query<{
        id: number;
        limit_cents: number | null;
        spent_cents: number;
      }>(
        `SELECT c.id,
                el.limit_cents,
                COALESCE(SUM(ee.amount_cents), 0) AS spent_cents
           FROM expense_categories c
           LEFT JOIN expense_limits el ON el.category_id = c.id
           LEFT JOIN expense_entries ee
                  ON ee.category_id = c.id
                 AND ee.entry_date >= ?
                 AND ee.entry_date < ?
          GROUP BY c.id
          ORDER BY c.sort_order, c.id`,
        [from, to],
      );
      return rows.map((r) => ({
        categoryId: r.id,
        spentCents: r.spent_cents,
        limitCents: r.limit_cents,
      }));
    },

    // -- Recurring payments ---------------------------------------------
    async listRecurring(
      includeInactive = false,
    ): Promise<RecurringPaymentRow[]> {
      const sql = includeInactive
        ? "SELECT * FROM recurring_payments ORDER BY next_due_date, id"
        : "SELECT * FROM recurring_payments WHERE active = 1 ORDER BY next_due_date, id";
      return driver.query<RecurringPaymentRow>(sql);
    },

    async createRecurring(input: RecurringInput): Promise<number> {
      const r = await driver.execute(
        `INSERT INTO recurring_payments
           (title, amount_cents, category_id, wallet_id, frequency, next_due_date, note, active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
        [
          input.title,
          input.amountCents,
          input.categoryId ?? null,
          input.walletId ?? null,
          input.frequency,
          input.nextDueDate,
          input.note ?? "",
          todayLocal(),
        ],
      );
      return r.lastInsertRowid;
    },

    async getRecurring(id: number): Promise<RecurringPaymentRow | undefined> {
      const rows = await driver.query<RecurringPaymentRow>(
        "SELECT * FROM recurring_payments WHERE id = ?",
        [id],
      );
      return rows[0];
    },

    async setRecurringActive(id: number, active: boolean): Promise<void> {
      // Same `recurring:${id}` key as `markRecurringPaid` (J3): pausing a
      // rule the mark is mid-way through booking must queue, not interleave
      // with its read-compute-write.
      return mutex.withLock(`recurring:${id}`, async () => {
        await driver.execute(
          "UPDATE recurring_payments SET active = ? WHERE id = ?",
          [active ? 1 : 0, id],
        );
      });
    },

    /**
     * Partial update for a recurring rule (review P2-9). `undefined` leaves a
     * column alone; an explicit `null` clears a nullable one.
     *
     * The amount must stay positive to match the schema's own CHECK, so a typo
     * that would have been rejected by the database is refused here with a
     * sentence a person can act on.
     */
    async updateRecurring(
      id: number,
      fields: Partial<RecurringInput>,
    ): Promise<void> {
      // Same `recurring:${id}` key as `markRecurringPaid` (J3): an edit
      // landing after the mark read the rule but before its batch commits
      // would have its `next_due_date` overwritten by the mark's stale
      // `advanceDate`, while the occurrences it books use the stale amount
      // and frequency.
      return mutex.withLock(`recurring:${id}`, async () => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (fields.title !== undefined) {
          sets.push("title = ?");
          params.push(fields.title);
        }
        if (fields.amountCents !== undefined) {
          if (fields.amountCents <= 0) {
            throw new Error("A recurring amount must be greater than zero.");
          }
          sets.push("amount_cents = ?");
          params.push(fields.amountCents);
        }
        if (fields.categoryId !== undefined) {
          sets.push("category_id = ?");
          params.push(fields.categoryId);
        }
        if (fields.walletId !== undefined) {
          sets.push("wallet_id = ?");
          params.push(fields.walletId);
        }
        if (fields.frequency !== undefined) {
          sets.push("frequency = ?");
          params.push(fields.frequency);
        }
        if (fields.nextDueDate !== undefined) {
          sets.push("next_due_date = ?");
          params.push(fields.nextDueDate);
        }
        if (fields.note !== undefined) {
          sets.push("note = ?");
          params.push(fields.note);
        }
        if (sets.length === 0) return;
        params.push(id);
        await driver.execute(
          `UPDATE recurring_payments SET ${sets.join(", ")} WHERE id = ?`,
          params,
        );
      });
    },

    /**
     * Delete a recurring rule (review P2-9). Pause/resume was the only escape
     * before, so a rule created by mistake or abandoned for good stayed in the
     * list forever.
     *
     * Expense entries it already produced are left alone — cash basis,
     * same as a job's income entries.
     */
    async deleteRecurring(id: number): Promise<void> {
      // Same `recurring:${id}` key as `markRecurringPaid` (J3): a delete
      // landing inside the mark's read-compute-write would book phantom
      // expense entries for a rule that no longer exists.
      return mutex.withLock(`recurring:${id}`, async () => {
        await driver.execute("DELETE FROM recurring_payments WHERE id = ?", [
          id,
        ]);
      });
    },

    /** See {@link dueOccurrences} — same capped walk, kept on the repo API. */
    occurrencesDue(
      rule: Pick<RecurringPaymentRow, "frequency" | "next_due_date">,
      onDate: string,
    ): string[] {
      return dueOccurrences(rule, onDate);
    },

    /**
     * Mark a recurring payment paid up to `onDate`: creates one expense entry
     * per due occurrence and advances next_due_date past the last one — all
     * as a single batch write. Returns the created entry dates (oldest first).
     */
    async markRecurringPaid(
      id: number,
      onDate: string,
      fallback: { categoryId: number; walletId: number },
    ): Promise<string[]> {
      // Serialized per rule: two interleaved calls must not insert the same
      // occurrences twice (the UI also guards with busyId — defense in depth).
      return mutex.withLock(`recurring:${id}`, async () => {
        const rule = await this.getRecurring(id);
        if (!rule) throw new Error(`recurring payment ${id} not found`);
        const dates = this.occurrencesDue(rule, onDate);
        if (dates.length === 0) return [];
        const categoryId = rule.category_id ?? fallback.categoryId;
        const walletId = rule.wallet_id ?? fallback.walletId;
        const created = todayLocal();
        const statements = dates.map((due) => ({
          ...ledgerInsertStatement("expense", {
            amountCents: rule.amount_cents,
            categoryId,
            walletId,
            entryDate: due,
            note: rule.title,
            createdAt: created,
          }),
        }));
        const lastDue = dates[dates.length - 1];
        if (lastDue === undefined) {
          throw new Error("markRecurringPaid: due dates vanished mid-write");
        }
        statements.push({
          sql: "UPDATE recurring_payments SET next_due_date = ? WHERE id = ?",
          params: [advanceDate(lastDue, rule.frequency), id],
        });
        await driver.batch(statements);
        return dates;
      });
    },
  };
}
