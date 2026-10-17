// Thumbnail generation (review M-02). The gallery grid used to read every
// photo at full resolution and keep all of those bytes alive as object URLs —
// hundreds of MB for a real library. A thumbnail is generated once (at import,
// or lazily the first time a grid tile needs one) and stored next to its photo
// by the Rust side, so the grid reads ~30 kB per tile instead of megabytes.
//
// The box arithmetic is pure and tested; the decode/encode half needs a
// document and is exercised by the app, not by `node --test`.

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
 * - pixel count *after* decode, because a small file can still declare huge
 *   dimensions (a few kilobytes of PNG header claim 100000x100000).
 *
 * The pixel bound is checked on the *declared* dimensions, which is what the
 * decoder allocates from, so the expensive allocation is what gets refused.
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

/** Throw before decoding if the file is too big to thumbnail safely. */
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
  const blob = new Blob([bytes as BlobPart]);
  const decoded = await decode(blob);
  try {
    // Post-decode check: the decoder has already reported the dimensions it
    // allocated, so a crafted header claiming impossible size is caught here
    // rather than becoming the allocation itself.
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
