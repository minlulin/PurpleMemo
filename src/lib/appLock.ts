// PIN lock shell helpers: the app lock is casual-eyes protection —
// 6+ character PIN, salted PBKDF2 hash in settings, auto-lock after a
// configurable idle window (default 10 minutes), and a security-question
// fallback that allows setting a new PIN. There is NO online recovery.

import type { PinHash } from "./crypto.ts";

export const MIN_PIN_LENGTH = 6;
export const DEFAULT_AUTO_LOCK_MINUTES = 10;

/**
 * Lock-screen failure delay: after this many consecutive
 * failed attempts the screen pauses before another try may start. The
 * 600k-iteration PBKDF2 hash already costs hundreds of ms per attempt, but
 * that is a side effect, not a policy — this makes the throttle explicit.
 * The count resets on the first success, and the delay is a UI pause only:
 * it never locks the user out.
 */
export const LOCK_MAX_FREE_ATTEMPTS = 5;
export const LOCK_RETRY_DELAY_MS = 5_000;

/** Consecutive-failure counter → ms the screen must wait before retrying. */
export function lockRetryDelayMs(failures: number): number {
  return failures >= LOCK_MAX_FREE_ATTEMPTS ? LOCK_RETRY_DELAY_MS : 0;
}

/**
 * The forgotten-PIN fallback (`LockScreen`'s "Forgot PIN?") REPLACES the
 * stored PIN once the security answer verifies. Whoever knows the answer can
 * therefore take the lock over and shut the owner out.
 *
 * Requiring the old PIN here is not an option: the flow exists for a PIN the
 * user no longer knows, and Settings → Change PIN already verifies the current
 * PIN for the case where they do. So the fallback cannot be made safe by proof
 * — only deliberate. This rule is what makes it deliberate: the answer alone
 * never writes anything; the screen states the consequence and the operator
 * must acknowledge it first.
 */
export type PinResetBlock =
  | "no-answer"
  | "short-pin"
  | "mismatch"
  | "unacknowledged";

/**
 * The first reason the fallback reset is refused, or `null` when it may
 * proceed. Pure, so the rule above is pinned by a test rather than by the
 * screen; the caller maps each code to its sentence.
 *
 * Order (deliberate, and what the tests pin): an unavailable fallback outranks
 * everything — it fails closed — then the new-PIN rules, then the
 * acknowledgement, which is the gate on the write itself. A refusal here is
 * not a failed attempt and must not count against the retry throttle.
 *
 * "Unavailable" means more than absent (G1): the hash must also pass the same
 * shape and iteration-floor checks `classifyPin` applies to `pin_hash`, so a
 * malformed or downgraded `security_answer_hash` (a crafted backup, a tampered
 * row) cannot be verified against at all.
 */
export function pinResetBlocked(input: {
  answerHash: unknown;
  acknowledged: boolean;
  pin: string;
  confirm: string;
}): PinResetBlock | null {
  // The hash is validated, not merely present (G1): `null`/`undefined` is the
  // absent row, but any value the classifier would refuse — wrong shape, or a
  // PBKDF2 count below the floor a downgrade attack would love to have honoured
  // — is just as unavailable, and must fail closed here rather than reach
  // `verifyAnswer` as trusted material. Every caller gets the same rule.
  if (!isPinHashShape(input.answerHash)) return "no-answer";
  if (input.answerHash.iterations < MIN_PIN_HASH_ITERATIONS) {
    return "no-answer";
  }
  if (input.pin.length < MIN_PIN_LENGTH) return "short-pin";
  if (input.pin !== input.confirm) return "mismatch";
  if (!input.acknowledged) return "unacknowledged";
  return null;
}

/**
 * True when the app has been idle longer than `minutes` (auto-lock).
 * `minutes <= 0` disables auto-lock — an idle app never locks itself.
 * Timestamps are compared in milliseconds; both must come from the same
 * monotonic clock (`performance.now()`), never wall-clock `Date.now()` — a
 * rolled-back system clock must not extend an unlocked session.
 */
