import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_AUTO_LOCK_MINUTES,
  isIdle,
  MIN_PIN_LENGTH,
} from "./appLock.ts";

test("isIdle: locks once the quiet window passes the configured minutes", () => {
  const now = 1_000_000;
  const tenMin = 10 * 60_000;
  assert.equal(isIdle(now - tenMin, now, 10), false, "exactly at the limit");
  assert.equal(isIdle(now - tenMin - 1, now, 10), true, "one ms over");
  assert.equal(isIdle(now - 60_000, now, 10), false, "active a minute ago");
});

test("isIdle: never locks when auto-lock is disabled (minutes <= 0)", () => {
  const now = 1_000_000;
  assert.equal(isIdle(0, now, 0), false);
  assert.equal(isIdle(0, now, -5), false);
});

test("guard rails: 6+ char PIN, 10 minute default (§2.9)", () => {
  assert.equal(MIN_PIN_LENGTH, 6);
  assert.equal(DEFAULT_AUTO_LOCK_MINUTES, 10);
});
