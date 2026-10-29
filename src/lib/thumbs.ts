// Thumbnail generation. The gallery grid used to read every
// photo at full resolution and keep all of those bytes alive as object URLs —
// hundreds of MB for a real library. A thumbnail is generated once (at import,
// or lazily the first time a grid tile needs one) and stored next to its photo
// by the Rust side, so the grid reads ~30 kB per tile instead of megabytes.
//
// The box arithmetic and the header-size probe are pure and tested; the
// decode/encode half needs a document and is exercised by the app, not by
// `node --test`.

/** Longest edge of a stored thumbnail, in pixels. */
export const THUMB_MAX_EDGE = 480;
/** JPEG quality for the stored thumbnail (0-1). */
export const THUMB_QUALITY = 0.72;
export const THUMB_MIME = "image/jpeg";

/**
 * EXIF orientation for the thumbnail decode (review P2-3).
 *
 * `createImageBitmap` defaults to `"none"`, which ignores the EXIF orientation
 * tag — so a phone photo taken in portrait (orientation 6 or 8) produced a
 * thumbnail rotated 90°, sitting in a grid next to the same photo rendered
 * upright in the inspector, which honours it via `<img>`
 * (`image-orientation: from-image`). The `<img>` fallback in `decode` below
 * produced oriented pixels all along, so the module was internally
 * inconsistent as well as wrong.
 *
 * **The hyphen is not a typo.** WebIDL spells this enum value `"from-image"`;
 * the camelCase `"fromImage"` that TypeScript's own `ImageOrientation` type
 * might suggest is not a member of the enum and throws a `TypeError` from the
 * browser rather than degrading. `thumbs.test.ts` pins the spelling.
 */
export const THUMB_IMAGE_ORIENTATION = "from-image";

/**
 * The largest `width x height` box that fits inside `maxEdge` while keeping
 * the aspect ratio — the size the photo is drawn at. Never upscales (a photo
 * smaller than the box keeps its own size) and `null` when there is nothing
 * to draw, which the caller treats as "no thumbnail for this file".
 */
