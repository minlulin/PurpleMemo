// Crypto module (PIN lock,  vault). PBKDF2-SHA256 at 600k
// iterations for both the PIN hash and the vault key; vault items are
// AES-256-GCM with a per-item salt + IV (plain base64 in the DB). All
// primitives are WebCrypto — available in the browser and in Node 24 tests.

export const PBKDF2_ITERATIONS = 600_000;
export const SALT_BYTES = 16;
const IV_BYTES = 12;

// ---------------------------------------------------------------------------
// base64 helpers (browser + Node, no Buffer dependency)
// ---------------------------------------------------------------------------

export function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ---------------------------------------------------------------------------
// SHA-256 hex (photo dedup, vault fingerprints — single shared copy)
// ---------------------------------------------------------------------------

/** SHA-256 of bytes -> lowercase hex. */
export async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** SHA-256 of a UTF-8 string -> lowercase hex. */
export async function sha256HexText(text: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(text));
}

/**
 * Cryptographically random bytes from the OS source. Exported so salt and IV
 * generation has exactly one implementation — the vault repo used to
 * hand-roll its own copies of this and hard-code the 16-byte length.
 */
export function randomBytes(len: number): Uint8Array {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** A fresh base64 salt of `SALT_BYTES`, as stored in the DB. */
export function randomSaltB64(): string {
  return bytesToB64(randomBytes(SALT_BYTES));
}

// ---------------------------------------------------------------------------
// PBKDF2-SHA256 (PIN hash, vault key)
// ---------------------------------------------------------------------------

async function pbkdf2Sha256(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    keyMaterial,
    256,
  );
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// PIN lock — salted PBKDF2-SHA256; the PIN itself is never stored
// ---------------------------------------------------------------------------

export interface PinHash {
  salt: string; // base64
  hash: string; // base64
  iterations: number;
}

export async function hashPin(pin: string): Promise<PinHash> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await pbkdf2Sha256(pin, salt, PBKDF2_ITERATIONS);
  return {
    salt: bytesToB64(salt),
    hash: bytesToB64(hash),
    iterations: PBKDF2_ITERATIONS,
  };
}

export async function verifyPin(
  pin: string,
  stored: PinHash,
): Promise<boolean> {
  const hash = await pbkdf2Sha256(
    pin,
    b64ToBytes(stored.salt),
    stored.iterations,
  );
  const expected = b64ToBytes(stored.hash);
  if (hash.length !== expected.length) return false;
  // Both arrays have the same verified length; Uint8Array indexing within
  // bounds always returns number — no undefined check needed.
  let diff = 0;
  for (let i = 0; i < hash.length; i++) {
    diff |= (hash[i] as number) ^ (expected[i] as number);
  }
  return diff === 0;
}

/** Security-question answers are compared case/space-insensitively. */
export function normalizeAnswer(answer: string): string {
  return answer.trim().toLowerCase().replace(/\s+/g, " ");
}

export async function hashAnswer(answer: string): Promise<PinHash> {
  return hashPin(normalizeAnswer(answer));
}

export async function verifyAnswer(
  answer: string,
  stored: PinHash,
): Promise<boolean> {
  return verifyPin(normalizeAnswer(answer), stored);
}

// ---------------------------------------------------------------------------
// Vault — separate password; per-item salt + IV; no recovery
// ---------------------------------------------------------------------------

export interface VaultKey {
  key: CryptoKey;
  salt: string; // base64 password salt (stored in settings)
}

/**
 * How many PBKDF2 iterations back the vault key cache's password tag
 * (review P3-19).
 *
 * The cache needs *something* that identifies which password an entry belongs
 * to, so that a wrong password cannot be answered from it. This used to be an
 * unsalted SHA-256 of the password, which is the wrong material entirely:
 * SHA-256 is dictionary-crackable at billions of hashes per second, so keeping
 * one in memory throws back exactly what PBKDF2 was bought to buy, and makes
 * the non-extractable `CryptoKey` beside it pointless — the password is the
 * cheaper way in.
 *
 * Deliberately **not** the full {@link PBKDF2_ITERATIONS}: the tag is compared
 * on every cache lookup, so matching it to the key's cost would double unlock
 * time for no extra protection. 100k is the same floor `classifyPin` accepts as
 * "not weak", and it is still ~4 orders of magnitude away from a plain hash —
 * far too slow to make an in-memory copy worth stealing.
 */
