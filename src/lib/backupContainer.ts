// Password-protected backup container.
//
// The backup archive itself is unchanged: a zip of `backup.json` + `photos/`.
// When the user asks for a password, that zip is sealed inside a fixed-layout
// envelope so the file on disk is inert without the password, while the file
// still opens as "not a zip" rather than as a broken zip.
//
// Container v1 layout (fixed; changing any of it needs a new version):
//   0-7    ASCII "PURPLEBK"
//   8-9    container version, unsigned big-endian (1)
//   10     KDF id (1 = PBKDF2-SHA256)
//   11     cipher id (1 = AES-256-GCM)
//   12-15  iteration count, unsigned big-endian (exactly 600,000 in v1)
//   16-31  salt, 16 fresh bytes per export
//   32-43  IV, 12 fresh bytes per export
//   44..   AES-256-GCM ciphertext with the 16-byte tag appended
//
// Bytes 0-43 are the AAD, so every parameter is authenticated: flipping the
// iteration count or the IV makes the tag fail instead of producing an archive
// that decrypts to something else. The parameters are NOT secret — this is
// deliberate, so a reader can reject an unsupported container before spending
// a key derivation on it.

import {
  decryptBytesWithKey,
  deriveAesGcmKey,
  encryptBytesWithKey,
  PBKDF2_ITERATIONS,
  randomBytes,
} from "./crypto.ts";

export const BACKUP_CONTAINER_MAGIC = "PURPLEBK";
export const BACKUP_CONTAINER_VERSION = 1;
export const BACKUP_CONTAINER_HEADER_BYTES = 44;
export const BACKUP_CONTAINER_SALT_BYTES = 16;
export const BACKUP_CONTAINER_IV_BYTES = 12;
/** AES-GCM's tag length, which WebCrypto appends to the ciphertext. */
export const BACKUP_CONTAINER_TAG_BYTES = 16;
/** What encryption adds to the archive it seals. */
export const BACKUP_CONTAINER_OVERHEAD_BYTES =
  BACKUP_CONTAINER_HEADER_BYTES + BACKUP_CONTAINER_TAG_BYTES;
export const BACKUP_CONTAINER_KDF_PBKDF2_SHA256 = 1;
export const BACKUP_CONTAINER_CIPHER_AES_256_GCM = 1;
/** Distinct from `.zip`, so the two files are not confused on disk or in a dialog. */
export const ENCRYPTED_BACKUP_EXTENSION = "pmbk";
export const ENCRYPTED_BACKUP_MIME = "application/vnd.purplememo.backup";

export interface BackupContainerHeader {
  version: number;
  kdf: number;
  cipher: number;
  iterations: number;
  salt: Uint8Array;
  iv: Uint8Array;
}

/**
 * The file is not a container this app can read: wrong magic, an unknown
 * version, or a KDF/cipher/iteration count v1 does not define. Fails closed —
 * nothing is written, and no key derivation is attempted.
 */
export class UnsupportedBackupContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedBackupContainerError";
  }
}

/** The bytes are a v1 container's shape but are cut short. */
export class CorruptBackupContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CorruptBackupContainerError";
  }
}

/**
 * The password did not open this archive — AES-GCM's tag check failed. This
 * is also what a modified header or a tampered payload raises, so the message
 * must not claim which one it was.
 */
export class WrongBackupPasswordError extends Error {
  constructor(
    message = "That password does not open this backup. Nothing was changed.",
  ) {
    super(message);
    this.name = "WrongBackupPasswordError";
  }
}

/**
 * Magic bytes, never "the zip parser choked". An encrypted file is not a
 * corrupt zip, and saying so would send the user looking for a bad download.
 */
export function isEncryptedBackup(bytes: Uint8Array): boolean {
  if (bytes.byteLength < BACKUP_CONTAINER_MAGIC.length) return false;
  for (let i = 0; i < BACKUP_CONTAINER_MAGIC.length; i++) {
    if (bytes[i] !== BACKUP_CONTAINER_MAGIC.charCodeAt(i)) return false;
  }
  return true;
}

/** The 44 header bytes, big-endian, exactly as v1 fixes them. Pure. */
export function encodeContainerHeader(
  header: BackupContainerHeader,
): Uint8Array {
  const out = new Uint8Array(BACKUP_CONTAINER_HEADER_BYTES);
  for (let i = 0; i < BACKUP_CONTAINER_MAGIC.length; i++) {
    out[i] = BACKUP_CONTAINER_MAGIC.charCodeAt(i);
  }
  out[8] = (header.version >>> 8) & 0xff;
  out[9] = header.version & 0xff;
  out[10] = header.kdf;
  out[11] = header.cipher;
  out[12] = (header.iterations >>> 24) & 0xff;
  out[13] = (header.iterations >>> 16) & 0xff;
  out[14] = (header.iterations >>> 8) & 0xff;
  out[15] = header.iterations & 0xff;
  out.set(header.salt, 16);
  out.set(header.iv, 32);
  return out;
}

