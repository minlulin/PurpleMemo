// Backup (§8): export reads every data table (never the trigger-maintained
// notes_fts index) plus photo bytes; the zip holds backup.json + the photos/
// tree; import validates the app marker, upgrades by file version, writes photo
// files first (so a failure leaves the DB untouched), then replaces all data
// in one batch with FK off (table order irrelevant), restoring FK on after.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { zipSync } from "fflate";
import type { Queryable } from "../data/driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import { first } from "../test-utils.ts";
import {
  applyBackup,
  BACKUP_APP,
  BACKUP_FORMAT_VERSION,
  BACKUP_JSON_ENTRY,
  BACKUP_TABLES,
  type BackupPayload,
  type BackupPhotoEntry,
  buildBackupZip,
  type ParsedBackup,
  parseBackupZip,
  readBackupData,
  summarizeBackup,
} from "./backup.ts";

const NOTE_ROW = {
  id: 1,
  title: "hello",
  content: "world",
  tags: "a,b",
  collection_id: null,
  pinned: 0,
  archived: 0,
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
};

const PHOTO_ROW = {
  id: 1,
  rel_path: "photos/2026/10/aaa.jpg",
  sha256: "aa",
  ext: "jpg",
  size_bytes: 3,
  taken_date: null,
  note: "",
  created_at: "2026-01-01",
};

function samplePayload(): BackupPayload {
  return {
    app: BACKUP_APP,
    version: BACKUP_FORMAT_VERSION,
    exportedAt: "2026-10-12T03:00:00.000Z",
    data: { notes: [NOTE_ROW], photos: [PHOTO_ROW] },
  };
}

function samplePhotos(): BackupPhotoEntry[] {
  return [{ path: "photos/2026/10/aaa.jpg", bytes: [9, 9, 9] }];
}

test("BACKUP_TABLES covers the 28 data tables and excludes the derived notes_fts index", () => {
  assert.equal(BACKUP_TABLES.length, 28);
  assert.ok(!BACKUP_TABLES.includes("notes_fts"));
  assert.ok(BACKUP_TABLES.includes("notes"));
  assert.ok(BACKUP_TABLES.includes("photos"));
  assert.ok(BACKUP_TABLES.includes("settings"));
});

test("readBackupData queries each table once, reads photo bytes, stamps the manifest", async () => {
  // One canned result per query, in call order: 28 table reads, then the
  // photos path lookup. (Hand-counting this list is how you get off-by-one.)
  const tableResults: Queryable[][] = BACKUP_TABLES.map((t) =>
    t === "collections" ? [{ id: 2, name: "Work" }] : [],
  );
  tableResults.push([PHOTO_ROW]);
  const driver = createMockDriver({ results: tableResults });
  const { payload, photos } = await readBackupData(driver);
  assert.equal(payload.app, BACKUP_APP);
  assert.equal(payload.version, BACKUP_FORMAT_VERSION);
  assert.equal(typeof payload.exportedAt, "string");
  assert.deepEqual(payload.data.collections, [{ id: 2, name: "Work" }]);
  assert.deepEqual(photos, [
    { path: "photos/2026/10/aaa.jpg", bytes: [1, 2, 3] }, // mock readPhoto bytes
  ]);
  const queries = driver.callsTo("query").map((c) => c.args[0] as string);
  assert.equal(queries.length, 29); // 28 tables + the photos path lookup
  for (const table of BACKUP_TABLES) {
    assert.ok(
      queries.includes(`SELECT * FROM ${table}`),
      `expected a SELECT from ${table}`,
    );
  }
  assert.ok(
    !queries.some((sql) => sql.includes("notes_fts")),
    "the trigger-maintained FTS index is derived data — never backed up",
  );
  const readCalls = driver.callsTo("readPhoto");
  assert.deepEqual(readCalls[0]?.args, ["photos/2026/10/aaa.jpg"]);
});

test("buildBackupZip + parseBackupZip roundtrip payload and photos tree", () => {
  const parsed = parseBackupZip(
    buildBackupZip(samplePayload(), samplePhotos()),
  );
  assert.deepEqual(parsed.payload, samplePayload());
  assert.deepEqual(parsed.photos, samplePhotos());
});

test("parseBackupZip rejects bytes that are not a zip", () => {
  assert.throws(
    () => parseBackupZip(new Uint8Array([1, 2, 3, 4])),
    /not a valid zip/i,
  );
});

test("parseBackupZip rejects a zip without backup.json", () => {
  const zip = zipSync({ "photos/2026/10/x.jpg": new Uint8Array([1]) });
  assert.throws(() => parseBackupZip(zip), /backup\.json/);
});

