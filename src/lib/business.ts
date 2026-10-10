// Business Tracker repository (§2.2). Jobs, shops, receivables, payables,
// history. Cash basis (§2.1): a job paid in full creates the Business-category
// income entry in the wallet the money arrived in; partial payments keep the
// job in Receivable with the remaining balance (never negative, §4).

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
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

export function createBusinessRepo(driver: DataDriver) {
	/**
	 * Serializes read-modify-write sequences per job/payable (§4). Two rapid
	 * "record payment" clicks (or a click racing a retry) interleave at IPC
	 * awaits; without the lock the second read sees stale balances and the
	 * writes clobber each other (duplicate income / lost update).
	 */
	const mutex = createKeyedMutex();

	/** Look up the seeded Business income category (§2.2). */
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

		// -- Shops (§2.2) ----------------------------------------------------------
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
			await driver.execute("DELETE FROM shops WHERE id = ?", [id]);
		},

		// -- Jobs (§2.2) -------------------------------------------------------------
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

		/** Open jobs with remaining balance — the Receivable view (§2.2). */
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

		/** Paid/closed jobs — the read-only History view (§2.2). */
		async listHistory(): Promise<JobRow[]> {
			return driver.query<JobRow>(
				"SELECT * FROM jobs WHERE status = 'paid' ORDER BY job_date DESC, id DESC",
			);
		},

		/** Per-customer receivable totals (§2.2). */
		async shopReceivableTotals(): Promise<
			{ shop_id: number; remaining_cents: number }[]
		> {
			return driver.query(
				`SELECT shop_id, SUM(total_cents - paid_cents) AS remaining_cents
         FROM jobs WHERE status = 'open' GROUP BY shop_id`,
			);
		},

		/**
		 * Record a payment against a job (§2.2). Never overpays (§4). Paid in
		 * full -> status 'paid' (moves to History) + a Business-category income
		 * entry in the wallet the money arrived in. Partial -> stays in
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
				if (fullyPaid) {
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
				}
				await driver.batch(statements);
				return { fullyPaid, appliedCents };
			});
		},

		// -- Payables (§2.2) -----------------------------------------------------------
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
		 * Mark a payable paid -> creates the expense entry (§2.2). Idempotent:
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

		// -- Text voucher for receivables (§2.2) ----------------------------------------
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

export type BusinessRepo = ReturnType<typeof createBusinessRepo>;
