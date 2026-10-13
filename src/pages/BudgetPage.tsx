// P3b Budget page (§2.1): wallets, income/expense entries, categories,
// monthly/yearly views, expense limits + warnings, recurring payments.
// Talks only to the budget repo (§4).

import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconBudget, IconWallet } from "../components/icons.tsx";
import { budgetRepo } from "../data/app.ts";
import {
  cleanName,
  type DayEntry,
  type LimitStatus,
  limitDisplayRows,
  monthSummaryDisplay,
  prospectiveStatus,
  recurringDisplay,
  resolveEntryDate,
  yearDisplay,
} from "../lib/budget.ts";
import {
  addDays,
  shiftYearMonth,
  todayLocal,
  yearMonthOf,
} from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import { monthLabel } from "../lib/journal.ts";
import { formatMMK, fromCents, parseMMK } from "../lib/money.ts";
import type {
  ExpenseCategoryRow,
  IncomeCategoryRow,
  RecurringFrequency,
  RecurringPaymentRow,
  WalletRow,
} from "../lib/types.ts";

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
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconBudget className="icon" />
            </span>
            <div>
              <h2 className="editor-title">Budget Tracker</h2>
              <p className="page-subtitle">
                Cash-basis personal finance, wallet balances &amp; monthly
                category caps
              </p>
            </div>
          </div>
        </div>
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
      </header>

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
      setError(errText(e));
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

      <section aria-label="Wallets" className="surface-card">
        <div className="dash-card-head">
          <div className="dash-card-title">
            <IconWallet className="icon" />
            <h2 className="side-heading">Wallets &amp; Accounts</h2>
          </div>
          <span className="badge">{wallets.length}</span>
        </div>
        {wallets.length === 0 ? (
          <p className="muted">No wallets yet — add one below.</p>
        ) : (
          <div className="wallet-grid">
            {wallets.map((w) => (
              <div key={w.id} className="wallet-card">
                <div className="wallet-card-head">
                  <span>{w.name}</span>
                  <IconWallet className="icon" />
                </div>
                <span className="wallet-card-balance figure">
                  {formatMMK(balances.get(w.id) ?? 0)}
                </span>
              </div>
            ))}
          </div>
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
            placeholder="New wallet name (e.g. KBZ Pay)"
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

      <div className="summary-breakdowns">
        <section aria-label="Expense categories">
          <div className="dash-card-head">
            <h2 className="side-heading">Expense categories</h2>
            <span className="badge">{expenseCats.length}</span>
          </div>
          {expenseCats.length === 0 ? (
            <p className="muted">No expense categories yet — add one below.</p>
          ) : (
            <ul className="budget-list">
              {expenseCats.map((c) => (
                <li key={c.id} className="budget-row">
                  <span>{c.name}</span>
                  <span className="badge">Expense</span>
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
          <div className="dash-card-head">
            <h2 className="side-heading">Income categories</h2>
            <span className="badge">{incomeCats.length}</span>
          </div>
          {incomeCats.length === 0 ? (
            <p className="muted">No income categories yet — add one below.</p>
          ) : (
            <ul className="budget-list">
              {incomeCats.map((c) => (
                <li key={c.id} className="budget-row">
                  <span>{c.name}</span>
                  <span className="badge badge-success">Income</span>
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
      </div>
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
  const editingExpenseCents =
    editing?.kind === "expense"
      ? (entries.find((e) => e.kind === "expense" && e.id === editing.id)
          ?.amount_cents ?? 0)
      : 0;

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
            info.spentCents - editingExpenseCents,
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
  }, [kind, categoryId, amountCents, date, editingExpenseCents]);

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
      const entryDate = resolveEntryDate(date, todayLocal());
      const input = {
        amountCents,
        categoryId,
        walletId,
        entryDate,
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
      if (date === entryDate) {
        await refreshDay(entryDate);
      } else {
        setDate(entryDate);
      }
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
    setAmountRaw(fromCents(entry.amount_cents).toFixed(2));
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

  const dayIn = entries
    .filter((e) => e.kind === "income")
    .reduce((sum, e) => sum + e.amount_cents, 0);
  const dayOut = entries
    .filter((e) => e.kind === "expense")
    .reduce((sum, e) => sum + e.amount_cents, 0);

  return (
    <section className="budget-entries" aria-label="Daily entries">
      <div className="dash-card-head">
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
        <div className="row-actions">
          <span className="badge badge-success figure">
            In +{formatMMK(dayIn)}
          </span>
          <span className="badge badge-danger figure">
            Out −{formatMMK(dayOut)}
          </span>
        </div>
      </div>

      {loading ? <p className="muted">Loading…</p> : null}
      {error ? (
        <p className="alert alert-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="split-workspace-grid">
        <section aria-label={`Entries for ${date}`}>
          <div className="dash-card-head">
            <h3 className="side-heading">Transactions on {date}</h3>
            <span className="badge">{entries.length}</span>
          </div>
          {entries.length === 0 ? (
            <EmptyState>No transactions recorded for this day.</EmptyState>
          ) : (
            <ul className="budget-list">
              {entries.map((e) => (
                <li key={`${e.kind}-${e.id}`} className="budget-row">
                  <div className="row-main">
                    <span className="row-title">
                      <b>{catName(e.category_id, e.kind)}</b>
                      <span className="chip">{walletName(e.wallet_id)}</span>
                    </span>
                    {e.note ? <span className="row-sub">{e.note}</span> : null}
                  </div>
                  <div className="row-end">
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
                  </div>
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
          <div className="dash-card-head">
            <h2 className="side-heading">
              {editing ? "Edit transaction" : "New transaction"}
            </h2>
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
          </div>

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
          <div className="form-grid">
            <label>
              Category
              <select
                aria-label="Category"
                value={categoryId === "" ? "" : String(categoryId)}
                onChange={(e) =>
                  setCategoryId(
                    e.target.value === "" ? "" : Number(e.target.value),
                  )
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
                  setWalletId(
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
          <label>
            Note
            <input
              value={note}
              placeholder="Optional description"
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {limitInfo &&
          limitInfo.status !== "ok" &&
          limitInfo.limitCents !== null ? (
            <p
              className={
                limitInfo.status === "exceeded"
                  ? "alert alert-error"
                  : "alert alert-note"
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
      </div>
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
          onClick={() => setYearMonth(shiftYearMonth(yearMonth, -1))}
        >
          ◀
        </button>
        <h2 className="side-heading month-label">{label}</h2>
        <button
          type="button"
          className="btn"
          onClick={() => setYearMonth(shiftYearMonth(yearMonth, 1))}
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
              <span className="muted">Net Cashflow</span>
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
              <div className="dash-card-head">
                <h3 className="side-heading">Expenses by category</h3>
                <span className="badge badge-danger">
                  {display.expenseRows.length}
                </span>
              </div>
              {display.expenseRows.length === 0 ? (
                <p className="muted">No expenses this month.</p>
              ) : (
                <ul className="budget-list">
                  {display.expenseRows.map((r) => {
                    const pct =
                      display.expenseCents > 0
                        ? Math.min(
                            100,
                            Math.round(
                              (r.totalCents / display.expenseCents) * 100,
                            ),
                          )
                        : 0;
                    return (
                      <li key={r.name} className="category-breakdown-item">
                        <div className="category-breakdown-top">
                          <span>
                            <b>{r.name}</b>{" "}
                            <span className="muted">({pct}%)</span>
                          </span>
                          <span className="figure amount-expense">
                            {formatMMK(r.totalCents)}
                          </span>
                        </div>
                        <div className="progress-track" aria-hidden="true">
                          <div
                            className="progress-fill is-danger"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
            <section aria-label="Income by category">
              <div className="dash-card-head">
                <h3 className="side-heading">Income by category</h3>
                <span className="badge badge-success">
                  {display.incomeRows.length}
                </span>
              </div>
              {display.incomeRows.length === 0 ? (
                <p className="muted">No income this month.</p>
              ) : (
                <ul className="budget-list">
                  {display.incomeRows.map((r) => {
                    const pct =
                      display.incomeCents > 0
                        ? Math.min(
                            100,
                            Math.round(
                              (r.totalCents / display.incomeCents) * 100,
                            ),
                          )
                        : 0;
                    return (
                      <li key={r.name} className="category-breakdown-item">
                        <div className="category-breakdown-top">
                          <span>
                            <b>{r.name}</b>{" "}
                            <span className="muted">({pct}%)</span>
                          </span>
                          <span className="figure amount-income">
                            {formatMMK(r.totalCents)}
                          </span>
                        </div>
                        <div className="progress-track" aria-hidden="true">
                          <div
                            className="progress-fill is-success"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
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
              <span className="muted">Annual Income</span>
              <span className="figure amount-income">
                +{formatMMK(display.totalIncomeCents)}
              </span>
            </div>
            <div>
              <span className="muted">Annual Expense</span>
              <span className="figure amount-expense">
                −{formatMMK(display.totalExpenseCents)}
              </span>
            </div>
            <div>
              <span className="muted">Annual Net</span>
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
          onClick={() => setYearMonth(shiftYearMonth(yearMonth, -1))}
        >
          ◀
        </button>
        <h2 className="side-heading month-label">{monthLabel(yearMonth)}</h2>
        <button
          type="button"
          className="btn"
          onClick={() => setYearMonth(shiftYearMonth(yearMonth, 1))}
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
          {rows.map((r) => {
            const barWidth =
              r.percent !== null ? Math.min(100, Math.max(0, r.percent)) : 0;
            const fillClass =
              r.status === "exceeded"
                ? "progress-fill is-danger"
                : r.status === "warn"
                  ? "progress-fill is-warn"
                  : "progress-fill is-success";
            return (
              <li key={r.categoryId} className="limit-row">
                <div className="row-main">
                  <span className="limit-name">
                    {r.name}
                    {r.status !== "ok" ? (
                      <span
                        className={
                          r.status === "exceeded"
                            ? "badge badge-danger"
                            : "badge badge-warn"
                        }
                        role="status"
                      >
                        {r.status === "exceeded" ? "Exceeded" : "80%+"}
                      </span>
                    ) : r.limitCents !== null ? (
                      <span className="badge badge-success">On track</span>
                    ) : null}
                  </span>
                  <span className="muted figure">
                    spent {formatMMK(r.spentCents)}
                    {r.limitCents !== null
                      ? ` of ${formatMMK(r.limitCents)}${r.percent !== null ? ` (${r.percent}%)` : ""}`
                      : " — no limit set"}
                  </span>
                  {r.limitCents !== null ? (
                    <div className="progress-track" aria-hidden="true">
                      <div
                        className={fillClass}
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                  ) : null}
                </div>
                <span className="inline-form">
                  <input
                    aria-label={`Monthly limit for ${r.name}`}
                    inputMode="decimal"
                    placeholder="Monthly cap (MMK)"
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
            );
          })}
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
        <label className="check-label">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />{" "}
          Show paused
        </label>
        <span className="toolbar-spacer" />
        <label className="muted">
          Fallback category{" "}
          <select
            className="select"
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
            className="select"
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
        <EmptyState>No recurring payments yet — add one below.</EmptyState>
      ) : (
        <ul className="budget-list">
          {rules.map((r) => {
            const d = recurringDisplay(r, today);
            return (
              <li key={r.id} className="limit-row">
                <div className="row-main">
                  <span className="row-title">
                    <b>{r.title}</b>
                    <span className="chip">{r.frequency}</span>
                    {r.active ? null : <span className="badge">Paused</span>}
                    {d.overdue ? (
                      <span className="badge badge-danger" role="status">
                        Overdue
                      </span>
                    ) : null}
                  </span>
                  <span className="muted figure">
                    {formatMMK(r.amount_cents)} · next due {r.next_due_date}
                  </span>
                </div>
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
        <div className="form-grid">
          <label>
            Title
            <input
              value={title}
              placeholder="e.g. Apartment Rent"
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
              onChange={(e) =>
                setFrequency(e.target.value as RecurringFrequency)
              }
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
                setRuleWallet(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
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
        </div>
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
