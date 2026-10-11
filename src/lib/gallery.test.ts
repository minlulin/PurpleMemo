// Gallery repository (§2.7): saving identical bytes twice returns the
// existing row instead of violating the rel_path UNIQUE constraint; photo
// links resolve by photo id; extensions come from the picked file name.

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
  const bytes = [10, 20, 30, 40];
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
