// Business Tracker repository. Jobs, shops, receivables, payables,
// history. Cash basis: a job paid in full creates the Business-category
// income entry in the wallet the money arrived in; partial payments keep the
// job in Receivable with the remaining balance (never negative).

import type { DataDriver } from "../data/driver.ts";
import { addDays, todayLocal } from "./dates.ts";
import { deleteLinkedEntity } from "./gallery.ts";
import { applyPayment, formatMMK, outstandingCents } from "./money.ts";
import { createKeyedMutex } from "./mutex.ts";
import type { JobRow, JobStatus, PayableRow, ShopRow } from "./types.ts";

export interface ShopInput {
  name: string;
  phone?: string;
  address?: string;
  notes?: string;
}

export interface JobInput {
  title: string;
  shopId?: number | null;
  totalCents: number;
  jobDate: string;
  warrantyDays?: number | null;
  note?: string;
}

export interface JobPayment {
  jobId: number;
  amountCents: number;
  walletId: number;
  date: string;
}

export interface PayableInput {
  title: string;
  amountCents: number;
  shopId?: number | null;
  dueDate?: string | null;
  note?: string;
}

export interface PayablePayment {
  payableId: number;
  walletId: number;
  categoryId: number;
  date: string;
}

export interface ReceivableJob extends JobRow {
  remaining_cents: number;
}

export interface ShopReceivableRow extends ShopRow {
  remaining_cents: number;
}

/**
 * Due-date status for a payable (display chip): `overdue` when the
 * due date passed, `due` on the day itself, `upcoming` ahead, `none`
 * when no due date is set. Paid payables are filtered out before this
 * runs — the chip never marks a settled debt.
 */
export function payableDueStatus(
  dueDate: string | null,
  today: string,
): "none" | "overdue" | "due" | "upcoming" {
  if (dueDate === null) return "none";
  if (dueDate < today) return "overdue";
  if (dueDate === today) return "due";
  return "upcoming";
}

/**
 * Last day the job is covered by warranty: job date + warranty
 * days. `null` when the job carries no warranty.
 */
export function warrantyEndDate(
  job: Pick<JobRow, "job_date" | "warranty_days">,
): string | null {
  if (job.warranty_days === null || job.warranty_days <= 0) return null;
  return addDays(job.job_date, job.warranty_days);
}

/** True while `today` is on or before the warranty end day. */
export function inWarranty(
  job: Pick<JobRow, "job_date" | "warranty_days">,
  today: string,
): boolean {
  const end = warrantyEndDate(job);
  return end !== null && today <= end;
}

/**
 * Join shops with their per-customer receivable totals. A shop with
 * no open jobs shows 0; a total whose shop was deleted keeps its row under a
 * `Deleted shop #<id>` label rather than vanishing from the receivable
 * picture. Order: balances first (largest first), then no-balance shops
 * alphabetically.
 */
export function shopReceivableRows(
  shops: ShopRow[],
  totals: { shop_id: number | null; remaining_cents: number }[],
): ShopReceivableRow[] {
  const byShop = new Map(
    totals
      .filter((t) => t.shop_id !== null)
      .map((t) => [t.shop_id, t.remaining_cents]),
  );
  const rows: ShopReceivableRow[] = shops.map((s) => ({
    ...s,
    remaining_cents: Math.max(0, byShop.get(s.id) ?? 0),
  }));
  // Jobs created without a shop (the shop field is optional) group
  // under "No shop" — never an orphan label.
  const loose = totals.find((t) => t.shop_id === null);
  if (loose !== undefined && loose.remaining_cents > 0) {
    rows.push({
      id: 0,
      name: "No shop",
      phone: "",
      address: "",
      notes: "",
      created_at: "",
      remaining_cents: Math.max(0, loose.remaining_cents),
    });
  }
  for (const t of totals) {
    if (t.shop_id === null || shops.some((s) => s.id === t.shop_id)) continue;
    rows.push({
      id: t.shop_id,
      name: `Deleted shop #${t.shop_id}`,
      phone: "",
      address: "",
      notes: "",
      created_at: "",
      remaining_cents: Math.max(0, t.remaining_cents),
    });
  }
  return rows.sort(
    (a, b) =>
      (b.remaining_cents > 0 ? 1 : 0) - (a.remaining_cents > 0 ? 1 : 0) ||
      b.remaining_cents - a.remaining_cents ||
      a.name.localeCompare(b.name),
  );
}

