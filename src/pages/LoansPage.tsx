// P3c Loans page: money lent and borrowed. State is derived
// (open | partial | overdue | closed), never stored — the list recomputes
// it against today's local date. Repayments never overpay

import { useCallback, useEffect, useRef, useState } from "react";
import { ConfirmButton } from "../components/ConfirmButton.tsx";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconCalendar, IconLoans } from "../components/icons.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { useT } from "../components/useTranslation.ts";
import { loansRepo } from "../data/app.ts";
import { todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import type { MessageKey } from "../lib/i18n.ts";
import {
  formatMMK,
  fromCents,
  isPartialAmount,
  parseMMK,
} from "../lib/money.ts";
import type { LoanDirection, LoanRow, LoanState } from "../lib/types.ts";
import { useDayRollover } from "../lib/useDayRollover.ts";

type LoanListItem = LoanRow & { state: LoanState; remaining_cents: number };

const STATE_LABEL_KEY: Record<LoanState, MessageKey> = {
  open: "loans.state.open",
  partial: "loans.state.partial",
  overdue: "loans.state.overdue",
  closed: "loans.state.closed",
};

const DIRECTION_LABEL_KEY: Record<LoanDirection, MessageKey> = {
  lent: "loans.direction.lent",
  borrowed: "loans.direction.borrowed",
};

const STATE_BADGE: Record<LoanState, string> = {
  open: "badge badge-accent",
  partial: "badge badge-warn",
  overdue: "badge badge-danger",
  closed: "badge",
};

export default function LoansPage({
  focusId = null,
  focusToken = 0,
}: {
  focusId?: number | null;
  focusToken?: number;
}) {
  const t = useT();
  const [loans, setLoans] = useState<LoanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [repayFor, setRepayFor] = useState<number | null>(null);
  const [repayAmount, setRepayAmount] = useState("");
  /**
   * In-flight submit guards (review P2-11). A double-click on a money button
   * sent the same write twice: `recordRepayment` serializes per loan, so the
   * second call re-reads a *fresh* balance — which stops a duplicate FULL
   * repayment (it clamps to zero and is skipped) but happily applies a second
   * PARTIAL one. The repo layer cannot tell a retry from a second click, so
   * the button must not send it.
   *
   * `savingRef` is the authoritative guard and the state is what the button
   * reads: React flushes a `useState` update from a discrete event before
   * dispatching the next one, so by the time a second click is delivered the
   * button is already disabled *and* this closure reads `true`.
   */
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [payingId, setPayingId] = useState<number | null>(null);
  /**
   * The loan the form is editing, or null when it creates (review P2-9).
   *
   * `updateLoan` existed in the repository the whole time and nothing called it,
   * so a mistyped counterparty — a name typed by hand, the most typo-prone field
   * on the page — was permanent. That is the finding's own complaint about
   * Business and Budget, in a module it did not name.
   */
  const [editing, setEditing] = useState<LoanListItem | null>(null);

  const [counterparty, setCounterparty] = useState("");
  const [direction, setDirection] = useState<LoanDirection>("lent");
  const [amountRaw, setAmountRaw] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");

  /**
   * The day the loaded rows belong to (C2). `reload` reads `todayLocal()` at
   * call time instead of taking the render's value: a page left mounted past
   * midnight used to keep yesterday's overdue chips until something re-rendered
   * it, and a render-captured date would put that staleness back inside every
   * load.
   */
  const todayRef = useRef(todayLocal());

  const reload = useCallback(async () => {
    const today = todayLocal();
    todayRef.current = today;
    try {
      setLoans(await loansRepo.listLoansWithState(today));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The app keeps this page mounted across midnight (C2), so nothing re-renders
  // it when the date rolls over: this tick is what reloads the derived state —
  // overdue is computed against the day, not against the day it was loaded on.
  useDayRollover(() => void reload());

  // biome-ignore lint/correctness/useExhaustiveDependencies: focusToken retriggers a jump to the same loan
  useEffect(() => {
    if (focusId === null || loading) return;
    const row = document.getElementById(`search-target-loan-${focusId}`);
    if (row) row.scrollIntoView({ block: "nearest" });
    else setError(t("loans.missing"));
    if (row) setError(null);
  }, [focusId, focusToken, loading]);

  const amountCents = parseMMK(amountRaw);
  const nameOk = counterparty.trim().length > 0;

  const addLoan = async () => {
    if (savingRef.current) return;
    if (amountCents === null || amountCents <= 0 || !nameOk) return;
    savingRef.current = true;
    setSaving(true);
    try {
      if (editing !== null) {
        await loansRepo.updateLoan(editing.id, {
          counterparty: counterparty.trim(),
          direction,
          amountCents,
          dueDate: dueDate === "" ? null : dueDate,
          note: note.trim(),
        });
      } else {
        await loansRepo.createLoan({
          counterparty: counterparty.trim(),
          direction,
          amountCents,
          dueDate: dueDate === "" ? null : dueDate,
          note: note.trim(),
        });
      }
      setCounterparty("");
      setAmountRaw("");
      setDueDate("");
      setNote("");
      setEditing(null);
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  const startEditLoan = (l: LoanListItem) => {
    setEditing(l);
    setCounterparty(l.counterparty);
    setDirection(l.direction);
    setAmountRaw(fromCents(l.amount_cents).toFixed(2));
    setDueDate(l.due_date ?? "");
    setNote(l.note);
    setRepayFor(null);
    setError(null);
  };

  const cancelEditLoan = () => {
    setEditing(null);
    setCounterparty("");
    setAmountRaw("");
    setDueDate("");
    setNote("");
  };

  const repay = async (id: number) => {
    if (payingId === id) return;
    const cents = parseMMK(repayAmount);
    if (cents === null || cents <= 0) return;
    setPayingId(id);
    try {
      await loansRepo.recordRepayment(id, cents);
      setRepayFor(null);
      setRepayAmount("");
      await reload();
    } catch (e) {
      setError(errText(e));
    } finally {
      setPayingId(null);
    }
  };

  const remove = async (id: number) => {
    try {
      await loansRepo.deleteLoan(id);
      if (repayFor === id) setRepayFor(null);
      if (editing?.id === id) cancelEditLoan();
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const lentRemaining = loans
    .filter((l) => l.direction === "lent" && l.state !== "closed")
    .reduce((sum, l) => sum + l.remaining_cents, 0);
  const borrowedRemaining = loans
    .filter((l) => l.direction === "borrowed" && l.state !== "closed")
    .reduce((sum, l) => sum + l.remaining_cents, 0);
  const activeCount = loans.filter((l) => l.state !== "closed").length;

  return (
    <div className="budget-page">
      <header className="page-header">
        <div className="page-header-main">
          <div className="page-title-row">
            <span className="page-icon-badge">
              <IconLoans className="icon" />
            </span>
            <div>
              <h2 className="editor-title">{t("loans.title")}</h2>
              <p className="page-subtitle">{t("loans.subtitle")}</p>
            </div>
          </div>
        </div>
      </header>

      <div className="summary-figures">
        <div>
          <span className="muted">{t("loans.lentTotal")}</span>
          <span className="figure amount-income">
            {formatMMK(lentRemaining)}
          </span>
        </div>
        <div>
          <span className="muted">{t("loans.borrowedTotal")}</span>
          <span className="figure amount-expense">
            {formatMMK(borrowedRemaining)}
          </span>
        </div>
        <div>
          <span className="muted">{t("loans.activeCount")}</span>
          <span className="figure">{activeCount}</span>
        </div>
      </div>

      <section className="budget-manage" aria-label={t("loans.aria")}>
        {loading ? <Skeleton count={3} /> : null}
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="dash-card-head">
          <h3 className="side-heading">{t("loans.heading")}</h3>
          <span className="badge">{loans.length}</span>
        </div>

        {loans.length === 0 ? (
          <EmptyState>{t("loans.empty")}</EmptyState>
        ) : (
          <ul className="budget-list">
            {loans.map((l) => (
              <li
                key={l.id}
                id={focusId === l.id ? `search-target-loan-${l.id}` : undefined}
                className={
                  focusId === l.id ? "limit-row is-search-target" : "limit-row"
                }
              >
                <div className="row-main">
                  <span className="row-title">
                    <b>{l.counterparty}</b>
                    <span
                      className={
                        l.direction === "lent"
                          ? "badge badge-success"
                          : "badge badge-warn"
                      }
                    >
                      {t(DIRECTION_LABEL_KEY[l.direction])}
                    </span>
                    <span className={STATE_BADGE[l.state]} role="status">
                      {t(STATE_LABEL_KEY[l.state])}
                    </span>
                  </span>
                  <span className="row-sub figure">
                    {t("loans.repaid", {
                      repaid: formatMMK(l.repaid_cents),
                      total: formatMMK(l.amount_cents),
                    })}
                    {l.state !== "closed"
                      ? ` · ${t("loans.left", {
                          amount: formatMMK(l.remaining_cents),
                        })}`
                      : ""}
                    {l.due_date
                      ? ` · ${t("loans.due", { date: l.due_date })}`
                      : ""}
                    {l.note ? ` — ${l.note}` : ""}
                  </span>
                </div>
                <span className="row-actions">
                  {l.state !== "closed" ? (
                    repayFor === l.id ? (
                      <>
                        <input
                          className="input"
                          aria-label={t("loans.repayAmountAria", {
                            name: l.counterparty,
                          })}
                          inputMode="decimal"
                          placeholder="0.00"
                          value={repayAmount}
                          onChange={(e) => setRepayAmount(e.target.value)}
                          aria-invalid={
                            repayAmount.trim() !== "" &&
                            !isPartialAmount(repayAmount)
                              ? "true"
                              : undefined
                          }
                        />
                        <button
                          type="button"
                          className="btn btn-primary"
                          disabled={
                            payingId === l.id ||
                            parseMMK(repayAmount) === null ||
                            (parseMMK(repayAmount) ?? 0) <= 0
                          }
                          onClick={() => void repay(l.id)}
                        >
                          {payingId === l.id
                            ? t("loans.saving")
                            : t("loans.save")}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setRepayFor(null)}
                        >
                          {t("common.cancel")}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() => {
                          setRepayFor(l.id);
                          setRepayAmount(
                            fromCents(l.remaining_cents).toFixed(2),
                          );
                        }}
                      >
                        {t("loans.recordRepayment")}
                      </button>
                    )
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => startEditLoan(l)}
                  >
                    {t("common.edit")}
                  </button>
                  <ConfirmButton
                    className="btn btn-ghost"
                    what={t(
                      l.repaid_cents > 0
                        ? "loans.deleteRepaidWhat"
                        : "loans.deleteWhat",
                      { name: l.counterparty },
                    )}
                    onConfirm={() => remove(l.id)}
                  >
                    {t("common.delete")}
                  </ConfirmButton>
                </span>
              </li>
            ))}
          </ul>
        )}

        <form
          className="entry-form"
          onSubmit={(e) => {
            e.preventDefault();
            void addLoan();
          }}
        >
          <div className="dash-card-head">
            <h2 className="side-heading">
              {editing === null
                ? t("loans.new")
                : t("loans.edit", { name: editing.counterparty })}
            </h2>
            <fieldset className="kind-toggle">
              <legend className="visually-hidden">
                {t("loans.directionLegend")}
              </legend>
              <button
                type="button"
                className={direction === "lent" ? "btn is-on" : "btn"}
                aria-pressed={direction === "lent"}
                onClick={() => setDirection("lent")}
              >
                {t("loans.direction.lent")}
              </button>
              <button
                type="button"
                className={direction === "borrowed" ? "btn is-on" : "btn"}
                aria-pressed={direction === "borrowed"}
                onClick={() => setDirection("borrowed")}
              >
                {t("loans.direction.borrowed")}
              </button>
            </fieldset>
          </div>
          <div className="form-grid">
            <label>
              {t("loans.counterpartyField")}
              <input
                value={counterparty}
                placeholder={t("loans.counterpartyPlaceholder")}
                onChange={(e) => setCounterparty(e.target.value)}
              />
            </label>
            <label>
              {t("loans.amountField")}
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
              {t("loans.dueField")}
              <span className="input-icon-wrap">
                <input
                  type="date"
                  aria-label={t("loans.dueAria")}
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
                <IconCalendar className="icon input-icon is-end" />
              </span>
            </label>
            <label>
              {t("loans.noteField")}
              <input
                value={note}
                placeholder={t("loans.notePlaceholder")}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </div>
          <div className="row-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={
                saving || !nameOk || amountCents === null || amountCents <= 0
              }
            >
              {saving
                ? t("loans.saving")
                : editing === null
                  ? t("loans.add")
                  : t("loans.saveChanges")}
            </button>
            {editing !== null ? (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={cancelEditLoan}
              >
                {t("loans.cancelEdit")}
              </button>
            ) : null}
          </div>
        </form>
      </section>
    </div>
  );
}
