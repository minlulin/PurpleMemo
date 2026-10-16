// Tasks repository: partial updates write only the provided fields.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMockDriver } from "../data/mock-driver.ts";
import { createTasksRepo, nextDueDate, nextReminderAt } from "./tasks.ts";

test("updateTask writes only the provided fields (no NULL wipe)", async () => {
  const driver = createMockDriver();
  const tasks = createTasksRepo(driver);
  await tasks.updateTask(3, { title: "Call shop" });
  const call = driver.lastCall();
  assert.ok(call);
  const [sql, params] = call.args as [string, unknown[]];
  assert.match(sql, /UPDATE tasks SET title = \? WHERE id = \?/);
  assert.deepEqual(params, ["Call shop", 3]);
});

test("updateTask with explicit null clears a nullable field", async () => {
  const driver = createMockDriver();
  const tasks = createTasksRepo(driver);
  await tasks.updateTask(3, { dueDate: null });
  const call = driver.lastCall();
  assert.ok(call);
  const [sql, params] = call.args as [string, unknown[]];
  assert.match(sql, /UPDATE tasks SET due_date = \? WHERE id = \?/);
  assert.deepEqual(params, [null, 3]);
});

test("nextDueDate: repeat rolls the due date to the next future occurrence (§2.7)", () => {
  // None: no roll — the task simply stays done.
  assert.equal(nextDueDate("2026-10-11", "none", "2026-10-11"), null);
  // Done on the due day -> one period forward.
  assert.equal(nextDueDate("2026-10-11", "daily", "2026-10-11"), "2026-10-12");
  assert.equal(nextDueDate("2026-10-11", "weekly", "2026-10-11"), "2026-10-18");
  assert.equal(
    nextDueDate("2026-10-11", "monthly", "2026-10-11"),
    "2026-11-11",
  );
  // Overdue catch-up: keeps advancing past today, never re-arms in the past.
  assert.equal(nextDueDate("2026-10-01", "daily", "2026-10-11"), "2026-10-12");
  assert.equal(nextDueDate("2026-08-11", "weekly", "2026-10-11"), "2026-10-18");
  // No due date: roll from today.
  assert.equal(nextDueDate(null, "daily", "2026-10-11"), "2026-10-12");
  // Month clamp (Jan 31 -> Feb 28) follows addMonths semantics.
  assert.equal(
    nextDueDate("2026-01-31", "monthly", "2026-01-31"),
    "2026-02-28",
  );
});

test("nextReminderAt: a repeating reminder re-arms to its next future occurrence (§2.7)", () => {
  // Fire time still ahead in this period -> one period forward.
  assert.equal(
    nextReminderAt("2026-01-01T09:00", "daily", "2026-01-01T08:00"),
    "2026-01-02T09:00",
  );
  assert.equal(
    nextReminderAt("2026-03-01T07:30", "weekly", "2026-03-01T08:00"),
    "2026-03-08T07:30",
  );
  // Month clamp, through the datetime helper (Jan 31 -> Feb 28).
  assert.equal(
    nextReminderAt("2026-01-31T09:00", "monthly", "2026-02-01T00:00"),
    "2026-02-28T09:00",
  );
  // Overdue by many periods: re-arm into the future, not one period at a time
  // — a single step would leave it overdue and fire on every poll.
  assert.equal(
    nextReminderAt("2026-01-01T09:00", "daily", "2026-01-05T09:00"),
    "2026-01-06T09:00",
  );
  assert.equal(
    nextReminderAt("2026-01-01T09:00", "weekly", "2026-02-20T09:00"),
    "2026-02-26T09:00",
  );
});

test("nextReminderAt: an absurd backlog and a malformed stamp both terminate", () => {
  // A decade of missed daily periods runs into the catch-up cap: the value
  // comes back advanced, but still behind `now`, instead of looping forever.
  const capped = nextReminderAt(
    "2016-01-01T09:00",
    "daily",
    "2026-10-16T09:00",
  );
  assert.ok(capped > "2016-01-01T09:00", "the cap still advances the time");
  assert.ok(capped <= "2026-10-16T09:00", `the cap is a cap: ${capped}`);
  // A malformed stamp comes back unchanged from the date helpers; the
  // no-progress guard, not the cap, is what ends the walk.
  assert.equal(
    nextReminderAt("not-a-date", "daily", "2026-10-16T09:00"),
    "not-a-date",
  );
});

test("rescheduleReminder updates in place so repeating reminders cannot be lost", async () => {
  const driver = createMockDriver();
  const tasks = createTasksRepo(driver);
  await tasks.rescheduleReminder(7, "2026-10-13T09:00");
  const call = driver.lastCall();
  assert.ok(call);
  assert.equal(call.method, "execute");
  assert.deepEqual(call.args, [
    "UPDATE reminders SET remind_at = ?, fired = 0 WHERE id = ?",
    ["2026-10-13T09:00", 7],
  ]);
});