/**
 * Parse and validate the header. Every rejection here happens before any key
 * is derived, so a file with unknown parameters costs nothing.
 */
export function readContainerHeader(bytes: Uint8Array): BackupContainerHeader {
  if (!isEncryptedBackup(bytes)) {
    throw new UnsupportedBackupContainerError(
      "This is not a password-protected Purple Memo backup.",
    );
  }
  if (bytes.byteLength < BACKUP_CONTAINER_HEADER_BYTES) {
    throw new CorruptBackupContainerError(
      "This backup is cut short before its header ends — import rejected.",
    );
  }
  const version = ((bytes[8] as number) << 8) | (bytes[9] as number);
  if (version !== BACKUP_CONTAINER_VERSION) {
    throw new UnsupportedBackupContainerError(
      version > BACKUP_CONTAINER_VERSION
        ? `This backup uses backup format ${version}, which this version of the app cannot read — update the app, then import it.`
        : `This backup uses backup format ${version}, which this version of the app cannot read.`,
    );
  }
  const kdf = bytes[10] as number;
  if (kdf !== BACKUP_CONTAINER_KDF_PBKDF2_SHA256) {
    throw new UnsupportedBackupContainerError(
      `This backup was written with key-derivation method ${kdf}, which this app does not support — import rejected.`,
    );
  }
  const cipher = bytes[11] as number;
  if (cipher !== BACKUP_CONTAINER_CIPHER_AES_256_GCM) {
    throw new UnsupportedBackupContainerError(
      `This backup was written with cipher ${cipher}, which this app does not support — import rejected.`,
    );
  }
  const iterations =
    (((bytes[12] as number) << 24) |
      ((bytes[13] as number) << 16) |
      ((bytes[14] as number) << 8) |
      (bytes[15] as number)) >>>
    0;
  if (iterations !== PBKDF2_ITERATIONS) {
    throw new UnsupportedBackupContainerError(
      `This backup was written with ${iterations.toLocaleString()} key iterations, which this app does not accept — import rejected.`,
    );
  }
  if (
    bytes.byteLength <
    BACKUP_CONTAINER_HEADER_BYTES + BACKUP_CONTAINER_TAG_BYTES
  ) {
    throw new CorruptBackupContainerError(
      "This backup ends before its authentication tag — import rejected.",
    );
  }
  return {
    version,
    kdf,
    cipher,
    iterations,
    salt: bytes.slice(16, 32),
    iv: bytes.slice(32, BACKUP_CONTAINER_HEADER_BYTES),
  };
}

/**
 * Seal a zip archive under `password`.
 *
 * Fresh salt and IV per export, from the OS CSPRNG: reusing either across two
 * archives under the same password would leak the relationship between them.
 * An empty password is refused here rather than in the UI, so no backup is
 * ever written that anybody can open.
 */
export async function sealBackupContainer(
  archive: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  if (password === "") {
    throw new Error("A backup password cannot be empty.");
  }
  const header = encodeContainerHeader({
    version: BACKUP_CONTAINER_VERSION,
    kdf: BACKUP_CONTAINER_KDF_PBKDF2_SHA256,
    cipher: BACKUP_CONTAINER_CIPHER_AES_256_GCM,
    iterations: PBKDF2_ITERATIONS,
    salt: randomBytes(BACKUP_CONTAINER_SALT_BYTES),
    iv: randomBytes(BACKUP_CONTAINER_IV_BYTES),
  });
  const key = await deriveAesGcmKey(
    password,
    header.slice(16, 32),
    PBKDF2_ITERATIONS,
  );
  const sealed = await encryptBytesWithKey(
    key,
    header.slice(32, BACKUP_CONTAINER_HEADER_BYTES),
    archive,
    header,
  );
  const container = new Uint8Array(
    BACKUP_CONTAINER_HEADER_BYTES + sealed.length,
  );
  container.set(header, 0);
  container.set(sealed, BACKUP_CONTAINER_HEADER_BYTES);
  return container;
}

/**
 * Authenticate and decrypt a container, returning the zip archive inside.
 *
 * The AAD is the container's own first 44 bytes, read from the file — not a
 * re-encoding of the parsed values — so a single flipped header byte fails the
 * tag check instead of being normalised away.
 */
export async function openBackupContainer(
  container: Uint8Array,
  password: string,
): Promise<Uint8Array> {
  const header = readContainerHeader(container);
  const aad = container.subarray(0, BACKUP_CONTAINER_HEADER_BYTES);
  const key = await deriveAesGcmKey(password, header.salt, header.iterations);
  try {
    return await decryptBytesWithKey(
      key,
      header.iv,
      container.subarray(BACKUP_CONTAINER_HEADER_BYTES),
      aad,
    );
  } catch (e) {
    if (e instanceof Error && e.name === "OperationError") {
      throw new WrongBackupPasswordError();
    }
    throw e;
  }
}
