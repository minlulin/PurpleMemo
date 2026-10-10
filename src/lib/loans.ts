// Loans repository (§2.3): money lent and borrowed. State is derived, never
// stored — `closed` when repaid >= amount, `overdue` when the due date passed
// (and not closed), `partial` when partly repaid, else `open`.

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import { applyPayment } from "./money.ts";
import type { LoanDirection, LoanRow, LoanState } from "./types.ts";

export interface LoanInput {
  counterparty: string;
  direction: LoanDirection;
  amountCents: number;
  dueDate?: string | null;
  note?: string;
}

/** Derive a loan's state from its row + today's local date (§2.3). */
export function deriveLoanState(
  loan: Pick<LoanRow, "amount_cents" | "repaid_cents" | "due_date">,
  today: string,
): LoanState {
  if (loan.repaid_cents >= loan.amount_cents) return "closed";
  if (loan.due_date !== null && loan.due_date < today) return "overdue";
  if (loan.repaid_cents > 0) return "partial";
  return "open";
}

export function createLoansRepo(driver: DataDriver) {
  return {
    async listLoans(): Promise<LoanRow[]> {
      return driver.query<LoanRow>("SELECT * FROM loans ORDER BY id");
    },

    async getLoan(id: number): Promise<LoanRow | undefined> {
      const rows = await driver.query<LoanRow>(
        "SELECT * FROM loans WHERE id = ?",
        [id],
      );
      return rows[0];
    },

    async createLoan(input: LoanInput): Promise<number> {
      const r = await driver.execute(
        `INSERT INTO loans (counterparty, direction, amount_cents, repaid_cents, due_date, note, created_at)
         VALUES (?, ?, ?, 0, ?, ?, ?)`,
        [
          input.counterparty,
          input.direction,
          input.amountCents,
          input.dueDate ?? null,
          input.note ?? "",
          todayLocal(),
        ],
      );
      return r.lastInsertRowid;
    },

    async updateLoan(id: number, fields: Partial<LoanInput>): Promise<void> {
      await driver.execute(
        "UPDATE loans SET counterparty = ?, direction = ?, amount_cents = ?, due_date = ?, note = ? WHERE id = ?",
        [
          fields.counterparty ?? null,
          fields.direction ?? null,
          fields.amountCents ?? null,
          fields.dueDate ?? null,
          fields.note ?? null,
          id,
        ],
      );
    },

    /** Record a repayment — never overpays (§4). Returns applied cents. */
    async recordRepayment(id: number, amountCents: number): Promise<number> {
      const loan = await this.getLoan(id);
      if (!loan) throw new Error(`loan ${id} not found`);
      const { newPaidCents, appliedCents } = applyPayment(
        loan.amount_cents,
        loan.repaid_cents,
        amountCents,
      );
      await driver.execute("UPDATE loans SET repaid_cents = ? WHERE id = ?", [
        newPaidCents,
        id,
      ]);
      return appliedCents;
    },

    async deleteLoan(id: number): Promise<void> {
      await driver.execute("DELETE FROM loans WHERE id = ?", [id]);
    },

    /** Loans with their derived state + remaining balance, for list views. */
    async listLoansWithState(
      today: string,
    ): Promise<(LoanRow & { state: LoanState; remaining_cents: number })[]> {
      const loans = await this.listLoans();
      return loans.map((loan) => ({
        ...loan,
        state: deriveLoanState(loan, today),
        remaining_cents: Math.max(0, loan.amount_cents - loan.repaid_cents),
      }));
    },
  };
}

export type LoansRepo = ReturnType<typeof createLoansRepo>;