export function thumbBox(
  width: number,
  height: number,
  maxEdge: number = THUMB_MAX_EDGE,
): { width: number; height: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  if (width < 1 || height < 1 || maxEdge < 1) return null;
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Decode `blob` into something drawable, without leaking an object URL. */
async function decode(blob: Blob): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  release: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob, {
      imageOrientation: THUMB_IMAGE_ORIENTATION,
    });
    return {
      source: bitmap,
      width: bitmap.width,
      height: bitmap.height,
      release: () => bitmap.close(),
    };
  }
  // Older WebKitGTK/WKWebView without createImageBitmap: decode through an
  // <img> pulled from an object URL. The URL is revoked as soon as the pixels
  // are available, so a failed decode cannot leak one.
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    return {
      source: image,
      width: image.naturalWidth,
      height: image.naturalHeight,
      release: () => undefined,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Guard on the bytes before anything decodes them (review P3-15).
 *
 * `decode` hands the whole file to `createImageBitmap`, which materialises the
 * *full* uncompressed image — not the thumbnail. A 100-megapixel phone photo is a
 * ~5 MB file and ~400 MB of pixels, so a single oversized or deliberately
 * crafted file could exhaust renderer memory with no way back short of a
 * restart. The thumbnail is at most `THUMB_MAX_EDGE` on a side, so anything
 * large enough to matter is already beyond what this function can use.
 *
 * Two bounds, because each alone leaves a gap:
 * - encoded size, so a huge file is rejected before it is read into a decoder;
 * - pixel count, because a small file can still declare huge dimensions
 *   (a few kilobytes of PNG header claim 100000x100000).
 *
 * The pixel bound runs **twice** (I1). First on the size read straight out of
 * the file's header by {@link probeImageSize}, *before* either decoder is
 * handed the blob — both `createImageBitmap` and `<img>.decode()` allocate
 * their raster from the declared size, so this is the check that refuses the
 * allocation. Then again on the size the decoder reports, as defence in depth
 * for a container the probe could not read. The second call alone was the old
 * bug: by then the decoder had already run.
 *
 * Both ceilings are set by what real cameras produce, not by what is
 * comfortable to decode. 150 MP is comfortably above a 108 MP phone sensor
 * (12000x9000 = 108 MP) and 64 MB covers a high-quality full-size JPEG of one;
 * tighter bounds would reject a user's genuine photo and leave them with a
 * permanent placeholder tile, which is a worse outcome than a slow thumbnail.
 * They still refuse the crafted cases by orders of magnitude (100000x100000 is
 * 10^10 pixels, 66x the ceiling). Lower them only alongside a plan for the
 * photos that would stop thumbnailing.
 */
export const MAX_THUMB_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_THUMB_SOURCE_PIXELS = 150_000_000; // ~150 MP

/**
 * Throw when a source is too big to thumbnail safely — on the byte count and
 * the pixel count together.
 *
 * Called twice by {@link makeThumbnail}: once on the header-declared size
 * before the decode and once on the decoded size after it, so each bound is
 * enforced in both orders (I1).
 */
export function assertThumbableSource(
  byteLength: number,
  width: number,
  height: number,
): void {
  if (byteLength > MAX_THUMB_SOURCE_BYTES) {
    throw new Error(
      `photo is too large to thumbnail (${Math.round(byteLength / 1024 / 1024)} MB)`,
    );
  }
  if (width * height > MAX_THUMB_SOURCE_PIXELS) {
    throw new Error(
      `photo declares too many pixels to thumbnail (${width}x${height})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Declared size, read from the header (I1)
// ---------------------------------------------------------------------------

/** The edges a file claims for itself, as its header declares them. */
export interface DeclaredSize {
  width: number;
  height: number;
}

/** `null` unless both edges are whole positive pixels. */
function edges(width: number, height: number): DeclaredSize | null {
  if (width < 1 || height < 1) return null;
  return { width, height };
}

/** Does `bytes` hold the ASCII `text` at `offset`? */
function holdsAscii(bytes: Uint8Array, offset: number, text: string): boolean {
  if (bytes.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

/** A view over the bytes themselves — never over a whole shared ArrayBuffer. */
function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** PNG: the 8-byte signature, then a 13-byte IHDR chunk (width, height BE). */
function probePng(bytes: Uint8Array): DeclaredSize | null {
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((b, i) => bytes[i] === b)) return null;
  if (!holdsAscii(bytes, 12, "IHDR")) return null;
  const view = viewOf(bytes);
  return edges(view.getUint32(16, false), view.getUint32(20, false));
}

/**
 * JPEG: walk the marker segments to the frame header (SOF), which carries the
 * precision, then height and width, both big-endian.
 *
 * The walk stops at the start of scan (0xDA) — entropy-coded data follows it,
 * and a JPEG that never declared a frame before its scan is unreadable anyway.
 * SOF markers are 0xC0–0xCF minus 0xC4 (a Huffman table), 0xC8 (a JPG
 * extension) and 0xCC (an arithmetic-coding table), which share the range but
 * are not frame headers.
 */
function probeJpeg(bytes: Uint8Array): DeclaredSize | null {
  if (bytes.length < 4) return null;
  const view = viewOf(bytes);
  if (view.getUint8(0) !== 0xff || view.getUint8(1) !== 0xd8) return null;
  let pos = 2;
  while (pos + 1 < bytes.length) {
    if (view.getUint8(pos) !== 0xff) return null; // out of step with markers
    const marker = view.getUint8(pos + 1);
    if (marker === 0xff) {
      pos += 1; // fill byte before a marker
      continue;
    }
    // Standalone markers carry no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      pos += 2;
      continue;
    }
    if (marker === 0x00 || marker === 0xda) return null; // stuffed byte | scan
    if (pos + 4 > bytes.length) return null;
    const length = view.getUint16(pos + 2);
    if (length < 2) return null;
    const isFrame =
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc;
    if (isFrame) {
      if (pos + 9 > bytes.length) return null;
      const height = view.getUint16(pos + 5);
      const width = view.getUint16(pos + 7);
      return edges(width, height);
    }
    pos += 2 + length; // skip the whole segment (APPn, DQT, DHT, …)
  }
  return null;
}

/** GIF: `GIF87a`/`GIF89a`, then the logical screen size, both little-endian. */
function probeGif(bytes: Uint8Array): DeclaredSize | null {
  if (bytes.length < 10) return null;
  if (!holdsAscii(bytes, 0, "GIF8")) return null;
  // The version digit is a 7 or a 9, then the trailing "a".
  if (bytes[4] !== 0x37 && bytes[4] !== 0x39) return null;
  if (bytes[5] !== 0x61) return null;
  const view = viewOf(bytes);
  return edges(view.getUint16(6, true), view.getUint16(8, true));
}

/**
 * WebP: `RIFF….WEBP`, then one of three chunk layouts — the lossy keyframe
 * (`VP8 `, sync code 9D 01 2A then two 14-bit edges), the lossless stream
 * (`VP8L`, signature 2F then two packed 14-bit edges minus one), or the
 * extended canvas (`VP8X`, two 24-bit edges minus one).
 */
function probeWebp(bytes: Uint8Array): DeclaredSize | null {
  if (bytes.length < 25) return null;
  if (!holdsAscii(bytes, 0, "RIFF") || !holdsAscii(bytes, 8, "WEBP")) {
    return null;
  }
  const view = viewOf(bytes);
  if (holdsAscii(bytes, 12, "VP8 ")) {
    if (bytes.length < 30) return null;
    if (
      view.getUint8(23) !== 0x9d ||
      view.getUint8(24) !== 0x01 ||
      view.getUint8(25) !== 0x2a
    ) {
      return null;
    }
    return edges(
      view.getUint16(26, true) & 0x3fff,
      view.getUint16(28, true) & 0x3fff,
    );
  }
  if (holdsAscii(bytes, 12, "VP8L")) {
    if (view.getUint8(20) !== 0x2f) return null;
    const lowW = view.getUint8(21);
    const packed = view.getUint8(22);
    const highH = view.getUint8(24);
    const width = 1 + lowW + ((packed & 0x3f) << 8);
    const height =
      1 +
      (((packed & 0xc0) >>> 6) |
        (view.getUint8(23) << 2) |
        ((highH & 0x0f) << 10));
    return edges(width, height);
  }
  if (holdsAscii(bytes, 12, "VP8X")) {
    if (bytes.length < 30) return null;
    const width =
      1 +
      (view.getUint8(24) |
        (view.getUint8(25) << 8) |
        (view.getUint8(26) << 16));
    const height =
      1 +
      (view.getUint8(27) |
        (view.getUint8(28) << 8) |
        (view.getUint8(29) << 16));
    return edges(width, height);
  }
  return null;
}

/**
 * BMP: `BM`, a DIB header at offset 14. The 12-byte core header stores two
 * 16-bit edges; every later one stores two 32-bit signed edges, where a
 * negative height means top-down rows rather than a negative size.
 */
function probeBmp(bytes: Uint8Array): DeclaredSize | null {
  if (bytes.length < 26 || bytes[0] !== 0x42 || bytes[1] !== 0x4d) return null;
  const view = viewOf(bytes);
  if (view.getUint32(14, true) === 12) {
    return edges(view.getUint16(18, true), view.getUint16(20, true));
  }
  return edges(
    Math.abs(view.getInt32(18, true)),
    Math.abs(view.getInt32(22, true)),
  );
}

/**
 * The `width x height` a file declares, read from its header alone — no
 * decode, no allocation (I1).
 *
 * The declared size is the one number both decoders allocate from, so it is
 * the only size checkable *before* they run. Five containers cover what a
 * desktop picker hands a photo app (JPEG, PNG, GIF, WebP, BMP); anything else
 * answers `null` and falls through to the decode, where `makeThumbnail`'s
 * post-decode check still runs.
 *
 * A malformed or truncated header answers `null` rather than throwing: this
 * probe is allowed to be wrong about a size (the decode re-checks it), never
 * to reject a photo on its own.
 */
export function probeImageSize(bytes: Uint8Array): DeclaredSize | null {
  return (
    probePng(bytes) ??
    probeJpeg(bytes) ??
    probeGif(bytes) ??
    probeWebp(bytes) ??
    probeBmp(bytes)
  );
}

/**
 * Downscale encoded image bytes to a JPEG thumbnail. Rejects when the webview
 * cannot decode the file (an unknown format, or a corrupt one) — the caller
 * keeps a placeholder tile and the inspector still offers the full bytes.
 */
export async function makeThumbnail(
  bytes: Uint8Array,
  maxEdge: number = THUMB_MAX_EDGE,
): Promise<Uint8Array> {
  // Cheap pre-check: refuses an oversized file before it is decoded at all.
  if (bytes.length > MAX_THUMB_SOURCE_BYTES) {
    throw new Error(
      `photo is too large to thumbnail (${Math.round(bytes.length / 1024 / 1024)} MB)`,
    );
  }
  // Pre-decode pixel bound (I1): the header is already in hand, so the
  // decoder's biggest allocation can be refused before either decoder path
  // sees the blob — a crafted 100000x100000 never reaches
  // `createImageBitmap` or `<img>.decode()`. A container this module cannot
  // read answers null and keeps the post-decode check below.
  const declared = probeImageSize(bytes);
  if (declared !== null) {
    assertThumbableSource(bytes.length, declared.width, declared.height);
  }
  const blob = new Blob([bytes as BlobPart]);
  const decoded = await decode(blob);
  try {
    // Post-decode check (defence in depth): the decoder has now reported the
    // dimensions it really allocated, so a header the probe could not read is
    // still caught here — before a single pixel of it is drawn.
    assertThumbableSource(bytes.length, decoded.width, decoded.height);
    const box = thumbBox(decoded.width, decoded.height, maxEdge);
    if (box === null) throw new Error("photo has no pixels to thumbnail");
    const canvas = document.createElement("canvas");
    canvas.width = box.width;
    canvas.height = box.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("no 2d canvas context available");
    context.drawImage(decoded.source, 0, 0, box.width, box.height);
    const encoded = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, THUMB_MIME, THUMB_QUALITY),
    );
    if (encoded === null) throw new Error("thumbnail encoding failed");
    return new Uint8Array(await encoded.arrayBuffer());
  } finally {
    decoded.release();
  }
}
