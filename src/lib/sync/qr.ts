/**
 * The QR half of pairing — protocol §11.1 (Phase C Session 4, task N.3/N.6).
 *
 * One payload, two implementations of the same standard: the desktop renders
 * the offer (`qrcode`), the phone scans it (`jsqr`). Neither library knows
 * anything about pairing, so this module keeps the pairing meaning in
 * `pairing.ts` and treats the QR as a lossless pipe — which is exactly what the
 * round-trip test checks: render → decode → `parseOffer` must give back the
 * offer that went in, byte for byte.
 *
 * Rendering is done from the module matrix rather than a canvas so the desktop
 * webview and the Node tests produce the same pixels from the same code.
 */
import jsQR from "jsqr";
import QRCode from "qrcode";
import {
  encodeOffer,
  type PairingOffer,
  type ParsedOffer,
  parseOffer,
} from "./pairing.ts";

/** Error-correction level M: ~15% recovery, the usual choice for a code shown
 * on a screen and read by a hand-held camera. */
const ERROR_CORRECTION = "M" as const;

/** Modules of quiet zone around the code. Without it many scanners miss the
 * finder patterns — this is part of the code, not decoration. */
export const QR_QUIET_ZONE = 4;

export interface QrMatrix {
  /** Modules per side, excluding the quiet zone. */
  size: number;
  /** Row-major, `size * size`, 1 = dark. */
  data: Uint8Array;
}

export interface QrPixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** The module matrix for a payload. Throws for a payload too large to encode —
 * a pairing offer never is, and silently truncating one would be worse. */
export function qrMatrix(payload: string): QrMatrix {
  const code = QRCode.create(payload, {
    errorCorrectionLevel: ERROR_CORRECTION,
  });
  return { size: code.modules.size, data: code.modules.data };
}

/**
 * The code as an SVG. One path of squares, integer coordinates: crisp at any
 * size, and no image encoder in the bundle. `moduleSize` is device pixels per
 * module; the quiet zone is included in the viewBox.
 */
export function qrSvg(payload: string, moduleSize = 4): string {
  const matrix = qrMatrix(payload);
  const side = matrix.size + QR_QUIET_ZONE * 2;
  const rects: string[] = [];
  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.data[y * matrix.size + x] === 1) {
        rects.push(`M${x + QR_QUIET_ZONE} ${y + QR_QUIET_ZONE}h1v1h-1z`);
      }
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}"`,
    ` width="${side * moduleSize}" height="${side * moduleSize}"`,
    ` shape-rendering="crispEdges" role="img">`,
    // Named colours, not hex literals: the token lint keeps raw colours out of
    // app code, and a QR is black on white by definition (modules are either
    // dark or light, never a brand colour — a tinted code is a scanner bug).
    `<rect width="${side}" height="${side}" fill="white"/>`,
    `<path d="${rects.join("")}" fill="black"/>`,
    "</svg>",
  ].join("");
}

/** RGBA pixels for a decoder: what a camera frame would look like. */
export function qrPixels(
  matrix: QrMatrix,
  scale = 8,
  quietZone = QR_QUIET_ZONE,
): QrPixels {
  const side = (matrix.size + quietZone * 2) * scale;
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const moduleX = Math.floor(x / scale) - quietZone;
      const moduleY = Math.floor(y / scale) - quietZone;
      const dark =
        moduleX >= 0 &&
        moduleY >= 0 &&
        moduleX < matrix.size &&
        moduleY < matrix.size &&
        matrix.data[moduleY * matrix.size + moduleX] === 1;
      const value = dark ? 0 : 255;
      const offset = (y * side + x) * 4;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
      data[offset + 3] = 255;
    }
  }
  return { data, width: side, height: side };
}

/** What a scanner reads, or null when there is no code in the frame. */
export function decodeQr(pixels: QrPixels): string | null {
  const found = jsQR(pixels.data, pixels.width, pixels.height);
  return found ? found.data : null;
}

/**
 * A camera frame turned into a pairing verdict (§11.1). A frame with no code,
 * a code that is not ours, and a malformed offer are all refusals with a
 * reason — the phone never pairs on half a payload.
 */
/**
 * What a scan found. The two refusals are distinct on purpose (N6):
 *
 * - `empty-frame` — no QR symbol at all, which is the normal state of a camera
 *   still looking for the desktop's screen; scanning continues.
 * - `invalid-qr` — a QR *was* read and `parseOffer` refused it (a foreign code,
 *   a wrong format version, an incomplete offer). Scanning must stop and the
 *   refusal must be shown; looping forever hid the reason completely.
 */
export type ScanResult =
  | { ok: true; offer: PairingOffer }
  | { ok: false; kind: "empty-frame" | "invalid-qr"; reason: string };

export function scanOffer(pixels: QrPixels): ScanResult {
  const payload = decodeQr(pixels);
  if (payload === null) {
    return {
      ok: false,
      kind: "empty-frame",
      reason: "no pairing code in view.",
    };
  }
  const parsed = parseOffer(payload);
  return parsed.ok
    ? parsed
    : { ok: false, kind: "invalid-qr", reason: parsed.reason };
}

/** The end-to-end proof, used by the tests and by the desktop's own smoke
 * check: the pixels a camera would see decode back to the same offer. */
export function verifyOfferQr(offer: PairingOffer): ParsedOffer {
  const payload = encodeOffer(offer);
  const matrix = qrMatrix(payload);
  const scanned = scanOffer(qrPixels(matrix));
  return scanned.ok ? scanned : { ok: false, reason: scanned.reason };
}
