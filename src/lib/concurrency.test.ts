import { strict as assert } from "node:assert";
import { test } from "node:test";

import { mapConcurrent } from "./concurrency.ts";

test("mapConcurrent preserves input order", async () => {
  const out = await mapConcurrent([3, 1, 2], 2, async (n) => {
    await new Promise((resolve) => setTimeout(resolve, n));
    return n * 10;
  });
  assert.deepEqual(out, [30, 10, 20]);
});

test("mapConcurrent never exceeds its limit", async () => {
  let inFlight = 0;
  let peak = 0;
  await mapConcurrent(
    Array.from({ length: 12 }, (_, i) => i),
    3,
    async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return null;
    },
  );
  assert.equal(peak, 3);
});

test("mapConcurrent handles an empty list", async () => {
  assert.deepEqual(await mapConcurrent([], 4, async (n) => n), []);
});

test("mapConcurrent clamps a nonsensical limit instead of stalling", async () => {
  assert.deepEqual(await mapConcurrent([1, 2], 0, async (n) => n + 1), [2, 3]);
});

test("mapConcurrent rejects with the first failure", async () => {
  await assert.rejects(
    mapConcurrent([1, 2, 3], 1, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    }),
    /boom/,
  );
});
