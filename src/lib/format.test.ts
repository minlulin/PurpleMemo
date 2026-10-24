// Locale-aware display formatting. The point of these tests
// is that presentation follows the locale while the underlying value does not:
// Gregorian calendar, Latin digits in both languages, and malformed rows shown
// as they are instead of throwing.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  formatDate,
  formatDateTime,
  formatLongDate,
  formatNumber,
  formatYearMonth,
  weekdayNarrow,
} from "./format.ts";
import { formatMMK } from "./money.ts";

const BURMESE_DIGITS = /[၀-၉]/;

test("dates render in the Gregorian calendar", () => {
  assert.equal(formatDate("en", "2026-10-20"), "Oct 20, 2026");
  assert.equal(formatYearMonth("en", "2026-10"), "Oct 2026");
});

test("Burmese dates keep Latin digits", () => {
  const rendered = formatDate("my", "2026-10-20");
  assert.match(rendered, /2026/);
  assert.doesNotMatch(rendered, BURMESE_DIGITS);
  assert.notEqual(rendered, "2026-10-20");
});

test("date-times keep the stored local clock time", () => {
  const rendered = formatDateTime("en", "2026-10-20T14:05");
  assert.match(rendered, /2026/);
  assert.match(rendered, /14:05/);
  assert.doesNotMatch(formatDateTime("my", "2026-10-20T14:05"), BURMESE_DIGITS);
});

test("long dates carry the weekday and keep Latin digits", () => {
  assert.equal(formatLongDate("en", "2026-10-20"), "Tuesday, October 20, 2026");
  assert.doesNotMatch(formatLongDate("my", "2026-10-20"), BURMESE_DIGITS);
  assert.equal(formatLongDate("en", "not-a-date"), "not-a-date");
});

test("narrow weekdays follow the locale", () => {
  assert.equal(weekdayNarrow("en", "2026-10-20"), "T");
  assert.notEqual(weekdayNarrow("my", "2026-10-20"), "T");
  assert.equal(weekdayNarrow("en", "not-a-date"), "not-a-date");
});

test("malformed values are returned unchanged", () => {
  // Display code must not throw over a bad row, and the raw value is more
  // useful than "Invalid Date".
  assert.equal(formatDate("en", "not-a-date"), "not-a-date");
  assert.equal(formatDateTime("en", ""), "");
  assert.equal(formatYearMonth("my", "2026-13"), "2026-13");
});

test("numbers group per locale with Latin digits everywhere", () => {
  assert.equal(formatNumber("en", 1000), "1,000");
  assert.doesNotMatch(formatNumber("my", 1000), BURMESE_DIGITS);
  assert.equal(
    formatNumber("en", 1234.5, { maximumFractionDigits: 1 }),
    "1,234.5",
  );
});

test("money keeps integer cents and two decimals, locale changes only grouping", () => {
  assert.equal(formatMMK(1_250_000, "en"), "12,500.00");
  assert.equal(formatMMK(5, "en"), "0.05");
  const burmese = formatMMK(1_250_000, "my");
  assert.match(burmese, /00$/);
  assert.doesNotMatch(burmese, BURMESE_DIGITS);
});
