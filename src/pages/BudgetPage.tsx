// P3b Budget page: wallets, income/expense entries, categories,
// monthly/yearly views, expense limits + warnings, recurring payments.
// Talks only to the budget repo

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import {
  IconBudget,
  IconCalendar,
  IconChevronLeft,
  IconChevronRight,
  IconWallet,
} from "../components/icons.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
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
import {
  formatMMK,
  fromCents,
  isPartialAmount,
  parseMMK,
} from "../lib/money.ts";
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
  const addWalletRef = useRef(false);
  const [addingWallet, setAddingWallet] = useState(false);
  const addExpenseRef = useRef(false);
  const [addingExpense, setAddingExpense] = useState(false);
  const addIncomeRef = useRef(false);
  const [addingIncome, setAddingIncome] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [ws, ec, ic, balances] = await Promise.all([
        budgetRepo.listWallets(),
        budgetRepo.listExpenseCategories(),
        budgetRepo.listIncomeCategories(),
        // Every wallet's balance in one grouped query. The old
        // shape issued `walletBalanceCents` once per wallet on first paint —
        // N IPC round trips through the single SQL mutex to draw one list.
        budgetRepo.listWalletBalances(),
      ]);
      const balanceById = new Map(balances.map((b) => [b.id, b.balanceCents]));
      setWallets(ws);
      setBalances(
        new Map<number, number>(
          ws.map((w): [number, number] => [w.id, balanceById.get(w.id) ?? 0]),
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
    if (addWalletRef.current) return;
    const name = cleanName(walletDraft);
    if (!name) return;
    addWalletRef.current = true;
    setAddingWallet(true);
    try {
      await budgetRepo.createWallet(name);
      setWalletDraft("");
      await refresh();
    } catch (e) {
      // A duplicate name is a UNIQUE failure — without this the rejection was
      // unhandled and the form gave no feedback at all (review P3-7).
      setError(errText(e));
    } finally {
      addWalletRef.current = false;
      setAddingWallet(false);
    }
  };

  const addExpenseCategory = async () => {
    if (addExpenseRef.current) return;
    const name = cleanName(expenseDraft);
    if (!name) return;
    addExpenseRef.current = true;
    setAddingExpense(true);
    try {
      await budgetRepo.createExpenseCategory(name);
      setExpenseDraft("");
      await refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      addExpenseRef.current = false;
      setAddingExpense(false);
    }
  };

  const addIncomeCategory = async () => {
    if (addIncomeRef.current) return;
    const name = cleanName(incomeDraft);
    if (!name) return;
    addIncomeRef.current = true;
    setAddingIncome(true);
    try {
      await budgetRepo.createIncomeCategory(name);
      setIncomeDraft("");
      await refresh();
    } catch (e) {
      setError(errText(e));
    } finally {
      addIncomeRef.current = false;
      setAddingIncome(false);
    }
  };

  /**
   * Rename / delete, for wallets and both kinds of category (review P2-9).
   *
   * Rename is always safe — entries reference the row by id, so every past
   * entry simply starts showing the new name. Delete is only offered while a
   * row is unused, and the repo refuses it otherwise with a count, so the
   * button explains itself before it is clicked rather than only in the error
   * afterwards. `editing`/`draft` is one pair for all three lists: they are the
   * same operation on three tables, and three copies of an inline rename form
   * is three places for them to drift.
   */
  const [editing, setEditing] = useState<{
    kind: "wallet" | "expense" | "income";
    id: number;
    name: string;
  } | null>(null);
  const [draft, setDraft] = useState("");

  const startRename = (
    kind: "wallet" | "expense" | "income",
    id: number,
    name: string,
  ) => {
    setEditing({ kind, id, name });
    setDraft(name);
    setError(null);
  };

  const saveRename = async () => {
    if (editing === null) return;
    const name = cleanName(draft);
    if (!name) return;
    try {
      if (editing.kind === "wallet") {
        await budgetRepo.renameWallet(editing.id, name);
      } else if (editing.kind === "expense") {
        await budgetRepo.renameExpenseCategory(editing.id, name);
      } else {
        await budgetRepo.renameIncomeCategory(editing.id, name);
      }
      setEditing(null);
      setDraft("");
      await refresh();
    } catch (e) {
      setError(errText(e));
    }
  };

  const removeRow = async (
    kind: "wallet" | "expense" | "income",
    id: number,
  ) => {
    try {
      if (kind === "wallet") {
        await budgetRepo.deleteWallet(id);
      } else if (kind === "expense") {
        await budgetRepo.deleteExpenseCategory(id);
      } else {
        await budgetRepo.deleteIncomeCategory(id);
      }
      if (editing?.id === id && editing.kind === kind) setEditing(null);
      await refresh();
    } catch (e) {
      setError(errText(e));
    }
  };

  /** The rename input + its controls, shared by all three lists. */
  const renameControls = (kind: "wallet" | "expense" | "income", id: number) =>
    editing?.kind === kind && editing.id === id ? (
      <span className="inline-form">
        <input
          aria-label={`New name for ${kind} ${id}`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!cleanName(draft)}
          onClick={() => void saveRename()}
        >
          Save name
        </button>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setEditing(null)}
        >
          Cancel
        </button>
      </span>
    ) : (
      <span className="row-actions">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            const row =
              kind === "wallet"
                ? wallets.find((w) => w.id === id)
                : kind === "expense"
                  ? expenseCats.find((c) => c.id === id)
                  : incomeCats.find((c) => c.id === id);
            startRename(kind, id, row?.name ?? "");
          }}
        >
          Rename
        </button>
        <ConfirmButton
          className="btn btn-ghost"
          what={`${kind} “${
            kind === "wallet"
              ? (wallets.find((w) => w.id === id)?.name ?? "")
              : kind === "expense"
                ? (expenseCats.find((c) => c.id === id)?.name ?? "")
                : (incomeCats.find((c) => c.id === id)?.name ?? "")
          }”`}
          onConfirm={() => removeRow(kind, id)}
        >
          Delete
        </ConfirmButton>
      </span>
    );

  return (
    <section
      className="budget-manage"
      aria-label="Manage wallets and categories"
    >
      {loading ? <Skeleton count={3} /> : null}
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
              <div key={w.id} className="wallet-card wallet-card-gradient">
                <div className="wallet-card-head">
                  <span>{w.name}</span>
                  <IconWallet className="icon" />
                </div>
                <IconWallet className="icon wallet-card-icon" />
                <span className="wallet-card-balance figure amount-large">
                  {formatMMK(balances.get(w.id) ?? 0)}
                </span>
                {renameControls("wallet", w.id)}
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
            disabled={!cleanName(walletDraft) || addingWallet}
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
                  {renameControls("expense", c.id)}
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
              disabled={!cleanName(expenseDraft) || addingExpense}
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
                  {renameControls("income", c.id)}
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
              disabled={!cleanName(incomeDraft) || addingIncome}
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

  // Prospective limit warning for the expense being drafted (warn at
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
        // Warning display is best-effort — it must never block entry
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
        if (editing.kind !== kind) {
          // The toggle is enabled while editing (review P2-9), so this is the
          // branch it exists for: the entry moves between the two tables in one
          // transaction, carrying its amount, date and note. Previously the
          // buttons were disabled here and the only way out was delete + retype,
          // which quietly lost the note and date.
          await budgetRepo.convertEntry(editing.kind, editing.id, input);
        } else if (editing.kind === "income") {
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
      if (editing?.id === entry.id && editing.kind === entry.kind) resetForm();
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
            className="btn btn-icon"
            aria-label="Previous day"
            title="Previous day"
            onClick={() => setDate(addDays(date, -1))}
          >
            <IconChevronLeft className="icon" />
          </button>
          <span className="input-icon-wrap">
            <input
              type="date"
              aria-label="Entry date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
            <IconCalendar className="icon input-icon is-end" />
          </span>
          <button
            type="button"
            className="btn btn-icon"
            aria-label="Next day"
            title="Next day"
            onClick={() => setDate(addDays(date, 1))}
          >
            <IconChevronRight className="icon" />
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

      {loading ? <Skeleton count={3} /> : null}
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
                      <ConfirmButton
                        className="btn btn-ghost"
                        what={`${e.kind} entry`}
                        onConfirm={() => remove(e)}
                      >
                        Delete
                      </ConfirmButton>
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
              {/* Enabled while editing since P2-9: switching kind now converts
                  the entry in place (see `convertEntry`) instead of forcing a
                  delete and a retype. The category list is re-pointed at the
                  other side, so the chosen category always belongs to the kind
                  being saved. */}
              <button
                type="button"
                className={kind === "income" ? "btn is-on" : "btn"}
                aria-pressed={kind === "income"}
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
            Amount
            <span className="input-affix">
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={amountRaw}
                onChange={(e) => setAmountRaw(e.target.value)}
                aria-invalid={
                  amountRaw.trim() !== "" && !isPartialAmount(amountRaw)
                    ? "true"
                    : undefined
                }
              />
              <span className="input-affix-prefix">MMK</span>
            </span>
          </label>
          {amountRaw.trim() !== "" && !isPartialAmount(amountRaw) ? (
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

/** Monthly summary: totals + per-category breakdown, month navigation. */
function MonthView() {
  const [yearMonth, setYearMonth] = useState(() => yearMonthOf(todayLocal()));
  const [display, setDisplay] = useState<ReturnType<
    typeof monthSummaryDisplay
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
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
          className="btn btn-icon"
          aria-label="Previous month"
          title="Previous month"
          onClick={() => setYearMonth(shiftYearMonth(yearMonth, -1))}
        >
          <IconChevronLeft className="icon" />
        </button>
        <h2 className="side-heading month-label">{label}</h2>
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Next month"
          title="Next month"
          onClick={() => setYearMonth(shiftYearMonth(yearMonth, 1))}
        >
          <IconChevronRight className="icon" />
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setYearMonth(yearMonthOf(todayLocal()))}
        >
          This month
        </button>
      </div>

      {loading ? <Skeleton count={3} /> : null}
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
                className={`figure${
                  display.netCents > 0
                    ? " amount-income budget-summary-highlight"
                    : display.netCents < 0
                      ? " amount-expense"
                      : ""
                }`}
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

/** Yearly summary: year totals + per-month income/expense/net rows. */
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
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Previous year"
          title="Previous year"
          onClick={() => shiftYear(-1)}
        >
          <IconChevronLeft className="icon" />
        </button>
        <h2 className="side-heading month-label">{year}</h2>
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Next year"
          title="Next year"
          onClick={() => shiftYear(1)}
        >
          <IconChevronRight className="icon" />
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setYear(currentYear)}
        >
          This year
        </button>
      </div>

      {loading ? <Skeleton count={3} /> : null}
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
          <table className="year-table year-table-row-hover">
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

/** Expense limits: per-category monthly cap with 80%/exceeded warnings. */
function LimitsView() {
  const [yearMonth, setYearMonth] = useState(() => yearMonthOf(todayLocal()));
  const [rows, setRows] = useState<ReturnType<typeof limitDisplayRows>>([]);
  const [drafts, setDrafts] = useState<Map<number, string>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (ym: string, signal: { cancelled: boolean }) => {
    try {
      setLoading(true);
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
      if (signal.cancelled) return;
      setRows(limitDisplayRows(cats, statuses));
      setError(null);
    } catch (e) {
      if (!signal.cancelled) setError(errText(e));
    } finally {
      if (!signal.cancelled) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void refresh(yearMonth, signal);
    return () => {
      signal.cancelled = true;
    };
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
          className="btn btn-icon"
          aria-label="Previous month"
          title="Previous month"
          onClick={() => setYearMonth(shiftYearMonth(yearMonth, -1))}
        >
          <IconChevronLeft className="icon" />
        </button>
        <h2 className="side-heading month-label">{monthLabel(yearMonth)}</h2>
        <button
          type="button"
          className="btn btn-icon"
          aria-label="Next month"
          title="Next month"
          onClick={() => setYearMonth(shiftYearMonth(yearMonth, 1))}
        >
          <IconChevronRight className="icon" />
        </button>
      </div>

      {loading ? <Skeleton count={3} /> : null}
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
                    <ConfirmButton
                      className="btn btn-ghost"
                      what={`spending limit for ${r.name}`}
                      onConfirm={() => removeLimit(r.categoryId)}
                    >
                      Remove
                    </ConfirmButton>
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

/** Recurring payments: rules list, mark-paid with capped catch-up. */
function RecurringView() {
  const [rules, setRules] = useState<RecurringPaymentRow[]>([]);
  const [expenseCats, setExpenseCats] = useState<ExpenseCategoryRow[]>([]);
  const [wallets, setWallets] = useState<WalletRow[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [fallbackCategoryId, setFallbackCategoryId] = useState<number | "">("");
  const [fallbackWalletId, setFallbackWalletId] = useState<number | "">("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  /**
   * `createRule` submit guard (review P2-4): the ref is authoritative and the
   * state is what the button reads — the pinned money-form shape. The repo
   * call is a plain INSERT, so a double submit creates a duplicate rule that
   * later double-books the same expense through `markPaid`.
   */
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  /** The rule the form is editing, or null when it creates (review P2-9). */
  const [editing, setEditing] = useState<RecurringPaymentRow | null>(null);

  const [title, setTitle] = useState("");
  const [amountRaw, setAmountRaw] = useState("");
  const [frequency, setFrequency] = useState<RecurringFrequency>("monthly");
  const [nextDue, setNextDue] = useState(() => todayLocal());
  const [ruleCategory, setRuleCategory] = useState<number | "">("");
  const [ruleWallet, setRuleWallet] = useState<number | "">("");

  const refresh = useCallback(async (includeInactive: boolean, signal?: { cancelled: boolean }) => {
    try {
      setLoading(true);
      const [rs, ec, ws] = await Promise.all([
        budgetRepo.listRecurring(includeInactive),
        budgetRepo.listExpenseCategories(),
        budgetRepo.listWallets(),
      ]);
      if (signal?.cancelled) return;
      setRules(rs);
      setExpenseCats(ec);
      setWallets(ws);
      // Deliberately NOT defaulted to the first category / first wallet
      // (review P3-30). It used to be, which made "I have not chosen a fallback"
      // and "I chose Food" indistinguishable — so a rule carrying no category
      // of its own was booked to `Food` from the first row of the table, with
      // no click from anyone. A fallback that is filled in by default is not a
      // fallback; it is a guess that lands in the ledger.
      setError(null);
    } catch (e) {
      if (!signal?.cancelled) setError(errText(e));
    } finally {
      if (!signal?.cancelled) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const signal = { cancelled: false };
    void refresh(showInactive, signal);
    return () => {
      signal.cancelled = true;
    };
  }, [showInactive, refresh]);

  /**
   * Resolve where a rule's expense should be booked, and say so plainly when it
   * cannot be worked out (review P3-30).
   *
   * The rule's OWN category and wallet win; the fallback pickers are only for
   * the rules that carry neither. The old guard required both fallbacks to be
   * selected unconditionally, so a fully-specified rule could not be marked
   * paid until the user touched two dropdowns that had no bearing on it — and
   * because those dropdowns auto-defaulted, the "pick one" step usually
   * resolved to the first row in the table without anyone deciding anything.
   *
   * Returns the ids, or null after setting the error itself.
   */
  const resolveBookingFor = (
    rule: RecurringPaymentRow,
  ): { categoryId: number; walletId: number } | null => {
    const categoryId = rule.category_id ?? fallbackCategoryId;
    const walletId = rule.wallet_id ?? fallbackWalletId;
    if (typeof categoryId !== "number" || typeof walletId !== "number") {
      const missing = [
        ...(typeof categoryId !== "number" ? ["category"] : []),
        ...(typeof walletId !== "number" ? ["wallet"] : []),
      ];
      setError(
        `“${rule.title}” has no ${missing.join(" or ")} of its own — choose a fallback ${missing.join(" and ")} above, or edit the rule.`,
      );
      return null;
    }
    return { categoryId, walletId };
  };

  const markPaid = async (rule: RecurringPaymentRow) => {
    if (busyId !== null) return;
    const booking = resolveBookingFor(rule);
    if (booking === null) return;
    setBusyId(rule.id);
    try {
      await budgetRepo.markRecurringPaid(rule.id, todayLocal(), booking);
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
    if (savingRef.current) return;
    const amountCents = parseMMK(amountRaw);
    const name = cleanName(title);
    if (amountCents === null || amountCents <= 0 || !name || !nextDue) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (editing !== null) {
        await budgetRepo.updateRecurring(editing.id, {
          title: name,
          amountCents,
          categoryId: ruleCategory === "" ? null : ruleCategory,
          walletId: ruleWallet === "" ? null : ruleWallet,
          frequency,
          nextDueDate: nextDue,
        });
      } else {
        await budgetRepo.createRecurring({
          title: name,
          amountCents,
          categoryId: ruleCategory === "" ? null : ruleCategory,
          walletId: ruleWallet === "" ? null : ruleWallet,
          frequency,
          nextDueDate: nextDue,
        });
      }
      setTitle("");
      setAmountRaw("");
      setRuleCategory("");
      setRuleWallet("");
      setEditing(null);
      await refresh(showInactive);
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  /** Load a rule into the form for correction (review P2-9). */
  const startEditRule = (rule: RecurringPaymentRow) => {
    setEditing(rule);
    setTitle(rule.title);
    setAmountRaw(fromCents(rule.amount_cents).toFixed(2));
    setRuleCategory(rule.category_id ?? "");
    setRuleWallet(rule.wallet_id ?? "");
    setFrequency(rule.frequency);
    setNextDue(rule.next_due_date);
    setError(null);
  };

  const cancelEditRule = () => {
    setEditing(null);
    setTitle("");
    setAmountRaw("");
    setRuleCategory("");
    setRuleWallet("");
  };

  const removeRule = async (id: number) => {
    try {
      await budgetRepo.deleteRecurring(id);
      if (editing?.id === id) cancelEditRule();
      await refresh(showInactive);
    } catch (e) {
      setError(errText(e));
    }
  };

  return (
    <section className="budget-recurring" aria-label="Recurring payments">
      {loading ? <Skeleton count={3} /> : null}
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
        {/* Both fallback pickers are now unselected by default and only apply to
            rules that carry no category/wallet of their own (review P3-30), so
            the labels say so — a picker that looks like a setting but is
            consulted only for some rules is how the silent Food/Cash booking
            went unnoticed. */}
        <label className="muted">
          Fallback category (rules with none){" "}
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
          Fallback wallet (rules with none){" "}
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
            const d = recurringDisplay(r, todayLocal());
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
                  {/* Pause was the only escape hatch before P2-9, so a rule
                      created by mistake stayed in the list forever. */}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => startEditRule(r)}
                  >
                    Edit
                  </button>
                  <ConfirmButton
                    className="btn btn-ghost"
                    what={`recurring rule “${r.title}” — expenses it already booked stay in the Budget`}
                    onConfirm={() => removeRule(r.id)}
                  >
                    Delete
                  </ConfirmButton>
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
        <h2 className="side-heading">
          {editing === null
            ? "New recurring payment"
            : `Edit rule — ${editing.title}`}
        </h2>
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
            Amount
            <span className="input-affix">
              <input
                inputMode="decimal"
                placeholder="0.00"
                value={amountRaw}
                onChange={(e) => setAmountRaw(e.target.value)}
                aria-invalid={
                  amountRaw.trim() !== "" && !isPartialAmount(amountRaw)
                    ? "true"
                    : undefined
                }
              />
              <span className="input-affix-prefix">MMK</span>
            </span>
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
            <span className="input-icon-wrap">
              <input
                type="date"
                aria-label="Next due date"
                value={nextDue}
                onChange={(e) => setNextDue(e.target.value)}
              />
              <IconCalendar className="icon input-icon is-end" />
            </span>
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
              saving ||
              cleanName(title) === null ||
              parseMMK(amountRaw) === null ||
              (parseMMK(amountRaw) ?? 0) <= 0 ||
              !nextDue
            }
          >
            {editing === null ? "Add rule" : "Save changes"}
          </button>
          {editing !== null ? (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={cancelEditRule}
            >
              Cancel edit
            </button>
          ) : null}
        </div>
      </form>
    </section>
  );
}
