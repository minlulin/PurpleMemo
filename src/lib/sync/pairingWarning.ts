/**
 * The line the pairing card shows before Trust (F1 Task 2).
 *
 * Pairing with a desktop this phone has never pinned is ordinary. Doing it
 * WHILE this phone still holds records of its own is the case worth saying out
 * loud: those records stay and merge with whatever the other desktop holds, so
 * someone who wanted a clean start has to clear this phone first (Settings →
 * Reset Purple Memo). The line informs only — nothing here changes what
 * pairing does.
 *
 * Both halves are kept out of the card so the spec's three cases can be unit
 * tests rather than DOM shapes (`node --test` cannot mount JSX, and this
 * project has no React testing library):
 *
 *   - `warnBeforeTrust` is the policy: three facts in, one boolean out, no I/O.
 *   - `holdsLocalData` is the read behind the third fact. A fresh install does
 *     NOT hold data — `BASELINE_SQL` (schema.rs) seeds five wallets and eleven
 *     categories into every new database — so the shipped seeds are subtracted
 *     rather than counted, and `settings` (preferences, the app PIN) is not a
 *     record a merge would touch.
 */
import type { DataDriver } from "../../data/driver.ts";
import { BACKUP_TABLES } from "../backup.ts";

/** What the card knows while an offer is on screen. */
export interface TrustWarningInput {
  /** The desktop this session would pair with — `offer.deviceId`, or null. */
  offerDeviceId: string | null;
  /** Every desktop this phone pins (`sync_peers`) — the identities it holds. */
  pinnedDeviceIds: readonly string[];
  /** Whether this phone holds records of its own — `holdsLocalData`. */
  holdsLocalData: boolean;
}

/**
 * Does the card owe the person that line before Trust?
 *
 * Refusals in the order the spec names them: with no offer there is nothing to
 * warn about; with no pin there is no OTHER identity to differ from (a first
 * pairing is not a different desktop); a pin matching the offer means this is
 * the identity already trusted. Only then does this phone's own data decide
 * it — the warning never appears on a phone with nothing to keep.
 */
export function warnBeforeTrust(input: TrustWarningInput): boolean {
  if (input.offerDeviceId === null) return false;
  if (input.pinnedDeviceIds.length === 0) return false;
  if (input.pinnedDeviceIds.includes(input.offerDeviceId)) return false;
  return input.holdsLocalData;
}

/**
 * The tables a fresh install already has rows in, and how many.
 *
 * `BASELINE_SQL` seeds these once — deletions stick and nothing re-seeds — so
 * a phone that deleted all five seeded wallets is still empty, while one that
 * added a sixth holds data. The counts are pinned to the real schema by the
 * test that opens `openBaselineStore()` and expects `false`.
 */
const SHIPPED_SEEDS = new Map<string, number>([
  ["wallets", 5],
  ["expense_categories", 7],
  ["income_categories", 4],
]);

/**
 * The backup tables that are the person's own records.
 *
 * `settings` is left out deliberately: theme, locale and the app PIN describe
 * the installation, not data a merge would carry.
 */
const DATA_TABLES = BACKUP_TABLES.filter((table) => table !== "settings");

/**
 * One round trip: how many rows this phone holds beyond what it shipped with.
 *
 * Table names come from `BACKUP_TABLES`, never from input, so the string is
 * safe to interpolate exactly as `backup.ts` interpolates it.
 */
function localDataCountSql(): string {
  const terms = DATA_TABLES.map((table) => {
    const shipped = SHIPPED_SEEDS.get(table);
    return shipped === undefined
      ? `(SELECT COUNT(*) FROM ${table})`
      : `max(0, (SELECT COUNT(*) FROM ${table}) - ${shipped})`;
  });
  return `SELECT ${terms.join(" + ")} AS held`;
}

/**
 * Does this phone hold records of its own?
 *
 * False on a fresh install, false once only preferences exist, and false when
 * the count cannot be read: the line this feeds is advisory, and a card that
 * failed to count must still be able to pair.
 */
export async function holdsLocalData(driver: DataDriver): Promise<boolean> {
  try {
    const rows = await driver.query<{ held: number | string }>(
      localDataCountSql(),
    );
    return Number(rows[0]?.held ?? 0) > 0;
  } catch {
    return false;
  }
}
