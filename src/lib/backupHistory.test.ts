// The last-backup record: the row Settings → Backup reads back.
//
// The stored value is untrusted, so the reader is a pure function tested here
// rather than assumptions spread through the page.

import assert from "node:assert/strict";
import { test } from "node:test";
import { describeBackupAge, parseLastBackup } from "./backupHistory.ts";

const NOW = new Date("2026-11-22T09:00:00.000Z");

/** An ISO instant `daysAgo` whole days before NOW. */
const at = (daysAgo: number) =>
  new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

test("a well-formed record keeps its three fields", () => {
  assert.deepEqual(parseLastBackup({ at: at(0), rows: 412, photos: 88 }), {
    at: at(0),
    rows: 412,
    photos: 88,
  });
});

test("anything that is not three valid fields is no record at all", () => {
  for (const bad of [
    null,
    undefined,
    [],
    {},
    "2026-11-22T09:00:00.000Z",
    { at: at(1) },
    { at: "not-a-date", rows: 1, photos: 0 },
    { at: at(1), rows: -1, photos: 0 },
    { at: at(1), rows: 1.5, photos: 0 },
    { at: at(1), rows: "412", photos: 0 },
    { at: at(1), rows: 1, photos: Number.NaN },
  ]) {
    assert.equal(
      parseLastBackup(bad),
      null,
      `${String(JSON.stringify(bad))} must not parse`,
    );
  }
});

test("the age reads the way a person would say it, and counts whole days", () => {
  assert.deepEqual(describeBackupAge("en", at(0), NOW), {
    age: "today",
    days: 0,
  });
  assert.deepEqual(describeBackupAge("en", at(1), NOW), {
    age: "yesterday",
    days: 1,
  });
  assert.deepEqual(describeBackupAge("en", at(3), NOW), {
    age: "3 days ago",
    days: 3,
  });
  // Past two months the unit changes: "47 days ago" is harder to read.
  assert.deepEqual(describeBackupAge("en", at(61), NOW), {
    age: "2 months ago",
    days: 61,
  });
});

test("a future timestamp reads as today, never as a negative age", () => {
  assert.deepEqual(describeBackupAge("en", at(-5), NOW), {
    age: "today",
    days: 0,
  });
});

test("an unreadable timestamp has no age to show", () => {
  assert.equal(describeBackupAge("en", "not-a-date", NOW), null);
});

test("Burmese keeps Latin digits, like every other number in the app", () => {
  const described = describeBackupAge("my", at(3), NOW);
  assert.ok(described !== null);
  assert.match(described.age, /3/);
  assert.doesNotMatch(described.age, /[\u1040-\u1049]/);
});
