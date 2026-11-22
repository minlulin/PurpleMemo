// The last-backup record: the row Settings → Backup reads back.
//
// The stored value is untrusted, so the reader is a pure function tested here
// rather than assumptions spread through the page.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BACKUP_STALE_DAYS,
  backupIsStale,
  formatBackupAge,
  parseLastBackup,
} from "./backupHistory.ts";

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

test("the age reads the way a person would say it", () => {
  assert.equal(formatBackupAge("en", at(0), NOW), "today");
  assert.equal(formatBackupAge("en", at(1), NOW), "yesterday");
  assert.equal(formatBackupAge("en", at(3), NOW), "3 days ago");
  // Past two months the unit changes: "47 days ago" is harder to read.
  assert.equal(formatBackupAge("en", at(61), NOW), "2 months ago");
});

test("a future timestamp reads as today, never as a negative age", () => {
  assert.equal(formatBackupAge("en", at(-5), NOW), "today");
});

test("an unreadable timestamp has no age to show", () => {
  assert.equal(formatBackupAge("en", "not-a-date", NOW), null);
});

test("Burmese keeps Latin digits, like every other number in the app", () => {
  const text = formatBackupAge("my", at(3), NOW);
  assert.ok(text !== null);
  assert.match(text, /3/);
  assert.doesNotMatch(text, /[\u1040-\u1049]/);
});

test("thirty days is not stale; one day past that is", () => {
  assert.equal(backupIsStale(at(BACKUP_STALE_DAYS), NOW), false);
  assert.equal(backupIsStale(at(BACKUP_STALE_DAYS + 1), NOW), true);
  assert.equal(backupIsStale("not-a-date", NOW), false);
});
