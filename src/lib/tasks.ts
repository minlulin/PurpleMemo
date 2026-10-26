// Tasks & reminders repository. Tasks carry due dates and repeats;
// reminders fire local notifications (the notification wiring itself is a P3d
// UI concern — this layer stores and queries them).

import type { DataDriver } from "../data/driver.ts";
import {
  addDays,
  addDaysToDateTime,
  addMonths,
  addMonthsToDateTime,
  isValidISODate,
  todayLocal,
} from "./dates.ts";
import { createTrashRepo } from "./trash.ts";
import type { ReminderRow, TaskRow } from "./types.ts";

/**
 * Hard cap on catch-up steps in {@link nextReminderAt}'s walk (an unparseable
 * stamp would otherwise never advance far enough to end it).
 */
export const REPEAT_ROLL_MAX_STEPS = 1000;

/**
 * Next due date after marking a repeating task done.
 *
 * `none` repeats never roll (the task simply stays done). Every other repeat
 * advances ONE period from whichever is later: the stored due date when it is
 * still in the future, or today.
 *
 * One step is all this needs, because that starting point is never behind
 * `today` — so the result is always strictly in the future, which is the whole
 * contract: completing an overdue task re-arms it instead of leaving it
 * immediately overdue again. An earlier version walked period-by-period from
 * the stored date with a cap and a progress guard, but `next` could never be
 * older than `today`, so the first step always returned and the loop was dead
 * code describing a walk that never happened (B14).
 *
 * The consequence to know: an OVERDUE task re-anchors to the completion day
 * rather than to its old schedule. A daily task three days late lands on
 * tomorrow — where a walk would land too — but a monthly task due on the 1st
 * and completed on the 19th is next due on the 19th of the following month,
 * not the 1st. Shifted anchors are the trade for "one step, always future";
 * `nextReminderAt` below is the counterpart that *does* walk, because a
 * reminder that lands one period short of now fires again on the next poll.
 */
export function nextDueDate(
  dueDate: string | null,
  repeat: TaskRow["repeat"],
  today: string,
): string | null {
  if (repeat === "none") return null;
  const step = (d: string): string => {
    if (repeat === "daily") return addDays(d, 1);
    if (repeat === "weekly") return addDays(d, 7);
    return addMonths(d, 1);
  };
  // Roll from whichever is later: the due date or today (a task with no
  // due date, an unreadable one, or one far in the past starts from today).
  const from =
    dueDate !== null && isValidISODate(dueDate) && dueDate > today
      ? dueDate
      : today;
  // Both branches advance a VALID date (an unreadable due date never reaches
  // here — `isValidISODate` rejected it), so this is strictly after `today`.
  return step(from);
}

/**
 * One period of a repeating reminder, through the datetime helpers in
 * `lib/dates.ts` (single source of truth for the month-end clamp).
 */
function stepReminderTime(
  remindAt: string,
  repeat: Exclude<ReminderRow["repeat"], "none">,
): string {
  if (repeat === "daily") return addDaysToDateTime(remindAt, 1);
  if (repeat === "weekly") return addDaysToDateTime(remindAt, 7);
  return addMonthsToDateTime(remindAt, 1);
}

/**
 * Next fire time for a repeating reminder — the datetime sibling of
 * [`nextDueDate`], and the reason the notification loop lives in the app shell
 * rather than in TasksPage. A reminder left overdue for many periods must
 * re-arm to its next *future* occurrence, not one period at a time: rolling a
 * single step would leave it still overdue, and it would fire again on every
 * poll until it had caught up.
 *
 * The walk is hard-capped by `REPEAT_ROLL_MAX_STEPS`, and a step that does
 * not advance the time ends it instead of looping forever (an unparseable
 * value comes back unchanged from the date helpers, so that guard is what
 * terminates it) — unlike `nextDueDate`, which needs only its single step.
 */
export function nextReminderAt(
  remindAt: string,
  repeat: Exclude<ReminderRow["repeat"], "none">,
  now: string,
): string {
  let next = stepReminderTime(remindAt, repeat);
  for (let i = 0; i < REPEAT_ROLL_MAX_STEPS && next <= now; i++) {
    const advanced = stepReminderTime(next, repeat);
    if (advanced <= next) break; // no progress — never loop forever
    next = advanced;
  }
  return next;
}

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

export function createTasksRepo(
  driver: DataDriver,
  trash = createTrashRepo(driver),
) {
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

    /**
     * Complete a task with  repeat semantics: a repeating task is re-armed
     * to its next future due date and stays open; a one-off is marked done.
     *
     * This used to be inline in the TasksPage click handler, which made "Today
     * completes tasks the same way" a convention rather than a fact. Today
     * completes tasks too, so the rule lives here and both
     * surfaces call the same function — proven identical by construction, not
     * by two copies staying in step.
     *
     * A row that vanished under the click is a no-op: the list the user was
     * looking at was already stale, and failing loudly would only surface that
     * as a scary error on an action that changed nothing.
     */
    async completeTask(id: number, today = todayLocal()): Promise<void> {
      const task = await this.getTask(id);
      if (task === undefined) return;
      const rolled = nextDueDate(task.due_date, task.repeat, today);
      if (rolled !== null) await this.updateTask(id, { dueDate: rolled });
      else await this.toggleTask(id, true);
    },

    /** Move the task and its relationships into Trash. */
    async deleteTask(id: number): Promise<void> {
      await trash.trashEntity("task", id);
    },

    /** Open tasks due on/before today — the dashboard's due list. */
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

    /** Re-arm a repeating reminder without a delete/insert gap. */
    async rescheduleReminder(id: number, remindAt: string): Promise<void> {
      await driver.execute(
        "UPDATE reminders SET remind_at = ?, fired = 0 WHERE id = ?",
        [remindAt, id],
      );
    },

    async deleteReminder(id: number): Promise<void> {
      await driver.execute("DELETE FROM reminders WHERE id = ?", [id]);
    },

    /** Reminders due now — the notification poll. */
    async dueReminders(now: string): Promise<ReminderRow[]> {
      return driver.query<ReminderRow>(
        "SELECT * FROM reminders WHERE fired = 0 AND remind_at <= ? ORDER BY remind_at",
        [now],
      );
    },

    /**
     * Fired one-shot reminders nobody has resolved yet.
     *
     * `fired` means "handed to the OS", not "seen". A repeating reminder never
     * lands here — the poll re-arms it instead — so every row is a one-shot
     * whose notification may have gone unnoticed. Today and the reminders list
     * keep showing these until the user acknowledges (deletes) or snoozes
     * them, rather than the poll silently dropping them from every list.
     */
    async firedReminders(): Promise<ReminderRow[]> {
      return driver.query<ReminderRow>(
        "SELECT * FROM reminders WHERE fired = 1 ORDER BY remind_at",
      );
    },
  };
}
