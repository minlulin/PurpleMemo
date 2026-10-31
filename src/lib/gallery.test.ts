// Gallery repository: saving identical bytes twice returns the
// existing row instead of violating the rel_path UNIQUE constraint; photo
// links resolve by photo id; extensions come from the picked file name; and
// bytes are `Uint8Array` on both sides of the driver, never a
// JSON array of byte numbers.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { BatchStatement } from "../data/driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import { at, first } from "../test-utils.ts";
import { MAX_BACKUP_PHOTO_BYTES } from "./backup.ts";
import {
  assertPickablePhotoSize,
  createGalleryRepo,
  createThumbUrlBook,
  deleteLinkedEntity,
  isPhotoCleanupPending,
  isUniqueViolation,
  PhotoCleanupPendingError,
  photoExtFromName,
} from "./gallery.ts";
import { createMemoriesRepo } from "./memories.ts";
import { createNotesRepo } from "./notes.ts";
import type { PhotoRefEntity } from "./types.ts";

test("savePhoto: duplicate bytes return the existing row, no second INSERT", async () => {
  const driver = createMockDriver({
    results: [
      [], // first save: no existing row for rel_path
      [{ id: 7 }], // second save: row already exists
    ],
  });
  const gallery = createGalleryRepo(driver);
  const bytes = Uint8Array.from([10, 20, 30, 40]);
  const first = await gallery.savePhoto({ bytes, ext: "jpg" });
  assert.equal(first, 1);
  const second = await gallery.savePhoto({ bytes, ext: "jpg" });
  assert.equal(second, 7);
  const inserts = driver
    .callsTo("execute")
    .filter((c) => /INSERT INTO photos/.test(c.args[0] as string));
  assert.equal(inserts.length, 1);
});

test("photoExtFromName: lowercases the last extension, sane fallback", () => {
  assert.equal(photoExtFromName("Photo.PNG"), "png");
  assert.equal(photoExtFromName("a.b.jpg"), "jpg");
  assert.equal(photoExtFromName("holiday pic.heic"), "heic");
});

test("photoExtFromName: missing or hostile extensions fall back to bin", () => {
  assert.equal(photoExtFromName("noextension"), "bin");
  assert.equal(photoExtFromName("weird.<script>"), "bin");
  assert.equal(photoExtFromName(""), "bin");
});

test("assertPickablePhotoSize: the picker refuses at the door what Rust refuses at the body (I2)", () => {
  // The preflight must never narrow the limit: at the ceiling and below, the
  // file is read exactly as before.
  assert.doesNotThrow(() => assertPickablePhotoSize(MAX_BACKUP_PHOTO_BYTES));
  assert.doesNotThrow(() => assertPickablePhotoSize(1));
  assert.doesNotThrow(() => assertPickablePhotoSize(0));
  // One byte over, and the native refusal's own words come back — the user
  // sees the same sentence either way.
  assert.throws(
    () => assertPickablePhotoSize(MAX_BACKUP_PHOTO_BYTES + 1),
    /unrestorable/,
  );
  assert.throws(
    () => assertPickablePhotoSize(MAX_BACKUP_PHOTO_BYTES + 1),
    /25 MiB/,
  );
  assert.throws(
    () => assertPickablePhotoSize(2 * 1024 * 1024 * 1024),
    /2048\.0 MiB/,
  );
});

test("listRefsForPhoto: queries photo_refs scoped by photo id", async () => {
  const driver = createMockDriver({
    results: [[{ id: 3, photo_id: 9, entity_type: "memory", entity_id: 4 }]],
  });
  const gallery = createGalleryRepo(driver);
  const refs = await gallery.listRefsForPhoto(9);
  const call = driver.lastCall();
  assert.ok(call);
  const [sql, params] = call.args as [string, unknown[]];
  assert.match(sql, /FROM photo_refs WHERE photo_id = \?/);
  assert.deepEqual(params, [9]);
  assert.equal(refs[0]?.entity_type, "memory");
});