export function isIdle(
  lastActivityMs: number,
  nowMs: number,
  minutes: number,
): boolean {
  if (minutes <= 0) return false;
  return nowMs - lastActivityMs > minutes * 60_000;
}

/** The idle-timeout choices offered in Settings (minutes; 0 = never). */
export const AUTO_LOCK_CHOICES = [5, 10, 15, 30, 0] as const;

/**
 * Which gate the app shows before the shell
 *
 * - `setup`   — first run: no PIN has ever been stored.
 * - `pin`     — locked, with the security-question fallback available.
 * - `pin-only` — locked, fallback unavailable (the answer hash is missing).
 * - `locked`  — a PIN **is** stored but cannot be read or trusted. Neither
 *   setup nor unlock is offered.
 *
 * The rule is deliberately fail-closed: the setup screen writes a new PIN
 * WITHOUT verifying any existing one, so it must be reachable only when no
 * PIN exists at all. `classifyPin` exists because "no PIN" and "unreadable
 * PIN" used to be the same `null` — `settingsRepo.getJSON` returns null both
 * when a key has no row and when its JSON fails to parse. That collapsed a
 * corrupt `pin_hash`, or an imported backup whose settings table predates the
 * PIN, straight into first-run setup: a complete lock bypass.
 */
export type LockGate = "setup" | "pin" | "pin-only" | "locked";

/** What the settings table says about the PIN, before it is trusted. */
export type PinState =
  | { kind: "absent" }
  | { kind: "stored"; hash: PinHash }
  | { kind: "unreadable"; reason: PinUnreadable };

export type PinUnreadable = "corrupt" | "malformed" | "weak-iterations";

/**
 * A stored hash must be at least this strong to be believed. The app has only
 * ever written `PBKDF2_ITERATIONS` (600k); anything far below that is either
 * a downgrade attack or a foreign row, and honouring it would turn PIN
 * verification into an instant oracle. Such a row is unreadable,
 * not weak-but-accepted.
 */
export const MIN_PIN_HASH_ITERATIONS = 100_000;

function isPinHashShape(value: unknown): value is PinHash {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<PinHash>;
  return (
    typeof v.salt === "string" &&
    v.salt.length > 0 &&
    typeof v.hash === "string" &&
    v.hash.length > 0 &&
    typeof v.iterations === "number" &&
    Number.isInteger(v.iterations)
  );
}

/**
 * Classify the RAW `pin_hash` settings value. Takes the raw string (not the
 * parsed one) precisely because the parse is where the old bypass lived: a
 * caller using `settingsRepo.getJSON` cannot tell this function "absent" from
 * "unparseable", so it must be handed the value before anything collapses it.
 */
export function classifyPin(raw: string | undefined): PinState {
  if (raw === undefined) return { kind: "absent" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "unreadable", reason: "corrupt" };
  }
  if (!isPinHashShape(parsed)) {
    return { kind: "unreadable", reason: "malformed" };
  }
  if (parsed.iterations < MIN_PIN_HASH_ITERATIONS) {
    return { kind: "unreadable", reason: "weak-iterations" };
  }
  return { kind: "stored", hash: parsed };
}

/**
 * How to tell the user their PIN is unreadable. Defined here, beside the
 * classification that produces it, so the two cannot drift — and reused by the
 * Change-PIN path, which said nothing at all before (review P3-18).
 */
export const UNREADABLE_PIN_REASON: Record<PinUnreadable, string> = {
  corrupt: "corrupt (not valid JSON)",
  malformed: "in an unexpected shape",
  "weak-iterations": `hashed with too few iterations (below ${MIN_PIN_HASH_ITERATIONS.toLocaleString()})`,
};

export function lockGate(pin: PinState, answerHash: unknown): LockGate {
  // Only a PIN that was never stored may open the setup screen.
  if (pin.kind === "absent") return "setup";
  // Stored but untrusted: fail closed. Offering setup would overwrite the
  // existing PIN with no verification; offering unlock would have nothing to
  // verify against.
  if (pin.kind === "unreadable") return "locked";
  return answerHash === null || answerHash === undefined ? "pin-only" : "pin";
}

