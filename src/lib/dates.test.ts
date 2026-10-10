import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  addDays,
  addMonths,
  advanceDate,
  datesInMonth,
  daysBetween,
  todayLocal,
  toISODate,
  yearMonthOf,
} from "./dates.ts";

test("todayLocal returns the local date as yyyy-mm-dd (§4)", () => {
  const today = todayLocal();
  assert.match(today, /^\d{4}-\d{2}-\d{2}$/);
  // Must equal the local calendar date, not UTC.
  const d = new Date();
  assert.equal(
    today,
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
  );
});

test("toISODate pads and does not shift to UTC", () => {
  assert.equal(toISODate(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(toISODate(new Date(2026, 11, 31)), "2026-12-31");
});

test("yearMonthOf buckets a date into yyyy-mm", () => {
  assert.equal(yearMonthOf("2026-10-09"), "2026-10");
});

test("addDays crosses month/year boundaries", () => {
  assert.equal(addDays("2026-10-30", 3), "2026-11-02");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("addMonths clamps the day (Jan 31 + 1mo -> Feb 28)", () => {
  assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonths("2026-02-28", 1), "2026-03-28");
  assert.equal(addMonths("2026-01-15", 13), "2027-02-15");
});

test("advanceDate steps weekly by days and longer frequencies by months", () => {
  assert.equal(advanceDate("2026-10-10", "weekly"), "2026-10-17");
  assert.equal(advanceDate("2026-10-10", "monthly"), "2026-11-10");
  assert.equal(advanceDate("2026-10-10", "quarterly"), "2027-01-10");
  assert.equal(advanceDate("2026-10-10", "yearly"), "2027-10-10");
});

test("daysBetween counts whole days", () => {
  assert.equal(daysBetween("2026-10-10", "2026-10-09"), 1);
  assert.equal(daysBetween("2026-10-09", "2026-10-10"), -1);
});

test("datesInMonth lists every day of the month oldest first", () => {
  const feb = datesInMonth("2026-02");
  assert.equal(feb.length, 28);
  assert.equal(feb[0], "2026-02-01");
  assert.equal(feb[feb.length - 1], "2026-02-28");
  assert.equal(datesInMonth("2024-02").length, 29, "leap year");
  assert.deepEqual(datesInMonth("bogus"), []);
});