test("savePhoto hands the driver raw bytes, never a number array", async () => {
  const driver = createMockDriver({ results: [[]] });
  const gallery = createGalleryRepo(driver);
  const bytes = Uint8Array.from([9, 8, 7]);
  await gallery.savePhoto({ bytes, ext: "png" });
  const [saved, ext] = driver.callsTo("savePhoto")[0]?.args ?? [];
  assert.ok(saved instanceof Uint8Array, "raw bytes cross the driver");
  assert.equal(ext, "png");
  // size_bytes describes the bytes that were stored, not a re-encoding.
  const insert = driver
    .callsTo("execute")
    .find((c) => /INSERT INTO photos/.test(c.args[0] as string));
  assert.ok(insert, "the photo row was inserted");
  const params = insert.args[1] as unknown[];
  assert.equal(params[3], 3);
});

test("readThumbBytes: a stored thumbnail reads back; a missing one rejects", async () => {
  // Row lookup, then the thumb read — the driver owns the path derivation.
  // The rel_path is a real content-addressed source path (D1-1): anything
  // else is refused by the driver before any thumbnail is looked for.
  const driver = createMockDriver({
    results: [[{ id: 4, rel_path: `photos/2026/10/${"a".repeat(64)}.jpg` }]],
  });
  const gallery = createGalleryRepo(driver);
  await assert.rejects(
    gallery.readThumbBytes(4),
    /no thumbnail/,
    "no thumbnail yet is a rejection the page turns into generation",
  );
  assert.deepEqual(driver.callsTo("readPhotoThumb")[0]?.args, [
    `photos/2026/10/${"a".repeat(64)}.jpg`,
  ]);
});

test("saveThumb writes the thumbnail against the photo's own path", async () => {
  const driver = createMockDriver({
    results: [[{ id: 4, rel_path: `photos/2026/10/${"a".repeat(64)}.jpg` }]],
  });
  const gallery = createGalleryRepo(driver);
  await gallery.saveThumb(4, Uint8Array.from([1, 2]));
  const [source, bytes] = driver.callsTo("savePhotoThumb")[0]?.args ?? [];
  assert.equal(source, `photos/2026/10/${"a".repeat(64)}.jpg`);
  assert.ok(bytes instanceof Uint8Array);
});

test("readPhotoBytes returns the driver's bytes unchanged", async () => {
  const driver = createMockDriver({
    results: [[{ id: 2, rel_path: "photos/2026/10/bb.jpg" }]],
  });
  const gallery = createGalleryRepo(driver);
  const bytes = await gallery.readPhotoBytes(2);
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(Array.from(bytes ?? []), [1, 2, 3]);
});

test("updatePhoto writes only the provided fields", async () => {
  const driver = createMockDriver();
  const gallery = createGalleryRepo(driver);
  await gallery.updatePhoto(5, { note: "beach trip" });
  const call = driver.lastCall();
  assert.ok(call);
  const [sql, params] = call.args as [string, unknown[]];
  assert.match(sql, /UPDATE photos SET note = \? WHERE id = \?/);
  assert.deepEqual(params, ["beach trip", 5]);
});

// -- Grid object URLs (review P2-4) ------------------------------------------------
// `URL.createObjectURL` needs a document, so the book is driven with a counting
// stand-in. The property that matters is the leak: every URL handed out is
// revoked exactly once, and never while the grid still points at it.

/** A fake `URL` pair that records what is minted and what is revoked. */
function fakeUrls() {
  let minted = 0;
  const revoked: string[] = [];
  return {
    io: {
      create: () => `blob:fake-${++minted}`,
      revoke: (url: string) => {
        revoked.push(url);
      },
    },
    revoked,
  };
}

