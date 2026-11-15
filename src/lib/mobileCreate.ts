// Rules for the two money modules that are create-only on the phone.
//
// Decision 4 (docs/ANDROID_DESIGN.md): Business and Loans can be created from
// the mobile surface, and nothing about their money can be changed there —
// job payments and loan repayments stay desktop-only. These helpers decide
// only when a create form may submit and how a derived loan state is labelled;
// they never describe a payment, because there is none to describe.

import type { MessageKey } from "./i18n.ts";
import type { LoanState } from "./types.ts";

export interface JobFormState {
  title: string;
  totalCents: number | null;
}

/**
 * True when a job may be saved: a title and a total greater than zero, which is
 * exactly what the schema accepts. A created job is stored open with nothing
 * paid, so its whole total is outstanding.
 */
export function jobFormReady(state: JobFormState): boolean {
  return (
    state.title.trim() !== "" &&
    state.totalCents !== null &&
    state.totalCents > 0
  );
}

export interface LoanFormState {
  counterparty: string;
  amountCents: number | null;
}

/** True when a loan may be saved: a counterparty and an amount above zero. */
export function loanFormReady(state: LoanFormState): boolean {
  return (
    state.counterparty.trim() !== "" &&
    state.amountCents !== null &&
    state.amountCents > 0
  );
}

/** The label key for a loan's derived state (`deriveLoanState`). */
export function loanStateKey(state: LoanState): MessageKey {
  switch (state) {
    case "closed":
      return "mobile.loan.stateClosed";
    case "overdue":
      return "mobile.loan.stateOverdue";
    case "partial":
      return "mobile.loan.statePartial";
    default:
      return "mobile.loan.stateOpen";
  }
}
