import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  DEFAULT_AUTO_LOCK_MINUTES,
  isIdle,
  type LockGate,
  lockGate,
  MIN_PIN_LENGTH,
} from "./appLock.ts";

// The lock gate must fail CLOSED (§2.9: the PIN is required and cannot be
// skipped). A partially-written settings row — a corrupt value, or a backup
// import whose settings table lacks one of the two keys — must never route to
// the setup screen, because setup overwrites the PIN without proving the old
// one. That is a full lock bypass.
const HASH = { salt: "c2FsdA==", hash: "aGFzaA==", iterations: 600_000 };

test("lockGate: a genuine first run (no PIN hash) is the only path to setup", () => {
  assert.equal(lockGate(null, null), "setup");
});

test("lockGate: a stored PIN always locks, even without the answer hash", () => {
  const cases: [LockGate, ReturnType<typeof lockGate>][] = [
    ["pin", lockGate(HASH, HASH)],
    ["pin-only", lockGate(HASH, null)],
  ];
  for (const [expected, actual] of cases) {
    assert.equal(actual, expected);
  }
});

test("lockGate: a stray answer hash without a PIN is still first run", () => {
  // No pin_hash means no PIN was ever set, so there is no lock to bypass and
  // nothing to verify against — setup is the only way forward. (The reverse
  // asymmetry is the real risk: see the two tests below.)
  assert.equal(lockGate(null, HASH), "setup");
  assert.equal(lockGate(undefined, HASH), "setup");
});

test("lockGate: setup is unreachable once a PIN exists", () => {
  // The regression that matters: a stored pin_hash must NEVER fall through to
  // first-run setup, whatever the answer hash looks like.
  for (const answer of [HASH, null, undefined]) {
    const gate = lockGate(HASH, answer);
    assert.notEqual(
      gate,
      "setup",
      "a stored PIN must never fall through to first-run setup",
    );
  }
});

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