test("swap revokes the previous set even when the photo is still in the grid", () => {
  // The regression. `loadThumbs` mints a NEW url for every photo on every
  // reload, and the old code only revoked previous entries whose id was absent
  // from the new map — so every still-visible photo leaked its first url
  // (~30 kB) on every "Add photos" batch.
  const { io, revoked } = fakeUrls();
  const book = createThumbUrlBook(io);
  const first = new Map([
    [1, book.create(Uint8Array.of(1))],
    [2, book.create(Uint8Array.of(2))],
  ]);
  book.swap(first);
  assert.deepEqual(revoked, [], "nothing to revoke on the first load");

  // Same two photos, freshly minted urls, plus the one that was just imported.
  const second = new Map([
    [1, book.create(Uint8Array.of(1))],
    [2, book.create(Uint8Array.of(2))],
    [3, book.create(Uint8Array.of(3))],
  ]);
  book.swap(second);
  assert.deepEqual(
    revoked,
    [first.get(1), first.get(2)],
    "both still-visible urls are revoked, not just the absent id",
  );
  assert.deepEqual([...book.current().values()], [...second.values()]);
  assert.equal(revoked.length, new Set(revoked).size, "revoked exactly once");
});

test("swap keeps a url the new grid still points at", () => {
  // The other direction: revoking a url that is still in use would blank the
  // tile, which is why the rule is "revoke what is no longer referenced".
  const { io, revoked } = fakeUrls();
  const book = createThumbUrlBook(io);
  const kept = book.create(Uint8Array.of(1));
  const dropped = book.create(Uint8Array.of(2));
  book.swap(
    new Map([
      [1, kept],
      [2, dropped],
    ]),
  );
  book.swap(new Map([[1, kept]]));
  assert.deepEqual(revoked, [dropped]);
  assert.deepEqual([...book.current().keys()], [1]);
});

test("swap copies the map it is given, so a later mutation cannot leak", () => {
  const { io } = fakeUrls();
  const book = createThumbUrlBook(io);
  const handed = new Map([[1, book.create(Uint8Array.of(1))]]);
  const live = book.swap(handed);
  handed.set(2, book.create(Uint8Array.of(2)));
  assert.deepEqual([...book.current().keys()], [1]);
  // And revoking through `clear` cannot reach a url the book never adopted.
  assert.equal(live.size, 1);
});

test("drop revokes one photo and leaves the rest of the grid alone", () => {
  const { io, revoked } = fakeUrls();
  const book = createThumbUrlBook(io);
  const a = book.create(Uint8Array.of(1));
  const b = book.create(Uint8Array.of(2));
  book.swap(
    new Map([
      [1, a],
      [2, b],
    ]),
  );
  const next = book.drop(1);
  assert.deepEqual(revoked, [a]);
  assert.deepEqual([...next.keys()], [2]);
  // Idempotent: dropping an id the grid does not have revokes nothing.
  book.drop(99);
  assert.deepEqual(revoked, [a]);
});

test("clear revokes everything, and a cancelled load revokes its own urls", () => {
  const { io, revoked } = fakeUrls();
  const book = createThumbUrlBook(io);
  const a = book.create(Uint8Array.of(1));
  book.swap(new Map([[1, a]]));
  // A load that is cancelled mid-flight mints urls the book never tracked —
  // `revokeAll` is the only way to release those.
  const orphan = book.create(Uint8Array.of(2));
  book.revokeAll([orphan]);
  book.clear();
  assert.deepEqual(revoked.sort(), [a, orphan].sort());
  assert.equal(book.current().size, 0);
});

// -- Deleting a linked entity (review P2-12) ---------------------------------------

test("deleteLinkedEntity: removes the entity's photo links in the same batch", () => {
  // The regression. `photo_refs` has ON DELETE CASCADE on `photo_id` but
  // nothing cascades its polymorphic `(entity_type, entity_id)`, so a bare
  // `DELETE FROM notes` left rows the Gallery Inspector rendered as `Note #12`
  // under "Linked to" — a link to a note that no longer existed.
  const statements = deleteLinkedEntity("note", 12);
  assert.equal(statements.length, 2, "both deletes, one atomic batch");
  assert.deepEqual(statements[0], {
    sql: "DELETE FROM photo_refs WHERE entity_type = ? AND entity_id = ?",
    params: ["note", 12],
  });
  assert.deepEqual(statements[1], {
    sql: "DELETE FROM notes WHERE id = ?",
    params: [12],
  });
  // Links first, so this stays correct if a real FK is ever added.
  assert.match(statements[0].sql, /photo_refs/);
  assert.match(statements[1].sql, /notes/);
});

