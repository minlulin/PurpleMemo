// Thumbnail box math (review M-02). The canvas half needs a document, but the
// arithmetic that decides how much of a photo is drawn — the part that can
// silently produce a zero-height canvas or an upscaled blurry tile — is pure.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { THUMB_MAX_EDGE, thumbBox } from "./thumbs.ts";

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
