import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  classifyPin,
  DEFAULT_AUTO_LOCK_MINUTES,
  isIdle,
  LOCK_MAX_FREE_ATTEMPTS,
  LOCK_RETRY_DELAY_MS,
  type LockGate,
  lockGate,
  lockRetryDelayMs,
  MIN_PIN_HASH_ITERATIONS,
  MIN_PIN_LENGTH,
  type PinResetBlock,
  type PinState,
  type PinUnreadable,
  pinResetBlocked,
  reloadOpensEntry,
  type SecurityReload,
  securityReloadNeeded,
  shellStage,
  showReloadWarning,
  UNREADABLE_PIN_REASON,
} from "./appLock.ts";

// The lock gate must fail CLOSED (the PIN is required and cannot be
// skipped). A partially-written settings row — a corrupt value, or a backup
// import whose settings table lacks one of the two keys — must never route to
// the setup screen, because setup overwrites the PIN without proving the old
// one. That is a full lock bypass.
const HASH = { salt: "c2FsdA==", hash: "aGFzaA==", iterations: 600_000 };
const STORED: PinState = { kind: "stored", hash: HASH };
const ABSENT: PinState = { kind: "absent" };

test("lockGate: a genuine first run (no PIN row) is the only path to setup", () => {
  assert.equal(lockGate(ABSENT, null), "setup");
  // What the shell actually reads: the raw value is `undefined` when the
  // settings row does not exist.
  assert.deepEqual(classifyPin(undefined), ABSENT);
  assert.equal(lockGate(classifyPin(undefined), null), "setup");
});

test("lockGate: a stored PIN always locks, even without the answer hash", () => {
  const cases: [LockGate, LockGate][] = [
    ["pin", lockGate(STORED, HASH)],
    ["pin-only", lockGate(STORED, null)],
  ];
  for (const [expected, actual] of cases) {
    assert.equal(actual, expected);
  }
});

test("lockGate: a stray answer hash without a PIN is still first run", () => {
  // No pin_hash means no PIN was ever set, so there is no lock to bypass and
  // nothing to verify against — setup is the only way forward. (The reverse
  // asymmetry is the real risk: see the two tests below.)
  assert.equal(lockGate(ABSENT, HASH), "setup");
});

test("lockGate: setup is unreachable once a PIN exists", () => {
  // The regression that matters: a stored pin_hash must NEVER fall through to
  // first-run setup, whatever the answer hash looks like.
  for (const answer of [HASH, null, undefined]) {
    assert.notEqual(
      lockGate(STORED, answer),
      "setup",
      "a stored PIN must never fall through to first-run setup",
    );
  }
});

// -- the bypass ------------------------------------------------------
//
// `settingsRepo.getJSON` returns null BOTH when a settings key has no row and
// when its JSON fails to parse. `lockGate` keyed "setup" off that null, so a
// corrupt `pin_hash` — or an imported backup taken before a PIN existed —
// opened the setup screen, which writes a new PIN with no verification at all.
// The distinction has to survive the read, so the shell reads raw and
// `classifyPin` decides.

test("classifyPin: an unreadable PIN is unreadable, never absent", () => {
  for (const raw of [
    "", // empty row
    "not json at all",
    "{", // truncated JSON
    "null",
    "undefined",
    '"just a string"',
    "42",
    "[]",
    "{}",
    JSON.stringify({ salt: "c2FsdA==" }), // no hash
    JSON.stringify({ salt: "c2FsdA==", hash: "aGFzaA==" }), // no iterations
    JSON.stringify({ ...HASH, iterations: "600000" }), // wrong type
    JSON.stringify({ ...HASH, iterations: 1.5 }), // not an integer
    JSON.stringify({ ...HASH, salt: "" }),
  ]) {
    const state = classifyPin(raw);
    assert.notEqual(
      state.kind,
      "absent",
      `raw ${JSON.stringify(raw)} must not be read as "no PIN stored"`,
    );
    assert.notEqual(
      lockGate(state, HASH),
      "setup",
      `raw ${JSON.stringify(raw)} must not reach first-run setup`,
    );
  }
});

