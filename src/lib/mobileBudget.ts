// The phone Budget screen's rules, kept out of the React tree so they can be
// pinned by tests.
//
// Decision 4 (docs/ANDROID_DESIGN.md): Budget is append-only on the phone —
// the surface can create entries, never edit or delete them. These helpers
// describe the numbers that surface shows and when its create form may submit.

/**
 * The recorded balance: the sum of the wallet balances the records produce.
 *
 * Deliberately a plain sum with no opening-balance column and no fallback —
 * the F9 decision says the Dashboard may only show what the records say. No
 * wallets at all sums to 0, and the screen then shows its guided empty state
 * instead of a figure, because a wallet list that does not exist is not a
 * balance of zero.
 */
export function recordedBalanceCents(
  balances: { balanceCents: number }[],
): number {
  return balances.reduce((sum, wallet) => sum + wallet.balanceCents, 0);
}

export interface EntryFormState {
  amountCents: number | null;
  walletId: number | null;
  categoryId: number | null;
}

/**
 * True when a ledger entry may be saved: a positive amount and real wallet and
 * category rows. The ids are the ones the form read from the database, so an
 * entry can never reference a wallet or category that does not exist.
 */
export function entryFormReady(state: EntryFormState): boolean {
  return (
    state.amountCents !== null &&
    state.amountCents > 0 &&
    state.walletId !== null &&
    state.categoryId !== null
  );
}
