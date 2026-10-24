import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createMockDriver } from "../data/mock-driver.ts";
import { at } from "../test-utils.ts";
import {
  bestStreak,
  createHabitsRepo,
  currentStreak,
  weekProgress,
} from "./habits.ts";

test("currentStreak counts consecutive days ending today", () => {
  const dates = [
    "2026-10-06",
    "2026-10-07",
    "2026-10-08",
    "2026-10-09",
    "2026-10-10",
  ];
  assert.equal(currentStreak(dates, "2026-10-10"), 5);
});

test("currentStreak survives today not logged yet (streak not broken)", () => {
  const dates = ["2026-10-08", "2026-10-09"];
  assert.equal(currentStreak(dates, "2026-10-10"), 2);
});

test("currentStreak breaks on a gap", () => {
  const dates = ["2026-10-01", "2026-10-02", "2026-10-08", "2026-10-09"];
  assert.equal(currentStreak(dates, "2026-10-10"), 2);
});

test("currentStreak is 0 when yesterday and today are both missed", () => {
  assert.equal(currentStreak(["2026-10-01"], "2026-10-10"), 0);
});

test("bestStreak finds the longest consecutive run ever", () => {
  const dates = [
    "2026-01-01",
    "2026-01-02",
    "2026-01-03",
    "2026-01-04", // run of 4
    "2026-02-01",
    "2026-02-02", // run of 2
  ];
  assert.equal(bestStreak(dates), 4);
  assert.equal(bestStreak([]), 0);
  assert.equal(bestStreak(["2026-05-05"]), 1);
});

test("weekProgress maps the 7 days ending today to done/not", () => {
  const dates = ["2026-10-09", "2026-10-10"];
  const week = weekProgress(dates, "2026-10-10");
  assert.equal(week.length, 7);
  assert.equal(at(week, 0, "week").date, "2026-10-04");
  assert.equal(at(week, 6, "week").date, "2026-10-10");
  assert.deepEqual(
    week.map((d) => d.done),
    [false, false, false, false, false, true, true],
  );
});

// The batch methods that replaced the per-habit fan-out. The
// pages and the share ticker both paid 2-3 queries PER HABIT for progress and
// dates; these tests pin the replacement shape: one habits read, one log read,
// and the full dates a calendar grid needs coming back with the same call.

test("habitProgressList: all habits, progress and dates in two queries", async () => {
  const driver = createMockDriver({
    results: [
      [
        { id: 1, name: "Run", created_at: "2026-01-01" },
        { id: 2, name: "Read", created_at: "2026-01-01" },
      ],
      [
        { habit_id: 1, log_date: "2026-10-09" },
        { habit_id: 1, log_date: "2026-10-10" },
        { habit_id: 2, log_date: "2026-10-01" },
      ],
    ],
  });
  const habits = createHabitsRepo(driver);
  const rows = await habits.habitProgressList("2026-10-10");

  assert.equal(
    driver.callsTo("query").length,
    2,
    "two habits must cost two queries total, not two each",
  );
  assert.equal(rows.length, 2);

  const first = at(rows, 0, "rows");
  assert.equal(first.habit.name, "Run");
  assert.equal(first.current, 2, "streak through today");
  assert.equal(first.best, 2);
  assert.deepEqual(first.dates, ["2026-10-09", "2026-10-10"]);
  assert.equal(first.week.length, 7);
  assert.equal(at(first.week, 6, "week").done, true);

  const second = at(rows, 1, "rows");
  assert.equal(second.current, 0, "a gap breaks the streak");
  assert.equal(second.best, 1);
  assert.deepEqual(second.dates, ["2026-10-01"]);

  // The log read is scoped to the ids the habits read returned.
  const logCall = at(driver.callsTo("query"), 1, "query calls");
  const [, params] = logCall.args as [string, unknown[]];
  assert.deepEqual(params, [1, 2], "habit ids, in list order");
});

test("habitProgressList: a limit caps the habit list, never the dates", async () => {
  const driver = createMockDriver({
    results: [
      [{ id: 7, name: "Run", created_at: "2026-01-01" }],
      [
        { habit_id: 7, log_date: "2026-09-01" },
        { habit_id: 7, log_date: "2026-10-10" },
      ],
    ],
  });
  const habits = createHabitsRepo(driver);
  const rows = await habits.habitProgressList("2026-10-10", 20);

  const [listSql, listParams] = at(driver.callsTo("query"), 0, "query calls")
    .args as [string, unknown[]];
  assert.match(listSql, /LIMIT \?/, "the cap belongs on the habits read");
  assert.deepEqual(listParams, [20]);
  // Streaks need the habit's whole history: the log read keeps every date.
  assert.deepEqual(at(rows, 0, "rows").dates, ["2026-09-01", "2026-10-10"]);
  assert.equal(
    at(rows, 0, "rows").current,
    1,
    "history is not truncated by the cap",
  );
});
