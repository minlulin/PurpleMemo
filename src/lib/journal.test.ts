// Unit tests for the journal helpers (month grid navigation).
// Runs under `node --test` with Node's type-stripping — no JSX, `.ts` imports only.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildMonthGrid, monthLabel, weekRowKey } from "./journal.ts";

test("October 2026 grid: Sunday-start, 4 leading blanks, 5 full weeks", () => {
  const weeks = buildMonthGrid("2026-10", []);
  assert.equal(weeks.length, 5);
  const first = weeks[0];
  assert.ok(first !== undefined);
  assert.equal(first.length, 7);
  // 2026-10-01 is a Thursday -> cells 0..3 are null (Sun..Wed).
  assert.deepEqual(first.slice(0, 4), [null, null, null, null]);
  assert.deepEqual(first[4], { date: "2026-10-01", hasEntry: false });
  const lastWeek = weeks[4];
  assert.ok(lastWeek !== undefined);
  assert.deepEqual(lastWeek[6], { date: "2026-10-31", hasEntry: false });
});

test("entry dates mark their day; dates outside the month are ignored", () => {
  const weeks = buildMonthGrid("2026-10", ["2026-10-10", "2026-09-30"]);
  const marked = weeks
    .flat()
    .filter((cell) => cell?.hasEntry === true)
    .map((cell) => cell?.date ?? "");
  assert.deepEqual(marked, ["2026-10-10"]);
});

test("February 2026 starts on a Sunday: no blanks, 4 exact weeks", () => {
  const weeks = buildMonthGrid("2026-02", []);
  assert.equal(weeks.length, 4);
  const firstWeek = weeks[0];
  assert.ok(firstWeek !== undefined);
  assert.deepEqual(firstWeek[0], { date: "2026-02-01", hasEntry: false });
});

test("invalid year-month strings yield an empty grid", () => {
  assert.deepEqual(buildMonthGrid("2026-13", []), []);
  assert.deepEqual(buildMonthGrid("bogus", []), []);
  assert.deepEqual(buildMonthGrid("", []), []);
});

test("every emitted week has a dated cell to key on (D12)", () => {
  // The grid rows used to carry a `?? blank-key` fallback, advertising an
  // all-blank week that buildMonthGrid cannot produce: leading blanks are at
  // most 6, trailing padding at most 6, and a month runs 28-31 days.
  for (const yearMonth of ["2026-10", "2026-02", "2026-08", "2027-05"]) {
    const weeks = buildMonthGrid(yearMonth, []);
    assert.ok(weeks.length > 0);
    for (const week of weeks) {
      const firstDated = week.find((cell) => cell !== null);
      assert.ok(firstDated, `${yearMonth} produced a blank-only week`);
      assert.equal(weekRowKey(week), firstDated.date);
    }
  }
  assert.throws(
    () => weekRowKey([null, null]),
    /no dated cell/,
    "a broken grid fails loudly instead of rendering under an invented key",
  );
});

test("monthLabel renders the English month name", () => {
  assert.equal(monthLabel("2026-10"), "October 2026");
  assert.equal(monthLabel("2026-01"), "January 2026");
  assert.equal(monthLabel("nope"), "");
});
