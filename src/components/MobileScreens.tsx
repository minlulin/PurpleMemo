// The phone's first real data screens: Notes, Tasks and Shopping, plus the
// Dashboard's quick capture and allowlisted search.
//
// Rules live in `lib/mobileShell.ts` / `lib/mobileSearch.ts`; this file is the
// wiring over the shared repositories, which are the same ones the desktop
// pages use. Nothing here touches the driver or Tauri IPC directly, and nothing
// here mints identity — `createNote` / `createTask` / `addItem` do that, so a
// record typed on the phone is as sync-ready as one typed on the desktop.
//
// Mobile is view + add + mark-done toggles only (design, interaction model):
// the three flows below can create a record and flip exactly the one boolean
// the design allows. No other edit exists here on purpose.

import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import {
  budgetRepo,
  habitsRepo,
  notesRepo,
  searchMobileWorkspace,
  shoppingRepo,
  tasksRepo,
} from "../data/app.ts";
import type { WalletEntryRow } from "../lib/budget.ts";
import { todayLocal } from "../lib/dates.ts";
import type { SearchGroup } from "../lib/globalSearch.ts";
import { entryFormReady, recordedBalanceCents } from "../lib/mobileBudget.ts";
import {
  habitDoneToday,
  pinnedNotes,
  urgentTasks,
} from "../lib/mobileDashboard.ts";
import { formatMMK, parseMMK } from "../lib/money.ts";
import { SEARCH_DEBOUNCE_MS } from "../lib/searchContract.ts";
import type {
  ShoppingItemRow,
  ShoppingListRow,
  TaskRow,
} from "../lib/types.ts";
import { EmptyState } from "./EmptyState.tsx";
import { markdownComponents, markdownUrlTransform } from "./MarkdownLink.tsx";
import { useLocale, useT } from "./useTranslation.ts";

/**
 * Loads a list once per mount and again after a reload.
 *
 * The reload counter is folded into the loader's identity rather than into the
 * effect's dependency list: that way the effect depends on ONE function whose
 * identity changes exactly when a re-read is wanted, and the counter is
 * genuinely used (a bare extra dependency is a lint error here).
 */