test("deleteLinkedEntity: the ref type and the owning table cannot drift apart", () => {
  // `entity_type` is CHECK-constrained to these three values and each has one
  // fixed table, so the table is derived rather than passed in. A mismatch here
  // would delete the links of one entity and the row of another.
  const expected: [PhotoRefEntity, string][] = [
    ["note", "notes"],
    ["memory", "memories"],
    ["job", "jobs"],
  ];
  for (const [type, table] of expected) {
    const links = first(deleteLinkedEntity(type, 3), type);
    const row = at(deleteLinkedEntity(type, 3), 1, type);
    assert.deepEqual(links.params, [type, 3]);
    assert.equal(row.sql, `DELETE FROM ${table} WHERE id = ?`);
    assert.deepEqual(row.params, [3]);
  }
});

test("deleteLinkedEntity: every value it interpolates is bound, not inlined", () => {
  // The table name is the one interpolated fragment, and it can only come from
  // the closed `PHOTO_REF_TABLES` map above.
  for (const type of ["note", "memory", "job"] as PhotoRefEntity[]) {
    for (const { sql, params } of deleteLinkedEntity(type, 1)) {
      const placeholders = sql.match(/\?/g)?.length ?? 0;
      assert.equal(
        placeholders,
        params?.length ?? -1,
        `unbalanced SQL in ${sql}`,
      );
    }
  }
});

