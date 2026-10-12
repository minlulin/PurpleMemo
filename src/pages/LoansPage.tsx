// P3c Loans page (§2.3): money lent and borrowed. State is derived
// (open | partial | overdue | closed), never stored — the list recomputes
// it against today's local date. Repayments never overpay (§4).

import { useCallback, useEffect, useState } from "react";
import { loansRepo } from "../data/app.ts";
import { todayLocal } from "../lib/dates.ts";
import { errText } from "../lib/errors.ts";
import { formatMMK, fromCents, parseMMK } from "../lib/money.ts";
import type { LoanDirection, LoanRow, LoanState } from "../lib/types.ts";

type LoanListItem = LoanRow & { state: LoanState; remaining_cents: number };

const STATE_LABEL: Record<LoanState, string> = {
  open: "Open",
  partial: "Partial",
  overdue: "Overdue",
  closed: "Closed",
};

const STATE_CHIP: Record<LoanState, string> = {
  open: "",
  partial: "limit-warn",
  overdue: "limit-exceeded",
  closed: "muted",
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

  return (
    <div className="budget-page">
      <section className="budget-manage" aria-label="Loans">
        {loading ? <p className="muted">Loading…</p> : null}
        {error ? (
          <p className="alert alert-error" role="alert">
            {error}
          </p>
        ) : null}

        {loans.length === 0 ? (
          <p className="muted">No loans yet — add one below.</p>
        ) : (
          <ul className="budget-list">
            {loans.map((l) => (
              <li key={l.id} className="budget-row">
                <span>
                  {l.counterparty}
                  <span className="muted"> · {l.direction}</span>
                  {l.state !== "open" && l.state !== "closed" ? (
                    <span className={STATE_CHIP[l.state]} role="status">
                      {" "}
                      ({STATE_LABEL[l.state].toLowerCase()})
                    </span>
                  ) : null}
                  {l.state === "closed" ? (
                    <span className="muted"> (closed)</span>
                  ) : null}
                  {l.due_date ? (
                    <span className="muted"> · due {l.due_date}</span>
                  ) : null}
                  {l.note ? <span className="muted"> — {l.note}</span> : null}
                </span>
                <span className="muted figure">
                  {formatMMK(l.repaid_cents)} / {formatMMK(l.amount_cents)}
                  {l.state !== "closed"
                    ? ` · ${formatMMK(l.remaining_cents)} left`
                    : ""}
                </span>
                <span className="row-actions">
                  {l.state !== "closed" ? (
                    repayFor === l.id ? (
                      <>
                        <input
                          aria-label={`Repayment amount for ${l.counterparty}`}
                          inputMode="decimal"
                          placeholder="0.00"
                          value={repayAmount}
                          onChange={(e) => setRepayAmount(e.target.value)}
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
          <label>
            Counterparty
            <input
              value={counterparty}
              placeholder="e.g. U Kyaw"
              onChange={(e) => setCounterparty(e.target.value)}
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
            Due date (optional)
            <input
              type="date"
              aria-label="Due date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </label>
          <label>
            Note (optional)
            <input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
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