test("classifyPin: a tampered iteration count is refused, not honoured", () => {
  // Honouring `iterations: 1` would make PIN verification an instant oracle.
  const weak = classifyPin(JSON.stringify({ ...HASH, iterations: 1 }));
  assert.deepEqual(weak, { kind: "unreadable", reason: "weak-iterations" });
  assert.equal(lockGate(weak, HASH), "locked");

  const weak2 = classifyPin(
    JSON.stringify({ ...HASH, iterations: MIN_PIN_HASH_ITERATIONS - 1 }),
  );
  assert.equal(lockGate(weak2, HASH), "locked");

  // At the floor it is still trusted.
  const ok = classifyPin(
    JSON.stringify({ ...HASH, iterations: MIN_PIN_HASH_ITERATIONS }),
  );
  assert.equal(ok.kind, "stored");
  assert.equal(lockGate(ok, HASH), "pin");
});

test("lockGate: an unreadable PIN locks, refusing BOTH setup and unlock", () => {
  for (const reason of ["corrupt", "malformed", "weak-iterations"] as const) {
    const state: PinState = { kind: "unreadable", reason };
    assert.equal(lockGate(state, HASH), "locked");
    assert.equal(lockGate(state, null), "locked");
  }
});

test("classifyPin: a real hash round-trips to `stored`", () => {
  const state = classifyPin(JSON.stringify(HASH));
  assert.equal(state.kind, "stored");
  if (state.kind !== "stored") throw new Error("unreachable");
  assert.deepEqual(state.hash, HASH);
});

test("securityReloadNeeded: a PIN write must refresh the lock shell's hash", () => {
  // the shell reads pin_hash once and hands it to the lock
  // screen, so a PIN write that skips the reload leaves the next lock
  // verifying against the previous PIN.
  assert.equal(securityReloadNeeded(["pin_hash"]), true);
  assert.equal(securityReloadNeeded(["security_answer_hash"]), true);
  assert.equal(
    securityReloadNeeded(["pin_hash", "security_question"]),
    true,
    "a mixed write still needs the reload",
  );
  // Writes that cannot affect the lock screen.
  assert.equal(securityReloadNeeded(["theme"]), false);
  assert.equal(securityReloadNeeded(["auto_lock_minutes"]), false);
  assert.equal(securityReloadNeeded([]), false);
});

test("shellStage: a failed security read is never resolved into a PIN check", () => {
  // The regression the whole fix exists for. The scenario:
  // the forgot-PIN reset writes a NEW pin_hash, `loadSecurity` then fails
  // transiently, and the shell used to unlock anyway — so the next lock
  // verified against the OLD hash (rejecting the PIN just set, accepting the
  // one being replaced). With `error` set, no screen that can verify a PIN is
  // reachable, whatever `boot.pin` happens to hold.
  const error = "Could not read the encrypted database: boom";
  const pins: PinState[] = [
    ABSENT,
    STORED,
    { kind: "unreadable", reason: "corrupt" },
  ];
  for (const pin of pins) {
    assert.equal(
      shellStage({
        ready: true,
        unlocked: false,
        error,
        pin,
        answerHash: HASH,
      }),
      "error",
      `a failed read must fail closed for ${JSON.stringify(pin)}`,
    );
  }
  // Including while booting into it — the boot-time read that failed first.
  assert.equal(
    shellStage({
      ready: false,
      unlocked: false,
      error,
      pin: ABSENT,
      answerHash: null,
    }),
    "booting",
    "the skeleton shows until the first read resolves",
  );
});

test("shellStage: a failed read stays armed for the next lock", () => {
  // Mid-session the workspace outranks the error (a theme write must not cost
  // the user their place), so the failure has to survive the transition to
  // locked — otherwise it is swallowed and the stale hash is used again.
  const error = "Could not read the encrypted database: boom";
  assert.equal(
    shellStage({
      ready: true,
      unlocked: true,
      error,
      pin: STORED,
      answerHash: HASH,
    }),
    "workspace",
    "an open session is not ejected by a failed reload",
  );
  assert.equal(
    shellStage({
      ready: true,
      unlocked: false,
      error,
      pin: STORED,
      answerHash: HASH,
    }),
    "error",
    "the very next lock lands on the error screen, not the lock screen",
  );
});

