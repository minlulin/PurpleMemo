// Memories repository: partial updates write only the provided fields.
// Month navigation lives in dates.ts (shiftYearMonth) and is tested there.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMockDriver } from "../data/mock-driver.ts";
import { createMemoriesRepo } from "./memories.ts";

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
