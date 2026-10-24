// Snapshot decryption for the phone page (audit F-07/F-09).
//
// This module is imported twice, by design:
//
//  * the LAN page, as `/_snapshot.js` (served by `share.rs`), and
//  * the Node test that decrypts a real payload produced by `encryptSnapshot`
//    in `src/lib/share.ts`.
//
// One module means the thing that is tested is the thing that runs. The page
// used to inline these twelve lines in a classic `<script>`, which nothing
// could execute: a typo in the AAD or the key decode would only surface on a
// phone, at runtime.
//
// It imports the vendored `@noble/ciphers` copy next door (`./_crypto/`), not
// `node_modules`. The relative path is what lets the same file work over HTTP
// (the server exposes `/_crypto/*`) and on disk (Node resolves it directly),
// and it is why the Rust build no longer depends on `npm install` having run.

import { gcm } from "./_crypto/aes.js";

/** The 32-byte key, from the 64-character hex in the URL fragment. */
export function keyBytes(hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) {
    throw new Error("Missing share key.");
  }
  return Uint8Array.from({ length: 32 }, (_, i) =>
    Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
}

/** Standard base64 -> bytes. `atob` exists in browsers and in Node 16+. */
export function base64Bytes(value) {
  if (typeof value !== "string") throw new Error("Malformed share envelope.");
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/**
 * Additional authenticated data: the format version and the snapshot's own
 * timestamp. It is exactly what `encryptSnapshot` in `src/lib/share.ts`
 * authenticates, so the envelope's version and timestamp cannot be edited on
 * the wire — a mismatch fails the GCM tag check rather than decrypting.
 */
export function envelopeAad(envelope) {
  if (
    typeof envelope?.version !== "number" ||
    typeof envelope?.generatedAt !== "string"
  ) {
    throw new Error("Malformed share envelope.");
  }
  return new TextEncoder().encode(
    `purple-memo/share/v${envelope.version}\0${envelope.generatedAt}`,
  );
}

/**
 * Decrypt a published envelope into the snapshot object.
 *
 * Throws on a wrong key, a tampered envelope, or a malformed one; the caller
 * shows one message either way, because the user's action is the same (open the
 * current link from the desktop).
 */
export function decryptSnapshot(envelope, keyHex) {
  const key = keyBytes(keyHex);
  const aad = envelopeAad(envelope);
  const plaintext = gcm(key, base64Bytes(envelope.nonce), aad).decrypt(
    base64Bytes(envelope.ciphertext),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}
