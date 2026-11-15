// Cross-device identity (docs/ANDROID_DESIGN.md, "Cross-device UID contract").
//
// Every synced record carries a UUID v4 minted by the client that creates it —
// the phone offline, the desktop at home — so the two can create records
// without coordination and pair later without renumbering anything. The value
// is identity only: not a cursor, not an ordering key, never shown to the user.
//
// `crypto.randomUUID` is the CSPRNG path both runtimes expose (WebView and
// Node's test runner). The `getRandomValues` fallback exists because the
// function is gated on secure contexts in some embedded webviews, and a
// creation flow that throws there would lose the user's record; the fallback
// is the same RFC 4122 v4 recipe, not a weaker one.

const HEX = "0123456789abcdef";

function randomBytes(count: number): Uint8Array {
  const bytes = new Uint8Array(count);
  crypto.getRandomValues(bytes);
  return bytes;
}

/**
 * A fresh canonical UUID v4 — lowercase, 36 characters.
 *
 * Throws when the runtime has no CSPRNG at all: a timestamp-based stand-in
 * would look like an identity while colliding across devices, which is the one
 * failure the contract cannot detect after the fact.
 */
export function newUid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();

  const bytes = randomBytes(16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // variant 10xx
  let out = "";
  for (let index = 0; index < bytes.length; index += 1) {
    if (index === 4 || index === 6 || index === 8 || index === 10) out += "-";
    const byte = bytes[index] ?? 0;
    out += HEX[byte >> 4] ?? "0";
    out += HEX[byte & 0x0f] ?? "0";
  }
  return out;
}

const UID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** True for a canonical lowercase UUID v4 — the shape the schema stores. */
export function isUid(value: unknown): value is string {
  return typeof value === "string" && UID_V4.test(value);
}
