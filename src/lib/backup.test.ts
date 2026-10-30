// Backup: export reads every data table (never the trigger-maintained
// notes_fts index) plus photo bytes; the zip holds backup.json + the photos/
// tree; import validates the app marker, upgrades by file version, writes photo
// files first (so a failure leaves the DB untouched), then replaces all data
// in one batch with FK off (table order irrelevant), restoring FK on after.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { zipSync } from "fflate";
import type {
  BatchStatement,
  DataDriver,
  ExecuteOutcome,
  Queryable,
  Row,
} from "../data/driver.ts";
import { createMockDriver, type MockDriver } from "../data/mock-driver.ts";
import { first } from "../test-utils.ts";
import {
  applyBackup,
  assertExpandedLimits,
  BACKUP_APP,
  BACKUP_FORMAT_VERSION,
  BACKUP_JSON_ENTRY,
  BACKUP_TABLES,
  type BackupPayload,
  type BackupPhotoEntry,
  buildBackupZip,
  createBackupRepo,
  exceedsEncryptedBackupCap,
  exportBudget,
  MAX_BACKUP_ARCHIVE_BYTES,
  MAX_BACKUP_ENTRIES,
  MAX_BACKUP_EXPANDED_BYTES,
  MAX_BACKUP_MANIFEST_BYTES,
  MAX_BACKUP_PHOTO_BYTES,
  MAX_BACKUP_PHOTOS,
  MAX_BACKUP_ROWS,
  MAX_ENCRYPTED_BACKUP_BYTES,
  MAX_EXPORT_PHOTO_BYTES,
  type ParsedBackup,
  parseBackupZip,
  readBackupData,
  summarizeBackup,
} from "./backup.ts";
import {
  isEncryptedBackup,
  openBackupContainer,
  sealBackupContainer,
  WrongBackupPasswordError,
} from "./backupContainer.ts";

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

/**
 * Every table, empty — the shape `readBackupData` writes on every export, and
 * therefore the shape a current-format manifest must carry (D1).
 */
function emptyTables(): BackupPayload["data"] {
  const data: BackupPayload["data"] = {};
  for (const table of BACKUP_TABLES) data[table] = [];
  return data;
}

function samplePayload(): BackupPayload {
  return {
    app: BACKUP_APP,
    version: BACKUP_FORMAT_VERSION,
    exportedAt: "2026-10-12T03:00:00.000Z",
    data: { ...emptyTables(), notes: [NOTE_ROW], photos: [PHOTO_ROW] },
  };
}

function samplePhotos(): BackupPhotoEntry[] {
  return [
    { path: "photos/2026/10/aaa.jpg", bytes: Uint8Array.from([9, 9, 9]) },
  ];
}

/**
 * Where the mock driver's `savePhoto` lands a photo (D1-1: content-addressed
 * like Rust — sha256 of the bytes, lowercased ext). `SAMPLE_JPG` is where
 * `samplePhotos()`' [9,9,9] land; `ONE_TWO_THREE_JPG` is [1,2,3].
 */
const SAMPLE_JPG =
  "photos/2026/10/e740a6faf2db65f5853148d75d9a335d7c4b94ab106fe5f237bc34fdcfc74584.jpg";
const ONE_TWO_THREE_JPG =
  "photos/2026/10/039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81.jpg";

// bytes are `Uint8Array` end to end — a `number[]` anywhere in
// this path is the JSON-array-per-byte problem coming back.
function expectBytes(value: unknown, expected: number[]): void {
  assert.ok(
    value instanceof Uint8Array,
    `expected a Uint8Array, got ${Object.prototype.toString.call(value)}`,
  );
  assert.deepEqual(Array.from(value), expected);
}

test("BACKUP_TABLES covers the 31 data tables and excludes the derived notes_fts index", () => {
  assert.equal(BACKUP_TABLES.length, 31);
  assert.ok(
    BACKUP_TABLES.includes("inbox_items"),
    "the capture inbox is backed up",
  );
  assert.ok(!BACKUP_TABLES.includes("notes_fts"));
  assert.ok(BACKUP_TABLES.includes("notes"));
  assert.ok(BACKUP_TABLES.includes("photos"));
  assert.ok(BACKUP_TABLES.includes("settings"));
  assert.ok(
    BACKUP_TABLES.includes("trash_items"),
    "the capture trash is backed up",
  );
});

