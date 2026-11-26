// The phone's Budget screen (wallets and the append-only entries) and the
// entry composer it appends through.

import { useCallback, useEffect, useState } from "react";
import { budgetRepo } from "../../data/app.ts";
import type { WalletEntryRow } from "../../lib/budget.ts";
import { todayLocal } from "../../lib/dates.ts";
import { entryFormReady } from "../../lib/mobileBudget.ts";
import { formatMMK, parseMMK } from "../../lib/money.ts";
import { EmptyState } from "../EmptyState.tsx";
import { useLocale, useT } from "../useTranslation.ts";
import { LoadMessage, useLoad } from "./common.tsx";

// -- Budget: wallets + append-only entries -----------------------------------

/**
 * The Budget tab: every wallet with its recorded balance, and the entries of
 * the wallet that was tapped.
 *
 * Append-only (decision 4): the screen offers the two create forms and nothing
 * else. There is no edit or delete control anywhere on the mobile surface, and
 * the repo methods behind it (`createIncomeEntry` / `createExpenseEntry`) only
 * INSERT.
 */
export function BudgetScreen({
  onCompose,
}: {
  onCompose: (id: "income" | "expense") => void;
}) {
  const t = useT();
  const locale = useLocale();
  const load = useCallback(async () => {
    const [wallets, balances, incomeCategories, expenseCategories] =
      await Promise.all([
        budgetRepo.listWallets(),
        budgetRepo.listWalletBalances(),
        budgetRepo.listIncomeCategories(),
        budgetRepo.listExpenseCategories(),
      ]);
    return { wallets, balances, incomeCategories, expenseCategories };
  }, []);
  const { data, failed, reload } = useLoad(load);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [entries, setEntries] = useState<WalletEntryRow[]>([]);

  const wallets = data?.wallets ?? [];
  const balanceById = new Map(
    (data?.balances ?? []).map((wallet) => [wallet.id, wallet.balanceCents]),
  );
  // Income and expense categories are separate id spaces (the schema keeps
  // them in separate tables), so they need separate maps: merged by id, an
  // income entry could be labelled with an unrelated expense category.
  const incomeNames = new Map(
    (data?.incomeCategories ?? []).map((row) => [row.id, row.name]),
  );
  const expenseNames = new Map(
    (data?.expenseCategories ?? []).map((row) => [row.id, row.name]),
  );
  const selected = wallets.find((wallet) => wallet.id === selectedId) ?? null;

  useEffect(() => {
    if (selectedId === null) {
      setEntries([]);
      return;
    }
    let cancelled = false;
    budgetRepo
      .listWalletEntries(selectedId)
      .then((rows) => {
        if (!cancelled) setEntries(rows);
      })
      .catch(() => {
        if (!cancelled) setEntries([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.budget")}</p>
      <div className="mobile-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onCompose("income")}
        >
          {t("mobile.fab.income")}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => onCompose("expense")}
        >
          {t("mobile.fab.expense")}
        </button>
      </div>
      <p className="muted">{t("mobile.budget.appendOnly")}</p>
      <LoadMessage failed={failed} />
      {data !== null && wallets.length === 0 ? (
        <EmptyState>{t("mobile.budget.noWallets")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.budget.walletsAria")}>
        {wallets.map((wallet) => {
          const isOpen = selected?.id === wallet.id;
          return (
            <li key={wallet.id}>
              <button
                type="button"
                className={
                  isOpen
                    ? "mobile-card mobile-card-btn is-open"
                    : "mobile-card mobile-card-btn"
                }
                aria-expanded={isOpen}
                onClick={() => setSelectedId(isOpen ? null : wallet.id)}
              >
                <span className="mobile-wallet-line">
                  <span className="mobile-card-title">{wallet.name}</span>
                  <span className="mobile-card-title">
                    {formatMMK(balanceById.get(wallet.id) ?? 0, locale)}
                  </span>
                </span>
                <span className="mobile-card-meta">
                  {isOpen
                    ? t("mobile.budget.hideEntries")
                    : t("mobile.budget.showEntries")}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {selected !== null ? (
        <div className="mobile-quick">
          <p className="mobile-section-kicker">
            {t("mobile.budget.entriesHeading")}
          </p>
          {entries.length === 0 ? (
            <p className="muted">{t("mobile.budget.noEntries")}</p>
          ) : (
            <ul
              className="mobile-list"
              aria-label={t("mobile.budget.entriesAria")}
            >
              {entries.map((entry) => (
                <li key={`${entry.kind}-${entry.id}`} className="mobile-card">
                  <span className="mobile-wallet-line">
                    <span className="mobile-row-text">
                      <span>
                        {entry.kind === "income"
                          ? t("mobile.entry.kindIncome")
                          : t("mobile.entry.kindExpense")}
                        {" · "}
                        {(entry.kind === "income"
                          ? incomeNames
                          : expenseNames
                        ).get(entry.category_id) ?? ""}
                      </span>
                      {entry.note.trim() !== "" ? (
                        <span className="mobile-row-meta">{entry.note}</span>
                      ) : null}
                    </span>
                    <span className="mobile-card-title">
                      {formatMMK(entry.amount_cents, locale)}
                    </span>
                  </span>
                  <span className="mobile-card-meta">{entry.entry_date}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      <button
        type="button"
        className="mobile-link-btn"
        onClick={reload}
        hidden={!failed}
      >
        {t("common.tryAgain")}
      </button>
    </section>
  );
}

/**
 * The create form for one ledger side, opened from the FAB or the Budget tab.
 *
 * The wallet and category lists come from the database. When either is empty
 * the form says where to create one (the desktop) and refuses to save — it
 * never invents a wallet, a category or a balance.
 */
export function EntryCompose({
  kind,
  onDone,
}: {
  kind: "income" | "expense";
  onDone: () => void;
}) {
  const t = useT();
  const load = useCallback(async () => {
    const [wallets, incomeCategories, expenseCategories] = await Promise.all([
      budgetRepo.listWallets(),
      budgetRepo.listIncomeCategories(),
      budgetRepo.listExpenseCategories(),
    ]);
    return { wallets, incomeCategories, expenseCategories };
  }, []);
  const { data, failed } = useLoad(load);
  const [amount, setAmount] = useState("");
  const [walletId, setWalletId] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [entryDate, setEntryDate] = useState(() => todayLocal());
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const wallets = data?.wallets ?? [];
  const categories =
    (kind === "income" ? data?.incomeCategories : data?.expenseCategories) ??
    [];
  const targetWallet = walletId ?? wallets[0]?.id ?? null;
  const targetCategory = categoryId ?? categories[0]?.id ?? null;
  const amountCents = parseMMK(amount);
  const ready = entryFormReady({
    amountCents,
    walletId: targetWallet,
    categoryId: targetCategory,
  });
  const amountProblem =
    amount.trim() !== "" && (amountCents === null || amountCents <= 0);

  const save = async () => {
    if (!ready || busy || targetWallet === null || targetCategory === null) {
      return;
    }
    setBusy(true);
    setSaveFailed(false);
    try {
      const input = {
        amountCents: amountCents ?? 0,
        categoryId: targetCategory,
        walletId: targetWallet,
        entryDate: entryDate === "" ? todayLocal() : entryDate,
        note: note.trim(),
      };
      if (kind === "income") await budgetRepo.createIncomeEntry(input);
      else await budgetRepo.createExpenseEntry(input);
      onDone();
    } catch {
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <p className="muted">{t("mobile.budget.appendOnly")}</p>
      <LoadMessage failed={failed} />
      {data !== null && wallets.length === 0 ? (
        <EmptyState>{t("mobile.entry.noWalletGuide")}</EmptyState>
      ) : null}
      {data !== null && wallets.length > 0 && categories.length === 0 ? (
        <EmptyState>
          {t("mobile.entry.noCategoryGuide", {
            kind:
              kind === "income"
                ? t("mobile.entry.kindIncome")
                : t("mobile.entry.kindExpense"),
          })}
        </EmptyState>
      ) : null}
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("mobile.entry.amountLabel")}</span>
          <input
            className="input"
            type="text"
            inputMode="decimal"
            value={amount}
            placeholder={t("mobile.entry.amountPlaceholder")}
            aria-invalid={amountProblem}
            onChange={(event) => setAmount(event.currentTarget.value)}
          />
        </label>
        {amountProblem ? (
          <p className="mobile-error" role="alert">
            {t("mobile.entry.invalidAmount")}
          </p>
        ) : null}
        {wallets.length > 0 && categories.length > 0 ? (
          <>
            <label className="mobile-field">
              <span>{t("mobile.entry.walletLabel")}</span>
              <select
                className="input"
                value={String(targetWallet ?? "")}
                onChange={(event) =>
                  setWalletId(Number(event.currentTarget.value))
                }
              >
                {wallets.map((wallet) => (
                  <option key={wallet.id} value={wallet.id}>
                    {wallet.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="mobile-field">
              <span>{t("mobile.entry.categoryLabel")}</span>
              <select
                className="input"
                value={String(targetCategory ?? "")}
                onChange={(event) =>
                  setCategoryId(Number(event.currentTarget.value))
                }
              >
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
          </>
        ) : null}
        <label className="mobile-field">
          <span>{t("mobile.entry.dateLabel")}</span>
          <input
            className="input"
            type="date"
            value={entryDate}
            onChange={(event) => setEntryDate(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("mobile.entry.noteLabel")}</span>
          <input
            className="input"
            type="text"
            value={note}
            placeholder={t("mobile.entry.notePlaceholder")}
            onChange={(event) => setNote(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={saveFailed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !ready}
          >
            {busy
              ? t("notes.saving")
              : kind === "income"
                ? t("mobile.entry.saveIncome")
                : t("mobile.entry.saveExpense")}
          </button>
        </div>
      </form>
    </section>
  );
}
