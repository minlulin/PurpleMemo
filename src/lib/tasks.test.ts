// Tasks repository: partial updates write only the provided fields.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMockDriver } from "../data/mock-driver.ts";
import { createTasksRepo, nextDueDate } from "./tasks.ts";

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
