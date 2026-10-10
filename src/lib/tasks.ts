// Tasks & reminders repository (§2.7). Tasks carry due dates and repeats;
// reminders fire local notifications (the notification wiring itself is a P3d
// UI concern — this layer stores and queries them).

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import type { ReminderRow, TaskRow } from "./types.ts";

export interface TaskInput {
	title: string;
	dueDate?: string | null;
	repeat?: TaskRow["repeat"];
	note?: string;
}

export interface ReminderInput {
	title: string;
	remindAt: string;
	repeat?: ReminderRow["repeat"];
	note?: string;
}

export function createTasksRepo(driver: DataDriver) {
	return {
		// -- Tasks -----------------------------------------------------------------
		async listTasks(includeDone = false): Promise<TaskRow[]> {
			return includeDone
				? driver.query<TaskRow>(
						"SELECT * FROM tasks ORDER BY due_date IS NULL, due_date, id",
					)
				: driver.query<TaskRow>(
						"SELECT * FROM tasks WHERE done = 0 ORDER BY due_date IS NULL, due_date, id",
					);
		},

		async getTask(id: number): Promise<TaskRow | undefined> {
			const rows = await driver.query<TaskRow>(
				"SELECT * FROM tasks WHERE id = ?",
				[id],
			);
			return rows[0];
		},

		async createTask(input: TaskInput): Promise<number> {
			const r = await driver.execute(
				`INSERT INTO tasks (title, due_date, done, repeat, note, created_at)
         VALUES (?, ?, 0, ?, ?, ?)`,
				[
					input.title,
					input.dueDate ?? null,
					input.repeat ?? "none",
					input.note ?? "",
					todayLocal(),
				],
			);
			return r.lastInsertRowid;
		},

		/**
		 * Partial update: only the provided fields are written (`undefined`
		 * leaves the column unchanged; explicit `null` clears a nullable one).
		 */
		async updateTask(id: number, fields: Partial<TaskInput>): Promise<void> {
			const sets: string[] = [];
			const params: unknown[] = [];
			if (fields.title !== undefined) {
				sets.push("title = ?");
				params.push(fields.title);
			}
			if (fields.dueDate !== undefined) {
				sets.push("due_date = ?");
				params.push(fields.dueDate);
			}
			if (fields.repeat !== undefined) {
				sets.push("repeat = ?");
				params.push(fields.repeat);
			}
			if (fields.note !== undefined) {
				sets.push("note = ?");
				params.push(fields.note);
			}
			if (sets.length === 0) return;
			params.push(id);
			await driver.execute(
				`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`,
				params,
			);
		},

		async toggleTask(id: number, done: boolean): Promise<void> {
			await driver.execute("UPDATE tasks SET done = ? WHERE id = ?", [
				done ? 1 : 0,
				id,
			]);
		},

		async deleteTask(id: number): Promise<void> {
			await driver.execute("DELETE FROM tasks WHERE id = ?", [id]);
		},

		/** Open tasks due on/before today — the dashboard's due list (§2.8). */
		async dueTasks(today = todayLocal()): Promise<TaskRow[]> {
			return driver.query<TaskRow>(
				"SELECT * FROM tasks WHERE done = 0 AND due_date IS NOT NULL AND due_date <= ? ORDER BY due_date, id",
				[today],
			);
		},

		// -- Reminders ---------------------------------------------------------------
		async listReminders(includeFired = false): Promise<ReminderRow[]> {
			return includeFired
				? driver.query<ReminderRow>(
						"SELECT * FROM reminders ORDER BY remind_at",
					)
				: driver.query<ReminderRow>(
						"SELECT * FROM reminders WHERE fired = 0 ORDER BY remind_at",
					);
		},

		async createReminder(input: ReminderInput): Promise<number> {
			const r = await driver.execute(
				`INSERT INTO reminders (title, remind_at, repeat, note, fired, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
				[
					input.title,
					input.remindAt,
					input.repeat ?? "none",
					input.note ?? "",
					todayLocal(),
				],
			);
			return r.lastInsertRowid;
		},

		async markReminderFired(id: number): Promise<void> {
			await driver.execute("UPDATE reminders SET fired = 1 WHERE id = ?", [id]);
		},

		async deleteReminder(id: number): Promise<void> {
			await driver.execute("DELETE FROM reminders WHERE id = ?", [id]);
		},

		/** Reminders due now — the notification poll (§2.7). */
		async dueReminders(now: string): Promise<ReminderRow[]> {
			return driver.query<ReminderRow>(
				"SELECT * FROM reminders WHERE fired = 0 AND remind_at <= ? ORDER BY remind_at",
				[now],
			);
		},
	};
}

export type TasksRepo = ReturnType<typeof createTasksRepo>;