export function createBusinessRepo(driver: DataDriver) {
  /**
   * Serializes read-modify-write sequences per job/payable. Two rapid
   * "record payment" clicks (or a click racing a retry) interleave at IPC
   * awaits; without the lock the second read sees stale balances and the
   * writes clobber each other (duplicate income / lost update).
   */
  const mutex = createKeyedMutex();

  /** Look up the seeded Business income category. */
  async function businessCategoryId(): Promise<number> {
    const rows = await driver.query<{ id: number }>(
      "SELECT id FROM income_categories WHERE name = 'Business'",
    );
    const id = rows[0]?.id;
    if (id === undefined)
      throw new Error("Business income category is missing");
    return id;
  }

  return {
    businessCategoryId,

    // -- Shops ----------------------------------------------------------
    async listShops(): Promise<ShopRow[]> {
      return driver.query<ShopRow>("SELECT * FROM shops ORDER BY name");
    },

    async createShop(input: ShopInput): Promise<number> {
      const r = await driver.execute(
        "INSERT INTO shops (name, phone, address, notes, created_at) VALUES (?, ?, ?, ?, ?)",
        [
          input.name,
          input.phone ?? "",
          input.address ?? "",
          input.notes ?? "",
          todayLocal(),
        ],
      );
      return r.lastInsertRowid;
    },

    /**
     * Partial update: only the provided fields are written. `undefined`
     * means "leave unchanged"; an explicit `null` clears a nullable column.
     * (Writing NULL for every unprovided field would silently wipe data.)
     */
    async updateShop(id: number, fields: Partial<ShopInput>): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (fields.name !== undefined) {
        sets.push("name = ?");
        params.push(fields.name);
      }
      if (fields.phone !== undefined) {
        sets.push("phone = ?");
        params.push(fields.phone);
      }
      if (fields.address !== undefined) {
        sets.push("address = ?");
        params.push(fields.address);
      }
      if (fields.notes !== undefined) {
        sets.push("notes = ?");
        params.push(fields.notes);
      }
      if (sets.length === 0) return;
      params.push(id);
      await driver.execute(
        `UPDATE shops SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
    },

    async deleteShop(id: number): Promise<void> {
      // The FKs have no ON DELETE action: null out references first so the
      // delete never fails, then remove the shop. Jobs/payables keep their
      // data and render as shopless. One batch write (atomic).
      await driver.batch([
        {
          sql: "UPDATE jobs SET shop_id = NULL WHERE shop_id = ?",
          params: [id],
        },
        {
          sql: "UPDATE payables SET shop_id = NULL WHERE shop_id = ?",
          params: [id],
        },
        { sql: "DELETE FROM shops WHERE id = ?", params: [id] },
      ]);
    },

    // -- Jobs -------------------------------------------------------------
    async createJob(input: JobInput): Promise<number> {
      const r = await driver.execute(
        `INSERT INTO jobs (title, shop_id, total_cents, paid_cents, job_date, warranty_days, status, note, created_at)
         VALUES (?, ?, ?, 0, ?, ?, 'open', ?, ?)`,
        [
          input.title,
          input.shopId ?? null,
          input.totalCents,
          input.jobDate,
          input.warrantyDays ?? null,
          input.note ?? "",
          todayLocal(),
        ],
      );
      return r.lastInsertRowid;
    },

    async getJob(id: number): Promise<JobRow | undefined> {
      const rows = await driver.query<JobRow>(
        "SELECT * FROM jobs WHERE id = ?",
        [id],
      );
      return rows[0];
    },

    /**
     * Partial update for a job (review P2-9). `undefined` leaves a column
     * alone; an explicit `null` clears a nullable one.
     *
     * Two things are not left to the caller, because both would silently
     * corrupt the money:
     *
     * 1. **`total_cents` may not drop below what has already been paid.** The
     *    schema only checks `total_cents > 0`, so a lower total would leave
     *    `paid_cents > total_cents` and `remaining_cents` — the number on the
     *    Dashboard and every customer voucher — would go negative. Refused with
     *    a message rather than clamped: a clamp would make the books agree with
     *    themselves and lie about the job.
     * 2. **`status` is recomputed from the new total.** It is a stored column
     *    with no trigger, so editing a total without recomputing would leave a
     *    fully-paid job sitting in the open list, or a paid one still owing.
     */
    async updateJob(id: number, fields: Partial<JobInput>): Promise<void> {
      // Serialized under the same per-job key as `recordJobPayment` (review
      // P2-2): the guard (total >= paid, status recomputed) must read the
      // balance under the lock the payment writes under, or an interleaved
      // payment can land between this read and this UPDATE.
      return mutex.withLock(`job:${id}`, async () => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (fields.title !== undefined) {
          sets.push("title = ?");
          params.push(fields.title);
        }
        if (fields.shopId !== undefined) {
          sets.push("shop_id = ?");
          params.push(fields.shopId);
        }
        if (fields.warrantyDays !== undefined) {
          sets.push("warranty_days = ?");
          params.push(fields.warrantyDays);
        }
        if (fields.jobDate !== undefined) {
          sets.push("job_date = ?");
          params.push(fields.jobDate);
        }
        if (fields.note !== undefined) {
          sets.push("note = ?");
          params.push(fields.note);
        }
        if (fields.totalCents !== undefined) {
          if (fields.totalCents <= 0) {
            throw new Error("A job total must be greater than zero.");
          }
          const job = await this.getJob(id);
          if (!job) throw new Error(`job ${id} not found`);
          if (fields.totalCents < job.paid_cents) {
            throw new Error(
              `This job has already been paid ${formatMMK(job.paid_cents)}, so its total cannot be lowered below that.`,
            );
          }
          sets.push("total_cents = ?");
          params.push(fields.totalCents);
          // Keep the stored status in step with the new total.
          sets.push("status = ?");
          params.push(job.paid_cents >= fields.totalCents ? "paid" : "open");
        }
        if (sets.length === 0) return;
        params.push(id);
        await driver.execute(
          `UPDATE jobs SET ${sets.join(", ")} WHERE id = ?`,
          params,
        );
      });
    },

    /**
     * Delete a job (review P2-9). The escape hatch a test job or a mistyped
     * entry needs — without it a job is permanent and inflates Total Receivable
     * forever.
     *
     * Its photo links go with it: `photo_refs` cascades on `photo_id` but has
     * nothing to cascade its polymorphic `(entity_type, entity_id)` pair, so
     * the same helper every note and memory delete uses applies here.
     *
     * **Income entries it produced are deliberately left alone.** Cash basis
     *: the money was received, and it is in the Budget as income. Removing
     * the job does not un-receive it. Those rows keep the job's title in their
     * note as a historical record.
     */
    async deleteJob(id: number): Promise<void> {
      await driver.batch(deleteLinkedEntity("job", id));
    },

    async listJobs(status?: JobStatus): Promise<JobRow[]> {
      return status
        ? driver.query<JobRow>(
            "SELECT * FROM jobs WHERE status = ? ORDER BY job_date DESC, id DESC",
            [status],
          )
        : driver.query<JobRow>(
            "SELECT * FROM jobs ORDER BY job_date DESC, id DESC",
          );
    },

    /** Open jobs with remaining balance — the Receivable view. */
    async listReceivable(): Promise<ReceivableJob[]> {
      const rows = await driver.query<ReceivableJob>(
        `SELECT j.*, (j.total_cents - j.paid_cents) AS remaining_cents
         FROM jobs j WHERE j.status = 'open' ORDER BY j.job_date, j.id`,
      );
      return rows.map((r) => ({
        ...r,
        remaining_cents: Math.max(0, r.remaining_cents),
      }));
    },

    /**
     * The whole open receivable figure in one aggregate (I3).
     *
     * `listReceivable` returns every open job with its remaining balance —
     * rows the Receivable view draws and the LAN share publisher then threw
     * away to publish one number, a read that grew with the job history every
     * 30 seconds. Same arithmetic here: the per-row `Math.max(0, …)` becomes
     * `CASE`, so a job paid past its total still contributes nothing.
     */
    async receivableTotal(): Promise<number> {
      const rows = await driver.query<{ total_cents: number }>(
        `SELECT COALESCE(SUM(CASE WHEN j.total_cents - j.paid_cents > 0
                                 THEN j.total_cents - j.paid_cents ELSE 0 END), 0)
                    AS total_cents
           FROM jobs j
          WHERE j.status = 'open'`,
      );
      return rows[0]?.total_cents ?? 0;
    },

    /**
     * Open jobs whose warranty ends within `days` of `today`, soonest end
     * first, capped in SQL (I3).
     *
     * The share publishes at most twenty of these, so
     * loading every open job to filter them in JavaScript was the ticker read
     * that grew with the whole job history. The predicate is
     * `warrantyEndDate` — `job_date + warranty_days`, absent when the warranty
     * is missing or non-positive — written as SQLite date arithmetic, and the
     * caller still runs `expiringWarranties` over whatever comes back: the
     * JavaScript check stays the exact one, and this query only has to be no
     * narrower than it.
     */
    async warrantiesExpiring(
      today: string,
      days: number,
      limit: number,
    ): Promise<JobRow[]> {
      const end = `date(job_date, '+' || warranty_days || ' days')`;
      return driver.query<JobRow>(
        `SELECT * FROM jobs
          WHERE status = 'open'
            AND warranty_days > 0
            AND ${end} >= ?
            AND ${end} <= ?
          ORDER BY ${end}, job_date, id
          LIMIT ?`,
        [today, addDays(today, days), limit],
      );
    },

    /** Paid/closed jobs — the read-only History view. */
    async listHistory(): Promise<JobRow[]> {
      return driver.query<JobRow>(
        "SELECT * FROM jobs WHERE status = 'paid' ORDER BY job_date DESC, id DESC",
      );
    },

    /**
     * Per-customer receivable totals. `shop_id` is null for jobs
     * created without a shop — the display layer groups those under
     * "No shop".
     */
    async shopReceivableTotals(): Promise<
      { shop_id: number | null; remaining_cents: number }[]
    > {
      return driver.query(
        `SELECT shop_id, SUM(total_cents - paid_cents) AS remaining_cents
         FROM jobs WHERE status = 'open' GROUP BY shop_id`,
      );
    },

    /**
     * Record a payment against a job. Never overpays. Cash basis
     *: every receipt creates a Business-category income entry in the
     * wallet the money arrived in, when it arrives — partial or full.
     * Fully paid -> status 'paid' (moves to History); partial -> stays in
     * Receivable. One batch write. Serialized per job: a second concurrent
     * call waits, re-reads the fresh balance, and applies only the remainder
     * (a double-submit can never duplicate the income entry).
     */
    async recordJobPayment(
      p: JobPayment,
    ): Promise<{ fullyPaid: boolean; appliedCents: number }> {
      return mutex.withLock(`job:${p.jobId}`, async () => {
        const job = await this.getJob(p.jobId);
        if (!job) throw new Error(`job ${p.jobId} not found`);
        const { newPaidCents, appliedCents } = applyPayment(
          job.total_cents,
          job.paid_cents,
          p.amountCents,
        );
        const fullyPaid = newPaidCents >= job.total_cents;
        // Nothing to apply (e.g. a duplicate submit for an already-paid
        // job): skip the write entirely — no 0-cent income entry.
        if (appliedCents === 0) return { fullyPaid, appliedCents: 0 };
        const statements = [
          {
            sql: "UPDATE jobs SET paid_cents = ?, status = ? WHERE id = ?",
            params: [newPaidCents, fullyPaid ? "paid" : "open", p.jobId],
          },
        ];
        // Cash basis: the receipt is income now, in the wallet it
        // arrived in — whether or not the job is fully paid.
        statements.push({
          sql: `INSERT INTO income_entries (amount_cents, category_id, wallet_id, entry_date, note, created_at)
                VALUES (?, ?, ?, ?, ?, ?)`,
          params: [
            appliedCents,
            await this.businessCategoryId(),
            p.walletId,
            p.date,
            `Job: ${job.title}`,
            todayLocal(),
          ],
        });
        await driver.batch(statements);
        return { fullyPaid, appliedCents };
      });
    },

    // -- Payables -----------------------------------------------------------
    async listPayables(includePaid = false): Promise<PayableRow[]> {
      return includePaid
        ? driver.query<PayableRow>(
            "SELECT * FROM payables ORDER BY due_date IS NULL, due_date, id",
          )
        : driver.query<PayableRow>(
            "SELECT * FROM payables WHERE paid = 0 ORDER BY due_date IS NULL, due_date, id",
          );
    },

    async createPayable(input: PayableInput): Promise<number> {
      const r = await driver.execute(
        `INSERT INTO payables (title, amount_cents, shop_id, due_date, paid, note, created_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
        [
          input.title,
          input.amountCents,
          input.shopId ?? null,
          input.dueDate ?? null,
          input.note ?? "",
          todayLocal(),
        ],
      );
      return r.lastInsertRowid;
    },

    /**
     * Partial update for a payable (review P2-9). `undefined` leaves a column
     * alone; an explicit `null` clears a nullable one.
     *
     * The amount may not change once the payable is paid. `markPayablePaid`
     * booked the expense entry at that moment, so a later amount edit would
     * leave the Budget and the payable disagreeing with no way to tell which is
     * right — and the Budget is where the money actually is. Everything else
     * (title, supplier, due date, note) stays editable.
     */
    async updatePayable(
      id: number,
      fields: Partial<PayableInput>,
    ): Promise<void> {
      // Serialized under the same per-payable key as `markPayablePaid`
      // (review P2-2): the paid-check guard must read under the lock that
      // books the Budget expense, or an interleaved payment can make this
      // edit disagree with the expense entry.
      return mutex.withLock(`payable:${id}`, async () => {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (fields.title !== undefined) {
          sets.push("title = ?");
          params.push(fields.title);
        }
        if (fields.shopId !== undefined) {
          sets.push("shop_id = ?");
          params.push(fields.shopId);
        }
        if (fields.dueDate !== undefined) {
          sets.push("due_date = ?");
          params.push(fields.dueDate);
        }
        if (fields.note !== undefined) {
          sets.push("note = ?");
          params.push(fields.note);
        }
        if (fields.amountCents !== undefined) {
          if (fields.amountCents <= 0) {
            throw new Error("A payable amount must be greater than zero.");
          }
          const rows = await driver.query<PayableRow>(
            "SELECT paid FROM payables WHERE id = ?",
            [id],
          );
          if (rows[0]?.paid === 1) {
            throw new Error(
              "This payable is already paid, and its amount is recorded in the Budget as an expense. Change that expense entry instead.",
            );
          }
          sets.push("amount_cents = ?");
          params.push(fields.amountCents);
        }
        if (sets.length === 0) return;
        params.push(id);
        await driver.execute(
          `UPDATE payables SET ${sets.join(", ")} WHERE id = ?`,
          params,
        );
      });
    },

    /**
     * Delete a payable (review P2-9) — the escape hatch for a typo or a
     * duplicate. No photo links to clear (`entity_type` is note/memory/job).
     *
     * A paid payable's expense entry is left in the Budget, for the same
     * cash-basis reason a job's income entries are
     */
    async deletePayable(id: number): Promise<void> {
      await driver.execute("DELETE FROM payables WHERE id = ?", [id]);
    },

    /**
     * Mark a payable paid -> creates the expense entry. Idempotent:
     * re-paying an already-paid payable is a no-op (no duplicate expense).
     * Serialized per payable so two rapid clicks can't both pass the check.
     */
    async markPayablePaid(p: PayablePayment): Promise<void> {
      return mutex.withLock(`payable:${p.payableId}`, async () => {
        const rows = await driver.query<PayableRow>(
          "SELECT * FROM payables WHERE id = ?",
          [p.payableId],
        );
        const payable = rows[0];
        if (!payable) throw new Error(`payable ${p.payableId} not found`);
        if (payable.paid === 1) return;
        await driver.batch([
          {
            sql: "UPDATE payables SET paid = 1 WHERE id = ?",
            params: [p.payableId],
          },
          {
            sql: `INSERT INTO expense_entries (amount_cents, category_id, wallet_id, entry_date, note, created_at)
                  VALUES (?, ?, ?, ?, ?, ?)`,
            params: [
              payable.amount_cents,
              p.categoryId,
              p.walletId,
              p.date,
              payable.title,
              todayLocal(),
            ],
          },
        ]);
      });
    },

    // -- Text voucher for receivables ----------------------------------------
    /**
     * Plain-text voucher: shop name, date, unpaid jobs (title + remaining
     * each), total remaining. Plain text is deliberate — the receiving phone
     * needs no PDF reader.
     */
    async voucherText(shopId: number): Promise<string> {
      const [shop, jobs] = await Promise.all([
        driver.query<ShopRow>("SELECT * FROM shops WHERE id = ?", [shopId]),
        this.listReceivable().then((all) =>
          all.filter((j) => j.shop_id === shopId),
        ),
      ]);
      const name = shop[0]?.name ?? "Unknown shop";
      const lines = jobs.map(
        (j, i) =>
          `${i + 1}. ${j.title} — ${formatMMK(outstandingCents(j.total_cents, j.paid_cents))}`,
      );
      const total = jobs.reduce(
        (sum, j) => sum + outstandingCents(j.total_cents, j.paid_cents),
        0,
      );
      return [
        "PURPLE MEMO — PAYMENT VOUCHER",
        `Shop: ${name}`,
        `Date: ${todayLocal()}`,
        "------------------------------",
        ...lines,
        "------------------------------",
        `Total due: ${formatMMK(total)}`,
      ].join("\n");
    },
  };
}
