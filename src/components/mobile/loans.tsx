// The phone's Loans screen and its create form: no repayment field.

import { useCallback, useState } from "react";
import { loansRepo } from "../../data/app.ts";
import { todayLocal } from "../../lib/dates.ts";
import { loanFormReady, loanStateKey } from "../../lib/mobileCreate.ts";
import { formatMMK, parseMMK } from "../../lib/money.ts";
import type { LoanDirection } from "../../lib/types.ts";
import { EmptyState } from "../EmptyState.tsx";
import { useLocale, useT } from "../useTranslation.ts";
import { LoadMessage, useLoad } from "./common.tsx";

/**
 * The Loans screen: lent and borrowed loans with counterparty, amount and
 * direction.
 *
 * Create-only (decision 4): no repayment control exists here. Repayments are
 * recorded on the desktop; this screen never offers to move money.
 */
export function LoansScreen({ onCompose }: { onCompose: () => void }) {
  const t = useT();
  const locale = useLocale();
  const load = useCallback(
    () => loansRepo.listLoansWithState(todayLocal()),
    [],
  );
  const { data, failed, reload } = useLoad(load);
  const loans = data ?? [];

  return (
    <section className="mobile-page">
      <p className="mobile-section-kicker">{t("nav.loans")}</p>
      <div className="mobile-actions">
        <button type="button" className="btn btn-primary" onClick={onCompose}>
          {t("mobile.loan.new")}
        </button>
      </div>
      <p className="muted">{t("mobile.loan.noRepayment")}</p>
      <LoadMessage failed={failed} />
      {data !== null && loans.length === 0 ? (
        <EmptyState>{t("mobile.loan.empty")}</EmptyState>
      ) : null}
      <ul className="mobile-list" aria-label={t("mobile.loan.listAria")}>
        {loans.map((loan) => (
          <li key={loan.id} className="mobile-card">
            <span className="mobile-wallet-line">
              <span className="mobile-card-title">{loan.counterparty}</span>
              <span className="mobile-card-title">
                {formatMMK(loan.amount_cents, locale)}
              </span>
            </span>
            <span className="mobile-card-meta">
              {loan.direction === "lent"
                ? t("mobile.loan.lent")
                : t("mobile.loan.borrowed")}
              {" · "}
              {t(loanStateKey(loan.state))}
              {loan.due_date !== null
                ? ` · ${t("mobile.loan.due", { date: loan.due_date })}`
                : ""}
            </span>
            {loan.state !== "closed" ? (
              <span className="mobile-card-meta">
                {t("mobile.loan.remaining", {
                  amount: formatMMK(loan.remaining_cents, locale),
                })}
              </span>
            ) : null}
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

/** The loan create form. No repayment field: a saved loan starts unpaid. */
export function LoanCompose({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [direction, setDirection] = useState<LoanDirection>("lent");
  const [counterparty, setCounterparty] = useState("");
  const [amount, setAmount] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const amountCents = parseMMK(amount);
  const ready = loanFormReady({ counterparty, amountCents });
  const amountProblem =
    amount.trim() !== "" && (amountCents === null || amountCents <= 0);

  const save = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setSaveFailed(false);
    try {
      await loansRepo.createLoan({
        counterparty: counterparty.trim(),
        direction,
        amountCents: amountCents ?? 0,
        dueDate: dueDate === "" ? null : dueDate,
      });
      onDone();
    } catch {
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mobile-page">
      <p className="muted">{t("mobile.loan.noRepayment")}</p>
      <form
        className="mobile-form"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <label className="mobile-field">
          <span>{t("mobile.loan.directionLabel")}</span>
          <select
            className="input"
            value={direction}
            onChange={(event) => {
              setDirection(
                event.currentTarget.value === "borrowed" ? "borrowed" : "lent",
              );
            }}
          >
            <option value="lent">{t("mobile.loan.lent")}</option>
            <option value="borrowed">{t("mobile.loan.borrowed")}</option>
          </select>
        </label>
        <label className="mobile-field">
          <span>{t("mobile.loan.counterpartyLabel")}</span>
          <input
            className="input"
            type="text"
            value={counterparty}
            placeholder={t("mobile.loan.counterpartyPlaceholder")}
            onChange={(event) => setCounterparty(event.currentTarget.value)}
          />
        </label>
        <label className="mobile-field">
          <span>{t("mobile.loan.amountLabel")}</span>
          <input
            className="input"
            type="text"
            inputMode="decimal"
            value={amount}
            placeholder={t("mobile.loan.amountPlaceholder")}
            aria-invalid={amountProblem}
            onChange={(event) => setAmount(event.currentTarget.value)}
          />
        </label>
        {amountProblem ? (
          <p className="mobile-error" role="alert">
            {t("mobile.entry.invalidAmount")}
          </p>
        ) : null}
        <label className="mobile-field">
          <span>{t("mobile.loan.dueLabel")}</span>
          <input
            className="input"
            type="date"
            value={dueDate}
            onChange={(event) => setDueDate(event.currentTarget.value)}
          />
        </label>
        <LoadMessage failed={saveFailed} />
        <div className="mobile-actions">
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || !ready}
          >
            {busy ? t("notes.saving") : t("mobile.loan.save")}
          </button>
        </div>
      </form>
    </section>
  );
}
