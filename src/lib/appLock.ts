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
