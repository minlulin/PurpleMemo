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
    const bitmap = await createImageBitmap(blob);
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
 * Downscale encoded image bytes to a JPEG thumbnail. Rejects when the webview
 * cannot decode the file (an unknown format, or a corrupt one) — the caller
 * keeps a placeholder tile and the inspector still offers the full bytes.
 */
export async function makeThumbnail(
  bytes: Uint8Array,
  maxEdge: number = THUMB_MAX_EDGE,
): Promise<Uint8Array> {
  const blob = new Blob([bytes as BlobPart]);
  const decoded = await decode(blob);
  try {
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
