import { strict as assert } from "node:assert";
import { test } from "node:test";

import { first } from "../test-utils.ts";
import { createMockDriver } from "./mock-driver.ts";

test("mock driver records calls and returns canned query results FIFO", async () => {
  const driver = createMockDriver({ results: [[{ id: 1 }], [{ id: 2 }]] });
  const rows = await driver.query("SELECT 1");
  assert.deepEqual(rows, [{ id: 1 }]);
  assert.deepEqual(await driver.query("SELECT 2"), [{ id: 2 }]);
  assert.deepEqual(
    await driver.query("SELECT 3"),
    [],
    "script exhausted -> empty",
  );
  assert.equal(driver.callsTo("query").length, 3);
});

test("mock driver returns the scripted execute outcome and auto rowids", async () => {
  const driver = createMockDriver({
    outcome: { rowsAffected: 1, lastInsertRowid: 42 },
  });
  const outcome = await driver.execute("INSERT INTO t VALUES (?)", [7]);
  assert.deepEqual(outcome, { rowsAffected: 1, lastInsertRowid: 42 });
  const next = await driver.execute("INSERT INTO t VALUES (?)", [8]);
  assert.equal(
    next.lastInsertRowid,
    43,
    "auto rowids increment after the script",
  );
  assert.deepEqual(first(driver.callsTo("execute"), "execute").args, [
    "INSERT INTO t VALUES (?)",
    [7],
  ]);
});

test("mock driver surfaces a scripted error once, then recovers", async () => {
  const driver = createMockDriver({ error: new Error("db down") });
  await assert.rejects(driver.query("SELECT 1"), /db down/);
  assert.deepEqual(
    await driver.query("SELECT 1"),
    [],
    "error consumed exactly once",
  );
});

test("mock driver records batch/begin/commit/rollback and photo calls", async () => {
  const driver = createMockDriver();
  await driver.batch([
    { sql: "UPDATE a SET x = ?", params: [1] },
    { sql: "UPDATE b SET y = ?", params: [2] },
  ]);
  await driver.begin();
  await driver.commit();
  const rel = await driver.savePhoto(Uint8Array.from([1, 2, 3]), "jpg");
  assert.equal(rel, "photos/2026/10/jpg.3");
  // Photo bytes are Uint8Array on both sides of the driver (review M-02).
  assert.deepEqual(await driver.readPhoto(rel), Uint8Array.from([1, 2, 3]));
  await driver.deletePhoto(rel);
  assert.equal(driver.callsTo("batch").length, 1);
  assert.equal(driver.callsTo("begin").length, 1);
  assert.equal(driver.callsTo("savePhoto").length, 1);
});

test("mock driver mirrors the thumbnail contract: missing thumb rejects, saved thumb reads back", async () => {
  const driver = createMockDriver();
  const rel = await driver.savePhoto(Uint8Array.from([1]), "jpg");
  await assert.rejects(
    driver.readPhotoThumb(rel),
    /no thumbnail/,
    "no stored thumbnail is an error the caller answers by generating one",
  );
  const thumb = await driver.savePhotoThumb(rel, Uint8Array.from([7, 7]));
  assert.equal(thumb, "photos/2026/10/jpg.thumb.1");
  assert.deepEqual(await driver.readPhotoThumb(rel), Uint8Array.from([7, 7]));
  await driver.deletePhoto(rel);
  await assert.rejects(driver.readPhotoThumb(rel), /no thumbnail/);
});
