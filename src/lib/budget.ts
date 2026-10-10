// Budget Tracker repository (§2.1). Money is integer cents end to end; wallet
// balance = sum of income entries − sum of expense entries naming it. Expense
// limits warn at 80% and again when exceeded — they never block an entry.
// Recurring payments catch up to a date with a hard cap (never an unbounded
// loop).

import type { DataDriver } from "../data/driver.ts";
import { advanceDate, todayLocal } from "./dates.ts";
import type {
  ExpenseCategoryRow,
  ExpenseLimitRow,
  IncomeCategoryRow,
  RecurringFrequency,
  RecurringPaymentRow,
  WalletRow,
} from "./types.ts";

/** Hard cap on catch-up occurrences per mark-paid call (§2.1). */
export const CATCHUP_MAX_OCCURRENCES = 60;

/**
 * Trim a user-supplied wallet/category name; empty or whitespace-only input
 * is invalid (`null`) so the UI never creates a nameless row.
 */
export function cleanName(raw: string): string | null {
  const name = raw.trim();
  return name.length > 0 ? name : null;
}

export interface EntryInput {
  amountCents: number;
  categoryId: number;
  walletId: number;
  entryDate: string;
  note?: string;
}

export interface DayEntry {
  kind: "income" | "expense";
  id: number;
  amount_cents: number;
  category_id: number;
  wallet_id: number;
  entry_date: string;
  note: string;
  created_at: string;
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
 * Turn a MonthSummary into display rows (§2.1 monthly view + per-category
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

/** Warning thresholds (§2.1): warn at 80%, warn again when exceeded. */
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
 * (§2.1 entry-form warning: the 80%/exceeded warnings never block an entry,
 * they only tell the user before they save).
 */
export function prospectiveStatus(
  spentCents: number,
  limitCents: number | null,
  additionalCents: number,
): LimitStatus {
  return limitStatus(spentCents + Math.max(0, additionalCents), limitCents);
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
 * Aggregate per-month totals into the yearly view (§2.1). `monthly` is
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
  return {
    // -- Wallets (§2.1) ------------------------------------------------------
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

    /** Balance = income − expense entries naming the wallet (§2.1). */
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

    // -- Categories (§2.1) ---------------------------------------------------
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

    // -- Income / expense entries (§2.1) --------------------------------------
    async createIncomeEntry(input: EntryInput): Promise<number> {
      const r = await driver.execute(
        `INSERT INTO income_entries (amount_cents, category_id, wallet_id, entry_date, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.amountCents,
          input.categoryId,
          input.walletId,
          input.entryDate,
          input.note ?? "",
          todayLocal(),
        ],
      );
      return r.lastInsertRowid;
    },

    async createExpenseEntry(input: EntryInput): Promise<number> {
      const r = await driver.execute(
        `INSERT INTO expense_entries (amount_cents, category_id, wallet_id, entry_date, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.amountCents,
          input.categoryId,
          input.walletId,
          input.entryDate,
          input.note ?? "",
          todayLocal(),
        ],
      );
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

    async deleteExpenseEntry(id: number): Promise<void> {
      await driver.execute("DELETE FROM expense_entries WHERE id = ?", [id]);
    },

    /** Both entry kinds for one day — the daily list view (§2.1). */
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

    // -- Summaries (§2.1: monthly / yearly / per-category) --------------------
    async monthlySummary(yearMonth: string): Promise<MonthSummary> {
      const [incomeRows, expenseRows, incomeByCat, expenseByCat] =
        await Promise.all([
          driver.query<{ total: number }>(
            "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM income_entries WHERE substr(entry_date, 1, 7) = ?",
            [yearMonth],
          ),
          driver.query<{ total: number }>(
            "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM expense_entries WHERE substr(entry_date, 1, 7) = ?",
            [yearMonth],
          ),
          driver.query<CategoryTotal>(
            "SELECT category_id, SUM(amount_cents) AS total_cents FROM income_entries WHERE substr(entry_date, 1, 7) = ? GROUP BY category_id",
            [yearMonth],
          ),
          driver.query<CategoryTotal>(
            "SELECT category_id, SUM(amount_cents) AS total_cents FROM expense_entries WHERE substr(entry_date, 1, 7) = ? GROUP BY category_id",
            [yearMonth],
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
      const [incomeRows, expenseRows] = await Promise.all([
        driver.query<{ total: number }>(
          "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM income_entries WHERE substr(entry_date, 1, 4) = ?",
          [year],
        ),
        driver.query<{ total: number }>(
          "SELECT COALESCE(SUM(amount_cents), 0) AS total FROM expense_entries WHERE substr(entry_date, 1, 4) = ?",
          [year],
        ),
      ]);
      return {
        incomeCents: incomeRows[0]?.total ?? 0,
        expenseCents: expenseRows[0]?.total ?? 0,
      };
    },

    // -- Expense limits (§2.1) -------------------------------------------------
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
      const [spentRows, limit] = await Promise.all([
        driver.query<{ total: number }>(
          `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM expense_entries
           WHERE category_id = ? AND substr(entry_date, 1, 7) = ?`,
          [categoryId, yearMonth],
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

    // -- Recurring payments (§2.1) ---------------------------------------------
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
      await driver.execute(
        "UPDATE recurring_payments SET active = ? WHERE id = ?",
        [active ? 1 : 0, id],
      );
    },

    /**
     * Occurrences due on/before `onDate`, oldest first, hard-capped at
     * CATCHUP_MAX_OCCURRENCES (§2.1 — never an unbounded loop). Computed in
     * JS from the rule's frequency so the cap is explicit and testable.
     */
    occurrencesDue(
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
      const rule = await this.getRecurring(id);
      if (!rule) throw new Error(`recurring payment ${id} not found`);
      const dates = this.occurrencesDue(rule, onDate);
      if (dates.length === 0) return [];
      const categoryId = rule.category_id ?? fallback.categoryId;
      const walletId = rule.wallet_id ?? fallback.walletId;
      const created = todayLocal();
      const statements = dates.map((due) => ({
        sql: `INSERT INTO expense_entries (amount_cents, category_id, wallet_id, entry_date, note, created_at)
               VALUES (?, ?, ?, ?, ?, ?)`,
        params: [
          rule.amount_cents,
          categoryId,
          walletId,
          due,
          rule.title,
          created,
        ],
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
    },
  };
}

export type BudgetRepo = ReturnType<typeof createBudgetRepo>;