export const VAULT_TAG_ITERATIONS = 100_000;

/**
 * A slow, password-specific tag for the vault key cache — see
 * {@link VAULT_TAG_ITERATIONS}.
 *
 * Derived from the item's own salt, so two items cached under the same password
 * do not share a tag and a leak of one reveals nothing about the other.
 */
export async function deriveVaultTag(
  password: string,
  saltB64: string,
): Promise<string> {
  const salt = b64ToBytes(saltB64);
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: new Uint8Array([...salt, 0x9e]) as BufferSource, // domain-separated
      iterations: VAULT_TAG_ITERATIONS,
    },
    keyMaterial,
    256,
  );
  return bytesToB64(new Uint8Array(bits));
}

/** Derive a vault key from a password + the setup salt. */
export async function deriveVaultKey(
  password: string,
  saltB64: string,
): Promise<CryptoKey> {
  return deriveAesGcmKey(password, b64ToBytes(saltB64), PBKDF2_ITERATIONS);
}

// ---------------------------------------------------------------------------
// Raw AES-256-GCM over bytes, with optional additional authenticated data
// ---------------------------------------------------------------------------

/**
 * PBKDF2-SHA256 -> AES-256-GCM, the one derivation shape both callers want:
 * the vault (its setup salt) and the encrypted backup container (a fresh salt
 * per export). The password is encoded as UTF-8 exactly as typed — no trimming,
 * no Unicode normalization — so what the user typed is what is stretched.
 */
export async function deriveAesGcmKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: salt as BufferSource,
      iterations,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * AES-256-GCM over raw bytes.
 *
 * `additionalData` is authenticated but not encrypted: passing the container
 * header here is what makes a flipped parameter byte fail the tag check
 * instead of silently producing a different but "valid" archive.
 */
export async function encryptBytesWithKey(
  key: CryptoKey,
  iv: Uint8Array,
  plaintext: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const sealed = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: additionalData as BufferSource | undefined,
    },
    key,
    plaintext as BufferSource,
  );
  return new Uint8Array(sealed);
}

/**
 * AES-256-GCM open. Throws `OperationError` when the tag does not verify —
 * wrong key, modified header, or tampered ciphertext; callers translate that
 * into the one message they may honestly show.
 */
export async function decryptBytesWithKey(
  key: CryptoKey,
  iv: Uint8Array,
  ciphertext: Uint8Array,
  additionalData?: Uint8Array,
): Promise<Uint8Array> {
  const opened = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: iv as BufferSource,
      additionalData: additionalData as BufferSource | undefined,
    },
    key,
    ciphertext as BufferSource,
  );
  return new Uint8Array(opened);
}

/** Create a fresh vault: new password salt + derived key (the key is never stored). */
export async function createVaultKey(password: string): Promise<VaultKey> {
  const salt = randomBytes(SALT_BYTES);
  const key = await deriveVaultKey(password, bytesToB64(salt));
  return { key, salt: bytesToB64(salt) };
}

export interface VaultCipher {
  ciphertext: string; // base64
  iv: string; // base64, per-item
}

export async function encryptWithKey(
  key: CryptoKey,
  plaintext: string,
): Promise<VaultCipher> {
  const iv = randomBytes(IV_BYTES);
  const sealed = await encryptBytesWithKey(
    key,
    iv,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: bytesToB64(sealed), iv: bytesToB64(iv) };
}

export async function decryptWithKey(
  key: CryptoKey,
  cipher: VaultCipher,
): Promise<string> {
  const plain = await decryptBytesWithKey(
    key,
    b64ToBytes(cipher.iv),
    b64ToBytes(cipher.ciphertext),
  );
  return new TextDecoder().decode(plain);
}