test("deleteNote: one batch, links included, never a lone row delete", async () => {
  const driver = createMockDriver({
    results: [
      [
        {
          id: 42,
          title: "note",
          content: "body",
          tags: "",
          collection_id: null,
          pinned: 0,
          archived: 0,
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
      ],
      [],
      [],
      [],
    ],
  });
  const notes = createNotesRepo(driver);
  await notes.deleteNote(42);
  assert.deepEqual(driver.callsTo("execute"), [], "no unbatched delete");
  // The Trash snapshot is written before links/photo refs are detached and the
  // source row is removed, all in one transaction.
  const statements = first(driver.callsTo("batch"), "deleteNote batch")
    .args[0] as BatchStatement[];
  assert.equal(statements.length, 4);
  assert.match(statements[0]?.sql ?? "", /INSERT INTO trash_items/);
  assert.match(statements[1]?.sql ?? "", /DELETE FROM links/);
  assert.match(statements[2]?.sql ?? "", /DELETE FROM photo_refs/);
  assert.match(statements[3]?.sql ?? "", /DELETE FROM notes WHERE id = \?/);
});

test("deleteMemory: one batch snapshots the row and removes its photo refs", async () => {
  const driver = createMockDriver({
    results: [
      [
        {
          id: 7,
          title: "memory",
          memory_date: "2026-01-01",
          note: "",
          created_at: "2026-01-01",
        },
      ],
      [],
      [],
    ],
  });
  const memories = createMemoriesRepo(driver);
  await memories.deleteMemory(7);
  assert.deepEqual(driver.callsTo("execute"), [], "no unbatched delete");
  const statements = first(driver.callsTo("batch"), "deleteMemory")
    .args[0] as BatchStatement[];
  assert.match(statements[0]?.sql ?? "", /INSERT INTO trash_items/);
  assert.match(statements[1]?.sql ?? "", /DELETE FROM photo_refs/);
  assert.match(statements[2]?.sql ?? "", /DELETE FROM memories WHERE id = \?/);
});

test("isUniqueViolation recognises a uniqueness failure and nothing else", () => {
  // Structural match, because the error shape differs per driver but the
  // wording of a UNIQUE failure does not.
  assert.ok(
    isUniqueViolation(new Error("UNIQUE constraint failed: photos.rel_path")),
  );
  assert.ok(
    isUniqueViolation(new Error("SQLite3Error: constraint failed: UNIQUE")),
  );
  assert.ok(!isUniqueViolation(new Error("no such table: photos")));
  assert.ok(!isUniqueViolation(new Error("database is locked")));
  assert.ok(!isUniqueViolation(undefined));
  assert.ok(!isUniqueViolation(null));
});

test("isPhotoCleanupPending separates pending cleanup from every other outcome", () => {
  // The distinction the UI relies on (M2): a completed delete throws
  // nothing, a refusal that changed nothing is a plain Error, and only the
  // typed error means "row gone, file still on disk".
  const pending = new PhotoCleanupPendingError(
    4,
    `photos/2026/10/${"a".repeat(64)}.jpg`,
    new Error("permission denied"),
  );
  assert.ok(isPhotoCleanupPending(pending));
  assert.equal(pending.photoId, 4);
  assert.equal(pending.relPath, `photos/2026/10/${"a".repeat(64)}.jpg`);
  assert.match(pending.message, /cleanup pending/);
  assert.match(
    pending.message,
    /permission denied/,
    "the driver's reason is kept",
  );
  // Look-alikes must not pass: the state is the error object, not the wording.
  assert.ok(!isPhotoCleanupPending(new Error("cleanup pending")));
  assert.ok(
    !isPhotoCleanupPending(
      new Error("This photo is held by an item in Trash."),
    ),
  );
  assert.ok(!isPhotoCleanupPending({ message: "cleanup pending" }));
  assert.ok(!isPhotoCleanupPending(undefined));
  assert.ok(!isPhotoCleanupPending(null));
});

test("deletePhoto commits the pending record with the row and never clears it on failure (M2)", async () => {
  // Row deletion and cleanup record in ONE batch: separate commits would
  // leave a crash window that recreates the orphan this fix prevents.
  const relPath = `photos/2026/10/${"b".repeat(64)}.jpg`;
  const driver = createMockDriver({
    results: [
      [], // sweep: nothing pending yet
      [{ id: 1, rel_path: relPath }], // getPhoto: the row exists
      [], // held by Trash: nobody
    ],
  });
  driver.deletePhoto = async () => {
    throw new Error("delete failed: permission denied");
  };
  const gallery = createGalleryRepo(driver);

  await assert.rejects(gallery.deletePhoto(1), (e: unknown) => {
    assert.ok(
      isPhotoCleanupPending(e),
      "a failed unlink is pending cleanup, not a success and not a plain error",
    );
    assert.equal((e as PhotoCleanupPendingError).relPath, relPath);
    return true;
  });

  const sweep = driver.callsTo("query")[0];
  assert.match(sweep?.args[0] as string, /FROM settings WHERE key LIKE/);

  const statements = first(driver.callsTo("batch"), "deletePhoto")
    .args[0] as BatchStatement[];
  assert.equal(statements.length, 2, "row and record commit atomically");
  assert.match(statements[0]?.sql ?? "", /DELETE FROM photos WHERE id = \?/);
  assert.match(statements[1]?.sql ?? "", /INSERT INTO settings/);
  assert.deepEqual(statements[1]?.params, [
    `gallery.pendingPhotoFile.1.${relPath}`,
    relPath,
  ]);

  const clears = driver
    .callsTo("execute")
    .filter((c) => /DELETE FROM settings/.test(c.args[0] as string));
  assert.equal(
    clears.length,
    0,
    "the record outlives the failure — it is cleared only after a real unlink",
  );
});

test("addRef: a link that already exists is a no-op, other failures still throw", async () => {
  // Schema v5 made (photo_id, entity_type, entity_id) unique, so the
  // second attach is refused by SQLite. The caller asked for a state the
  // database is already in, which is why the refusal is absorbed — and nothing
  // else is.
  const driver = createMockDriver();
  const gallery = createGalleryRepo(driver);
  await gallery.addRef(1, "note", 2);
  const realExecute = driver.execute;
  driver.execute = (async (sql: string, params?: unknown[]) => {
    if (/INSERT INTO photo_refs/.test(sql)) {
      throw new Error(
        "UNIQUE constraint failed: photo_refs.photo_id, photo_refs.entity_type, photo_refs.entity_id",
      );
    }
    return realExecute(sql, params);
  }) as typeof driver.execute;
  await gallery.addRef(1, "note", 2);
  driver.execute = (async () => {
    throw new Error("no such table: photo_refs");
  }) as typeof driver.execute;
  await assert.rejects(() => gallery.addRef(1, "note", 2), /no such table/);
});

test("a lost insert race returns the row it collided with, not an error", async () => {
  // P3-25: the SELECT and INSERT are a check-then-act. Two concurrent saves of
  // the same bytes can both see no row; the loser used to surface the UNIQUE
  // violation as an error, which failed a save of a picture already in the
  // library. Scripted exactly as the race happens: the pre-INSERT SELECT sees
  // nothing, the INSERT is refused, and the re-read finds the winner's row.
  const driver = createMockDriver({
    results: [[], [{ id: 7 }]], // pre-INSERT miss, then the winner's row
  });
  const gallery = createGalleryRepo(driver);
  const realExecute = driver.execute.bind(driver);
  let inserts = 0;
  driver.execute = (async (sql: string, params?: unknown[]) => {
    if (/INSERT INTO photos/.test(sql)) {
      inserts += 1;
      if (inserts === 1) {
        throw new Error("UNIQUE constraint failed: photos.rel_path");
      }
    }
    return realExecute(sql, params);
  }) as typeof driver.execute;

  const id = await gallery.savePhoto({
    bytes: Uint8Array.from([10, 20, 30, 40]),
    ext: "jpg",
  });

  assert.equal(id, 7, "the raced save resolves to the row it collided with");
  // Exactly one insert attempt: the loser must not retry the INSERT. Counted
  // here rather than via callsTo("execute"), because the interception above
  // replaces the driver's own recording for the call it throws from.
  assert.equal(inserts, 1, "one INSERT attempt, no blind retry");
  // And the re-read happened — that is the recovery, not luck.
  const selects = driver
    .callsTo("query")
    .filter((c) =>
      /SELECT id FROM photos WHERE rel_path/.test(c.args[0] as string),
    );
  assert.equal(selects.length, 2, "pre-INSERT miss plus the post-race re-read");
});

test("a lost race whose row has since vanished rethrows", async () => {
  // If the colliding row is gone again, the violation was not ours to absorb —
  // rethrow instead of inventing an id for a photo that is not there.
  const driver = createMockDriver({ results: [[], []] });
  const gallery = createGalleryRepo(driver);
  const realExecute = driver.execute.bind(driver);
  let inserts = 0;
  driver.execute = (async (sql: string, params?: unknown[]) => {
    if (/INSERT INTO photos/.test(sql)) {
      inserts += 1;
      if (inserts === 1) {
        throw new Error("UNIQUE constraint failed: photos.rel_path");
      }
    }
    return realExecute(sql, params);
  }) as typeof driver.execute;

  await assert.rejects(
    () => gallery.savePhoto({ bytes: Uint8Array.from([1, 2, 3]), ext: "jpg" }),
    /UNIQUE constraint failed/,
    "no row to absorb the race into, so the error stands",
  );
});

test("a non-uniqueness insert failure is not swallowed", async () => {
  // The recovery must not become a way to lose real errors: if the INSERT fails
  // for any other reason the caller still hears about it.
  const driver = createMockDriver();
  const gallery = createGalleryRepo(driver);
  driver.execute = (async () => {
    throw new Error("database is locked");
  }) as typeof driver.execute;

  await assert.rejects(
    () => gallery.savePhoto({ bytes: new Uint8Array([1]), ext: "jpg" }),
    /database is locked/,
    "a locked database is not a lost race and must propagate",
  );
});