function useLoad<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [failed, setFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  const load = useCallback(() => {
    void version; // the counter is the reason this identity changes
    return loader();
  }, [loader, version]);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    load()
      .then((value) => {
        if (!cancelled) setData(value);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [load]);
  return { data, failed, reload };
}

function LoadMessage({ failed }: { failed: boolean }) {
  const t = useT();
  if (!failed) return null;
  return (
    <p className="mobile-error" role="alert">
      {t("mobile.loadFailed")}
    </p>
  );
}

// -- Notes -------------------------------------------------------------------

export function NotesScreen({ onCompose }: { onCompose: () => void }) {
  const t = useT();
  const load = useCallback(() => notesRepo.listNotes({ limit: 100 }), []);
  const { data, failed, reload } = useLoad(load);

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.notes")}</p>
      <div className="mobile-actions">
        <button type="button" className="btn btn-primary" onClick={onCompose}>
          {t("notes.newNote")}
        </button>
      </div>
      <LoadMessage failed={failed} />
      {data !== null && data.length === 0 ? (
        <EmptyState>{t("notes.noNotes")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("notes.notesAria")}>
        {(data ?? []).map((note) => (
          <li key={note.id} className="mobile-card">
            <p className="mobile-card-title">
              {note.title.trim() === "" ? t("notes.untitled") : note.title}
            </p>
            <p className="mobile-card-body">
              {note.content.trim() === "" ? t("notes.noExcerpt") : note.content}
            </p>
            <p className="mobile-card-meta">{note.updated_at}</p>
          </li>
        ))}
      </ul>
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

export function NoteCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const empty = title.trim() === "" && content.trim() === "";

  const save = async () => {
    if (empty || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await notesRepo.createNote({ title: title.trim(), content });
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("notes.titleAria")}</span>
          <input
            className="input"
            type="text"
            value={title}
            placeholder={t("mobile.noteTitlePlaceholder")}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("notes.contentAria")}</span>
          <textarea
            className="input mobile-textarea"
            value={content}
            placeholder={t("notes.contentPlaceholder")}
            rows={6}
            onChange={(event) => setContent(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={failed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || empty}
          >
            {busy ? t("notes.saving") : t("notes.save")}
          </button>
        </div>
      </form>
    </section>
  );
}

// -- Tasks -------------------------------------------------------------------

export function TasksScreen({ onCompose }: { onCompose: () => void }) {
  const t = useT();
  const load = useCallback(() => tasksRepo.listTasks(true), []);
  const { data, failed, reload } = useLoad(load);
  const [busyId, setBusyId] = useState<number | null>(null);

  const toggle = async (task: TaskRow) => {
    setBusyId(task.id);
    try {
      await tasksRepo.toggleTask(task.id, task.done === 0);
      reload();
    } finally {
      setBusyId(null);
    }
  };

  const tasks = data ?? [];
  const open = tasks.filter((task) => task.done === 0);
  const done = tasks.filter((task) => task.done === 1);

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("tasks.title")}</p>
      <div className="mobile-actions">
        <button type="button" className="btn btn-primary" onClick={onCompose}>
          {t("tasks.newTask")}
        </button>
      </div>
      <LoadMessage failed={failed} />
      {data !== null && open.length === 0 ? (
        <EmptyState>{t("tasks.empty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("tasks.openAria")}>
        {open.map((task) => (
          <li key={task.id}>
            <label className="mobile-row">
              <input
                type="checkbox"
                checked={false}
                disabled={busyId === task.id}
                aria-label={t("mobile.markDone")}
                onChange={() => void toggle(task)}
              />
              <span className="mobile-row-text">
                {task.title}
                {task.due_date !== null ? (
                  <span className="mobile-row-meta">
                    {task.due_date < todayLocal()
                      ? t("tasks.overdue")
                      : t("tasks.due", { date: task.due_date })}
                  </span>
                ) : null}
              </span>
            </label>
          </li>
        ))}
      </ul>
      {done.length > 0 ? (
        <>
          <p className="mobile-section-kicker">{t("tasks.completed")}</p>
          <ul className="mobile-list" aria-label={t("tasks.completed")}>
            {done.map((task) => (
              <li key={task.id}>
                <label className="mobile-row is-done">
                  <input
                    type="checkbox"
                    checked
                    disabled={busyId === task.id}
                    aria-label={t("mobile.markNotDone")}
                    onChange={() => void toggle(task)}
                  />
                  <span className="mobile-row-text">{task.title}</span>
                </label>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}

export function TaskCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async () => {
    if (title.trim() === "" || busy) return;
    setBusy(true);
    setFailed(false);
    try {
      await tasksRepo.createTask({
        title: title.trim(),
        dueDate: dueDate === "" ? null : dueDate,
      });
      onDone();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("tasks.titleLabel")}</span>
          <input
            className="input"
            type="text"
            value={title}
            placeholder={t("tasks.titlePlaceholder")}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("tasks.dueLabel")}</span>
          <input
            className="input"
            type="date"
            value={dueDate}
            aria-label={t("tasks.dueAria")}
            onChange={(event) => setDueDate(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={failed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || title.trim() === ""}
          >
            {busy ? t("notes.saving") : t("tasks.add")}
          </button>
        </div>
      </form>
    </section>
  );
}

// -- Shopping ----------------------------------------------------------------

export function ShoppingScreen({ onCompose }: { onCompose: () => void }) {
  const t = useT();
  const load = useCallback(() => shoppingRepo.listLists(), []);
  const { data: lists, failed, reload } = useLoad(load);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [newList, setNewList] = useState("");
  const [creating, setCreating] = useState(false);
  const [items, setItems] = useState<ShoppingItemRow[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);

  const all = lists ?? [];
  const selected = all.find((list) => list.id === selectedId) ?? all[0];

  // The item list follows the selected list; `reloadIfEmpty` re-reads the
  // lists after the create form adds one.
  useEffect(() => {
    if (selected === undefined) {
      setItems([]);
      return;
    }
    let cancelled = false;
    shoppingRepo
      .listItems(selected.id)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch(() => {
        if (!cancelled) setItems([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  const toggleItem = async (item: ShoppingItemRow) => {
    setBusyId(item.id);
    try {
      await shoppingRepo.toggleItem(item.id, item.done === 0);
      const rows = await shoppingRepo.listItems(item.list_id);
      setItems(rows);
    } finally {
      setBusyId(null);
    }
  };

  const createList = async () => {
    const name = newList.trim();
    if (name === "" || creating) return;
    setCreating(true);
    try {
      const id = await shoppingRepo.createList(name);
      setNewList("");
      setSelectedId(id);
      reload();
    } finally {
      setCreating(false);
    }
  };

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.shopping")}</p>
      <div className="mobile-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={onCompose}
          disabled={all.length === 0}
        >
          {t("mobile.addItem")}
        </button>
      </div>
      <LoadMessage failed={failed} />
      {all.length === 0 ? (
        <EmptyState>{t("mobile.shoppingNoLists")}</EmptyState>
      ) : (
        <div
          className="mobile-chips"
          role="tablist"
          aria-label={t("nav.shopping")}
        >
          {all.map((list) => (
            <button
              key={list.id}
              type="button"
              role="tab"
              aria-selected={(selected?.id ?? null) === list.id}
              className={
                (selected?.id ?? null) === list.id
                  ? "mobile-chip is-active"
                  : "mobile-chip"
              }
              onClick={() => setSelectedId(list.id)}
            >
              {list.name}
            </button>
          ))}
        </div>
      )}
      {all.length > 0 && items.length === 0 ? (
        <EmptyState>{t("mobile.shoppingEmpty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.shoppingItemsAria")}>
        {items.map((item) => (
          <li key={item.id}>
            <label
              className={item.done === 0 ? "mobile-row" : "mobile-row is-done"}
            >
              <input
                type="checkbox"
                checked={item.done === 1}
                disabled={busyId === item.id}
                aria-label={
                  item.done === 1
                    ? t("mobile.markNotBought")
                    : t("mobile.markBought")
                }
                onChange={() => void toggleItem(item)}
              />
              <span className="mobile-row-text">{item.text}</span>
            </label>
          </li>
        ))}
      </ul>
      <form
        className="mobile-actions"
        onSubmit={(event) => {
          event.preventDefault();
          void createList();
        }}
      >
        <input
          className="input"
          type="text"
          value={newList}
          placeholder={t("mobile.shoppingNewList")}
          aria-label={t("mobile.shoppingNewList")}
          onChange={(event) => setNewList(event.currentTarget.value)}
        />
        <button
          type="submit"
          className="btn"
          disabled={creating || newList.trim() === ""}
        >
          {t("mobile.shoppingCreateList")}
        </button>
      </form>
    </section>
  );
}

export function ShoppingItemCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const load = useCallback(() => shoppingRepo.listLists(), []);
  const { data: lists, failed } = useLoad(load);
  const [text, setText] = useState("");
  const [listId, setListId] = useState<number | null>(null);
  const [newListName, setNewListName] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const all: ShoppingListRow[] = lists ?? [];
  const targetId = listId ?? all[0]?.id ?? null;

  const save = async () => {
    if (text.trim() === "" || busy) return;
    setBusy(true);
    setSaveFailed(false);
    try {
      let destination = targetId;
      if (destination === null) {
        const name = newListName.trim();
        if (name === "") {
          setBusy(false);
          return;
        }
        destination = await shoppingRepo.createList(name);
      }
      await shoppingRepo.addItem(destination, text.trim());
      onDone();
    } catch {
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("mobile.shoppingItemLabel")}</span>
          <input
            className="input"
            type="text"
            value={text}
            placeholder={t("mobile.shoppingItemPlaceholder")}
            onChange={(event) => setText(event.currentTarget.value)}
          />
        </label>
        {all.length > 0 ? (
          <label className="mobile-field">
            <span>{t("mobile.shoppingListLabel")}</span>
            <select
              className="input"
              value={String(targetId ?? "")}
              onChange={(event) => setListId(Number(event.currentTarget.value))}
            >
              {all.map((list) => (
                <option key={list.id} value={list.id}>
                  {list.name}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="mobile-field">
            <span>{t("mobile.shoppingListName")}</span>
            <input
              className="input"
              type="text"
              value={newListName}
              placeholder={t("mobile.shoppingNewList")}
              onChange={(event) => setNewListName(event.currentTarget.value)}
            />
          </label>
        )}
        <LoadMessage failed={failed || saveFailed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || text.trim() === ""}
          >
            {busy ? t("notes.saving") : t("mobile.addItem")}
          </button>
        </div>
      </form>
    </section>
  );
}

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

// -- Dashboard: money, due tasks, pinned notes, habit check-ins ----------------

export function DashboardScreen({
  onOpenNote,
}: {
  onOpenNote: (id: number) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const load = useCallback(async () => {
    const today = todayLocal();
    const [balances, tasks, notes, habits] = await Promise.all([
      budgetRepo.listWalletBalances(),
      tasksRepo.dueTasks(today),
      notesRepo.listNotes({ limit: 100 }),
      habitsRepo.habitProgressList(today),
    ]);
    return { today, balances, tasks, notes, habits };
  }, []);
  const { data, failed, reload } = useLoad(load);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [writeFailed, setWriteFailed] = useState(false);
  const [text, setText] = useState("");
  const [saved, setSaved] = useState(false);

  const completeTask = async (task: TaskRow) => {
    setBusyKey(`task:${task.id}`);
    setWriteFailed(false);
    try {
      await tasksRepo.completeTask(task.id);
      reload();
    } catch {
      setWriteFailed(true);
    } finally {
      setBusyKey(null);
    }
  };

  const toggleHabit = async (habitId: number, date: string) => {
    setBusyKey(`habit:${habitId}`);
    setWriteFailed(false);
    try {
      await habitsRepo.toggleLog(habitId, date);
      reload();
    } catch {
      setWriteFailed(true);
    } finally {
      setBusyKey(null);
    }
  };

  const today = data?.today ?? todayLocal();
  const balances = data?.balances ?? [];
  const tasks = data === null ? [] : urgentTasks(data.tasks, data.today);
  const pinned = data === null ? [] : pinnedNotes(data.notes);
  const habits = data?.habits ?? [];

  const capture = async () => {
    const body = text.trim();
    if (body === "") return;
    try {
      await notesRepo.createNote({ title: "", content: body });
      setText("");
      setSaved(true);
      reload();
    } catch {
      setSaved(false);
    }
  };

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.dashboard")}</p>
      <LoadMessage failed={failed || writeFailed} />

      <div className="mobile-quick">
        <p className="mobile-section-kicker">
          {t("mobile.dashboard.recordedBalance")}
        </p>
        {data !== null && balances.length === 0 ? (
          <p className="muted">{t("mobile.dashboard.noWallets")}</p>
        ) : (
          <>
            <p className="mobile-balance">
              {formatMMK(recordedBalanceCents(balances), locale)}
            </p>
            <ul
              className="mobile-list"
              aria-label={t("mobile.dashboard.walletsAria")}
            >
              {balances.map((wallet) => (
                <li key={wallet.id} className="mobile-wallet-line">
                  <span className="mobile-row-text">{wallet.name}</span>
                  <span className="mobile-row-meta">
                    {formatMMK(wallet.balanceCents, locale)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      <div className="mobile-quick">
        <p className="mobile-section-kicker">
          {t("mobile.dashboard.tasksHeading")}
        </p>
        {data !== null && tasks.length === 0 ? (
          <p className="muted">{t("mobile.dashboard.noTasks")}</p>
        ) : null}
        <ul
          className="mobile-list"
          aria-label={t("mobile.dashboard.tasksAria")}
        >
          {tasks.map((task) => (
            <li key={task.id}>
              <label className="mobile-row">
                <input
                  type="checkbox"
                  checked={false}
                  disabled={busyKey === `task:${task.id}`}
                  aria-label={t("mobile.markDone")}
                  onChange={() => void completeTask(task)}
                />
                <span className="mobile-row-text">
                  {task.title}
                  {task.due_date !== null ? (
                    <span className="mobile-row-meta">
                      {task.due_date < today
                        ? t("tasks.overdue")
                        : t("tasks.due", { date: task.due_date })}
                    </span>
                  ) : null}
                </span>
              </label>
            </li>
          ))}
        </ul>
      </div>

      <div className="mobile-quick">
        <p className="mobile-section-kicker">
          {t("mobile.dashboard.pinnedHeading")}
        </p>
        {data !== null && pinned.length === 0 ? (
          <p className="muted">{t("mobile.dashboard.noPinned")}</p>
        ) : null}
        <ul
          className="mobile-list"
          aria-label={t("mobile.dashboard.pinnedAria")}
        >
          {pinned.map((note) => (
            <li key={note.id}>
              <button
                type="button"
                className="mobile-card mobile-card-btn"
                onClick={() => onOpenNote(note.id)}
              >
                <span className="mobile-card-title">
                  {note.title.trim() === "" ? t("notes.untitled") : note.title}
                </span>
                {note.content.trim() !== "" ? (
                  <span className="mobile-card-body">{note.content}</span>
                ) : null}
                <span className="mobile-card-meta">
                  {t("mobile.dashboard.openNote")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>

      <div className="mobile-quick">
        <p className="mobile-section-kicker">
          {t("mobile.dashboard.habitsHeading")}
        </p>
        {data !== null && habits.length === 0 ? (
          <p className="muted">{t("mobile.dashboard.noHabits")}</p>
        ) : null}
        <ul
          className="mobile-list"
          aria-label={t("mobile.dashboard.habitsAria")}
        >
          {habits.map((progress) => {
            const done = habitDoneToday(progress.week, today);
            return (
              <li key={progress.habit.id}>
                <label className={done ? "mobile-row is-done" : "mobile-row"}>
                  <input
                    type="checkbox"
                    checked={done}
                    disabled={busyKey === `habit:${progress.habit.id}`}
                    aria-label={
                      done ? t("mobile.markNotDone") : t("mobile.markDone")
                    }
                    onChange={() => void toggleHabit(progress.habit.id, today)}
                  />
                  <span className="mobile-row-text">{progress.habit.name}</span>
                </label>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mobile-quick">
        <label className="mobile-quick-label" htmlFor="mobile-quick-capture">
          {t("mobile.quickCapture")}
        </label>
        <input
          id="mobile-quick-capture"
          className="input"
          type="text"
          value={text}
          placeholder={t("mobile.quickCapturePlaceholder")}
          onChange={(event) => {
            setText(event.currentTarget.value);
            setSaved(false);
          }}
          onFocus={(event) => {
            const field = event.currentTarget;
            requestAnimationFrame(() =>
              field.scrollIntoView({ block: "center" }),
            );
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void capture();
            }
          }}
        />
        <p className="muted">{t("mobile.quickCaptureHint")}</p>
        <div className="mobile-actions">
          <button
            type="button"
            className="btn"
            disabled={text.trim() === ""}
            onClick={() => void capture()}
          >
            {t("notes.save")}
          </button>
        </div>
        {saved ? (
          <p className="mobile-saved" role="status">
            {t("mobile.noteSaved")}
          </p>
        ) : null}
      </div>
      <MobileSearch />
    </section>
  );
}

/**
 * A note opened from the Dashboard preview. Its own screen (a route, not a
 * dialog) so the Android back gesture closes it instead of leaving the app.
 */
export function NoteReaderScreen({ noteId }: { noteId: number }) {
  const t = useT();
  const load = useCallback(() => notesRepo.getNote(noteId), [noteId]);
  const { data, failed, reload } = useLoad(load);

  return (
    <section className="mobile-page">
      <LoadMessage failed={failed} />
      <button
        type="button"
        className="mobile-link-btn"
        onClick={reload}
        hidden={!failed}
      >
        {t("common.tryAgain")}
      </button>
      {data === null ? null : data === undefined ? (
        <EmptyState>{t("mobile.noteReader.notFound")}</EmptyState>
      ) : (
        <article className="mobile-reader">
          <h2 className="mobile-reader-title">
            {data.title.trim() === "" ? t("notes.untitled") : data.title}
          </h2>
          <p className="mobile-card-meta">{data.updated_at}</p>
          {data.content.trim() === "" ? (
            <EmptyState>{t("mobile.noteReader.empty")}</EmptyState>
          ) : (
            <div className="mobile-reader-body">
              <ReactMarkdown
                components={markdownComponents}
                urlTransform={markdownUrlTransform}
              >
                {data.content}
              </ReactMarkdown>
            </div>
          )}
        </article>
      )}
    </section>
  );
}

/** Search scoped to the two entities the phone may see. */
export function MobileSearch() {
  const t = useT();
  const [term, setTerm] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);

  useEffect(() => {
    const input = term.trim();
    if (input === "") {
      setGroups([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      searchMobileWorkspace(input)
        .then((found) => {
          if (!cancelled) setGroups(found);
        })
        .catch(() => {
          if (!cancelled) setGroups([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [term]);

  const results = groups.flatMap((group) => group.results);

  return (
    <div className="mobile-quick">
      <label className="mobile-quick-label" htmlFor="mobile-search">
        {t("mobile.searchLabel")}
      </label>
      <input
        id="mobile-search"
        className="input"
        type="search"
        value={term}
        placeholder={t("mobile.searchPlaceholder")}
        onChange={(event) => setTerm(event.currentTarget.value)}
      />
      {term.trim() === "" ? (
        <p className="muted">{t("mobile.searchHint")}</p>
      ) : results.length === 0 ? (
        <p className="muted">{t("mobile.searchNoResults")}</p>
      ) : (
        <ul className="mobile-list" aria-label={t("mobile.searchResultsAria")}>
          {results.map((result) => (
            <li key={`${result.type}-${result.id}`} className="mobile-card">
              <p className="mobile-card-title">{result.title}</p>
              {result.excerpt !== null ? (
                <p className="mobile-card-body">{result.excerpt}</p>
              ) : null}
              <p className="mobile-card-meta">
                {t(
                  result.type === "task"
                    ? "search.type.task"
                    : "search.type.note",
                )}
              </p>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
