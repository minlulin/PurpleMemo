// Crypto module (§2.9 PIN lock, §5.3 vault). PBKDF2-SHA256 at 600k
// iterations for both the PIN hash and the vault key; vault items are
// AES-256-GCM with a per-item salt + IV (plain base64 in the DB). All
// primitives are WebCrypto — available in the browser and in Node 24 tests.

export const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
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

function randomBytes(len: number): Uint8Array {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return bytes;
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
// PIN lock (§2.9) — salted PBKDF2-SHA256; the PIN itself is never stored
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
  let diff = 0;
  for (let i = 0; i < hash.length; i++) {
    const h = hash[i];
    const e = expected[i];
    if (h === undefined || e === undefined) return false;
    diff |= h ^ e;
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
// Vault (§5.3) — separate password; per-item salt + IV; no recovery
// ---------------------------------------------------------------------------

export interface VaultKey {
  key: CryptoKey;
  salt: string; // base64 password salt (stored in settings)
}

/** Derive a vault key from a password + the setup salt. */
export async function deriveVaultKey(
  password: string,
  saltB64: string,
): Promise<CryptoKey> {
  const salt = b64ToBytes(saltB64);
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
      iterations: PBKDF2_ITERATIONS,
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
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
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  return { ciphertext: bytesToB64(new Uint8Array(sealed)), iv: bytesToB64(iv) };
}

export async function decryptWithKey(
  key: CryptoKey,
  cipher: VaultCipher,
): Promise<string> {
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64ToBytes(cipher.iv) as BufferSource },
    key,
    b64ToBytes(cipher.ciphertext) as BufferSource,
  );
  return new TextDecoder().decode(plain);
}
