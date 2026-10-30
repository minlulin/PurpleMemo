// Type-safe accessors for tests under `noUncheckedIndexedAccess` —
// runtime-checked, so no non-null assertions are needed anywhere.

import { strict as assert } from "node:assert";
import type { DataDriver, Queryable } from "./data/driver.ts";

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

/**
 * A copy of `base` whose `query` holds every call at a gate until
 * `release()` (J3's serialization tests). The first caller suspends
 * mid-critical-section — long enough to start a second, concurrent
 * operation — so a missing lock shows up as the second caller racing
 * ahead instead of queueing behind the first.
 */
export function gatedQueryDriver<T extends DataDriver>(
  base: T,
): {
  driver: T;
  release: () => void;
} {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const driver = {
    ...base,
    query: <R extends Queryable>(sql: string, params?: unknown[]) =>
      gate.then(() => base.query<R>(sql, params)),
  };
  return { driver: driver as unknown as T, release };
}

/** Let queued microtasks and timers run — for asserting "has not happened yet". */
export function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
