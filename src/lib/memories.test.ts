// Memories repository: partial updates write only the provided fields.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMockDriver } from "../data/mock-driver.ts";
import { createMemoriesRepo, shiftYearMonth } from "./memories.ts";

test("updateMemory writes only the provided fields (no NULL wipe)", async () => {
  const driver = createMockDriver();
  const memories = createMemoriesRepo(driver);
  await memories.updateMemory(2, { note: "rainy day" });
  const call = driver.lastCall();
  assert.ok(call);
  const [sql, params] = call.args as [string, unknown[]];
  assert.match(sql, /UPDATE memories SET note = \? WHERE id = \?/);
  assert.deepEqual(params, ["rainy day", 2]);
});

test("shiftYearMonth: steps forward and backward across year boundaries", () => {
  assert.equal(shiftYearMonth("2026-10", 1), "2026-11");
  assert.equal(shiftYearMonth("2026-12", 1), "2027-01");
  assert.equal(shiftYearMonth("2026-01", -1), "2025-12");
  assert.equal(shiftYearMonth("2026-10", -3), "2026-07");
});

test("shiftYearMonth: invalid input falls through unchanged", () => {
  assert.equal(shiftYearMonth("banana", 1), "banana");
  assert.equal(shiftYearMonth("2026", 1), "2026");
  assert.equal(shiftYearMonth("", 1), "");
});