// ---------------------------------------------------------------------------
// What the shell shows — and what it is allowed to do (review P2-2)
// ---------------------------------------------------------------------------

/**
 * Which screen the app shell is on. Every branch of the shell's render comes
 * from `shellStage`, so the ORDER of these checks is stated once, in a pure
 * function, instead of being implied by the order of JSX branches — where a
 * well-meaning reordering could silently reintroduce the bug this exists to
 * prevent.
 */
export type ShellStage =
  | "booting"
  | "error"
  | "setup"
  | "locked"
  | "lock"
  | "workspace";

/**
 * The one rule, and the order it is applied in.
 *
 * `loadSecurity` used to catch its own failure into `boot.error` and return
 * void, and `handleUnlock` then set `unlocked` unconditionally — so the
 * `!unlocked && error !== null` branch was skipped, the message was never
 * shown, and the shell carried on holding whatever `boot.pin` it had read
 * earlier. Concretely: the forgot-PIN reset writes a NEW `pin_hash`, the
 * reload fails transiently, and the next lock verifies against the OLD hash —
 * rejecting the PIN the user just set and accepting the one they were trying
 * to get rid of.
 *
 * Two properties make the fix hold, both pinned by the tests:
 *
 * 1. **A failed read outranks every lock screen.** `error` is checked before
 *    `lockGate`, so a pending failure can never be resolved into "verify the
 *    PIN against `boot.pin`". That is the whole security property: the stale
 *    hash is never used as a trust root.
 * 2. **An open session is not ejected.** The workspace outranks `error`
 *    because a reload can also fail mid-session (a Settings write calls
 *    `loadSecurity` too), and a hiccup while changing the theme must not cost
 *    the user their place. The failure is not swallowed there — the shell
 *    shows it as a banner — and it is still armed for the next lock, which
 *    lands on `"error"`.
 */
export function shellStage(input: {
  ready: boolean;
  unlocked: boolean;
  error: string | null;
  pin: PinState;
  answerHash: unknown;
}): ShellStage {
  if (!input.ready) return "booting";
  if (input.unlocked) return "workspace";
  // Ahead of `lockGate`: no failure may ever resolve into PIN verification.
  if (input.error !== null) return "error";
  const gate = lockGate(input.pin, input.answerHash);
  if (gate === "setup") return "setup";
  if (gate === "locked") return "locked";
  return "lock";
}

/**
 * True when a session is open AND a security reload is still outstanding, so
 * the shell must say so instead of swallowing it.
 *
 * Separate from `shellStage` because it is the one thing the shell shows
 * *alongside* a screen rather than choosing between screens.
 */
export function showReloadWarning(input: {
  stage: ShellStage;
  error: string | null;
}): boolean {
  return input.stage === "workspace" && input.error !== null;
}

/**
 * The outcome of one `loadSecurity` pass. The entry decision rides WITH the
 * result rather than beside it, so a caller cannot read the new security
 * state and then set `unlocked` from some other notion of success — which is
 * exactly how the stale-PIN-hash bug happened.
 */
export type SecurityReload = { ok: true } | { ok: false; error: string };

/** True when the reload succeeded, so the workspace may be entered. */
export function reloadOpensEntry(reload: SecurityReload): boolean {
  return reload.ok;
}

/**
 * The settings keys the lock screen's trust root is built from. The shell
 * reads `pin_hash` once per `loadSecurity` and hands it to the lock screen, so
 * a write to any of these keys MUST be followed by a reload of that state —
 * otherwise the next lock verifies against a stale hash and rejects the PIN
 * the user just set.
 */
export const SECURITY_TRUST_ROOT_KEYS: readonly string[] = [
  "pin_hash",
  "security_answer_hash",
];

/**
 * True when a settings write touched the lock screen's trust root and the
 * shell must re-read its security state before the next lock. Kept pure so
 * every PIN-writing path can share the rule instead of each remembering it.
 */
export function securityReloadNeeded(writtenKeys: readonly string[]): boolean {
  return writtenKeys.some((k) => SECURITY_TRUST_ROOT_KEYS.includes(k));
}
