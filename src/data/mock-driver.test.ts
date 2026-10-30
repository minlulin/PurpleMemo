import { strict as assert } from "node:assert";
import { test } from "node:test";

import { first } from "../test-utils.ts";
import { createMockDriver, thumbPath } from "./mock-driver.ts";

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

test("a scripted string error is thrown as an Error with that message (J4)", async () => {
  // `MockScript.error` accepts a bare string for the common case: the
  // message is usually all a test cares about.
  const driver = createMockDriver({ error: "disk full", batchError: "nope" });
  await assert.rejects(driver.query("SELECT 1"), /disk full/);
  await assert.rejects(
    driver.batch([{ sql: "UPDATE a SET x = ?", params: [1] }]),
    /nope/,
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
  // D1-1: content-addressed like Rust — sha256 of [1,2,3], lowercased ext.
  const rel = await driver.savePhoto(Uint8Array.from([1, 2, 3]), "jpg");
  assert.equal(
    rel,
    "photos/2026/10/039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81.jpg",
  );
  // Photo bytes are Uint8Array on both sides of the driver.
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
  // P3-16: the thumb is ALWAYS `.thumb.jpg` (the encoder writes JPEG), never
  // the source's extension — and the stem is the source's sha256.
  const thumb = await driver.savePhotoThumb(rel, Uint8Array.from([7, 7]));
  assert.equal(
    thumb,
    "photos/2026/10/4bf5122f344554c53bde2ebb8cd2b7e3d1600ad631c385a5d7cce23c7785459a.thumb.jpg",
  );
  assert.deepEqual(await driver.readPhotoThumb(rel), Uint8Array.from([7, 7]));
  await driver.deletePhoto(rel);
  await assert.rejects(driver.readPhotoThumb(rel), /no thumbnail/);
});

test("savePhoto lowercases the extension and refuses one Rust would refuse (D1-1)", async () => {
  const driver = createMockDriver();
  const upper = await driver.savePhoto(Uint8Array.from([1, 2, 3]), "JPG");
  assert.equal(
    upper,
    "photos/2026/10/039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81.jpg",
    "the stored ext is the lowercased one, on the same content-addressed path",
  );
  for (const ext of ["", "toolongext", "jp g", "j.pg", "j-pg"]) {
    await assert.rejects(
      () => driver.savePhoto(Uint8Array.from([1]), ext),
      /1-8 lowercase letters\/digits expected/,
      `ext ${JSON.stringify(ext)} must be refused like photos.rs refuses it`,
    );
  }
});

test("thumbPath: always .thumb.jpg, and malformed sources are refused (D1-1)", () => {
  const hash = "a".repeat(64);
  assert.equal(
    thumbPath(`photos/2026/10/${hash}.png`),
    `photos/2026/10/${hash}.thumb.jpg`,
    "the source ext is parsed but never used — the encoder writes JPEG",
  );
  for (const bad of [
    "photos/2026/10/jpg.3", // the old synthetic grammar: not a 64-hex stem
    `photos/2026/10/${"a".repeat(63)}.jpg`, // wrong hash length
    `photos/2026/13/${hash}.jpg`, // month out of range
    `photos/2026/10/${hash}.tar.gz`, // multi-dot ext
    "2026/10/" + hash + ".jpg", // no photos/ prefix
    `photos/2026/${hash}.jpg`, // missing a segment
  ]) {
    assert.throws(
      () => thumbPath(bad),
      /invalid photo path/,
      `${bad} is not a valid source path`,
    );
  }
});

test("thumbnails are keyed per photo: one delete does not clear its sibling (J4)", async () => {
  const driver = createMockDriver();
  const a = await driver.savePhoto(Uint8Array.from([1]), "jpg");
  const b = await driver.savePhoto(Uint8Array.from([2]), "jpg");
  await driver.savePhotoThumb(a, Uint8Array.from([7, 7]));
  await driver.savePhotoThumb(b, Uint8Array.from([8, 8]));
  await driver.deletePhoto(a);
  await assert.rejects(driver.readPhotoThumb(a), /no thumbnail/);
  assert.deepEqual(
    await driver.readPhotoThumb(b),
    Uint8Array.from([8, 8]),
    "the surviving photo keeps its own thumbnail",
  );
});

test("the import window opens at the safety copy and refuses writers without its lease (J4)", async () => {
  const driver = createMockDriver();
  await driver.safetyBackupCopy("label");
  // Rust IMPORT_BLOCKED's own words: the write did not happen, and the
  // message says so.
  const refused =
    /an import is replacing this app's data — this write was refused/;
  await assert.rejects(driver.execute("UPDATE a SET x = 1"), refused);
  await assert.rejects(
    driver.batch([{ sql: "UPDATE a SET x = ?", params: [1] }]),
    refused,
  );
  await assert.rejects(driver.savePhoto(Uint8Array.from([1]), "jpg"), refused);
  await assert.rejects(driver.deletePhoto("photos/2026/10/x.jpg"), refused);

  // The import attaches to the SAME window (same lease), and its writes
  // thread that lease through every writer.
  const lease = await driver.beginImportLease?.();
  assert.equal(typeof lease, "number");
  await driver.execute("UPDATE a SET x = 1", undefined, lease);
  await driver.batch([{ sql: "UPDATE a SET x = ?", params: [1] }], lease);
  const rel = await driver.savePhoto(Uint8Array.from([1]), "jpg", lease);
  await driver.deletePhoto(rel, lease);

  // A wrong lease is refused exactly like no lease; the window is closed
  // only by the exact lease it handed out.
  await assert.rejects(async () => {
    await driver.endImportLease?.((lease ?? 0) + 1);
  }, /no import window is open for that lease/);
  await assert.rejects(
    () => driver.execute("UPDATE a SET x = 1", undefined, (lease ?? 0) + 1),
    refused,
  );
  await driver.endImportLease?.(lease as number);
  // Closed: ordinary writes flow again, and the stale lease is harmless.
  await driver.execute("UPDATE a SET x = 1");
  await driver.execute("UPDATE a SET x = 1", undefined, lease);
});

test("beginImportLease opens a window when the safety copy never ran, and is monotonic (J4)", async () => {
  const driver = createMockDriver();
  const initial = await driver.beginImportLease?.();
  assert.equal(
    await driver.beginImportLease?.(),
    initial,
    "attaching returns the SAME lease — one window, not two",
  );
  await driver.endImportLease?.(initial as number);
  const second = await driver.beginImportLease?.();
  assert.notEqual(second, initial, "a new window gets a fresh, higher lease");
});

test("a lease is recorded in the call args only when the caller sent one (J4)", async () => {
  // Repository tests deep-equal exact arg arrays like [sql, params]; the
  // lease may only appear when it was actually threaded.
  const driver = createMockDriver();
  await driver.execute("UPDATE a SET x = 1", [1]);
  await driver.execute("UPDATE a SET x = 1", [1], 5);
  await driver.batch([{ sql: "UPDATE a SET x = ?", params: [1] }], 5);
  await driver.deletePhoto("photos/2026/10/x.jpg", 5);
  assert.deepEqual(
    driver.callsTo("execute").map((c) => c.args),
    [
      ["UPDATE a SET x = 1", [1]],
      ["UPDATE a SET x = 1", [1], 5],
    ],
  );
  assert.deepEqual(driver.callsTo("batch")[0]?.args[1], 5);
  assert.deepEqual(driver.callsTo("deletePhoto")[0]?.args, [
    "photos/2026/10/x.jpg",
    5,
  ]);
});

test("the manual-transaction flag refuses the misuses Rust refuses (J4)", async () => {
  const driver = createMockDriver();
  await driver.begin();
  await assert.rejects(driver.begin(), /a transaction is already open/);
  await assert.rejects(
    driver.batch([{ sql: "UPDATE a SET x = ?", params: [1] }]),
    /db_batch is not allowed while a manual transaction is open/,
  );
  await driver.commit();
  await assert.rejects(driver.commit(), /no open transaction to commit/);
  await assert.rejects(driver.rollback(), /no open transaction to roll back/);
  // resetTxn is the idempotent break-glass: it clears the flag whether or
  // not a transaction is open, and a batch flows again afterwards.
  await driver.resetTxn();
  await driver.resetTxn();
  await driver.batch([{ sql: "UPDATE a SET x = ?", params: [1] }]);
});

test("shareStart burns the armed token on EVERY attempt, matched or not (J4)", async () => {
  const driver = createMockDriver();
  await assert.rejects(
    driver.shareStart("consent-1"),
    /must be confirmed first/,
    "a token nobody armed is refused",
  );
  const token = await driver.shareArm();
  await assert.rejects(
    driver.shareStart("consent-999"),
    /must be confirmed first/,
    "a wrong token is refused",
  );
  // ...and the REAL token was burned by that failed probe: the security
  // choice in Rust take_consent — a mismatch costs the arming, so guessing
  // is not an oracle.
  await assert.rejects(
    driver.shareStart(token),
    /must be confirmed first/,
    "the armed token was consumed by the failed attempt",
  );
  const fresh = await driver.shareArm();
  assert.equal((await driver.shareStart(fresh)).running, true);
});

test("an ordinary stop leaves the armed token alive; a lock's stop revokes it (J4)", async () => {
  const driver = createMockDriver();
  await driver.shareArm();
  await driver.shareStop();
  const token = await driver.shareArm();
  await driver.shareStop(true);
  await assert.rejects(
    driver.shareStart(token),
    /must be confirmed first/,
    "stopForLock revokes consent — locking ends sharing, token included",
  );
});

const SNAPSHOT = JSON.stringify({
  version: 1,
  generatedAt: "2026-10-20T10:00:00.000Z",
  nonce: "abc",
  ciphertext: "def",
});

test("sharePublish validates the envelope like parse_snapshot, even when stopped (J4)", async () => {
  const driver = createMockDriver();
  for (const [bad, pattern] of [
    ["not json", /not valid JSON/],
    ["[]", /must be a JSON object/],
    [
      JSON.stringify({
        version: 2,
        generatedAt: "x",
        nonce: "a",
        ciphertext: "b",
      }),
      /unsupported encrypted snapshot version/,
    ],
    [
      JSON.stringify({ generatedAt: "x", nonce: "a", ciphertext: "b" }),
      /missing its numeric version/,
    ],
    [
      JSON.stringify({ version: 1, nonce: "a", ciphertext: "b" }),
      /missing its generatedAt/,
    ],
    [
      JSON.stringify({ version: 1, generatedAt: "x", ciphertext: "b" }),
      /missing nonce/,
    ],
    [
      JSON.stringify({ version: 1, generatedAt: "x", nonce: "a" }),
      /missing ciphertext/,
    ],
    [
      JSON.stringify({
        version: 1,
        generatedAt: "x",
        nonce: "",
        ciphertext: "b",
      }),
      /missing nonce/,
    ],
  ] as const) {
    await assert.rejects(
      () => driver.sharePublish(bad),
      pattern,
      "a malformed envelope is a refusal, not the stopped no-op",
    );
  }
});

test("sharePublish while running stamps generatedAt; while stopped it stores nothing (J4)", async () => {
  const driver = createMockDriver();
  // Stopped: valid envelope, and the publish is the off-sharing no-op —
  // `publishedAt` stays null and nothing is remembered.
  const stopped = await driver.sharePublish(SNAPSHOT);
  assert.equal(stopped.publishedAt, null);
  assert.equal((await driver.shareStatus()).publishedAt, null);

  const token = await driver.shareArm();
  await driver.shareStart(token);
  const running = await driver.sharePublish(SNAPSHOT);
  assert.equal(running.publishedAt, "2026-10-20T10:00:00.000Z");
  assert.equal(
    (await driver.shareStatus()).publishedAt,
    "2026-10-20T10:00:00.000Z",
  );
});
