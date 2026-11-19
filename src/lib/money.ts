// Money lib: integer cents in DB and in logic; major units (MMK) only at
// display/parse edges. Cash-basis rule: outstanding amounts are never
// negative — promises and unpaid balances are never income.

import { getLocale, type Locale } from "./i18n.ts";

/** Major units -> integer cents (`toCents = Math.round(v*100)`). */
export function toCents(major: number): number {
  return Math.round(major * 100);
}

/**
 * Largest amount this app records, in cents (10 trillion major units).
 *
 * A ceiling is not cosmetic (audit A3). Cents cross IPC as a JSON number and
 * become a SQLite value in `src-tauri/src/db.rs`: an exact integer binds as
 * `INTEGER`, while anything a double cannot represent exactly binds as `REAL`.
 * Past 2^53 − 1 cents (~9.007 × 10^15) there is no such thing as an exact cent
 * in JavaScript, so the value would be stored as a float and every `SUM`,
 * comparison and CSV export over that column would drift.
 *
 * 10^15 is deliberate: comfortably below 2^53 − 1 so the multiply-and-add that
 * produces the cents is exact, and so far past any real balance in a personal
 * money app that the refusal only ever fires on a typo, a paste, or a crafted
 * payload.
 */
export const MAX_AMOUNT_CENTS = 1_000_000_000_000_000;

const AMOUNT_GRAMMAR_DIGITS = /^\d+$/;

/**
 * One grammar for amount input, shared by the parser and the mid-edit check.
 *
 * The whole part is either plain digits (`1234`) or comma-grouped thousands
 * (`1,234`, `12,345,678`). Grouping is strict: a comma must follow a digit, the
 * first group is one to three digits, and every later group is exactly three.
 * `"1,,2"`, `",5"`, `"1,2,3"`, `"1,2345"` and trailing commas are not amounts.
 *
 * `partial` is for a field the user is still typing. It allows the one group
 * that can grow (the final one may hold 0–3 digits, so `"1,2"` and `"1,"`
 * pass), a final empty fraction (`"12."`), and a leading fraction (`".5"`).
 * It never accepts a grammar the finished value could not reach: an empty
 * middle group or an over-long fraction is still wrong.
 */
function amountGrammar(raw: string, partial: boolean): boolean {
  const value = raw.trim();
  if (value.length === 0) return partial;
  // Only digits, separators and the decimal point belong in an amount.
  if (!/^[\d.,]+$/.test(value)) return false;
  const parts = value.split(".");
  if (parts.length > 2) return false;
  const whole = parts[0] ?? "";
  const fraction = parts[1];

  if (fraction !== undefined) {
    if (!/^\d{0,2}$/.test(fraction)) return false;
    if (fraction.length === 0 && !partial) return false;
  }
  // `.5` and `.` can only be midway through typing.
  if (whole.length === 0) return partial;

  const groups = whole.split(",");
  if (groups.length === 1) return AMOUNT_GRAMMAR_DIGITS.test(whole);

  const [first = ""] = groups;
  if (!/^\d{1,3}$/.test(first)) return false;
  for (let i = 1; i < groups.length; i += 1) {
    const group = groups[i] ?? "";
    const last = i === groups.length - 1;
    if (partial && last) {
      if (!/^\d{0,3}$/.test(group)) return false;
    } else if (!/^\d{3}$/.test(group)) {
      return false;
    }
  }
  return true;
}

/**
 * Parse user-typed major-unit input ("1,234.56") to integer cents at the
 * display edge. Accepts optional, correctly grouped thousands commas and up to
 * two decimals; anything else (empty, negative, ungrouped or misplaced commas,
 * malformed, or above {@link MAX_AMOUNT_CENTS}) is `null` — the same
 * invalid-input answer every form already renders as its normal "enter an
 * amount" error.
 *
 * The arithmetic is exact by construction: the digits are split and combined as
 * `BigInt` cents, so no double ever multiplies the amount. `Number(x) * 100`
 * used to lose cents for large inputs (and return a non-safe integer for
 * `"9007199254740993"`, which SQLite then stored as `REAL`).
 */
export function parseMMK(raw: string): number | null {
  const trimmed = raw.trim();
  if (!amountGrammar(trimmed, false)) return null;
  const normalized = trimmed.replace(/,/g, "");
  const [units = "", fraction = ""] = normalized.split(".");
  const cents = BigInt(units) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents > BigInt(MAX_AMOUNT_CENTS)) return null;
  return Number(cents);
}

/** Integer cents -> major units (number, for further logic — not display). */
export function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * True while `raw` could still become a valid amount with a few more
 * keystrokes. Lets the UI hold off on `aria-invalid` for "12." — which
 * `parseMMK` rejects — instead of flashing an error mid-edit.
 *
 * Reads the SAME grammar as `parseMMK`, so the two can no longer disagree about
 * a separator: a string this says is wrong can never parse successfully.
 */
export function isPartialAmount(raw: string): boolean {
  return amountGrammar(raw, true);
}

const MMK_FORMATS = new Map<Locale, Intl.NumberFormat>();

function mmkFormat(locale: Locale): Intl.NumberFormat {
  const cached = MMK_FORMATS.get(locale);
  if (cached !== undefined) return cached;
  const formatter = new Intl.NumberFormat(locale, {
    // Display money with Latin digits in every locale, so a
    // Burmese screen and an exported CSV use the same numerals.
    numberingSystem: "latn",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  MMK_FORMATS.set(locale, formatter);
  return formatter;
}

/**
 * Integer cents -> display string in major units, e.g. 1250000 -> "12,500.00".
 * Locale affects grouping only; the value and its two decimals do not change.
 */
export function formatMMK(cents: number, locale: Locale = getLocale()): string {
  return mmkFormat(locale).format(fromCents(cents));
}

/**
 * Outstanding balance, never negative. Used wherever a promised or
 * partially-paid amount must not become negative income/expense.
 */
export function outstandingCents(
  totalCents: number,
  paidCents: number,
): number {
  return Math.max(0, totalCents - paidCents);
}

/**
 * Apply a payment without overpaying: the paid total never exceeds the total,
 * and the returned applied amount is what actually counted (cash basis —
 * only cash that arrived is recorded).
 */
export function applyPayment(
  totalCents: number,
  paidCents: number,
  paymentCents: number,
): { newPaidCents: number; appliedCents: number } {
  const room = outstandingCents(totalCents, paidCents);
  const appliedCents = Math.max(0, Math.min(paymentCents, room));
  return { newPaidCents: paidCents + appliedCents, appliedCents };
}
