import { strict as assert } from "node:assert";
import { test } from "node:test";

import { at } from "../test-utils.ts";
import { bestStreak, currentStreak, weekProgress } from "./habits.ts";

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

test("weekProgress maps the 7 days ending today to done/not (§2.7)", () => {
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
