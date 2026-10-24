// Thumbnail box math. The canvas half needs a document, but the
// arithmetic that decides how much of a photo is drawn — the part that can
// silently produce a zero-height canvas or an upscaled blurry tile — is pure.
// The one DOM call that can be pinned from here is read out of the source, the
// same trick `ipc.test.ts` uses on the IPC boundary.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertThumbableSource,
  MAX_THUMB_SOURCE_BYTES,
  MAX_THUMB_SOURCE_PIXELS,
  THUMB_IMAGE_ORIENTATION,
  THUMB_MAX_EDGE,
  thumbBox,
} from "./thumbs.ts";

const src = readFileSync(new URL("./thumbs.ts", import.meta.url), "utf8");

test("thumbBox: scales the longest edge to the box, keeping the ratio", () => {
  assert.deepEqual(thumbBox(4000, 3000, 480), { width: 480, height: 360 });
  assert.deepEqual(thumbBox(3000, 4000, 480), { width: 360, height: 480 });
  assert.deepEqual(thumbBox(480, 480, 480), { width: 480, height: 480 });
});

test("thumbBox: never upscales a photo smaller than the box", () => {
  assert.deepEqual(thumbBox(64, 32, 480), { width: 64, height: 32 });
});

test("thumbBox: the shrunken edge keeps at least one pixel", () => {
  // A 10000x3 panorama rounds the height to zero; a zero-height canvas throws.
  assert.deepEqual(thumbBox(10_000, 3, 480), { width: 480, height: 1 });
});

test("thumbBox: nothing to draw returns null, not a zero-sized canvas", () => {
  const invalid: [number, number][] = [
    [0, 10],
    [10, 0],
    [Number.NaN, 10],
    [10, Number.POSITIVE_INFINITY],
    [-5, 10],
  ];
  for (const [width, height] of invalid) {
    assert.equal(thumbBox(width, height), null, `${width}x${height}`);
  }
  assert.equal(thumbBox(10, 10, 0), null, "a zero box has no size to draw");
});

test("THUMB_MAX_EDGE is a tile size, not a second copy of the photo", () => {
  assert.ok(
    THUMB_MAX_EDGE >= 128 && THUMB_MAX_EDGE <= 1024,
    `THUMB_MAX_EDGE=${THUMB_MAX_EDGE} is not a thumbnail-sized edge`,
  );
});

test("the bitmap decode asks the browser to apply EXIF orientation (P2-3)", () => {
  // `createImageBitmap` defaults to `"none"`, so without this option a phone
  // photo with EXIF orientation 6/8 thumbnailed 90° sideways while the same
  // photo rendered upright in the inspector. Read out of the source because
  // `node --test` has no `createImageBitmap` to observe.
  assert.match(
    src,
    /createImageBitmap\(\s*blob,\s*\{\s*imageOrientation:\s*THUMB_IMAGE_ORIENTATION,?\s*\}\s*\)/,
    "the createImageBitmap call must pass the orientation option",
  );
  assert.notEqual(
    THUMB_IMAGE_ORIENTATION,
    "none",
    "the default is what made phone photos render sideways",
  );
});

test("the orientation value is spelled the way WebIDL spells it", () => {
  // The enum is "from-image", not "fromImage": a camelCase value is not a
  // member of `ImageOrientation`, so the browser throws a TypeError from the
  // decode instead of quietly ignoring it — which would break every thumbnail
  // on a platform where the typo shipped.
  assert.equal(THUMB_IMAGE_ORIENTATION, "from-image");
  assert.doesNotMatch(
    src,
    /imageOrientation:\s*"fromImage"/,
    "the camelCase spelling is not a member of the ImageOrientation enum",
  );
});

test("assertThumbableSource: an ordinary photo passes", () => {
  // A 12 MP phone photo: ~4 MB encoded, 4000x3000. Well inside both bounds, so
  // the guard must not get in the way of real use.
  assert.doesNotThrow(() => assertThumbableSource(4_000_000, 4000, 3000));
  assert.doesNotThrow(() => assertThumbableSource(1, 1, 1));
  // The pixel ceiling is generous on purpose: a real 12 MP photo is a small
  // fraction of it, and a 108 MP sensor photo must still thumbnailable, so the
  // bound cannot be set by what is comfortable to decode.
  const realPhoto = 4000 * 3000;
  assert.ok(
    realPhoto < MAX_THUMB_SOURCE_PIXELS * 0.25,
    `the ceiling (${MAX_THUMB_SOURCE_PIXELS}) is uncomfortably close to a real 12 MP photo (${realPhoto})`,
  );
  // A 108 MP phone photo must still get a thumbnail, or the user is left with a
  // permanent placeholder tile — a worse outcome than a slow decode.
  assert.doesNotThrow(() => assertThumbableSource(12_000_000, 12000, 9000));
});

test("assertThumbableSource: an oversized file is refused before decoding", () => {
  // P3-15: decode materialises the FULL image, so bytes are the first bound.
  assert.throws(
    () => assertThumbableSource(MAX_THUMB_SOURCE_BYTES + 1, 100, 100),
    /too large/,
  );
  assert.doesNotThrow(() =>
    assertThumbableSource(MAX_THUMB_SOURCE_BYTES, 100, 100),
  );
});

test("assertThumbableSource: a small file claiming huge dimensions is refused", () => {
  // The gap a byte bound alone leaves: a few KB of PNG header can declare
  // 100000x100000, and the decoder allocates from the DECLARED dimensions. This
  // is the bound that actually closes it.
  assert.throws(
    () => assertThumbableSource(2_000, 100_000, 100_000),
    /too many pixels/,
  );
  assert.doesNotThrow(() => assertThumbableSource(2_000, 1000, 1000));
});

test("the byte bound is checked before the decode, not only after", () => {
  // If the only guard were after decode, the allocation we are guarding against
  // would already have happened. Assert the ordering in the source: the cheap
  // length check appears before the decode call.
  const makeThumbnail = src.slice(
    src.indexOf("export async function makeThumbnail"),
  );
  const preCheck = makeThumbnail.indexOf("MAX_THUMB_SOURCE_BYTES");
  const decodeCall = makeThumbnail.indexOf("await decode(blob)");
  assert.ok(preCheck > -1, "makeThumbnail must check the byte length itself");
  assert.ok(
    preCheck < decodeCall,
    "the byte bound must be enforced before decode, not only after it",
  );
  assert.ok(
    makeThumbnail.includes("assertThumbableSource(bytes.length, decoded.width"),
    "and the decoded dimensions must be re-checked afterwards",
  );
});
