// Thumbnail box math and the header probe that guards the decode. The canvas
// half needs a document, but the arithmetic that decides how much of a photo
// is drawn — the part that can silently produce a zero-height canvas or an
// upscaled blurry tile — is pure, and so is reading a declared size out of a
// file header. The rest is read out of the source, the same trick `ipc.test.ts`
// uses on the IPC boundary.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  assertThumbableSource,
  MAX_THUMB_SOURCE_BYTES,
  MAX_THUMB_SOURCE_PIXELS,
  makeThumbnail,
  probeImageSize,
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

// ---------------------------------------------------------------------------
// I1 — the pixel ceiling has to be applied BEFORE the decode, because both
// decoder paths allocate their raster from the declared size. The fixtures
// below are the first few dozen bytes of each container: enough to declare a
// size, far too little to be an image.
// ---------------------------------------------------------------------------

function writeAscii(bytes: Uint8Array, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    bytes[offset + i] = text.charCodeAt(i);
  }
}

/** A PNG whose IHDR declares `width x height`. */
function pngDeclaring(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13, false); // length of the IHDR chunk
  writeAscii(bytes, 12, "IHDR");
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return bytes;
}

/** A JPEG whose frame header (SOF0, one component) declares the size. */
function jpegDeclaring(width: number, height: number): Uint8Array {
  return Uint8Array.from([
    0xff,
    0xd8, // SOI
    0xff,
    0xc0,
    0x00,
    0x0b, // SOF0, segment length 11
    0x08, // sample precision
    (height >> 8) & 0xff,
    height & 0xff,
    (width >> 8) & 0xff,
    width & 0xff,
    0x01, // one colour component
    0x01,
    0x11,
    0x00,
  ]);
}

/** A GIF87a/89a logical screen descriptor declaring the size. */
function gifDeclaring(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(10);
  writeAscii(bytes, 0, "GIF89a");
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
}

/** A lossy WebP (`VP8 `) keyframe header declaring the size. */
function webpLossyDeclaring(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  writeAscii(bytes, 0, "RIFF");
  writeAscii(bytes, 8, "WEBP");
  writeAscii(bytes, 12, "VP8 ");
  bytes[23] = 0x9d;
  bytes[24] = 0x01;
  bytes[25] = 0x2a; // keyframe sync code
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

/** A lossless WebP (`VP8L`) header: two packed 14-bit edges, each minus one. */
function webpLosslessDeclaring(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(25);
  writeAscii(bytes, 0, "RIFF");
  writeAscii(bytes, 8, "WEBP");
  writeAscii(bytes, 12, "VP8L");
  bytes[20] = 0x2f; // stream signature
  const w = width - 1;
  const h = height - 1;
  bytes[21] = w & 0xff;
  bytes[22] = ((w >> 8) & 0x3f) | ((h & 0x3) << 6);
  bytes[23] = (h >> 2) & 0xff;
  bytes[24] = (h >> 10) & 0x0f;
  return bytes;
}

/** A BMP with a BITMAPINFOHEADER declaring the size (may be top-down). */
function bmpDeclaring(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(30);
  bytes[0] = 0x42;
  bytes[1] = 0x4d; // "BM"
  const view = new DataView(bytes.buffer);
  view.setUint32(14, 40, true); // DIB header size
  view.setInt32(18, width, true);
  view.setInt32(22, height, true);
  return bytes;
}

test("probeImageSize: reads the declared size out of every container it knows", () => {
  assert.deepEqual(probeImageSize(pngDeclaring(4000, 3000)), {
    width: 4000,
    height: 3000,
  });
  assert.deepEqual(probeImageSize(jpegDeclaring(12000, 9000)), {
    width: 12000,
    height: 9000,
  });
  assert.deepEqual(probeImageSize(gifDeclaring(640, 480)), {
    width: 640,
    height: 480,
  });
  assert.deepEqual(probeImageSize(webpLossyDeclaring(1920, 1080)), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(probeImageSize(webpLosslessDeclaring(1600, 900)), {
    width: 1600,
    height: 900,
  });
  // A negative BMP height is a row order, not a size.
  assert.deepEqual(probeImageSize(bmpDeclaring(800, -600)), {
    width: 800,
    height: 600,
  });
});

test("probeImageSize: an unreadable header answers null, never throws", () => {
  assert.equal(probeImageSize(new Uint8Array(0)), null);
  assert.equal(
    probeImageSize(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])),
    null,
  );
  // Truncated mid-header.
  assert.equal(probeImageSize(pngDeclaring(100, 100).slice(0, 20)), null);
  // Right magic, wrong inner marker: decline rather than read garbage.
  const brokenPng = pngDeclaring(100, 100);
  brokenPng[12] = 0x58; // "XHDR"
  assert.equal(probeImageSize(brokenPng), null);
  // SOI straight into a start-of-scan: no frame header was ever declared.
  assert.equal(
    probeImageSize(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02])),
    null,
  );
});

test("makeThumbnail refuses an over-ceiling file before either decoder runs (I1)", async () => {
  // `node --test` has neither `createImageBitmap` nor `Image`, so a rejection
  // that says "too many pixels" can only have come from the header probe —
  // the guard fired before either decoder path was reached. The same must hold
  // for the JPEG walk, which is a different probe.
  const png = pngDeclaring(100_000, 100_000);
  assert.ok(
    png.length < MAX_THUMB_SOURCE_BYTES,
    "it is the pixel bound that rejects this file, not the byte bound",
  );
  await assert.rejects(() => makeThumbnail(png), /too many pixels/);
  await assert.rejects(
    () => makeThumbnail(jpegDeclaring(65_535, 65_535)),
    /too many pixels/,
  );
});

test("the preflight does not stand between an ordinary photo and the decoder (I1)", async () => {
  const failure = await makeThumbnail(pngDeclaring(4000, 3000)).then(
    () => null,
    (e: unknown) => (e instanceof Error ? e : new Error(String(e))),
  );
  assert.ok(
    failure !== null,
    "header-only bytes cannot decode anywhere — expected a decoder failure",
  );
  assert.doesNotMatch(
    failure.message,
    /too many pixels|too large/,
    "the guards passed: the decoder was reached, as it must be for a real photo",
  );
});

test("the header bound is applied before the decode in the source (I1)", () => {
  // Both decoder paths live inside `decode`, so a check placed before that one
  // call covers `createImageBitmap` and the `<img>` fallback alike.
  const body = src.slice(src.indexOf("export async function makeThumbnail"));
  const probe = body.indexOf("probeImageSize(bytes)");
  const decodeCall = body.indexOf("await decode(blob)");
  assert.ok(probe > -1, "makeThumbnail must read the declared size itself");
  assert.ok(decodeCall > -1, "and must still decode afterwards");
  assert.ok(
    probe < decodeCall,
    "the header bound must be enforced before the decode, not only after it",
  );
});
