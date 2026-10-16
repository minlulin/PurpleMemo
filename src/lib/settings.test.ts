// Settings repository (§2.8/§2.9). This module had no test file, which
// mattered: `getJSON` collapses "no row" and "unparseable JSON" into a single
// null, and the lock shell's fail-closed rule depends on telling those apart
// (review C-3). `getRaw` is the seam that preserves the difference, so both
// behaviours are pinned here.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMockDriver } from "../data/mock-driver.ts";
import { createSettingsRepo, SETTING_KEYS } from "./settings.ts";

test("getRaw: undefined when the row does not exist", async () => {
  const driver = createMockDriver({ results: [[]] });
  const settings = createSettingsRepo(driver);
  assert.equal(await settings.getRaw(SETTING_KEYS.pinHash), undefined);
});

test("getRaw: the unparsed value when the row does exist", async () => {
  const driver = createMockDriver({ results: [[{ value: '{"a":1}' }]] });
  const settings = createSettingsRepo(driver);
  assert.equal(await settings.getRaw(SETTING_KEYS.pinHash), '{"a":1}');
});

test("getRaw: a corrupt value comes back intact rather than as null", async () => {
  // The whole point: `classifyPin` must be able to see that SOMETHING is
  // stored here, even though it cannot be parsed.
  const driver = createMockDriver({ results: [[{ value: "not json" }]] });
  const settings = createSettingsRepo(driver);
  const raw = await settings.getRaw(SETTING_KEYS.pinHash);
  assert.equal(raw, "not json");
});

test("getJSON: no row and unparseable JSON both read as null", async () => {
  // Documented, unchanged behaviour — and exactly why the lock shell must NOT
  // use getJSON for the PIN. Pinned so the difference cannot be "tidied away".
  const absent = createMockDriver({ results: [[]] });
  assert.equal(
    await createSettingsRepo(absent).getJSON(SETTING_KEYS.pinHash),
    null,
  );
  const corrupt = createMockDriver({ results: [[{ value: "not json" }]] });
  assert.equal(
    await createSettingsRepo(corrupt).getJSON(SETTING_KEYS.pinHash),
    null,
  );
});

test("setJSON upserts on the settings primary key", async () => {
  const driver = createMockDriver();
  await createSettingsRepo(driver).setJSON(SETTING_KEYS.theme, "light");
  const call = driver.lastCall();
  assert.ok(call, "setJSON must record an execute call");
  const [sql] = call.args as [string, unknown[]];
  // A plain INSERT would fail on the second write to the same key.
  assert.match(sql, /ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value/);
});

test("setManyJSON writes every entry as one batch of upserts", async () => {
  const driver = createMockDriver();
  await createSettingsRepo(driver).setManyJSON([
    { key: SETTING_KEYS.pinHash, value: { salt: "s" } },
    { key: SETTING_KEYS.securityQuestion, value: "First pet?" },
  ]);
  const batches = driver.callsTo("batch");
  assert.equal(batches.length, 1);
  const statements = batches[0]?.args[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(statements.length, 2);
  for (const s of statements) {
    assert.match(s.sql, /ON CONFLICT\(key\) DO UPDATE/);
  }
});