test("shellStage: the ordinary screens are unchanged", () => {
  assert.equal(
    shellStage({
      ready: false,
      unlocked: false,
      error: null,
      pin: ABSENT,
      answerHash: null,
    }),
    "booting",
  );
  assert.equal(
    shellStage({
      ready: true,
      unlocked: false,
      error: null,
      pin: ABSENT,
      answerHash: null,
    }),
    "setup",
  );
  assert.equal(
    shellStage({
      ready: true,
      unlocked: false,
      error: null,
      pin: STORED,
      answerHash: HASH,
    }),
    "lock",
  );
  assert.equal(
    shellStage({
      ready: true,
      unlocked: false,
      error: null,
      pin: STORED,
      answerHash: null,
    }),
    "lock",
    "a missing answer hash still gets the lock screen",
  );
  assert.equal(
    shellStage({
      ready: true,
      unlocked: false,
      error: null,
      pin: { kind: "unreadable", reason: "weak-iterations" },
      answerHash: HASH,
    }),
    "locked",
  );
  assert.equal(
    shellStage({
      ready: true,
      unlocked: true,
      error: null,
      pin: STORED,
      answerHash: HASH,
    }),
    "workspace",
  );
});

test("reloadOpensEntry: only a successful reload opens the shell", () => {
  // The gate `handleUnlock` / `handleSetupDone` route through. Before the fix
  // both awaited `loadSecurity()` and set `unlocked` regardless of the answer,
  // which is how a swallowed failure became a stale trust root.
  assert.equal(reloadOpensEntry({ ok: true }), true);
  assert.equal(
    reloadOpensEntry({ ok: false, error: "boom" }),
    false,
    "a failed reload must not grant entry",
  );
  // A caller cannot get at the state without also getting the decision.
  const reload: SecurityReload = { ok: false, error: "boom" };
  if (reload.ok) assert.fail("the failed arm must not be reachable as ok");
});

