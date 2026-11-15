// Loans repository: money lent and borrowed. State is derived, never
// stored — `closed` when repaid >= amount, `overdue` when the due date passed
// (and not closed), `partial` when partly repaid, else `open`.

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import { applyPayment, formatMMK } from "./money.ts";
import { createKeyedMutex } from "./mutex.ts";
import {
  deleteStatements,
  outboxStatements,
  readRowId,
  readRowUid,
} from "./sync/store.ts";
import type { LoanDirection, LoanRow, LoanState } from "./types.ts";
import { newUid } from "./uid.ts";

export interface LoanInput {
  counterparty: string;
  direction: LoanDirection;
  amountCents: number;
  dueDate?: string | null;
  note?: string;
}

/** Derive a loan's state from its row + today's local date. */
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
  /**
   * Serializes repayments per loan — same read-modify-write race as
   * job payments: two rapid repayments must not clobber each other's
   * `repaid_cents`.
   */
  const mutex = createKeyedMutex();
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
      // Cross-device UID at creation (docs/ANDROID_DESIGN.md, Phase A
      // contract) — a loan created offline on the phone carries its identity
      // before it ever pairs.
      const created = todayLocal();
      const uid = newUid();
      const fields = {
        counterparty: input.counterparty,
        direction: input.direction,
        amount_cents: input.amountCents,
        repaid_cents: 0,
        due_date: input.dueDate ?? null,
        note: input.note ?? "",
        created_at: created,
      };
      await driver.batch([
        {
          sql: `INSERT INTO loans (uid, counterparty, direction, amount_cents, repaid_cents, due_date, note, created_at)
                VALUES (?, ?, ?, ?, 0, ?, ?, ?)`,
          params: [
            uid,
            fields.counterparty,
            fields.direction,
            fields.amount_cents,
            fields.due_date,
            fields.note,
            fields.created_at,
          ],
        },
        ...outboxStatements([{ table: "loans", uid, kind: "create", fields }]),
      ]);
      return readRowId(driver, "loans", uid);
    },

    /**
     * Partial update. `undefined` leaves a column alone; an explicit `null`
     * clears a nullable one.
     *
     * **The amount may not drop below what has already been repaid** — the same
     * rule `updateJob` carries, and for the same reason. The schema only checks
     * `amount_cents > 0` and `repaid_cents >= 0` independently, so lowering the
     * amount under the repayments leaves `remaining_cents` — on the Lent /
     * Borrowed figures and in `deriveLoanState` — negative. Refused rather than
     * clamped: a clamp would make the books agree with themselves and lie about
     * the loan.
     */
    async updateLoan(id: number, fields: Partial<LoanInput>): Promise<void> {
      // Serialized under the same per-loan key as `recordRepayment` (review
      // P2-2): the guard (amount >= repaid) must read the balance under the
      // lock repayment writes under, or an interleaved repayment can land
      // between this read and this UPDATE.
      return mutex.withLock(`loan:${id}`, async () => {
        const sets: string[] = [];
        const params: unknown[] = [];
        const changed: Record<string, unknown> = {};
        if (fields.counterparty !== undefined) {
          sets.push("counterparty = ?");
          params.push(fields.counterparty);
          changed.counterparty = fields.counterparty;
        }
        if (fields.direction !== undefined) {
          sets.push("direction = ?");
          params.push(fields.direction);
          changed.direction = fields.direction;
        }
        if (fields.amountCents !== undefined) {
          if (fields.amountCents <= 0) {
            throw new Error("A loan amount must be greater than zero.");
          }
          const loan = await this.getLoan(id);
          if (!loan) throw new Error(`loan ${id} not found`);
          if (fields.amountCents < loan.repaid_cents) {
            throw new Error(
              `This loan has already been repaid ${formatMMK(loan.repaid_cents)}, so its amount cannot be lowered below that.`,
            );
          }
          sets.push("amount_cents = ?");
          params.push(fields.amountCents);
          changed.amount_cents = fields.amountCents;
        }
        if (fields.dueDate !== undefined) {
          sets.push("due_date = ?");
          params.push(fields.dueDate);
          changed.due_date = fields.dueDate;
        }
        if (fields.note !== undefined) {
          sets.push("note = ?");
          params.push(fields.note);
          changed.note = fields.note;
        }
        if (sets.length === 0) return;
        params.push(id);
        const uid = await readRowUid(driver, "loans", id);
        await driver.batch([
          { sql: `UPDATE loans SET ${sets.join(", ")} WHERE id = ?`, params },
          ...outboxStatements(
            uid
              ? [
                  {
                    table: "loans" as const,
                    uid,
                    kind: "update",
                    fields: changed,
                  },
                ]
              : [],
          ),
        ]);
      });
    },

    /**
     * Record a repayment — never overpays. Returns applied cents.
     * Serialized per loan so concurrent repayments can't overwrite each other.
     */
    async recordRepayment(id: number, amountCents: number): Promise<number> {
      return mutex.withLock(`loan:${id}`, async () => {
        const loan = await this.getLoan(id);
        if (!loan) throw new Error(`loan ${id} not found`);
        const { newPaidCents, appliedCents } = applyPayment(
          loan.amount_cents,
          loan.repaid_cents,
          amountCents,
        );
        if (appliedCents === 0) return 0;
        const uid = await readRowUid(driver, "loans", id);
        await driver.batch([
          {
            sql: "UPDATE loans SET repaid_cents = ? WHERE id = ?",
            params: [newPaidCents, id],
          },
          // §6.1: a repayment is an update of exactly the counter it wrote.
          ...outboxStatements(
            uid
              ? [
                  {
                    table: "loans" as const,
                    uid,
                    kind: "update" as const,
                    fields: { repaid_cents: newPaidCents },
                  },
                ]
              : [],
          ),
        ]);
        return appliedCents;
      });
    },

    async deleteLoan(id: number): Promise<void> {
      const uid = await readRowUid(driver, "loans", id);
      await driver.batch([
        { sql: "DELETE FROM loans WHERE id = ?", params: [id] },
        ...deleteStatements(uid ? [{ table: "loans", uid }] : []),
      ]);
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
