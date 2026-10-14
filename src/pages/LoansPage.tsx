// P3c Loans page (§2.3): money lent and borrowed. State is derived
// (open | partial | overdue | closed), never stored — the list recomputes
// it against today's local date. Repayments never overpay (§4).

import { useCallback, useEffect, useState } from "react";
import { EmptyState } from "../components/EmptyState.tsx";
import { IconCalendar, IconLoans } from "../components/icons.tsx";
import { Skeleton } from "../components/Skeleton.tsx";
import { loansRepo } from "../data/app.ts";
import { todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import {
  formatMMK,
  fromCents,
  isPartialAmount,
  parseMMK,
} from "../lib/money.ts";
import type { LoanDirection, LoanRow, LoanState } from "../lib/types.ts";

type LoanListItem = LoanRow & { state: LoanState; remaining_cents: number };

const STATE_LABEL: Record<LoanState, string> = {
  open: "Open",
  partial: "Partial",
  overdue: "Overdue",
  closed: "Closed",
};

const STATE_BADGE: Record<LoanState, string> = {
  open: "badge badge-accent",
  partial: "badge badge-warn",
  overdue: "badge badge-danger",
  closed: "badge",
};

export default function LoansPage() {
  const today = todayLocal();
  const [loans, setLoans] = useState<LoanListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [repayFor, setRepayFor] = useState<number | null>(null);
  const [repayAmount, setRepayAmount] = useState("");

  const [counterparty, setCounterparty] = useState("");
  const [direction, setDirection] = useState<LoanDirection>("lent");
  const [amountRaw, setAmountRaw] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [note, setNote] = useState("");

  const reload = useCallback(async () => {
    try {
      setLoans(await loansRepo.listLoansWithState(today));
      setError(null);
    } catch (e) {
      setError(errText(e));
    } finally {
      setLoading(false);
    }
  }, [today]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const amountCents = parseMMK(amountRaw);
  const nameOk = counterparty.trim().length > 0;

  const addLoan = async () => {
    if (amountCents === null || amountCents <= 0 || !nameOk) return;
    try {
      await loansRepo.createLoan({
        counterparty: counterparty.trim(),
        direction,
        amountCents,
        dueDate: dueDate === "" ? null : dueDate,
        note: note.trim(),
      });
      setCounterparty("");
      setAmountRaw("");
      setDueDate("");
      setNote("");
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const repay = async (id: number) => {
    const cents = parseMMK(repayAmount);
    if (cents === null || cents <= 0) return;
    try {
      await loansRepo.recordRepayment(id, cents);
      setRepayFor(null);
      setRepayAmount("");
      await reload();
    } catch (e) {
      setError(errText(e));
    }
  };

  const remove = async (id: number) => {
    try {
      await loansRepo.deleteLoan(id);
      if (repayFor === id) setRepayFor(null);
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
              <h2 className="editor-title">Loans &amp; Debts</h2>
              <p className="page-subtitle">
                Money lent and borrowed with automatic repayment &amp; due-state
                tracking
              </p>
            </div>
          </div>
        </div>
      </header>

      <div className="summary-figures">
        <div>
          <span className="muted">Lent (Owed to you)</span>
          <span className="figure amount-income">
            {formatMMK(lentRemaining)}
          </span>
        </div>
        <div>
          <span className="muted">Borrowed (You owe)</span>
          <span className="figure amount-expense">
            {formatMMK(borrowedRemaining)}
          </span>
        </div>
        <div>
          <span className="muted">Active Loans</span>
          <span className="figure">{activeCount}</span>
        </div>
      </div>

      <section className="budget-manage" aria-label="Loans">
        {loading ? <Skeleton count={3} /> : null}
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}

        <div className="dash-card-head">
          <h3 className="side-heading">Loan Ledger</h3>
          <span className="badge">{loans.length}</span>
        </div>

        {loans.length === 0 ? (
          <EmptyState>No loans yet — add one below.</EmptyState>
        ) : (
          <ul className="budget-list">
            {loans.map((l) => (
              <li key={l.id} className="limit-row">
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
                      {l.direction}
                    </span>
                    <span className={STATE_BADGE[l.state]} role="status">
                      {STATE_LABEL[l.state]}
                    </span>
                  </span>
                  <span className="row-sub figure">
                    Repaid {formatMMK(l.repaid_cents)} /{" "}
                    {formatMMK(l.amount_cents)}
                    {l.state !== "closed"
                      ? ` · ${formatMMK(l.remaining_cents)} left`
                      : ""}
                    {l.due_date ? ` · due ${l.due_date}` : ""}
                    {l.note ? ` — ${l.note}` : ""}
                  </span>
                </div>
                <span className="row-actions">
                  {l.state !== "closed" ? (
                    repayFor === l.id ? (
                      <>
                        <input
                          className="input"
                          aria-label={`Repayment amount for ${l.counterparty}`}
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
                            parseMMK(repayAmount) === null ||
                            (parseMMK(repayAmount) ?? 0) <= 0
                          }
                          onClick={() => void repay(l.id)}
                        >
                          Save
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setRepayFor(null)}
                        >
                          Cancel
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
                        Record repayment
                      </button>
                    )
                  ) : null}
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => void remove(l.id)}
                  >
                    Delete
                  </button>
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
            <h2 className="side-heading">New loan</h2>
            <fieldset className="kind-toggle">
              <legend className="visually-hidden">Loan direction</legend>
              <button
                type="button"
                className={direction === "lent" ? "btn is-on" : "btn"}
                aria-pressed={direction === "lent"}
                onClick={() => setDirection("lent")}
              >
                Lent
              </button>
              <button
                type="button"
                className={direction === "borrowed" ? "btn is-on" : "btn"}
                aria-pressed={direction === "borrowed"}
                onClick={() => setDirection("borrowed")}
              >
                Borrowed
              </button>
            </fieldset>
          </div>
          <div className="form-grid">
            <label>
              Counterparty
              <input
                value={counterparty}
                placeholder="e.g. U Kyaw"
                onChange={(e) => setCounterparty(e.target.value)}
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
              Due date (optional)
              <span className="input-icon-wrap">
                <input
                  type="date"
                  aria-label="Due date"
                  value={dueDate}
                  onChange={(e) => setDueDate(e.target.value)}
                />
                <IconCalendar className="icon input-icon is-end" />
              </span>
            </label>
            <label>
              Note (optional)
              <input
                value={note}
                placeholder="Optional note"
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </div>
          <div className="row-actions">
            <button
              type="submit"
              className="btn btn-primary"
              disabled={!nameOk || amountCents === null || amountCents <= 0}
            >
              Add loan
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
