// Money lib (§4): integer cents in DB and in logic; major units (MMK) only at
// display/parse edges. Cash-basis rule (§2.1): outstanding amounts are never
// negative — promises and unpaid balances are never income.

/** Major units -> integer cents (§4: `toCents = Math.round(v*100)`). */
export function toCents(major: number): number {
  return Math.round(major * 100);
}

const AMOUNT_INPUT = /^\d+(?:\.\d{1,2})?$/;

/**
 * Parse user-typed major-unit input ("1,234.56") to integer cents at the
 * display edge (§4). Accepts optional thousands commas and up to two
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

const MMK_FORMAT = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Integer cents -> display string in major units, e.g. 1250000 -> "12,500.00". */
export function formatMMK(cents: number): string {
  return MMK_FORMAT.format(fromCents(cents));
}

/**
 * Outstanding balance, never negative (§4). Used wherever a promised or
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
