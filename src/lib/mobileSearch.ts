// The phone's search allowlist (design §2: Gallery, Contacts, Journal and
// Memories are desktop-only, so no mobile surface may show their data).
//
// The desktop search contract already refuses the vault, settings, photos and
// money, but it *includes* contacts, journal entries, memories, jobs, payables,
// loans and shopping items — all legitimate on the desktop. The phone is
// narrower by design, so it does not filter results after the fact: it tells
// the engine which entities to query, which means an excluded table is never
// read at all. Filtering afterwards would still have put the rows on the IPC
// wire, and a filter is one refactor away from being dropped.

import type { DataDriver } from "../data/driver.ts";
import {
  globalSearch,
  type SearchGroup,
  type SearchOptions,
} from "./globalSearch.ts";

/**
 * The only entities the phone may search.
 *
 * Phase A ships Notes and Tasks; Shopping joins when its search surface does.
 * Everything else — including the excluded modules — stays on the desktop.
 */
export const MOBILE_SEARCH_TYPES = ["note", "task"] as const;

/** True when a result type may be shown on the phone. */
export function isMobileSearchType(
  type: string,
): type is (typeof MOBILE_SEARCH_TYPES)[number] {
  return (MOBILE_SEARCH_TYPES as readonly string[]).includes(type);
}

/**
 * Search, scoped to the phone's allowlist.
 *
 * `types` is not accepted from the caller: letting a caller pass its own list
 * would make the allowlist advisory. Callers may pass every other option.
 */
export function mobileSearch(
  driver: DataDriver,
  input: string,
  options: Omit<SearchOptions, "types"> = {},
): Promise<SearchGroup[]> {
  return globalSearch(driver, input, {
    ...options,
    types: [...MOBILE_SEARCH_TYPES],
  });
}
