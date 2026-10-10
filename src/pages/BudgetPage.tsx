// P3b Budget page (§2.1): wallets, income/expense entries, categories,
// monthly/yearly views, expense limits + warnings, recurring payments.
// Talks only to the budget repo (§4). Views land progressively: this file
// starts with the shell + Manage view and gains one view per P3b task.

import { useCallback, useEffect, useState } from "react";
import { budgetRepo } from "../data/app.ts";
import {
  cleanName,
  type DayEntry,
  type LimitStatus,
  limitDisplayRows,
  monthSummaryDisplay,
  prospectiveStatus,
  recurringDisplay,
  yearDisplay,
} from "../lib/budget.ts";
import { addDays, todayLocal, yearMonthOf } from "../lib/dates.ts";
import { monthLabel } from "../lib/journal.ts";
import { formatMMK, parseMMK } from "../lib/money.ts";
import type {
  ExpenseCategoryRow,
  IncomeCategoryRow,
  RecurringFrequency,
  RecurringPaymentRow,
  WalletRow,
} from "../lib/types.ts";

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function shiftMonth(yearMonth: string, delta: number): string {
  const [y, m] = yearMonth.split("-").map(Number);
  if (!y || !m) return yearMonth;
  const d = new Date(y, m - 1 + delta, 1);
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${yy}-${mm}`;
}

type BudgetView =
  | "entries"
  | "month"
  | "year"
  | "limits"
  | "recurring"
  | "manage";

const VIEWS: { key: BudgetView; label: string }[] = [
  { key: "entries", label: "Entries" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
  { key: "limits", label: "Limits" },
  { key: "recurring", label: "Recurring" },
  { key: "manage", label: "Manage" },
];

export default function BudgetPage() {
  const [view, setView] = useState<BudgetView>("entries");

  return (
    <div className="budget-page">
      <nav className="budget-viewnav" aria-label="Budget views">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            className={view === v.key ? "nav-tab is-active" : "nav-tab"}
            aria-current={view === v.key ? "page" : undefined}
            onClick={() => setView(v.key)}
          >
            {v.label}
          </button>
        ))}
      </nav>
      {view === "entries" ? (
        <EntriesView />
      ) : view === "month" ? (
        <MonthView />
      ) : view === "year" ? (
        <YearView />
      ) : view === "limits" ? (
        <LimitsView />
      ) : view === "recurring" ? (
        <RecurringView />
      ) : view === "manage" ? (
        <ManageView />
      ) : (
        <p className="budget-todo">
          The {VIEWS.find((v) => v.key === view)?.label} view is part of the
          in-progress P3b build-out.
        </p>
      )}
    </div>
  );
}

/** Wallets + balances, expense/income categories, and their create forms. */
function ManageView() {
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [balances, setBalances] = useState<Map<number, number>>(new Map());
  const [expenseCats, setExpenseCats] = useState<ExpenseCategoryRow[]>([]);
  const [incomeCats, setIncomeCats] = useState<IncomeCategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [walletDraft, setWalletDraft] = useState("");
  const [expenseDraft, setExpenseDraft] = useState("");
  const [incomeDraft, setIncomeDraft] = useState("");

  const refresh = useCallback(async () => {
    try {
      const [ws, ec, ic] = await Promise.all([
        budgetRepo.listWallets(),
        budgetRepo.listExpenseCategories(),
        budgetRepo.listIncomeCategories(),
      ]);
      const amounts = await Promise.all(
        ws.map((w) => budgetRepo.walletBalanceCents(w.id)),
      );
      setWallets(ws);
      setBalances(
        new Map<number, number>(
          ws.map((w, i): [number, number] => [w.id, amounts[i] ?? 0]),
        ),
      );
      setExpenseCats(ec);
      setIncomeCats(ic);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const addWallet = async () => {
    const name = cleanName(walletDraft);
    if (!name) return;
    await budgetRepo.createWallet(name);
    setWalletDraft("");
    await refresh();
  };

  const addExpenseCategory = async () => {
    const name = cleanName(expenseDraft);
    if (!name) return;
    await budgetRepo.createExpenseCategory(name);
    setExpenseDraft("");
    await refresh();
  };

  const addIncomeCategory = async () => {
    const name = cleanName(incomeDraft);
    if (!name) return;
    await budgetRepo.createIncomeCategory(name);
    setIncomeDraft("");
    await refresh();
  };

  return (
    <section
      className="budget-manage"
      aria-label="Manage wallets and categories"
    >
      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <section aria-label="Wallets">
        <h2 className="side-heading">Wallets</h2>
        {wallets.length === 0 ? (
          <p className="muted">No wallets yet — add one below.</p>
        ) : (
          <ul className="budget-list">
            {wallets.map((w) => (
              <li key={w.id} className="budget-row">
                <span>{w.name}</span>
                <span className="figure">
                  {formatMMK(balances.get(w.id) ?? 0)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addWallet();
          }}
        >
          <input
            aria-label="New wallet name"
            placeholder="New wallet name"
            value={walletDraft}
            onChange={(e) => setWalletDraft(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!cleanName(walletDraft)}
          >
            Add wallet
          </button>
        </form>
      </section>

      <section aria-label="Expense categories">
        <h2 className="side-heading">Expense categories</h2>
        {expenseCats.length === 0 ? (
          <p className="muted">No expense categories yet — add one below.</p>
        ) : (
          <ul className="budget-list">
            {expenseCats.map((c) => (
              <li key={c.id} className="budget-row">
                <span>{c.name}</span>
              </li>
            ))}
          </ul>
        )}
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addExpenseCategory();
          }}
        >
          <input
            aria-label="New expense category name"
            placeholder="New expense category"
            value={expenseDraft}
            onChange={(e) => setExpenseDraft(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!cleanName(expenseDraft)}
          >
            Add category
          </button>
        </form>
      </section>

      <section aria-label="Income categories">
        <h2 className="side-heading">Income categories</h2>
        {incomeCats.length === 0 ? (
          <p className="muted">No income categories yet — add one below.</p>
        ) : (
          <ul className="budget-list">
            {incomeCats.map((c) => (
              <li key={c.id} className="budget-row">
                <span>{c.name}</span>
              </li>
            ))}
          </ul>
        )}
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addIncomeCategory();
          }}
        >
          <input
            aria-label="New income category name"
            placeholder="New income category"
            value={incomeDraft}
            onChange={(e) => setIncomeDraft(e.target.value)}
          />
          <button
            type="submit"
            className="btn btn-primary"
            disabled={!cleanName(incomeDraft)}
          >
            Add category
          </button>
        </form>
      </section>
    </section>
  );
}

/** Daily entries: day navigation, income/expense entry form + CRUD, limit warning. */
function EntriesView() {
  const [date, setDate] = useState(() => todayLocal());
  const [entries, setEntries] = useState<DayEntry[]>([]);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [expenseCats, setExpenseCats] = useState<ExpenseCategoryRow[]>([]);
  const [incomeCats, setIncomeCats] = useState<IncomeCategoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [kind, setKind] = useState<"income" | "expense">("expense");
  const [amountRaw, setAmountRaw] = useState("");
  const [categoryId, setCategoryId] = useState<number | "">("");
  const [walletId, setWalletId] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState<{
    kind: "income" | "expense";
    id: number;
  } | null>(null);
  const [limitInfo, setLimitInfo] = useState<{
    spentCents: number;
    limitCents: number | null;
    status: LimitStatus;
  } | null>(null);

  const amountCents = parseMMK(amountRaw);
  const categories = kind === "income" ? incomeCats : expenseCats;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [ws, ec, ic] = await Promise.all([
          budgetRepo.listWallets(),
          budgetRepo.listExpenseCategories(),
          budgetRepo.listIncomeCategories(),
        ]);
        if (cancelled) return;
        setWallets(ws);
        setExpenseCats(ec);
        setIncomeCats(ic);
      } catch (e) {
        if (!cancelled) setError(errText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshDay = useCallback(async (d: string) => {
    try {
      setEntries(await budgetRepo.listDayEntries(d));
      setError(null);
    } catch (e) {
      setError(errText(e));
    }
  }, []);

  useEffect(() => {
    void refreshDay(date);
  }, [date, refreshDay]);

  // Prospective limit warning for the expense being drafted (§2.1: warn at
  // 80%, warn again when exceeded — never blocks the entry).
  useEffect(() => {
    let cancelled = false;
    if (
      kind !== "expense" ||
      typeof categoryId !== "number" ||
      amountCents === null ||
      amountCents <= 0
    ) {
      setLimitInfo(null);
      return;
    }
    (async () => {
      try {
        const info = await budgetRepo.limitStatusFor(
          categoryId,
          yearMonthOf(date),
        );
        if (cancelled) return;
        setLimitInfo({
          ...info,
          status: prospectiveStatus(
            info.spentCents,
            info.limitCents,
            amountCents,
          ),
        });
      } catch {
        // Warning display is best-effort — it must never block entry (§2.1).
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, categoryId, amountCents, date]);

  const resetForm = () => {
    setAmountRaw("");
    setCategoryId("");
    setNote("");
    setEditing(null);
  };

  const submit = async () => {
    if (
      amountCents === null ||
      amountCents <= 0 ||
      typeof categoryId !== "number" ||
      typeof walletId !== "number"
    ) {
      return;
    }
    setSaving(true);
    try {
      const input = {
        amountCents,
        categoryId,
        walletId,
        entryDate: date,
        note: note.trim(),
      };
      if (editing) {
        if (editing.kind === "income") {
          await budgetRepo.updateIncomeEntry(editing.id, input);
        } else {
          await budgetRepo.updateExpenseEntry(editing.id, input);
        }
      } else if (kind === "income") {
        await budgetRepo.createIncomeEntry(input);
      } else {
        await budgetRepo.createExpenseEntry(input);
      }
      resetForm();
      await refreshDay(date);
    } catch (e) {
      setError(errText(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (entry: DayEntry) => {
    try {
      if (entry.kind === "income") {
        await budgetRepo.deleteIncomeEntry(entry.id);
      } else {
        await budgetRepo.deleteExpenseEntry(entry.id);
      }
      if (editing?.id === entry.id) resetForm();
      await refreshDay(date);
    } catch (e) {
      setError(errText(e));
    }
  };

  const startEdit = (entry: DayEntry) => {
    setKind(entry.kind);
    setAmountRaw((entry.amount_cents / 100).toFixed(2));
    setCategoryId(entry.category_id);
    setWalletId(entry.wallet_id);
    setNote(entry.note);
    setEditing({ kind: entry.kind, id: entry.id });
  };

  const catName = (id: number, of: "income" | "expense"): string => {
    const list = of === "income" ? incomeCats : expenseCats;
    return list.find((c) => c.id === id)?.name ?? "—";
  };
  const walletName = (id: number): string =>
    wallets.find((w) => w.id === id)?.name ?? "—";

  return (
    <section className="budget-entries" aria-label="Daily entries">
      <div className="day-nav">
        <button
          type="button"
          className="btn"
          onClick={() => setDate(addDays(date, -1))}
        >
          ◀
        </button>
        <input
          type="date"
          aria-label="Entry date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <button
          type="button"
          className="btn"
          onClick={() => setDate(addDays(date, 1))}
        >
          ▶
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setDate(todayLocal())}
        >
          Today
        </button>
      </div>

      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <section aria-label={`Entries for ${date}`}>
        {entries.length === 0 ? (
          <p className="muted">No entries for this day.</p>
        ) : (
          <ul className="budget-list">
            {entries.map((e) => (
              <li key={`${e.kind}-${e.id}`} className="budget-row">
                <span
                  className={
                    e.kind === "income"
                      ? "figure amount-income"
                      : "figure amount-expense"
                  }
                >
                  {e.kind === "income" ? "+" : "−"}
                  {formatMMK(e.amount_cents)}
                </span>
                <span>
                  {catName(e.category_id, e.kind)}
                  {e.note ? ` — ${e.note}` : ""}
                </span>
                <span className="muted">{walletName(e.wallet_id)}</span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => startEdit(e)}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void remove(e)}
                  >
                    Delete
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <form
        className="entry-form"
        onSubmit={(ev) => {
          ev.preventDefault();
          void submit();
        }}
      >
        <h2 className="side-heading">{editing ? "Edit entry" : "New entry"}</h2>
        <fieldset className="kind-toggle">
          <legend className="visually-hidden">Entry kind</legend>
          <button
            type="button"
            className={kind === "income" ? "btn is-on" : "btn"}
            aria-pressed={kind === "income"}
            disabled={editing !== null}
            onClick={() => {
              setKind("income");
              setCategoryId("");
            }}
          >
            Income
          </button>
          <button
            type="button"
            className={kind === "expense" ? "btn is-on" : "btn"}
            aria-pressed={kind === "expense"}
            disabled={editing !== null}
            onClick={() => {
              setKind("expense");
              setCategoryId("");
            }}
          >
            Expense
          </button>
        </fieldset>
        <label>
          Amount (MMK)
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amountRaw}
            onChange={(e) => setAmountRaw(e.target.value)}
          />
        </label>
        {amountRaw.trim() !== "" && amountCents === null ? (
          <p className="limit-warn" role="status">
            Enter a valid amount — digits with up to 2 decimals.
          </p>
        ) : null}
        <label>
          Category
          <select
            aria-label="Category"
            value={categoryId === "" ? "" : String(categoryId)}
            onChange={(e) =>
              setCategoryId(e.target.value === "" ? "" : Number(e.target.value))
            }
          >
            <option value="">Choose…</option>
            {categories.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Wallet
          <select
            aria-label="Wallet"
            value={walletId === "" ? "" : String(walletId)}
            onChange={(e) =>
              setWalletId(e.target.value === "" ? "" : Number(e.target.value))
            }
          >
            <option value="">Choose…</option>
            {wallets.map((w) => (
              <option key={w.id} value={String(w.id)}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Note
          <input
            value={note}
            placeholder="Optional"
            onChange={(e) => setNote(e.target.value)}
          />
        </label>
        {limitInfo &&
        limitInfo.status !== "ok" &&
        limitInfo.limitCents !== null ? (
          <p
            className={
              limitInfo.status === "exceeded" ? "limit-exceeded" : "limit-warn"
            }
            role="status"
          >
            {limitInfo.status === "exceeded"
              ? `Limit exceeded: ${formatMMK(limitInfo.spentCents)} of ${formatMMK(limitInfo.limitCents)} already spent this month.`
              : `Approaching limit: ${formatMMK(limitInfo.spentCents)} of ${formatMMK(limitInfo.limitCents)} spent this month.`}
          </p>
        ) : null}
        <div className="row-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              saving ||
              amountCents === null ||
              amountCents <= 0 ||
              categoryId === "" ||
              walletId === ""
            }
          >
            {editing ? "Update entry" : "Save entry"}
          </button>
          {editing ? (
            <button type="button" className="btn" onClick={resetForm}>
              Cancel
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}

/** Monthly summary: totals + per-category breakdown, month navigation (§2.1). */
function MonthView() {
  const [yearMonth, setYearMonth] = useState(() => yearMonthOf(todayLocal()));
  const [display, setDisplay] = useState<ReturnType<
    typeof monthSummaryDisplay
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [summary, ec, ic] = await Promise.all([
          budgetRepo.monthlySummary(yearMonth),
          budgetRepo.listExpenseCategories(),
          budgetRepo.listIncomeCategories(),
        ]);
        if (cancelled) return;
        setDisplay(monthSummaryDisplay(summary, ic, ec));
        setError(null);
      } catch (e) {
        if (!cancelled) setError(errText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [yearMonth]);

  const label = monthLabel(yearMonth);

  return (
    <section className="budget-month" aria-label="Monthly summary">
      <div className="day-nav">
        <button
          type="button"
          className="btn"
          onClick={() => setYearMonth(shiftMonth(yearMonth, -1))}
        >
          ◀
        </button>
        <h2 className="side-heading month-label">{label}</h2>
        <button
          type="button"
          className="btn"
          onClick={() => setYearMonth(shiftMonth(yearMonth, 1))}
        >
          ▶
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setYearMonth(yearMonthOf(todayLocal()))}
        >
          This month
        </button>
      </div>

      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {display ? (
        <>
          <div className="summary-figures">
            <div>
              <span className="muted">Income</span>
              <span className="figure amount-income">
                +{formatMMK(display.incomeCents)}
              </span>
            </div>
            <div>
              <span className="muted">Expense</span>
              <span className="figure amount-expense">
                −{formatMMK(display.expenseCents)}
              </span>
            </div>
            <div>
              <span className="muted">Net</span>
              <span
                className={
                  display.netCents > 0
                    ? "figure amount-income"
                    : display.netCents < 0
                      ? "figure amount-expense"
                      : "figure"
                }
              >
                {formatMMK(display.netCents)}
              </span>
            </div>
          </div>
          <div className="summary-breakdowns">
            <section aria-label="Expense by category">
              <h3 className="side-heading">Expenses by category</h3>
              {display.expenseRows.length === 0 ? (
                <p className="muted">No expenses this month.</p>
              ) : (
                <ul className="budget-list">
                  {display.expenseRows.map((r) => (
                    <li key={r.name} className="budget-row">
                      <span>{r.name}</span>
                      <span className="figure">{formatMMK(r.totalCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section aria-label="Income by category">
              <h3 className="side-heading">Income by category</h3>
              {display.incomeRows.length === 0 ? (
                <p className="muted">No income this month.</p>
              ) : (
                <ul className="budget-list">
                  {display.incomeRows.map((r) => (
                    <li key={r.name} className="budget-row">
                      <span>{r.name}</span>
                      <span className="figure">{formatMMK(r.totalCents)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      ) : null}
    </section>
  );
}

/** Yearly summary: year totals + per-month income/expense/net rows (§2.1). */
function YearView() {
  const [year, setYear] = useState(() => todayLocal().slice(0, 4));
  const [display, setDisplay] = useState<ReturnType<typeof yearDisplay> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const monthly = await Promise.all(
          Array.from({ length: 12 }, (_, i) =>
            budgetRepo.monthlySummary(
              `${year}-${String(i + 1).padStart(2, "0")}`,
            ),
          ),
        );
        if (cancelled) return;
        setDisplay(yearDisplay(year, monthly));
        setError(null);
      } catch (e) {
        if (!cancelled) setError(errText(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [year]);

  const currentYear = todayLocal().slice(0, 4);
  const shiftYear = (delta: number) => {
    const y = Number(year);
    if (!Number.isNaN(y)) setYear(String(y + delta));
  };

  return (
    <section className="budget-year" aria-label="Yearly summary">
      <div className="day-nav">
        <button type="button" className="btn" onClick={() => shiftYear(-1)}>
          ◀
        </button>
        <h2 className="side-heading month-label">{year}</h2>
        <button type="button" className="btn" onClick={() => shiftYear(1)}>
          ▶
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setYear(currentYear)}
        >
          This year
        </button>
      </div>

      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {display ? (
        <>
          <div className="summary-figures">
            <div>
              <span className="muted">Income</span>
              <span className="figure amount-income">
                +{formatMMK(display.totalIncomeCents)}
              </span>
            </div>
            <div>
              <span className="muted">Expense</span>
              <span className="figure amount-expense">
                −{formatMMK(display.totalExpenseCents)}
              </span>
            </div>
            <div>
              <span className="muted">Net</span>
              <span
                className={
                  display.netCents > 0
                    ? "figure amount-income"
                    : display.netCents < 0
                      ? "figure amount-expense"
                      : "figure"
                }
              >
                {formatMMK(display.netCents)}
              </span>
            </div>
          </div>
          <table className="year-table">
            <caption className="visually-hidden">Months of {year}</caption>
            <thead>
              <tr>
                <th scope="col">Month</th>
                <th scope="col">Income</th>
                <th scope="col">Expense</th>
                <th scope="col">Net</th>
              </tr>
            </thead>
            <tbody>
              {display.months.map((m) => {
                const empty = m.incomeCents === 0 && m.expenseCents === 0;
                return (
                  <tr
                    key={m.yearMonth}
                    className={empty ? "is-empty" : undefined}
                  >
                    <th scope="row">{monthLabel(m.yearMonth)}</th>
                    <td className="figure">{formatMMK(m.incomeCents)}</td>
                    <td className="figure">{formatMMK(m.expenseCents)}</td>
                    <td
                      className={
                        m.netCents > 0
                          ? "figure amount-income"
                          : m.netCents < 0
                            ? "figure amount-expense"
                            : "figure"
                      }
                    >
                      {formatMMK(m.netCents)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      ) : null}
    </section>
  );
}

/** Expense limits: per-category monthly cap with 80%/exceeded warnings (§2.1). */
function LimitsView() {
  const [yearMonth, setYearMonth] = useState(() => yearMonthOf(todayLocal()));
  const [rows, setRows] = useState<ReturnType<typeof limitDisplayRows>>([]);
  const [drafts, setDrafts] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (ym: string) => {
    try {
      const cats = await budgetRepo.listExpenseCategories();
      const statuses = await Promise.all(
        cats.map(async (c) => {
          const info = await budgetRepo.limitStatusFor(c.id, ym);
          return {
            categoryId: c.id,
            spentCents: info.spentCents,
            limitCents: info.limitCents,
          };
        }),
      );
      setRows(limitDisplayRows(cats, statuses));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(yearMonth);
  }, [yearMonth, refresh]);

  const saveLimit = async (categoryId: number) => {
    const cents = parseMMK(drafts.get(categoryId) ?? "");
    if (cents === null || cents <= 0) return;
    try {
      await budgetRepo.setLimit(categoryId, cents);
      await refresh(yearMonth);
    } catch (e) {
      setError(errText(e));
    }
  };

  const removeLimit = async (categoryId: number) => {
    try {
      await budgetRepo.deleteLimit(categoryId);
      await refresh(yearMonth);
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <section className="budget-limits" aria-label="Expense limits">
      <div className="day-nav">
        <button
          type="button"
          className="btn"
          onClick={() => setYearMonth(shiftMonth(yearMonth, -1))}
        >
          ◀
        </button>
        <h2 className="side-heading month-label">{monthLabel(yearMonth)}</h2>
        <button
          type="button"
          className="btn"
          onClick={() => setYearMonth(shiftMonth(yearMonth, 1))}
        >
          ▶
        </button>
      </div>

      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <p className="muted">
          No expense categories — add one in Manage to set limits.
        </p>
      ) : (
        <ul className="budget-list">
          {rows.map((r) => (
            <li key={r.categoryId} className="limit-row">
              <span className="limit-name">
                {r.name}
                {r.status !== "ok" ? (
                  <span
                    className={
                      r.status === "exceeded" ? "limit-exceeded" : "limit-warn"
                    }
                    role="status"
                  >
                    {r.status === "exceeded" ? " (exceeded)" : " (80%+)"}
                  </span>
                ) : null}
              </span>
              <span className="muted">
                spent {formatMMK(r.spentCents)}
                {r.limitCents !== null
                  ? ` of ${formatMMK(r.limitCents)}${r.percent !== null ? ` (${r.percent}%)` : ""}`
                  : " — no limit"}
              </span>
              <span className="inline-form">
                <input
                  aria-label={`Monthly limit for ${r.name}`}
                  inputMode="decimal"
                  placeholder="0.00"
                  value={drafts.get(r.categoryId) ?? ""}
                  onChange={(e) => {
                    const next = new Map(drafts);
                    next.set(r.categoryId, e.target.value);
                    setDrafts(next);
                  }}
                />
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={parseMMK(drafts.get(r.categoryId) ?? "") === null}
                  onClick={() => void saveLimit(r.categoryId)}
                >
                  Set limit
                </button>
                {r.limitCents !== null ? (
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void removeLimit(r.categoryId)}
                  >
                    Remove
                  </button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Recurring payments: rules list, mark-paid with capped catch-up (§2.1). */
function RecurringView() {
  const today = todayLocal();
  const [rules, setRules] = useState<RecurringPaymentRow[]>([]);
  const [expenseCats, setExpenseCats] = useState<ExpenseCategoryRow[]>([]);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [fallbackCategoryId, setFallbackCategoryId] = useState<number | "">("");
  const [fallbackWalletId, setFallbackWalletId] = useState<number | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const [title, setTitle] = useState("");
  const [amountRaw, setAmountRaw] = useState("");
  const [frequency, setFrequency] = useState<RecurringFrequency>("monthly");
  const [nextDue, setNextDue] = useState(today);
  const [ruleCategory, setRuleCategory] = useState<number | "">("");
  const [ruleWallet, setRuleWallet] = useState<number | "">("");

  const refresh = useCallback(async (includeInactive: boolean) => {
    try {
      const [rs, ec, ws] = await Promise.all([
        budgetRepo.listRecurring(includeInactive),
        budgetRepo.listExpenseCategories(),
        budgetRepo.listWallets(),
      ]);
      setRules(rs);
      setExpenseCats(ec);
      setWallets(ws);
      setFallbackCategoryId((prev) => (prev === "" ? (ec[0]?.id ?? "") : prev));
      setFallbackWalletId((prev) => (prev === "" ? (ws[0]?.id ?? "") : prev));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh(showInactive);
  }, [showInactive, refresh]);

  const markPaid = async (rule: RecurringPaymentRow) => {
    if (
      typeof fallbackCategoryId !== "number" ||
      typeof fallbackWalletId !== "number"
    ) {
      setError("Pick a fallback category and wallet first.");
      return;
    }
    setBusyId(rule.id);
    try {
      await budgetRepo.markRecurringPaid(rule.id, today, {
        categoryId: fallbackCategoryId,
        walletId: fallbackWalletId,
      });
      await refresh(showInactive);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusyId(null);
    }
  };

  const setActive = async (rule: RecurringPaymentRow, active: boolean) => {
    try {
      await budgetRepo.setRecurringActive(rule.id, active);
      await refresh(showInactive);
    } catch (e) {
      setError(errText(e));
    }
  };

  const createRule = async () => {
    const amountCents = parseMMK(amountRaw);
    const name = cleanName(title);
    if (amountCents === null || amountCents <= 0 || !name || !nextDue) return;
    try {
      await budgetRepo.createRecurring({
        title: name,
        amountCents,
        categoryId: ruleCategory === "" ? null : ruleCategory,
        walletId: ruleWallet === "" ? null : ruleWallet,
        frequency,
        nextDueDate: nextDue,
      });
      setTitle("");
      setAmountRaw("");
      setRuleCategory("");
      setRuleWallet("");
      await refresh(showInactive);
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <section className="budget-recurring" aria-label="Recurring payments">
      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="inline-form">
        <label className="muted">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{" "}
          Show paused
        </label>
        <label className="muted">
          Fallback category{" "}
          <select
            aria-label="Fallback expense category"
            value={fallbackCategoryId === "" ? "" : String(fallbackCategoryId)}
            onChange={(e) =>
              setFallbackCategoryId(
                e.target.value === "" ? "" : Number(e.target.value),
              )
            }
          >
            <option value="">Choose…</option>
            {expenseCats.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="muted">
          Fallback wallet{" "}
          <select
            aria-label="Fallback wallet"
            value={fallbackWalletId === "" ? "" : String(fallbackWalletId)}
            onChange={(e) =>
              setFallbackWalletId(
                e.target.value === "" ? "" : Number(e.target.value),
              )
            }
          >
            <option value="">Choose…</option>
            {wallets.map((w) => (
              <option key={w.id} value={String(w.id)}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {rules.length === 0 ? (
        <p className="muted">No recurring payments yet — add one below.</p>
      ) : (
        <ul className="budget-list">
          {rules.map((r) => {
            const d = recurringDisplay(r, today);
            return (
              <li key={r.id} className="limit-row">
                <span>
                  {r.title}
                  {r.active ? null : <span className="muted"> (paused)</span>}
                  {d.overdue ? (
                    <span className="limit-exceeded" role="status">
                      {" "}
                      (overdue)
                    </span>
                  ) : null}
                </span>
                <span className="muted">
                  {formatMMK(r.amount_cents)} · {r.frequency} · next{" "}
                  {r.next_due_date}
                </span>
                <span className="row-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={busyId === r.id || d.occurrences.length === 0}
                    onClick={() => void markPaid(r)}
                  >
                    {d.occurrences.length > 1
                      ? `Mark paid (${d.occurrences.length} occurrences)`
                      : "Mark paid"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void setActive(r, !r.active)}
                  >
                    {r.active ? "Pause" : "Resume"}
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <form
        className="entry-form"
        onSubmit={(e) => {
          e.preventDefault();
          void createRule();
        }}
      >
        <h2 className="side-heading">New recurring payment</h2>
        <label>
          Title
          <input
            value={title}
            placeholder="e.g. Rent"
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          Amount (MMK)
          <input
            inputMode="decimal"
            placeholder="0.00"
            value={amountRaw}
            onChange={(e) => setAmountRaw(e.target.value)}
          />
        </label>
        <label>
          Frequency
          <select
            aria-label="Frequency"
            value={frequency}
            onChange={(e) => setFrequency(e.target.value as RecurringFrequency)}
          >
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
            <option value="yearly">Yearly</option>
          </select>
        </label>
        <label>
          Next due date
          <input
            type="date"
            aria-label="Next due date"
            value={nextDue}
            onChange={(e) => setNextDue(e.target.value)}
          />
        </label>
        <label>
          Category (optional — falls back when marking paid)
          <select
            aria-label="Rule category"
            value={ruleCategory === "" ? "" : String(ruleCategory)}
            onChange={(e) =>
              setRuleCategory(
                e.target.value === "" ? "" : Number(e.target.value),
              )
            }
          >
            <option value="">None</option>
            {expenseCats.map((c) => (
              <option key={c.id} value={String(c.id)}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Wallet (optional — falls back when marking paid)
          <select
            aria-label="Rule wallet"
            value={ruleWallet === "" ? "" : String(ruleWallet)}
            onChange={(e) =>
              setRuleWallet(e.target.value === "" ? "" : Number(e.target.value))
            }
          >
            <option value="">None</option>
            {wallets.map((w) => (
              <option key={w.id} value={String(w.id)}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <div className="row-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={
              cleanName(title) === null ||
              parseMMK(amountRaw) === null ||
              (parseMMK(amountRaw) ?? 0) <= 0 ||
              !nextDue
            }
          >
            Add rule
          </button>
        </div>
      </form>
    </section>
  );
}
