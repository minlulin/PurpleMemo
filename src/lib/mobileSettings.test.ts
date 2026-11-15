import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  databaseBytes,
  formatBytes,
  reminderDraftReady,
  reminderIsFuture,
} from "./mobileSettings.ts";

describe("databaseBytes", () => {
  it("multiplies the page counters", () => {
    assert.equal(databaseBytes(10, 4096), 40960);
  });

  it("answers zero for nonsense instead of NaN", () => {
    assert.equal(databaseBytes(Number.NaN, 4096), 0);
    assert.equal(databaseBytes(-1, 4096), 0);
    assert.equal(databaseBytes(0, 4096), 0);
  });
});

describe("formatBytes", () => {
  it("keeps small sizes in bytes", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(512), "512 B");
  });

  it("shows one decimal above a kilobyte", () => {
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  });

  it("rounds down, so it never overstates disk use", () => {
    assert.equal(formatBytes(1024 * 1024 * 1.99), "1.9 MB");
  });

  it("answers zero for a broken read", () => {
    assert.equal(formatBytes(Number.NaN), "0 B");
    assert.equal(formatBytes(-4), "0 B");
  });
});

describe("reminderDraftReady", () => {
  it("needs a title and a complete local time", () => {
    assert.equal(
      reminderDraftReady({ title: "Call", remindAt: "2026-11-06T18:30" }),
      true,
    );
    assert.equal(
      reminderDraftReady({ title: "   ", remindAt: "2026-11-06T18:30" }),
      false,
    );
    assert.equal(
      reminderDraftReady({ title: "Call", remindAt: "2026-11-06" }),
      false,
    );
    assert.equal(reminderDraftReady({ title: "Call", remindAt: "" }), false);
  });
});

describe("reminderIsFuture", () => {
  it("compares the fixed-width local format in order", () => {
    assert.equal(
      reminderIsFuture("2026-11-06T18:31", "2026-11-06T18:30"),
      true,
    );
    assert.equal(
      reminderIsFuture("2026-11-06T18:30", "2026-11-06T18:30"),
      false,
    );
    assert.equal(
      reminderIsFuture("2026-11-06T09:00", "2026-11-06T18:30"),
      false,
    );
  });

  it("refuses a value it cannot read", () => {
    assert.equal(reminderIsFuture("tomorrow", "2026-11-06T18:30"), false);
    assert.equal(reminderIsFuture("2026-11-06T18:31", "now"), false);
  });
});
