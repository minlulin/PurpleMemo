// Backup (§8): export reads every data table (never the trigger-maintained
// notes_fts index) plus photo bytes; the zip holds backup.json + the photos/
// tree; import validates the app marker, upgrades by file version, writes photo
// files first (so a failure leaves the DB untouched), then replaces all data
// in one batch with FK off (table order irrelevant), restoring FK on after.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { zipSync } from "fflate";
import type { Queryable } from "../data/driver.ts";
import { createMockDriver, type MockDriver } from "../data/mock-driver.ts";
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
  exportBudget,
  MAX_BACKUP_ARCHIVE_BYTES,
  MAX_BACKUP_ENTRIES,
  MAX_BACKUP_MANIFEST_BYTES,
  MAX_BACKUP_PHOTO_BYTES,
  MAX_BACKUP_PHOTOS,
  MAX_BACKUP_ROWS,
  MAX_EXPORT_PHOTO_BYTES,
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
  return [
    { path: "photos/2026/10/aaa.jpg", bytes: Uint8Array.from([9, 9, 9]) },
  ];
}

// Review M-02: bytes are `Uint8Array` end to end — a `number[]` anywhere in
// this path is the JSON-array-per-byte problem coming back.
function expectBytes(value: unknown, expected: number[]): void {
  assert.ok(
    value instanceof Uint8Array,
    `expected a Uint8Array, got ${Object.prototype.toString.call(value)}`,
  );
  assert.deepEqual(Array.from(value), expected);
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
  assert.equal(photos.length, 1);
  assert.equal(photos[0]?.path, "photos/2026/10/aaa.jpg");
  expectBytes(photos[0]?.bytes, [1, 2, 3]); // mock readPhoto bytes
  const queries = driver.callsTo("query").map((c) => c.args[0] as string);
  assert.equal(queries.length, 29); // 28 tables + the photo-size lookup
  // The export cap needs each photo's stored size, so the lookup reads it in
  // the same pass as the path (no second query, no bytes).
  assert.ok(
    queries.includes("SELECT rel_path, size_bytes FROM photos ORDER BY id"),
  );
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

test("buildBackupZip + parseBackupZip roundtrip payload and photos tree", async () => {
  const bytes = await buildBackupZip(samplePayload(), samplePhotos());
  const parsed = parseBackupZip(bytes);
  assert.deepEqual(parsed.payload, samplePayload());
  assert.deepEqual(parsed.photos, samplePhotos());
  expectBytes(parsed.photos[0]?.bytes, [9, 9, 9]);
});

test("buildBackupZip roundtrips a multi-photo archive byte for byte", async () => {
  // The async zipper (worker, with a blocking fallback) must produce an
  // archive this app can read back — that is the whole contract.
  const photos: BackupPhotoEntry[] = [];
  for (let i = 0; i < 24; i += 1) {
    photos.push({
      path: `photos/2026/10/${String(i).padStart(64, "a")}.jpg`,
      bytes: Uint8Array.from({ length: 512 }, (_, b) => (i * 31 + b) % 256),
    });
  }
  const parsed = parseBackupZip(await buildBackupZip(samplePayload(), photos));
  assert.equal(parsed.photos.length, photos.length);
  for (const [i, photo] of parsed.photos.entries()) {
    assert.equal(photo.path, photos[i]?.path);
    assert.deepEqual(photo.bytes, photos[i]?.bytes);
  }
});

test("exportBudget: sums stored sizes and refuses one archive above the cap", () => {
  const rows = [
    { size_bytes: 3 },
    { size_bytes: 5 }, // 8 total, comfortably inside a 10-byte limit
    { size_bytes: Number.NaN }, // a nonsense size is ignored, not fatal
  ];
  assert.deepEqual(exportBudget(rows, 10), {
    bytes: 8,
    photos: 3,
    ok: true,
    limit: 10,
  });
  // Exactly at the cap is allowed; one byte over is not.
  assert.equal(exportBudget([{ size_bytes: 10 }], 10).ok, true);
  const over = exportBudget([{ size_bytes: 11 }], 10);
  assert.equal(over.ok, false);
  assert.equal(over.bytes, 11);
  // The default cap is the import limit minus the manifest allowance, so an
  // archive this app writes is one it can always read back.
  assert.equal(
    MAX_EXPORT_PHOTO_BYTES,
    MAX_BACKUP_ARCHIVE_BYTES - MAX_BACKUP_MANIFEST_BYTES,
  );
});

test("readBackupData refuses an oversized library BEFORE reading any photo bytes", async () => {
  const tableResults: Queryable[][] = BACKUP_TABLES.map(() => []);
  tableResults.push([
    { rel_path: "photos/2026/10/aaa.jpg", size_bytes: MAX_EXPORT_PHOTO_BYTES },
    { rel_path: "photos/2026/10/bbb.jpg", size_bytes: 1 },
  ]);
  const driver = createMockDriver({ results: tableResults });
  await assert.rejects(
    () => readBackupData(driver),
    /more than the \d+ MiB one backup can hold/i,
  );
  assert.deepEqual(
    driver.callsTo("readPhoto"),
    [],
    "a refused export must not pull the library through IPC first",
  );
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

test("parseBackupZip rejects an archive over the compressed-size limit", () => {
  assert.throws(
    () => parseBackupZip(new Uint8Array(MAX_BACKUP_ARCHIVE_BYTES + 1)),
    /archive is larger/i,
  );
});

test("parseBackupZip rejects an oversized manifest before extraction", () => {
  const zip = zipSync({
    [BACKUP_JSON_ENTRY]: new Uint8Array(MAX_BACKUP_MANIFEST_BYTES + 1),
  });
  assert.throws(() => parseBackupZip(zip), /backup\.json is larger/i);
});

test("parseBackupZip rejects too many entries", () => {
  const files: Record<string, Uint8Array> = {
    [BACKUP_JSON_ENTRY]: new TextEncoder().encode(
      JSON.stringify(samplePayload()),
    ),
  };
  for (let i = 0; i < MAX_BACKUP_ENTRIES; i += 1) {
    files[`ignored/${i}`] = new Uint8Array();
  }
  const zip = zipSync(files);
  assert.throws(() => parseBackupZip(zip), /more than .* entries/i);
});

/** A zip whose manifest is `payload`, for the limit tests below. */
function zipWithPayload(payload: BackupPayload): Uint8Array {
  return zipSync({
    [BACKUP_JSON_ENTRY]: new TextEncoder().encode(JSON.stringify(payload)),
  });
}

test("an import is refused when the manifest holds more rows than the cap", () => {
  // Review H-5: every other import resource was bounded, but row count was
  // not — so a manifest well inside the 16 MB limit could expand to enough
  // rows to exhaust renderer memory once each became a batch statement.
  const overCap = zipWithPayload({
    ...samplePayload(),
    data: {
      notes: Array.from({ length: MAX_BACKUP_ROWS + 1 }, (_, i) => ({
        ...NOTE_ROW,
        id: i + 1,
      })),
      photos: [],
    },
  });
  assert.throws(() => parseBackupZip(overCap), /more than .* rows/i);
});

test("the row cap sums across tables, it is not per table", () => {
  // Neither table alone is over the limit; together they are. Summing is what
  // has to happen, because the cap protects the import, not any one table.
  const half = Math.ceil((MAX_BACKUP_ROWS + 1) / 2);
  const spread = zipWithPayload({
    ...samplePayload(),
    data: {
      notes: Array.from({ length: half }, (_, i) => ({
        ...NOTE_ROW,
        id: i + 1,
      })),
      journal_entries: Array.from({ length: half }, (_, i) => ({
        ...NOTE_ROW,
        id: i + 1,
      })),
      photos: [],
    },
  });
  assert.throws(() => parseBackupZip(spread), /more than .* rows/i);
});

test("a manifest exactly at the row cap is still accepted", () => {
  // The cap must reject pathological manifests, not merely large real ones.
  const atCap = zipWithPayload({
    ...samplePayload(),
    data: {
      notes: Array.from({ length: MAX_BACKUP_ROWS }, (_, i) => ({
        ...NOTE_ROW,
        id: i + 1,
      })),
      photos: [],
    },
  });
  const parsed = parseBackupZip(atCap);
  assert.equal(parsed.payload.data.notes?.length, MAX_BACKUP_ROWS);
});

test("parseBackupZip rejects too many and oversized photos before extraction", () => {
  const tooMany: Record<string, Uint8Array> = {
    [BACKUP_JSON_ENTRY]: new TextEncoder().encode(
      JSON.stringify(samplePayload()),
    ),
  };
  for (let i = 0; i <= MAX_BACKUP_PHOTOS; i += 1) {
    tooMany[`photos/${i}.jpg`] = new Uint8Array();
  }
  assert.throws(() => parseBackupZip(zipSync(tooMany)), /more than .* photos/i);

  const oversized = zipSync({
    [BACKUP_JSON_ENTRY]: new TextEncoder().encode(
      JSON.stringify(samplePayload()),
    ),
    "photos/large.jpg": new Uint8Array(MAX_BACKUP_PHOTO_BYTES + 1),
  });
  assert.throws(() => parseBackupZip(oversized), /backup photo is larger/i);
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
  const saved = first(driver.callsTo("savePhoto"), "save").args;
  expectBytes(saved[0], [9, 9, 9]);
  assert.equal(saved[1], "jpg");

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

test("applyBackup removes newly written photos when the DB import fails", async () => {
  const driver = createMockDriver({ batchError: new Error("batch failed") });
  driver.pushResults([[{ rel_path: "photos/2026/01/old.jpg" }]]);
  const parsed: ParsedBackup = {
    payload: {
      ...samplePayload(),
      data: {
        notes: [],
        photos: [
          {
            id: 1,
            rel_path: "photos/2026/10/new.jpg",
            sha256: "old",
            ext: "jpg",
            size_bytes: 99,
          },
        ],
      },
    },
    photos: [
      { path: "photos/2026/10/new.jpg", bytes: Uint8Array.from([1, 2, 3]) },
    ],
  };

  await assert.rejects(applyBackup(driver, parsed), /batch failed/);
  assert.deepEqual(
    driver.callsTo("deletePhoto").map((c) => c.args),
    [["photos/2026/10/jpg.3"]],
  );
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

test("a failed FK restore cannot mask the batch error (FIX-05)", async () => {
  // Worst case: the batch fails AND the connection dies before the restore
  // pragma runs. The restore is best-effort — its failure must be logged,
  // not thrown, or the exception from the `finally` block would replace the
  // batch error the caller needs to see.
  const base = createMockDriver({ batchError: new Error("batch exploded") });
  const driver: MockDriver = {
    ...base,
    execute: async (sql, params) => {
      if (sql === "PRAGMA foreign_keys = ON") {
        // The base mock records inside `execute`, which this override never
        // reaches — record the attempt here so the test can assert the
        // restore was still tried.
        base.calls.push({ method: "execute", args: [sql, params] });
        throw new Error("connection died");
      }
      return base.execute(sql, params);
    },
  };
  const logged: string[] = [];
  const realConsoleError = console.error;
  console.error = (message?: unknown) => {
    logged.push(String(message));
  };
  try {
    await assert.rejects(
      () =>
        applyBackup(driver, {
          payload: { ...samplePayload(), data: { notes: [NOTE_ROW] } },
          photos: [],
        }),
      /batch exploded/,
      "the original batch error must propagate, not the restore failure",
    );
  } finally {
    console.error = realConsoleError;
  }
  // FK OFF ran before the batch; the ON restore was still attempted after.
  assert.deepEqual(
    driver.callsTo("execute").map((c) => c.args[0]),
    ["PRAGMA foreign_keys = OFF", "PRAGMA foreign_keys = ON"],
  );
  assert.deepEqual(logged, [
    "[backup] failed to restore foreign_keys = ON after import",
  ]);
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

test("applyBackup corrects sha256 + size_bytes when a zip entry does not match the manifest", async () => {
  // PHOTO_ROW claims sha256 "aa" and size 3, but the zip entry carries
  // different bytes, so savePhoto lands them at a new content-addressed
  // path. Every column that describes the bytes must move together.
  const driver = createMockDriver();
  await applyBackup(driver, {
    payload: samplePayload(),
    photos: samplePhotos(),
  });
  const statements = first(driver.callsTo("batch"), "batch").args[0] as {
    sql: string;
    params?: unknown[];
  }[];
  const photoInsert = statements.find((s) =>
    s.sql.startsWith("INSERT INTO photos"),
  );
  assert.ok(photoInsert);
  const relIdx = photoInsert.sql.indexOf("rel_path");
  assert.ok(relIdx > 0);
  const cols = photoInsert.sql
    .slice(
      photoInsert.sql.indexOf("(") + 1,
      photoInsert.sql.indexOf(") VALUES"),
    )
    .split(",")
    .map((c) => c.trim());
  const get = (name: string) => photoInsert.params?.[cols.indexOf(name)];

  assert.equal(get("rel_path"), "photos/2026/10/jpg.3");
  // sha256 of the actual bytes [9,9,9], and the actual byte length.
  assert.equal(
    get("sha256"),
    "e740a6faf2db65f5853148d75d9a335d7c4b94ab106fe5f237bc34fdcfc74584",
  );
  assert.equal(get("size_bytes"), 3);
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
