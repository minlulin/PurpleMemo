// Money lib: integer cents in DB and in logic; major units (MMK) only at
// display/parse edges. Cash-basis rule: outstanding amounts are never
// negative — promises and unpaid balances are never income.

import { getLocale, type Locale } from "./i18n.ts";

/** Major units -> integer cents (`toCents = Math.round(v*100)`). */
export function toCents(major: number): number {
  return Math.round(major * 100);
}

const AMOUNT_INPUT = /^\d+(?:\.\d{1,2})?$/;

/**
 * Parse user-typed major-unit input ("1,234.56") to integer cents at the
 * display edge. Accepts optional thousands commas and up to two
 * decimals; anything else (empty, negative, malformed) is `null`.
 */
export function parseMMK(raw: string): number | null {
  const normalized = raw.trim().replace(/,/g, "");
  if (!AMOUNT_INPUT.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

/** Integer cents -> major units (number, for further logic — not display). */
export function fromCents(cents: number): number {
  return cents / 100;
}

// A half-typed amount: "12" or "12." or "12.5" are all still on the way to a
// valid number, so a field must not call them wrong while the user types.
const AMOUNT_IN_PROGRESS = /^\d*\.?\d{0,2}$/;

/**
 * True while `raw` could still become a valid amount with a few more
 * keystrokes. Lets the UI hold off on `aria-invalid` for "12." — which
 * `parseMMK` rejects — instead of flashing an error mid-edit.
 */
export function isPartialAmount(raw: string): boolean {
  return AMOUNT_IN_PROGRESS.test(raw.trim().replace(/,/g, ""));
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