test("readBackupData queries each table once, reads photo bytes, stamps the manifest", async () => {
  // One canned result per query, in call order: 31 table reads, then the
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
  assert.equal(queries.length, 32); // 31 tables + the photo-size lookup
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
    largest: 5,
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

test("exportBudget: refuses a single photo over the importer's per-photo limit (E6)", () => {
  // The total can be tiny and still be un-exportable: inspection rejects any
  // one photo above MAX_BACKUP_PHOTO_BYTES on restore, so an export that
  // included it would write a backup this app refuses to read back — and it
  // must be caught from the stored sizes, before any bytes are pulled.
  const overPhoto = exportBudget(
    [{ size_bytes: MAX_BACKUP_PHOTO_BYTES + 1 }, { size_bytes: 1 }],
    MAX_EXPORT_PHOTO_BYTES,
  );
  assert.equal(
    overPhoto.ok,
    false,
    "well inside the total cap, one byte over the per-photo cap",
  );
  assert.equal(overPhoto.largest, MAX_BACKUP_PHOTO_BYTES + 1);
  // Exactly at the cap is still fine, same as the total's inclusive bound.
  assert.equal(
    exportBudget(
      [{ size_bytes: MAX_BACKUP_PHOTO_BYTES }],
      MAX_EXPORT_PHOTO_BYTES,
    ).ok,
    true,
  );
});

test("readBackupData refuses an oversized single photo BEFORE reading any photo bytes (E6)", async () => {
  const tableResults: Queryable[][] = BACKUP_TABLES.map(() => []);
  tableResults.push([
    {
      rel_path: "photos/2026/10/big.jpg",
      size_bytes: MAX_BACKUP_PHOTO_BYTES + 1,
    },
  ]);
  const driver = createMockDriver({ results: tableResults });
  await assert.rejects(
    () => readBackupData(driver),
    /over the \d+ MiB a single backup photo may be/i,
  );
  assert.deepEqual(
    driver.callsTo("readPhoto"),
    [],
    "the per-photo refusal must fire before the library is read through IPC",
  );
});

test("readBackupData refuses an oversized library BEFORE reading any photo bytes", async () => {
  const tableResults: Queryable[][] = BACKUP_TABLES.map(() => []);
  // Every row sits exactly AT the per-photo cap (so the E6 single-photo check
  // stays quiet) while five of them blow the whole-library cap — this refusal
  // is about the total, and only the total.
  tableResults.push(
    Array.from({ length: 5 }, (_, i) => ({
      rel_path: `photos/2026/10/p${i}.jpg`,
      size_bytes: MAX_BACKUP_PHOTO_BYTES,
    })),
  );
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
  // every other import resource was bounded, but row count was
  // not — so a manifest well inside the 16 MB limit could expand to enough
  // rows to exhaust renderer memory once each became a batch statement.
  const overCap = zipWithPayload({
    ...samplePayload(),
    data: {
      ...emptyTables(),
      notes: Array.from({ length: MAX_BACKUP_ROWS + 1 }, (_, i) => ({
        ...NOTE_ROW,
        id: i + 1,
      })),
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
      ...emptyTables(),
      notes: Array.from({ length: half }, (_, i) => ({
        ...NOTE_ROW,
        id: i + 1,
      })),
      journal_entries: Array.from({ length: half }, (_, i) => ({
        ...NOTE_ROW,
        id: i + 1,
      })),
    },
  });
  assert.throws(() => parseBackupZip(spread), /more than .* rows/i);
});

test("a manifest exactly at the row cap is still accepted", () => {
  // The cap must reject pathological manifests, not merely large real ones.
  const atCap = zipWithPayload({
    ...samplePayload(),
    data: {
      ...emptyTables(),
      notes: Array.from({ length: MAX_BACKUP_ROWS }, (_, i) => ({
        ...NOTE_ROW,
        id: i + 1,
      })),
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

test("a current-format manifest must name every table (D1)", () => {
  // The exporter writes all 31 keys, so a version-4 manifest missing one is
  // not "an empty table" — it is a file this app did not write. `applyBackup`
  // deletes every table and then inserts `data[table] ?? []`, so accepting it
  // would wipe the live rows of the table it leaves out.
  const data = { ...samplePayload().data };
  delete data.notes;
  assert.throws(
    () => parseBackupZip(zipWithPayload({ ...samplePayload(), data })),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /is incomplete/);
      assert.match(e.message, /table notes/);
      assert.match(e.message, /all 31 tables/);
      assert.match(e.message, /would empty the tables it leaves out/);
      return true;
    },
  );
  // A complete manifest of the same shape still parses: the check is on the
  // keys, not on emptiness.
  assert.deepEqual(
    parseBackupZip(zipWithPayload(samplePayload())).payload.data,
    samplePayload().data,
  );
});

test("a manifest missing most tables names the count, not thirty errors (D1)", () => {
  // One present table, thirty absent: the refusal has to be readable in a
  // single sentence, so it counts and samples the tables instead of listing
  // every one of them.
  assert.throws(
    () =>
      parseBackupZip(
        zipWithPayload({ ...samplePayload(), data: { notes: [NOTE_ROW] } }),
      ),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /missing 30 tables \(/);
      assert.match(e.message, /… and 24 more/);
      return true;
    },
  );
});

test("only the current format is strict — an older manifest may still omit tables (D1)", () => {
  // The boundary the decision draws: `upgradeBackupData` is what adds the
  // tables a format could not know about, so a pre-current manifest stays
  // permissive while a current one must name everything. A sparse v1 payload
  // still imports and still gains the three tables it predates.
  const v1 = {
    ...samplePayload(),
    version: 1,
    data: { notes: [NOTE_ROW], photos: [PHOTO_ROW] },
  };
  const parsed = parseBackupZip(zipWithPayload(v1));
  assert.equal(parsed.payload.version, BACKUP_FORMAT_VERSION);
  assert.deepEqual(parsed.payload.data.notes, [NOTE_ROW]);
  assert.deepEqual(parsed.payload.data.inbox_items, []);
  assert.deepEqual(parsed.payload.data.links, []);
  assert.deepEqual(parsed.payload.data.trash_items, []);
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

test("a v1 payload upgrades to v2 with an empty inbox", () => {
  // The seam a real upgrade takes: a backup taken before quick capture existed
  // must still import, and must arrive with the table the current code expects
  // to exist rather than a missing key.
  const v1 = { ...samplePayload(), version: 1 };
  const parsed = parseBackupZip(zipWithPayload(v1));
  assert.equal(parsed.payload.version, BACKUP_FORMAT_VERSION);
  assert.deepEqual(parsed.payload.data.inbox_items, []);
  // Its real data is untouched.
  assert.deepEqual(parsed.payload.data.notes, [NOTE_ROW]);
});

test("a v1 payload's inbox can never smuggle rows in", () => {
  // The upgrade normalizes the table, so a hand-edited v1 file cannot carry an
  // inbox the app never validated. `inbox_items: [...]` is dropped, not kept.
  const v1 = {
    ...samplePayload(),
    version: 1,
    data: {
      notes: [NOTE_ROW],
      photos: [],
      inbox_items: [{ id: 1, body: "sneaky", status: "open", created_at: "x" }],
    },
  };
  const parsed = parseBackupZip(zipWithPayload(v1));
  assert.deepEqual(parsed.payload.data.inbox_items, []);
});

test("a v2 payload round-trips its inbox rows", () => {
  const row = {
    id: 1,
    body: "buy milk",
    status: "converted",
    converted_type: "note",
    converted_id: 7,
    created_at: "2026-10-18",
  };
  const parsed = parseBackupZip(
    zipWithPayload({
      ...samplePayload(),
      data: { ...emptyTables(), notes: [NOTE_ROW], inbox_items: [row] },
    }),
  );
  assert.equal(parsed.payload.version, BACKUP_FORMAT_VERSION);
  assert.deepEqual(parsed.payload.data.inbox_items, [row]);
});

test("a converted inbox row keeps its target reference when the target is gone", () => {
  // `converted_type` / `converted_id` are historical, not a foreign key: an
  // archive taken after the note was hard-deleted still imports, and the row
  // still names what it produced.
  const row = {
    id: 3,
    body: "buy milk",
    status: "converted",
    converted_type: "note",
    converted_id: 999,
    created_at: "2026-10-18",
  };
  const parsed = parseBackupZip(
    zipWithPayload({
      ...samplePayload(),
      data: { ...emptyTables(), inbox_items: [row] },
    }),
  );
  const imported = parsed.payload.data.inbox_items?.[0];
  assert.equal(imported?.converted_type, "note");
  assert.equal(imported?.converted_id, 999);
  assert.equal(
    parsed.payload.data.notes?.length,
    0,
    "the target itself is absent",
  );
});

test("a payload from a newer app is still refused", () => {
  const future = { ...samplePayload(), version: BACKUP_FORMAT_VERSION + 1 };
  assert.throws(
    () => parseBackupZip(zipWithPayload(future)),
    /made by a newer version/i,
  );
});

// ---------------------------------------------------------------------------
// Relationship rows in a payload
// ---------------------------------------------------------------------------

/** A payload with one live note and one live task, plus the given links. */
function payloadWithLinks(links: Row[]): BackupPayload {
  return {
    ...samplePayload(),
    data: {
      ...emptyTables(),
      notes: [{ ...NOTE_ROW, id: 1 }],
      tasks: [{ id: 1, title: "a task" }],
      links,
    },
  };
}

function validLink() {
  // contact < note in BINARY order, so this is canonical.
  return {
    id: 1,
    kind: "related",
    type_a: "note",
    id_a: 1,
    type_b: "task",
    id_b: 1,
    created_at: "2026-10-19",
  };
}

test("a well-formed relationship round-trips", () => {
  const parsed = parseBackupZip(
    zipWithPayload(payloadWithLinks([validLink()])),
  );
  assert.equal(parsed.payload.version, BACKUP_FORMAT_VERSION);
  assert.equal(parsed.payload.data.links?.length, 1);
  assert.deepEqual(parsed.payload.data.links?.[0], validLink());
});

test("a v2 payload upgrades to v4 with empty links and Trash tables", () => {
  const v2 = { ...samplePayload(), version: 2 };
  const parsed = parseBackupZip(zipWithPayload(v2));
  assert.equal(parsed.payload.version, BACKUP_FORMAT_VERSION);
  assert.deepEqual(parsed.payload.data.links, []);
  assert.deepEqual(parsed.payload.data.trash_items, []);
});

test("a v3 payload upgrades to v4 with an empty Trash table", () => {
  const v3 = { ...samplePayload(), version: 3 };
  const parsed = parseBackupZip(zipWithPayload(v3));
  assert.equal(parsed.payload.version, BACKUP_FORMAT_VERSION);
  assert.deepEqual(parsed.payload.data.trash_items, []);
});

test("malformed Trash snapshot data is rejected before backup apply", () => {
  const payload = {
    ...samplePayload(),
    data: {
      ...samplePayload().data,
      trash_items: [
        {
          entity_type: "note",
          entity_id: 1,
          snapshot: "{}",
          deleted_at: "2026-01-01",
        },
      ],
    },
  };
  assert.throws(
    () => parseBackupZip(zipWithPayload(payload)),
    /unsupported snapshot format/,
  );
});

test("a v1 payload upgrades with both newer tables empty", () => {
  const v1 = { ...samplePayload(), version: 1 };
  const parsed = parseBackupZip(zipWithPayload(v1));
  assert.deepEqual(parsed.payload.data.links, []);
  assert.deepEqual(parsed.payload.data.inbox_items, []);
  assert.deepEqual(parsed.payload.data.trash_items, []);
});

test("a link naming an item the payload does not contain is refused", () => {
  // The case that matters: without this, importing could attach a relationship
  // to a DIFFERENT row that happens to reuse the id.
  const ghost = { ...validLink(), id_b: 99 };
  assert.throws(
    () => parseBackupZip(zipWithPayload(payloadWithLinks([ghost]))),
    /not in this backup/,
  );
  // Canonical order, but the second end names a task the payload does not have.
  const ghostSecond = { ...validLink(), id_b: 42 };
  assert.throws(
    () => parseBackupZip(zipWithPayload(payloadWithLinks([ghostSecond]))),
    /not in this backup/,
  );
});

test("a self-link, an out-of-order pair, a duplicate, and bad enums are refused", () => {
  const cases: [Row, RegExp][] = [
    [{ ...validLink(), type_b: "note", id_b: 1 }, /linked to itself/],
    [{ ...validLink(), type_a: "task", type_b: "note" }, /out of order/],
    [{ ...validLink(), kind: "parent" }, /unknown kind/],
    [{ ...validLink(), type_b: "journal" }, /unknown entity type/],
    [{ ...validLink(), id_b: "seven" }, /missing endpoint/],
    [validLink(), /the same pair appears twice/],
  ];
  for (const [link, expected] of cases) {
    assert.throws(
      () =>
        parseBackupZip(
          zipWithPayload(
            payloadWithLinks([
              link,
              ...(expected.source === "the same pair appears twice"
                ? [link]
                : []),
            ]),
          ),
        ),
      expected,
      `expected ${String(expected)} for ${JSON.stringify(link)}`,
    );
  }
});

test("a relationship is refused before any photo file is written", () => {
  // parseBackupZip is the gate: import validates through it, and applyBackup
  // only runs afterwards. Asserting the order here is the whole guarantee.
  const driver = createMockDriver({ results: [[]] });
  const repo = createBackupRepo(driver);
  const bad = zipWithPayload(payloadWithLinks([{ ...validLink(), id_b: 99 }]));
  assert.throws(() => parseBackupZip(bad), /not in this backup/);
  void repo;
  void driver;
  assert.equal(
    driver.calls.length,
    0,
    "no database work for a refused payload",
  );
});

test("applyBackup writes photo files first, then replaces all data in one batch", async () => {
  const driver = createMockDriver();
  const parsed: ParsedBackup = {
    payload: samplePayload(),
    photos: samplePhotos(),
  };
  const result = await applyBackup(driver, parsed);
  // The mock savePhoto derives its own path (photos/2026/10/<sha256>.jpg,
  // D1-1 content-addressed like Rust) from the bytes — different from the
  // zip path — so the row is re-pointed at the real location instead of
  // trusting the zip path.
  assert.deepEqual(result, { tables: 31, rows: 2, photos: 1 });

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
  assert.equal(deletes.length, 31);
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
  assert.equal(photoInsert.params?.[1], SAMPLE_JPG);
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
    [[ONE_TWO_THREE_JPG]],
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

test("a failed FK restore cannot mask the batch error", async () => {
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
  // The mock savePhoto re-points the row to its content-addressed path
  // (SAMPLE_JPG), so that is the path the new DB references — a current
  // file at that exact path must survive the import.
  const driver = createMockDriver({
    results: [[{ rel_path: SAMPLE_JPG }]],
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
  // The only non-identifier-shaped statement is the FK canary (P3-5) — and it
  // is a static constant in `backup.ts`, interpolated with nothing at all.
  // Pin it verbatim: the day its text varies with the payload, this exemption
  // is exactly the hole the charset rule exists to close.
  const canary = statements.filter((s) =>
    s.sql.includes("pragma_foreign_key_check"),
  );
  assert.equal(canary.length, 1, "exactly one FK canary per import");
  assert.equal(
    first(canary, "fk canary").sql,
    "INSERT INTO settings (key, value) SELECT 'import-fk-check', NULL WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check)",
  );
  for (const s of statements) {
    if (s.sql.includes("pragma_foreign_key_check")) continue;
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

  assert.equal(get("rel_path"), SAMPLE_JPG);
  // sha256 of the actual bytes [9,9,9], and the actual byte length — and
  // with D1-1 content-addressing the rel_path IS that hash: every column
  // that describes the bytes moves together, path included.
  assert.equal(
    get("sha256"),
    "e740a6faf2db65f5853148d75d9a335d7c4b94ab106fe5f237bc34fdcfc74584",
  );
  assert.equal(get("size_bytes"), 3);
});

test("applyBackup repairs forged photo metadata when the content path already matches", async () => {
  // The mock's savePhoto IS content-addressed now (D1-1): the path below is
  // exactly where it lands [9,9,9].jpg — no patching needed.
  const driver = createMockDriver();
  const payload = samplePayload();
  payload.data.photos = [
    { ...PHOTO_ROW, rel_path: SAMPLE_JPG, sha256: "forged", size_bytes: 1 },
  ];

  await applyBackup(driver, {
    payload,
    photos: [{ path: SAMPLE_JPG, bytes: Uint8Array.from([9, 9, 9]) }],
  });

  const statements = first(driver.callsTo("batch"), "batch").args[0] as {
    sql: string;
    params?: unknown[];
  }[];
  const photoInsert = statements.find((statement) =>
    statement.sql.startsWith("INSERT INTO photos"),
  );
  assert.ok(photoInsert);
  const columns = photoInsert.sql
    .slice(
      photoInsert.sql.indexOf("(") + 1,
      photoInsert.sql.indexOf(") VALUES"),
    )
    .split(",")
    .map((column) => column.trim());
  const get = (name: string) => photoInsert.params?.[columns.indexOf(name)];

  assert.equal(get("rel_path"), SAMPLE_JPG);
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
  assert.equal(summary.tableCount, 31);
  assert.equal(summary.rowCount, 2);
  assert.equal(summary.photoCount, 1);
  assert.equal(summary.exportedAt, "2026-10-12T03:00:00.000Z");
});

test("assertExpandedLimits counts REAL bytes, not what a header declared", () => {
  // P3-26: the pre-filter sums `originalSize`, which is read out of the archive
  // and is therefore attacker-controlled. The recovery has to be independent of
  // it, so these entries carry no header at all — only their actual length.
  // The zip needed to trip the real 512 MB ceiling cannot be built in a test,
  // so the rule is pinned here and the ordering is pinned from the source below.
  const manifest = new Uint8Array(MAX_BACKUP_MANIFEST_BYTES + 1);
  assert.throws(
    () =>
      assertExpandedLimits({
        [BACKUP_JSON_ENTRY]: manifest,
      }),
    /backup\.json is larger/i,
    "an over-large manifest is caught by real length",
  );

  const oversizePhoto = new Uint8Array(MAX_BACKUP_PHOTO_BYTES + 1);
  assert.throws(
    () =>
      assertExpandedLimits({
        [BACKUP_JSON_ENTRY]: new TextEncoder().encode("{}"),
        "photos/big.jpg": oversizePhoto,
      }),
    /backup photo is larger/i,
    "an over-large photo is caught by real length",
  );

  // The total is a sum across entries, not a per-entry max: many small entries
  // are the actual zip-bomb shape.
  const chunk = new Uint8Array(MAX_BACKUP_PHOTO_BYTES);
  const bomb: Record<string, Uint8Array> = {
    [BACKUP_JSON_ENTRY]: new TextEncoder().encode("{}"),
  };
  for (
    let i = 0;
    i * MAX_BACKUP_PHOTO_BYTES <= MAX_BACKUP_EXPANDED_BYTES;
    i += 1
  ) {
    bomb[`photos/${i}.jpg`] = chunk;
  }
  assert.throws(
    () => assertExpandedLimits(bomb),
    /expands beyond/i,
    "a total under many legal entries still trips the aggregate ceiling",
  );
});

test("assertExpandedLimits lets a normal archive through", () => {
  // The guard must not reject what this app itself writes.
  assert.doesNotThrow(() =>
    assertExpandedLimits({
      [BACKUP_JSON_ENTRY]: new TextEncoder().encode("{}"),
      "photos/2026/10/a.jpg": new Uint8Array(200_000),
      "photos/2026/10/b.jpg": new Uint8Array(200_000),
    }),
  );
});

test("the real-byte check runs AFTER unzipSync, not only inside its filter", () => {
  // If the only guard were the filter's header sum, a lying header would walk
  // straight past it. The ordering is the whole fix, so it is asserted rather
  // than assumed.
  const source = readFileSync(new URL("./backup.ts", import.meta.url), "utf8");
  const start = source.indexOf("entries = unzipSync(");
  const end = source.indexOf("assertExpandedLimits(entries)", start);
  assert.ok(start > -1, "parseBackupZip must decompress through unzipSync");
  assert.ok(
    end > start,
    "the real-byte check must run on the extracted entries",
  );
  assert.match(
    source,
    /for \(const \[name, data\] of Object\.entries\(entries\)\)/,
  );
});
// ---------------------------------------------------------------------------
// Password-protected container through the repository
// ---------------------------------------------------------------------------

function exportDriver(): MockDriver {
  const tableResults: Queryable[][] = BACKUP_TABLES.map((t) => {
    if (t === "notes") return [NOTE_ROW];
    if (t === "photos") return [PHOTO_ROW];
    return [];
  });
  // The last query is the export's photo path/size lookup.
  tableResults.push([PHOTO_ROW]);
  return createMockDriver({ results: tableResults });
}

const PASSWORD = "a backup password";

test("exportBackup without a password still writes a plain zip, unchanged", async () => {
  const repo = createBackupRepo(exportDriver());
  const { bytes, summary, encrypted } = await repo.exportBackup();
  assert.equal(encrypted, false);
  // A zip starts with PK and the archive parser takes it exactly as before.
  assert.deepEqual(Array.from(bytes.subarray(0, 2)), [0x50, 0x4b]);
  const { parsed, inner } = await repo.inspectBackup(bytes);
  assert.equal(parsed.payload.version, BACKUP_FORMAT_VERSION);
  // rowCount sums every table: the note plus the photo row.
  assert.equal(summary.rowCount, 2);
  assert.equal(parsed.payload.data.notes?.length, 1);
  assert.equal(summary.photoCount, parsed.photos.length);
  // `inner` IS the picked file: the unencrypted path passes it straight
  // through, so nothing about that flow changed.
  assert.equal(inner, bytes);
});

test("exportBackup with a password seals the same archive in the container", async () => {
  // One driver per export: the mock hands out its canned query results in
  // order, so a second export from the same driver would read different rows.
  const plainRepo = createBackupRepo(exportDriver());
  const plain = await plainRepo.exportBackup();
  const sealed = await createBackupRepo(exportDriver()).exportBackup(PASSWORD);
  assert.equal(sealed.encrypted, true);
  assert.equal(isEncryptedBackup(sealed.bytes), true);
  // 60 bytes of envelope, and nothing else.
  const plainParsed = parseBackupZip(plain.bytes);
  const opened = parseBackupZip(
    await openBackupContainer(sealed.bytes, PASSWORD),
  );
  assert.deepEqual(opened.payload.data.notes, plainParsed.payload.data.notes);
  // Same library in both, so the counts a person reads must agree. The
  // timestamps cannot: each export stamps its own moment.
  const { summary: plainSummary } = await plainRepo.inspectBackup(plain.bytes);
  const { summary, inner } = await createBackupRepo(
    exportDriver(),
  ).inspectBackup(sealed.bytes, PASSWORD);
  assert.deepEqual(
    { ...summary, exportedAt: null },
    { ...plainSummary, exportedAt: null },
  );
  assert.equal(typeof summary.exportedAt, "string");
  assert.equal(isEncryptedBackup(inner), false);
  assert.equal(inner.length, sealed.bytes.length - 60);
});

test("inspectBackup refuses a wrong password and writes nothing at all", async () => {
  const driver = exportDriver();
  const repo = createBackupRepo(driver);
  const { bytes } = await repo.exportBackup(PASSWORD);
  driver.calls.length = 0;
  await assert.rejects(
    () => repo.inspectBackup(bytes, "not the password"),
    WrongBackupPasswordError,
  );
  assert.equal(
    driver.calls.length,
    0,
    "a refused decrypt must not touch the database or the photos",
  );
});

test("an encrypted file asks for its password instead of guessing", async () => {
  const repo = createBackupRepo(exportDriver());
  const { bytes } = await repo.exportBackup(PASSWORD);
  await assert.rejects(() => repo.inspectBackup(bytes), /password-protected/);
  await assert.rejects(
    () => repo.inspectBackup(bytes, ""),
    /password-protected/,
  );
});

test("the encrypted input is bounded BEFORE anything is decrypted", async () => {
  assert.equal(MAX_ENCRYPTED_BACKUP_BYTES, MAX_BACKUP_ARCHIVE_BYTES + 60);
  assert.equal(exceedsEncryptedBackupCap(MAX_ENCRYPTED_BACKUP_BYTES), false);
  assert.equal(exceedsEncryptedBackupCap(MAX_ENCRYPTED_BACKUP_BYTES + 1), true);
  assert.equal(exceedsEncryptedBackupCap(0), false);

  // This container is BOTH truncated-looking and over the cap. Only the size
  // refusal can be reported if the cap is checked before the header is read.
  // (The reported byteLength is stubbed: allocating 128 MiB per assertion is
  // not a test, and the cap arithmetic above is pinned separately.)
  const container = await sealBackupContainer(
    zipWithPayload(samplePayload()),
    PASSWORD,
  );
  Object.defineProperty(container, "byteLength", {
    value: MAX_ENCRYPTED_BACKUP_BYTES + 1,
  });
  const repo = createBackupRepo(exportDriver());
  await assert.rejects(
    () => repo.inspectBackup(container, PASSWORD),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /larger than the .* byte limit/);
      assert.doesNotMatch(e.message, /cut short|does not open/);
      return true;
    },
  );
});

test("the inner archive is validated with every existing limit after decryption", async () => {
  // A sealed archive whose manifest is over the row cap is still refused: the
  // zip-level rules run on the authenticated plaintext, and they run for the
  // encrypted path exactly as they do for the plain one.
  const overCap = zipWithPayload({
    ...samplePayload(),
    data: {
      ...emptyTables(),
      notes: Array.from({ length: MAX_BACKUP_ROWS + 1 }, (_, i) => ({
        ...NOTE_ROW,
        id: i + 1,
      })),
    },
  });
  const sealedOverCap = await sealBackupContainer(overCap, PASSWORD);
  const repo = createBackupRepo(exportDriver());
  await assert.rejects(
    () => repo.inspectBackup(sealedOverCap, PASSWORD),
    /rows/i,
  );
  // And the same archive, unencrypted, is refused the same way — one parser,
  // one set of limits.
  await assert.rejects(() => repo.inspectBackup(overCap), /rows/i);
});

test("an unencrypted archive is never asked for a password", async () => {
  const repo = createBackupRepo(exportDriver());
  const { bytes } = await repo.exportBackup();
  const { summary } = await repo.inspectBackup(bytes, PASSWORD);
  assert.equal(summary.rowCount, 2); // the note and the photo row
  assert.equal(summary.photoCount, 1);
});

test("a file that is not a backup at all is refused by the zip parser, as before", async () => {
  const repo = createBackupRepo(exportDriver());
  await assert.rejects(
    () => repo.inspectBackup(Uint8Array.from([1, 2, 3, 4, 5])),
    /not a valid zip file/i,
  );
});

test("the safety copy takes a label, never a destination", async () => {
  // The import confirm step calls this before anything is deleted. Rust
  // composes the folder under app-data from the label, so a renderer cannot
  // point the copy somewhere else — that is the whole reason it is not a
  // `saveBackupFile(path, …)` call.
  const driver = createMockDriver();
  const repo = createBackupRepo(driver);
  const path = await repo.saveSafetyCopy("2026-10-20T14-05");
  assert.match(path, /pre-import-2026-10-20T14-05$/);
  assert.deepEqual(first(driver.callsTo("safetyBackupCopy"), "safety").args, [
    "2026-10-20T14-05",
  ]);
});

test("a failed safety copy rejects, so the import can be abandoned", async () => {
  // Swallowing this would restore exactly the bug: a destructive import whose
  // undo silently did not exist.
  const driver = createMockDriver({ error: new Error("disk full") });
  const repo = createBackupRepo(driver);
  await assert.rejects(() => repo.saveSafetyCopy("x"), /disk full/);
});

test("importBackup runs its onBeforeImport hook before the first write (J5)", async () => {
  // The hook is where in-memory state that belongs to the rows being
  // replaced must die — the vault's key cache through the composition
  // root. If it ran after the first write, a key could survive into the
  // replaced data.
  const driver = createMockDriver({ results: [[]] });
  let hooked = 0;
  const repo = createBackupRepo(driver, {
    onBeforeImport: () => {
      hooked += 1;
      assert.equal(driver.callsTo("savePhoto").length, 0, "no photo write yet");
      assert.equal(driver.callsTo("batch").length, 0, "no batch yet");
      assert.equal(driver.callsTo("execute").length, 0, "no execute yet");
    },
  });
  const bytes = await buildBackupZip(samplePayload(), samplePhotos());
  const result = await repo.importBackup(bytes);
  assert.ok(result.photos === 1, "the import itself still applied");
  assert.equal(hooked, 1, "exactly once per import");
});

test("the onBeforeImport hook runs even when the import fails (J5)", async () => {
  // The data is not replaced on a failed parse, but the hook must still be
  // unconditional — a caller cannot know in advance which imports fail.
  const driver = createMockDriver();
  let hooked = 0;
  const repo = createBackupRepo(driver, {
    onBeforeImport: () => {
      hooked += 1;
    },
  });
  await assert.rejects(
    () => repo.importBackup(Uint8Array.from([1, 2, 3, 4, 5])),
    /not a valid zip file/i,
  );
  assert.equal(hooked, 1);
});

test("app.ts locks the vault before an import replaces the data (J5)", () => {
  // The hook tests above prove the seam; this proves the production
  // composition root wires the vault into it — an unhooked repo keeps
  // every test green while the stale-CryptoKey window stays open.
  const app = readFileSync(
    new URL("../../src/data/app.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    app,
    /onBeforeImport: \(\) => vaultRepo\.lockVault\(\)/,
    "importBackup must invalidate the vault's key cache for every caller",
  );
});

test("export -> inspect -> import round-trips a password-protected backup", async () => {
  // The whole ship criterion in miniature: one library, sealed to disk,
  // inspected through a password, and applied from exactly the bytes that were
  // inspected.
  const { bytes, encrypted } = await createBackupRepo(
    exportDriver(),
  ).exportBackup(PASSWORD);
  assert.equal(encrypted, true);

  const importer = createMockDriver({ results: [[]] });
  const repo = createBackupRepo(importer);
  const { inner, summary } = await repo.inspectBackup(bytes, PASSWORD);
  assert.equal(summary.photoCount, 1);
  const result = await repo.importBackup(inner);
  assert.equal(result.rows, 2); // the note and the photo row
  assert.equal(result.photos, 1);
  // The bytes that were validated are the bytes that were written.
  const statements = first(importer.callsTo("batch"), "batch").args[0] as {
    sql: string;
  }[];
  const inserts = statements.filter((s) =>
    s.sql.startsWith("INSERT INTO notes"),
  );
  assert.equal(inserts.length, 1);
});

// -- Referential check on import (review P3-5) --------------------------------
// The payload is parsed, not produced by this app, and the batch runs FK-off —
// so a hand-crafted file could commit rows whose parent does not exist. The
// check runs as the batch's LAST statement, inside the same transaction: a
// violation must roll the whole batch back and leave the pre-import data
// exactly as it was. This needs the shipped schema, so the fixture reads
// BASELINE_SQL out of schema.rs (source-reading, like `ipc.test.ts`) instead of
// a second hand-copied schema that could drift.

function baselineSql(): string {
  const src = readFileSync(
    new URL("../../src-tauri/src/schema.rs", import.meta.url),
    "utf8",
  );
  const match = /pub const BASELINE_SQL: &str = r#"([\s\S]*?)"#;/.exec(src);
  assert.ok(match, "BASELINE_SQL must be readable from schema.rs");
  const sql = match[1];
  assert.ok(sql !== undefined, "BASELINE_SQL body must be captured");
  return sql;
}

const OFF_SHARE = {
  running: false,
  url: null,
  key: null,
  port: null,
  publishedAt: null,
  note: null,
};

function importDriver(): DataDriver & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(baselineSql());
  return {
    db,
    async query<T extends Queryable>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async execute(
      sql: string,
      params: unknown[] = [],
    ): Promise<ExecuteOutcome> {
      const r = db.prepare(sql).run(...(params as never[]));
      return {
        rowsAffected: Number(r.changes),
        lastInsertRowid: Number(r.lastInsertRowid),
      };
    },
    async batch(statements: BatchStatement[]) {
      db.exec("BEGIN");
      for (const [idx, statement] of statements.entries()) {
        try {
          db.prepare(statement.sql).run(
            ...((statement.params ?? []) as never[]),
          );
        } catch (error) {
          db.exec("ROLLBACK");
          // Speak the Rust `db::batch` error contract verbatim (db.rs:
          // "batch statement {idx} failed and was rolled back") — applyBackup
          // recognizes the FK canary by that index, so the harness must report
          // failures the same way production does.
          throw new Error(
            `batch statement ${idx} failed and was rolled back: execute failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      db.exec("COMMIT");
    },
    async begin() {},
    async commit() {},
    async rollback() {},
    async resetTxn() {},
    async savePhoto() {
      return "photos/2026/10/x.jpg";
    },
    async readPhoto() {
      return new Uint8Array(0);
    },
    async readPhotoThumb() {
      return new Uint8Array(0);
    },
    async savePhotoThumb() {
      return "photos/2026/10/x.thumb.jpg";
    },
    async deletePhoto() {},
    async saveBackupFile() {},
    async saveExportFile() {},
    async saveDbKeyFile() {},
    async shareStart() {
      return OFF_SHARE;
    },
    async shareStop() {
      return OFF_SHARE;
    },
    async shareStatus() {
      return OFF_SHARE;
    },
    async sharePublish() {
      return OFF_SHARE;
    },
    async safetyBackupCopy() {
      throw new Error("no safety copy in this test driver");
    },
    async shareArm() {
      return "";
    },
  };
}

test("a hand-crafted payload with a dangling row is refused and the current data survives (P3-5)", async () => {
  const driver = importDriver();
  const { db } = driver;

  // Pre-import state the refusal must leave untouched.
  db.exec(
    "INSERT INTO collections (name, created_at) VALUES ('Mine', '2026-01-01')",
  );
  db.exec(`INSERT INTO notes (title, content, tags, collection_id, pinned, archived, created_at, updated_at)
           SELECT 'current', 'kept', '', id, 0, 0, '2026-01-01', '2026-01-01'
           FROM collections WHERE name = 'Mine'`);
  db.exec("INSERT INTO settings (key, value) VALUES ('p3-5-probe', 'kept')");

  // The dangling row: a note filed under collection 99, which no payload table
  // contains. parseBackupZip does not check plain column references — only
  // links/trash shapes — so this reaches the batch in production too if it
  // came from a hand-edited file.
  const payload: BackupPayload = {
    app: BACKUP_APP,
    version: BACKUP_FORMAT_VERSION,
    exportedAt: "2026-10-12T03:00:00.000Z",
    data: { notes: [{ ...NOTE_ROW, collection_id: 99 }] },
  };

  await assert.rejects(
    () => applyBackup(driver, { payload, photos: [] }),
    /refers to rows the backup does not contain/,
    "the refusal must be the clear message, not raw SQLite text",
  );

  // The batch rolled back: every pre-import row is exactly as it was…
  const note = db
    .prepare("SELECT content FROM notes WHERE title = 'current'")
    .get() as { content: string } | undefined;
  assert.equal(note?.content, "kept", "the pre-import note survived");
  const collection = db
    .prepare("SELECT count(*) AS n FROM collections WHERE name = 'Mine'")
    .get() as { n: number };
  assert.equal(collection.n, 1, "the pre-import collection survived");
  const setting = db
    .prepare("SELECT value FROM settings WHERE key = 'p3-5-probe'")
    .get() as { value: string } | undefined;
  assert.equal(setting?.value, "kept", "pre-import settings survived");
  // The dangling note was NOT committed…
  const dangling = db
    .prepare("SELECT count(*) AS n FROM notes WHERE collection_id = 99")
    .get() as { n: number };
  assert.equal(dangling.n, 0, "the dangling row must not be committed");
  // …the canary never survived either, and FK enforcement is back on.
  const canary = db
    .prepare("SELECT count(*) AS n FROM settings WHERE key = 'import-fk-check'")
    .get() as { n: number };
  assert.equal(canary.n, 0, "the canary probe row must not be committed");
  const fk = db.prepare("PRAGMA foreign_keys").get() as {
    foreign_keys: number;
  };
  assert.equal(fk.foreign_keys, 1, "FK must be restored after the refusal");
});

test("a clean payload still imports — the FK canary stays silent (P3-5)", async () => {
  // The check must not fire on app-shaped data: a valid import still commits.
  const driver = importDriver();
  const { db } = driver;
  db.exec(
    "INSERT INTO collections (name, created_at) VALUES ('Mine', '2026-01-01')",
  );
  db.exec("INSERT INTO settings (key, value) VALUES ('p3-5-probe', 'kept')");

  const payload: BackupPayload = {
    app: BACKUP_APP,
    version: BACKUP_FORMAT_VERSION,
    exportedAt: "2026-10-12T03:00:00.000Z",
    data: {
      collections: [{ id: 7, name: "Imported", created_at: "2026-02-02" }],
      notes: [{ ...NOTE_ROW, collection_id: 7 }],
    },
  };
  const result = await applyBackup(driver, { payload, photos: [] });
  assert.equal(result.rows, 2);

  const note = db
    .prepare("SELECT collection_id FROM notes WHERE id = 1")
    .get() as { collection_id: number };
  assert.equal(note.collection_id, 7, "the valid import committed");
  const gone = db
    .prepare("SELECT count(*) AS n FROM collections WHERE name = 'Mine'")
    .get() as { n: number };
  assert.equal(gone.n, 0, "the replacement still happened");
  const fk = db.prepare("PRAGMA foreign_keys").get() as {
    foreign_keys: number;
  };
  assert.equal(fk.foreign_keys, 1);
});