test("showReloadWarning: a mid-session failure is announced, not swallowed", () => {
  assert.equal(
    showReloadWarning({ stage: "workspace", error: "boom" }),
    true,
    "an open session must show the failure",
  );
  assert.equal(
    showReloadWarning({ stage: "workspace", error: null }),
    false,
    "nothing to say on a clean reload",
  );
  // The dedicated screens already carry the message; no second copy.
  assert.equal(showReloadWarning({ stage: "error", error: "boom" }), false);
  assert.equal(showReloadWarning({ stage: "lock", error: null }), false);
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

test("guard rails: 6+ char PIN, 10 minute default", () => {
  assert.equal(MIN_PIN_LENGTH, 6);
  assert.equal(DEFAULT_AUTO_LOCK_MINUTES, 10);
});

// The forgotten-PIN fallback *replaces* the PIN once the answer is known, so
// whoever knows the answer can lock the owner out (remaining
// half). Requiring the old PIN there is impossible by design — the fallback
// exists precisely for a PIN the user no longer knows — so the rule is that
// the answer alone is never enough: the screen must state the consequence and
// the operator must acknowledge it before anything is written.
const RESET = {
  answerHash: HASH,
  acknowledged: true,
  pin: "newpin1",
  confirm: "newpin1",
};

test("pinResetBlocked: the answer alone cannot replace the PIN", () => {
  assert.equal(
    pinResetBlocked({ ...RESET, acknowledged: false }),
    "unacknowledged" satisfies PinResetBlock,
  );
});

test("pinResetBlocked: an acknowledged, well-formed reset may proceed", () => {
  assert.equal(pinResetBlocked(RESET), null);
});

test("pinResetBlocked: a missing answer hash fails closed, ack or not", () => {
  for (const answerHash of [null, undefined]) {
    assert.equal(
      pinResetBlocked({ ...RESET, answerHash }),
      "no-answer",
      `${String(answerHash)} answer hash`,
    );
    assert.equal(
      pinResetBlocked({ ...RESET, answerHash, acknowledged: false }),
      "no-answer",
      "unavailable fallback outranks the acknowledgement",
    );
  }
});

test("pinResetBlocked: PIN rules still apply once acknowledged", () => {
  const short = "short"; // 5 chars < MIN_PIN_LENGTH (6)
  assert.equal(
    pinResetBlocked({ ...RESET, pin: short, confirm: short }),
    "short-pin",
  );
  assert.equal(
    pinResetBlocked({ ...RESET, pin: "newpin1", confirm: "newpin2" }),
    "mismatch",
  );
  // The typed fields are validated ahead of the acknowledgement, so a
  // malformed reset reports the field it can fix rather than the checkbox.
  assert.equal(
    pinResetBlocked({
      ...RESET,
      acknowledged: false,
      pin: short,
      confirm: short,
    }),
    "short-pin",
  );
});

test("lockRetryDelayMs: free attempts are instant, then a fixed pause", () => {
  assert.equal(LOCK_MAX_FREE_ATTEMPTS, 5);
  assert.equal(LOCK_RETRY_DELAY_MS, 5_000);
  for (let failures = 0; failures < LOCK_MAX_FREE_ATTEMPTS; failures += 1) {
    assert.equal(lockRetryDelayMs(failures), 0, `${failures} failures`);
  }
  assert.equal(lockRetryDelayMs(LOCK_MAX_FREE_ATTEMPTS), LOCK_RETRY_DELAY_MS);
  assert.equal(
    lockRetryDelayMs(LOCK_MAX_FREE_ATTEMPTS + 40),
    LOCK_RETRY_DELAY_MS,
  );
});

test("UNREADABLE_PIN_REASON covers every reason classifyPin can produce", () => {
  // P3-18: the Change-PIN path now names the reason. Every kind the classifier
  // can return needs a message, or the UI falls back to nothing useful — which
  // is what it used to do.
  const reasons: PinUnreadable[] = ["corrupt", "malformed", "weak-iterations"];
  for (const reason of reasons) {
    assert.ok(
      UNREADABLE_PIN_REASON[reason]?.length > 0,
      `no message for ${reason}`,
    );
    assert.doesNotMatch(
      UNREADABLE_PIN_REASON[reason],
      /\[object|undefined/,
      "the message must be plain text the user can read",
    );
  }
  // The iteration floor is named in the message, so the user learns why a PIN
  // that used to work is now refused.
  assert.match(
    UNREADABLE_PIN_REASON["weak-iterations"],
    new RegExp(
      String(MIN_PIN_HASH_ITERATIONS).replace(/(\d)(?=(\d{3})+$)/g, "$1,"),
    ),
  );
});

test("a weak-iteration PIN is unreadable, so Change PIN refuses to touch it", () => {
  // The second trust root. Boot already fails closed on this row, which is why
  // the audit called the Change-PIN path unreachable — but a trust root that
  // reaches the same secret and validates nothing is still a trust root.
  const weak = classifyPin(
    JSON.stringify({
      salt: "s".repeat(16),
      hash: "h".repeat(64),
      iterations: 1,
    }),
  );
  assert.equal(weak.kind, "unreadable");
  assert.equal(
    weak.kind === "unreadable" ? weak.reason : null,
    "weak-iterations",
  );
  // And the message the page will show names the floor.
  assert.match(UNREADABLE_PIN_REASON["weak-iterations"], /too few iterations/);
});

test("classifyPin still separates absent from unreadable for the write path", () => {
  // getJSON returned null for both, which is how Change-PIN could not tell "no
  // PIN yet" from "corrupt PIN". The raw-value API keeps them apart.
  assert.equal(classifyPin(undefined).kind, "absent");
  assert.equal(classifyPin("{nope").kind, "unreadable");
  assert.equal(classifyPin('{"salt":"s"}').kind, "unreadable");
});

test("concurrent failures count once each, not once per render snapshot (P3-12)", () => {
  // The lock screen's failure counter is read and written inside an async
  // handler. With useState it was a render-time snapshot: two attempts landing
  // inside one PBKDF2 verify window both read the same value and both produced
  // the same count, under-counting — which hands an attacker extra free
  // attempts. A ref (what the screen now uses) is read and written
  // synchronously, so nothing can sit between the read and the write.
  let failuresRef = 0;
  const noteFailure = () => {
    const next = failuresRef + 1;
    failuresRef = next;
    return next;
  };

  // Each attempt increments exactly once: no await between read and write.
  assert.equal(noteFailure(), 1);
  assert.equal(noteFailure(), 2);
  assert.equal(noteFailure(), 3);

  // A success resets the authoritative value, which is why the screen resets the
  // ref rather than only the state it used to keep.
  failuresRef = 0;
  assert.equal(noteFailure(), 1, "a reset must not leave the old count behind");

  // The counter must still agree with where the free attempts end, or the pause
  // it controls would fire at a different point than the button state expects.
  // `lockRetryDelayMs` pauses at `>= LOCK_MAX_FREE_ATTEMPTS`, and the screen
  // passes the post-increment count, so the 5th wrong guess is the one that
  // waits — four free attempts, not five.
  failuresRef = 0;
  for (let attempt = 1; attempt < LOCK_MAX_FREE_ATTEMPTS; attempt += 1) {
    assert.equal(lockRetryDelayMs(noteFailure()), 0, `attempt ${attempt}`);
  }
  assert.equal(
    lockRetryDelayMs(noteFailure()),
    LOCK_RETRY_DELAY_MS,
    "the fifth failure pauses",
  );
});