test("parseBackupZip rejects a corrupt backup.json", () => {
  const zip = zipSync({
    [BACKUP_JSON_ENTRY]: new TextEncoder().encode("{nope"),
  });
  assert.throws(() => parseBackupZip(zip), /JSON/);
});

test("parseBackupZip rejects files not made by this app", () => {
  const foreign = { ...samplePayload(), app: "someone-elses-backup" };
  const zip = zipSync({
    [BACKUP_JSON_ENTRY]: new TextEncoder().encode(JSON.stringify(foreign)),
  });
  assert.throws(() => parseBackupZip(zip), /not a Purple Memo backup/i);
});

test("parseBackupZip rejects backups from a newer format version", () => {
  const newer = { ...samplePayload(), version: BACKUP_FORMAT_VERSION + 1 };
  const zip = zipSync({
    [BACKUP_JSON_ENTRY]: new TextEncoder().encode(JSON.stringify(newer)),
  });
  assert.throws(() => parseBackupZip(zip), /newer version/i);
});

test("parseBackupZip rejects payloads whose data is not a table map", () => {
  for (const bad of [
    { ...samplePayload(), data: [] },
    { ...samplePayload(), data: "x" },
    { ...samplePayload(), data: { notes: "not-rows" } },
  ]) {
    const zip = zipSync({
      [BACKUP_JSON_ENTRY]: new TextEncoder().encode(JSON.stringify(bad)),
    });
    assert.throws(() => parseBackupZip(zip), /corrupt/i);
  }
});

test("parseBackupZip ignores zip entries outside the photos/ tree", () => {
  const zip = zipSync({
    [BACKUP_JSON_ENTRY]: new TextEncoder().encode(
      JSON.stringify(samplePayload()),
    ),
    "readme.txt": new TextEncoder().encode("ignore me"),
  });
  const parsed = parseBackupZip(zip);
  assert.deepEqual(parsed.payload, samplePayload());
  assert.deepEqual(parsed.photos, []);
});

test("the version upgrade seam rejects versions it cannot map forward", () => {
  const ancient = { ...samplePayload(), version: 0 };
  const zip = zipSync({
    [BACKUP_JSON_ENTRY]: new TextEncoder().encode(JSON.stringify(ancient)),
  });
  assert.throws(() => parseBackupZip(zip), /unsupported backup version/i);
});

test("applyBackup writes photo files first, then replaces all data in one batch", async () => {
  const driver = createMockDriver();
  const parsed: ParsedBackup = {
    payload: samplePayload(),
    photos: samplePhotos(),
  };
  const result = await applyBackup(driver, parsed);
  // The mock savePhoto derives its own path (photos/2026/10/jpg.3) from the
  // bytes — different from the zip path — so the row is re-pointed at the
  // real content-addressed location instead of trusting the zip path.
  assert.deepEqual(result, { tables: 28, rows: 2, photos: 1 });

  // Photo files go through savePhoto BEFORE any DB write — a photo failure
  // must leave the current data untouched.
  const saveIdx = driver.calls.findIndex((c) => c.method === "savePhoto");
  const batchIdx = driver.calls.findIndex((c) => c.method === "batch");
  assert.ok(saveIdx >= 0 && batchIdx >= 0 && saveIdx < batchIdx);
  assert.deepEqual(first(driver.callsTo("savePhoto"), "save").args, [
    [9, 9, 9],
    "jpg",
  ]);

  // FK off before the batch, back on after — in a finally, so a failed
  // import never leaves the connection in FK-off mode.
  const executes = driver.callsTo("execute").map((c) => c.args[0] as string);
  assert.deepEqual(executes, [
    "PRAGMA foreign_keys = OFF",
    "PRAGMA foreign_keys = ON",
  ]);

  const statements = first(driver.callsTo("batch"), "batch").args[0] as {
    sql: string;
    params?: unknown[];
  }[];
  const deletes = statements.filter((s) => s.sql.startsWith("DELETE FROM "));
  assert.equal(deletes.length, 28);
  assert.deepEqual(
    deletes.map((s) => s.sql),
    BACKUP_TABLES.map((t) => `DELETE FROM ${t}`),
  );
  const noteInsert = statements.find((s) =>
    s.sql.startsWith("INSERT INTO notes"),
  );
  assert.ok(noteInsert);
  assert.deepEqual(noteInsert.params, [
    1,
    "hello",
    "world",
    "a,b",
    null,
    0,
    0,
    "2026-01-01",
    "2026-01-01",
  ]);
  const photoInsert = statements.find((s) =>
    s.sql.startsWith("INSERT INTO photos"),
  );
  assert.ok(photoInsert);
  assert.equal(photoInsert.params?.[1], "photos/2026/10/jpg.3");
});

