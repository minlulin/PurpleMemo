// P3b Budget page (§2.1): wallets, income/expense entries, categories,
// monthly/yearly views, expense limits + warnings, recurring payments.
// Talks only to the budget repo (§4). Views land progressively: this file
// starts with the shell + Manage view and gains one view per P3b task.

import { useCallback, useEffect, useState } from "react";
import { budgetRepo } from "../data/app.ts";
import { cleanName } from "../lib/budget.ts";
import { formatMMK } from "../lib/money.ts";
import type {
  ExpenseCategoryRow,
  IncomeCategoryRow,
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
      {view === "manage" ? (
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
