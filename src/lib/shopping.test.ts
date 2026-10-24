import { strict as assert } from "node:assert";
import { test } from "node:test";
import { moveItem } from "./shopping.ts";

test("moveItem: swaps an item with its neighbor, bounds are no-ops", () => {
  assert.deepEqual(moveItem([1, 2, 3], 0, "up"), [1, 2, 3], "top stays");
  assert.deepEqual(moveItem([1, 2, 3], 2, "down"), [1, 2, 3], "bottom stays");
  assert.deepEqual(moveItem([1, 2, 3], 0, "down"), [2, 1, 3]);
  assert.deepEqual(moveItem([1, 2, 3], 2, "up"), [1, 3, 2]);
  assert.deepEqual(moveItem([1], 0, "up"), [1]);
});
