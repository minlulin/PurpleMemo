// Gallery repository (§2.7): saving identical bytes twice returns the
// existing row instead of violating the rel_path UNIQUE constraint; photo
// links resolve by photo id; extensions come from the picked file name; and
// bytes are `Uint8Array` on both sides of the driver (review M-02), never a
// JSON array of byte numbers.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMockDriver } from "../data/mock-driver.ts";
import { createGalleryRepo, photoExtFromName } from "./gallery.ts";

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
  const driver = createMockDriver({
    results: [[{ id: 4, rel_path: "photos/2026/10/aa.jpg" }]],
  });
  const gallery = createGalleryRepo(driver);
  await assert.rejects(
    gallery.readThumbBytes(4),
    /no thumbnail/,
    "no thumbnail yet is a rejection the page turns into generation",
  );
  assert.deepEqual(driver.callsTo("readPhotoThumb")[0]?.args, [
    "photos/2026/10/aa.jpg",
  ]);
});

test("saveThumb writes the thumbnail against the photo's own path", async () => {
  const driver = createMockDriver({
    results: [[{ id: 4, rel_path: "photos/2026/10/aa.jpg" }]],
  });
  const gallery = createGalleryRepo(driver);
  await gallery.saveThumb(4, Uint8Array.from([1, 2]));
  const [source, bytes] = driver.callsTo("savePhotoThumb")[0]?.args ?? [];
  assert.equal(source, "photos/2026/10/aa.jpg");
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
