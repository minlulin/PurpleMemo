// Type-safe accessors for tests under `noUncheckedIndexedAccess` (§7) —
// runtime-checked, so no non-null assertions are needed anywhere.

import { strict as assert } from "node:assert";

/** `items[index]` with a readable failure instead of `undefined`. */
export function at<T>(
  items: { [index: number]: T },
  index: number,
  what: string,
): T {
  const item = items[index];
  assert.ok(item !== undefined, `${what}[${index}] is missing`);
  return item;
}

/** The first element of a list, with a readable failure instead of `undefined`. */
export function first<T>(items: { [index: number]: T }, what: string): T {
  return at(items, 0, what);
}