test("applyBackup cancels before any DB write when a photo file is missing", async () => {
  const driver = createMockDriver();
  await assert.rejects(
    () => applyBackup(driver, { payload: samplePayload(), photos: [] }),
    /missing the file/i,
  );
  assert.equal(driver.callsTo("batch").length, 0);
});

test("applyBackup restores FK on even when the batch fails", async () => {
  const driver = createMockDriver({
    batchError: new Error("insert failed"),
  });
  await assert.rejects(
    () =>
      applyBackup(driver, {
        payload: { ...samplePayload(), data: { notes: [NOTE_ROW] } },
        photos: [],
      }),
    /insert failed/,
  );
  assert.equal(driver.callsTo("batch").length, 1);
  const last = driver.lastCall();
  assert.equal(last?.method, "execute");
  assert.equal(last?.args[0], "PRAGMA foreign_keys = ON");
});

test("applyBackup deletes orphaned old photo files, but only after the batch commits", async () => {
  const driver = createMockDriver({
    results: [[{ rel_path: "photos/2026/01/old.jpg" }]], // current photos table
  });
  await applyBackup(driver, {
    payload: samplePayload(),
    photos: samplePhotos(),
  });
  assert.deepEqual(
    driver.callsTo("deletePhoto").map((c) => c.args),
    [["photos/2026/01/old.jpg"]],
  );
  const batchIdx = driver.calls.findIndex((c) => c.method === "batch");
  const delIdx = driver.calls.findIndex((c) => c.method === "deletePhoto");
  assert.ok(delIdx > batchIdx, "unlink only runs once the data is replaced");
});

test("applyBackup keeps files the imported backup still references", async () => {
  // The mock savePhoto re-points the row to photos/2026/10/jpg.3, so that is
  // the path the new DB references — a current file at that exact path must
  // survive the import.
  const driver = createMockDriver({
    results: [[{ rel_path: "photos/2026/10/jpg.3" }]],
  });
  await applyBackup(driver, {
    payload: samplePayload(),
    photos: samplePhotos(),
  });
  assert.equal(driver.callsTo("deletePhoto").length, 0);
});

test("applyBackup rejects column names that would inject SQL, before writing anything", async () => {
  // Column names are interpolated into the statement (values are bound), and
  // they come straight out of the backup file — a hostile file must never be
  // able to smuggle SQL through them.
  const hostile = {
    ...samplePayload(),
    data: {
      notes: [
        {
          id: 1,
          "id); VALUES (1); DROP TABLE notes; --": "x",
        },
      ],
    },
  };
  const driver = createMockDriver();
  await assert.rejects(
    () => applyBackup(driver, { payload: hostile, photos: [] }),
    /invalid column name/,
  );
  // No data was written (the batch never ran); the two executes are the
  // PRAGMA foreign_keys OFF/ON pair, so FK ends up restored.
  assert.equal(driver.callsTo("batch").length, 0);
  const executes = driver.callsTo("execute").map((c) => c.args[0]);
  assert.ok(
    executes.every((sql) =>
      /^PRAGMA foreign_keys = (OFF|ON)$/.test(sql as string),
    ),
  );
});

test("applyBackup emits only plain identifiers in its SQL", async () => {
  const driver = createMockDriver();
  await applyBackup(driver, {
    payload: { ...samplePayload(), data: { notes: [NOTE_ROW] } },
    photos: [],
  });
  const statements = first(driver.callsTo("batch"), "batch").args[0] as {
    sql: string;
  }[];
  assert.ok(statements.length > 0);
  for (const s of statements) {
    // Only identifiers, parens, commas, spaces and `?` placeholders — no
    // quotes, semicolons or dashes that could carry a second statement.
    assert.match(
      s.sql,
      /^[A-Za-z0-9_(), ?]+$/,
      `unexpected SQL punctuation: ${s.sql}`,
    );
  }
});

test("summarizeBackup counts rows and photos for the import summary", () => {
  const summary = summarizeBackup({
    payload: samplePayload(),
    photos: samplePhotos(),
  });
  assert.equal(summary.tableCount, 28);
  assert.equal(summary.rowCount, 2);
  assert.equal(summary.photoCount, 1);
  assert.equal(summary.exportedAt, "2026-10-12T03:00:00.000Z");
});
