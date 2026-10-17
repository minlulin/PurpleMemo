// Thumbnail box math (review M-02). The canvas half needs a document, but the
// arithmetic that decides how much of a photo is drawn — the part that can
// silently produce a zero-height canvas or an upscaled blurry tile — is pure.
// The one DOM call that can be pinned from here is read out of the source, the
// same trick `ipc.test.ts` uses on the IPC boundary.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { THUMB_IMAGE_ORIENTATION, THUMB_MAX_EDGE, thumbBox } from "./thumbs.ts";

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
