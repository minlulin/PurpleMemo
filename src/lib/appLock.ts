// PIN lock shell helpers (§2.9): the app lock is casual-eyes protection —
// 6+ character PIN, salted PBKDF2 hash in settings, auto-lock after a
// configurable idle window (default 10 minutes), and a security-question
// fallback that allows setting a new PIN. There is NO online recovery.

export const MIN_PIN_LENGTH = 6;
export const DEFAULT_AUTO_LOCK_MINUTES = 10;

/**
 * True when the app has been idle longer than `minutes` (§2.9 auto-lock).
 * `minutes <= 0` disables auto-lock — an idle app never locks itself.
 * Timestamps are compared in milliseconds (performance.now() or Date.now()).
 */
export function isIdle(
  lastActivityMs: number,
  nowMs: number,
  minutes: number,
): boolean {
  if (minutes <= 0) return false;
  return nowMs - lastActivityMs > minutes * 60_000;
}

/** The idle-timeout choices offered in Settings (§2.9, minutes; 0 = never). */
export const AUTO_LOCK_CHOICES = [5, 10, 15, 30, 0] as const;

/**
 * Which gate the app shows before the shell (§2.9).
 *
 * - `setup`    — first run: no PIN has ever been stored.
 * - `pin`      — locked, with the security-question fallback available.
 * - `pin-only` — locked, fallback unavailable (the answer hash is missing).
 *
 * The rule is deliberately fail-closed: the setup screen writes a new PIN
 * WITHOUT verifying any existing one, so it must be reachable only when no
 * PIN exists at all. Keying off both hashes instead would let a partially
 * written settings row — a corrupt value (`getJSON` returns null on a parse
 * failure) or a backup import whose settings table lacks one key — drop a
 * locked app straight into first-run setup, which is a full lock bypass.
 */
export type LockGate = "setup" | "pin" | "pin-only";

export function lockGate(pinHash: unknown, answerHash: unknown): LockGate {
  if (pinHash === null || pinHash === undefined) return "setup";
  return answerHash === null || answerHash === undefined ? "pin-only" : "pin";
}
