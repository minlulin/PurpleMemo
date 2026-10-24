// Password-protected backup container. The layout is
// fixed by the plan, so these tests assert the bytes at their exact offsets —
// a container that decodes under a tolerant reader and not under another one
// would be a container two versions of the app disagree about.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { strFromU8 } from "fflate";
import {
  BACKUP_APP,
  BACKUP_FORMAT_VERSION,
  BACKUP_JSON_ENTRY,
  type BackupPayload,
  type BackupPhotoEntry,
  buildBackupZip,
} from "./backup.ts";
import {
  BACKUP_CONTAINER_HEADER_BYTES,
  BACKUP_CONTAINER_MAGIC,
  BACKUP_CONTAINER_OVERHEAD_BYTES,
  BACKUP_CONTAINER_TAG_BYTES,
  BACKUP_CONTAINER_VERSION,
  CorruptBackupContainerError,
  ENCRYPTED_BACKUP_EXTENSION,
  encodeContainerHeader,
  isEncryptedBackup,
  openBackupContainer,
  readContainerHeader,
  sealBackupContainer,
  UnsupportedBackupContainerError,
  WrongBackupPasswordError,
} from "./backupContainer.ts";
import { PBKDF2_ITERATIONS } from "./crypto.ts";

function samplePayload(): BackupPayload {
  return {
    app: BACKUP_APP,
    version: BACKUP_FORMAT_VERSION,
    exportedAt: "2026-10-18T03:00:00.000Z",
    data: { notes: [{ id: 1, title: "hello", content: "world" }] },
  };
}

function samplePhotos(): BackupPhotoEntry[] {
  return [
    { path: "photos/2026/10/aaa.jpg", bytes: Uint8Array.from([9, 9, 9]) },
  ];
}

const PASSWORD = "correct horse battery staple";
const ARCHIVE = Uint8Array.from({ length: 4096 }, (_, i) => (i * 7 + 3) % 256);

async function sealed(): Promise<Uint8Array> {
  return sealBackupContainer(ARCHIVE, PASSWORD);
}

test("the extension is distinct from .zip", () => {
  assert.equal(ENCRYPTED_BACKUP_EXTENSION, "pmbk");
  assert.notEqual(ENCRYPTED_BACKUP_EXTENSION, "zip");
});

test("the header occupies the exact offsets the format fixes", async () => {
  const bytes = await sealed();
  const magic = [...BACKUP_CONTAINER_MAGIC].map((c) => c.charCodeAt(0));
  expectBytes(bytes.subarray(0, 8), magic);
  // version, big-endian
  expectBytes(bytes.subarray(8, 10), [0, BACKUP_CONTAINER_VERSION]);
  expectBytes(bytes.subarray(10, 12), [1, 1]); // PBKDF2-SHA256, AES-256-GCM
  // iterations, big-endian, exactly the PIN/vault figure
  expectBytes(bytes.subarray(12, 16), [0, 0x09, 0x27, 0xc0]);
  assert.equal(PBKDF2_ITERATIONS, 600_000);
  assert.equal(bytes[12], 0);
  assert.equal(
    ((bytes[12] as number) << 24) |
      ((bytes[13] as number) << 16) |
      ((bytes[14] as number) << 8) |
      (bytes[15] as number),
    PBKDF2_ITERATIONS,
  );
  // salt is 16 bytes at 16-31, IV is 12 at 32-43
  const header = readContainerHeader(bytes);
  assert.equal(header.salt.length, 16);
  assert.equal(header.iv.length, 12);
  expectBytes(header.salt, [...bytes.subarray(16, 32)]);
  expectBytes(header.iv, [...bytes.subarray(32, 44)]);
  assert.equal(BACKUP_CONTAINER_HEADER_BYTES, 44);
  assert.equal(BACKUP_CONTAINER_TAG_BYTES, 16);
  assert.equal(BACKUP_CONTAINER_OVERHEAD_BYTES, 60);
  // ciphertext + tag follows the header
  assert.equal(bytes.length, ARCHIVE.length + BACKUP_CONTAINER_OVERHEAD_BYTES);
});

test("a sealed file does not leak what is inside it", async () => {
  const archive = await buildBackupZip(samplePayload(), samplePhotos());
  // The plain zip names its manifest and every photo in the clear.
  assert.equal(strFromU8(archive).includes(BACKUP_JSON_ENTRY), true);
  const sealedBytes = await sealBackupContainer(archive, PASSWORD);
  const text = strFromU8(sealedBytes);
  assert.equal(text.includes(BACKUP_JSON_ENTRY), false);
  assert.equal(text.includes("photos/"), false);
  assert.equal(text.includes(BACKUP_APP), false);
  // ...and the first bytes are the container magic, not a zip signature.
  assert.equal(sealedBytes[0], 0x50);
  assert.equal(sealedBytes[1], 0x55);
  assert.equal(archive[0], 0x50);
  assert.equal(archive[1], 0x4b);
});

test("seal + open round-trips the archive byte for byte", async () => {
  const opened = await openBackupContainer(await sealed(), PASSWORD);
  assert.equal(opened.length, ARCHIVE.length);
  assert.deepEqual([...opened.subarray(0, 64)], [...ARCHIVE.subarray(0, 64)]);
  assert.deepEqual([...opened], [...ARCHIVE]);
});

test("the password is used exactly as typed — no trimming, no normalization", async () => {
  const bytes = await sealBackupContainer(ARCHIVE, " မြန်မာ pass word ");
  await openBackupContainer(bytes, " မြန်မာ pass word "); // opens
  await assert.rejects(
    () => openBackupContainer(bytes, "မြန်မာ pass word"),
    WrongBackupPasswordError,
  );
  await assert.rejects(
    () => openBackupContainer(bytes, " မြန်မာ pass word"),
    WrongBackupPasswordError,
  );
});

test("an empty password is refused rather than written as an openable file", async () => {
  await assert.rejects(
    () => sealBackupContainer(ARCHIVE, ""),
    /cannot be empty/,
  );
});

test("a wrong password is refused and returns nothing", async () => {
  const bytes = await sealed();
  await assert.rejects(
    () => openBackupContainer(bytes, `${PASSWORD} `),
    (e: unknown) => {
      assert.ok(e instanceof WrongBackupPasswordError);
      // The message must not claim to know WHICH of password/ciphertext/header
      // failed: a tag check cannot tell them apart.
      assert.match(e.message, /does not open this backup/);
      return true;
    },
  );
});

test("a flipped ciphertext byte fails the tag", async () => {
  const bytes = await sealed();
  bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) ^ 0x01;
  await assert.rejects(
    () => openBackupContainer(bytes, PASSWORD),
    WrongBackupPasswordError,
  );
});

test("a flipped tag byte fails the tag", async () => {
  const bytes = await sealed();
  bytes[BACKUP_CONTAINER_HEADER_BYTES] =
    (bytes[BACKUP_CONTAINER_HEADER_BYTES] as number) ^ 0xff;
  await assert.rejects(
    () => openBackupContainer(bytes, PASSWORD),
    WrongBackupPasswordError,
  );
});

test("a modified IV fails the tag — the header is authenticated", async () => {
  const bytes = await sealed();
  bytes[32] = (bytes[32] as number) ^ 0x01;
  await assert.rejects(
    () => openBackupContainer(bytes, PASSWORD),
    WrongBackupPasswordError,
  );
});

test("a modified salt fails the tag rather than deriving a wrong key", async () => {
  const bytes = await sealed();
  bytes[16] = (bytes[16] as number) ^ 0x01;
  await assert.rejects(
    () => openBackupContainer(bytes, PASSWORD),
    WrongBackupPasswordError,
  );
});

test("an altered iteration count is refused by the header, before any derivation", async () => {
  const bytes = await sealed();
  bytes[15] = (bytes[15] as number) - 1;
  await assert.rejects(
    () => openBackupContainer(bytes, PASSWORD),
    UnsupportedBackupContainerError,
  );
});

test("an unknown KDF or cipher id is refused", async () => {
  const bytes = await sealed();
  const kdf = Uint8Array.from(bytes);
  kdf[10] = 2;
  await assert.rejects(
    () => openBackupContainer(kdf, PASSWORD),
    UnsupportedBackupContainerError,
  );
  const cipher = Uint8Array.from(bytes);
  cipher[11] = 9;
  await assert.rejects(
    () => openBackupContainer(cipher, PASSWORD),
    UnsupportedBackupContainerError,
  );
});

test("an unknown container version fails closed, older and newer alike", async () => {
  const newer = await sealed();
  newer[8] = 0;
  newer[9] = 2;
  await assert.rejects(
    () => openBackupContainer(newer, PASSWORD),
    (e: unknown) => {
      assert.ok(e instanceof UnsupportedBackupContainerError);
      assert.match(e.message, /update the app/);
      return true;
    },
  );
  const older = await sealed();
  older[8] = 0;
  older[9] = 0;
  await assert.rejects(
    () => openBackupContainer(older, PASSWORD),
    UnsupportedBackupContainerError,
  );
});

test("a truncated header is corrupt, not a wrong password", async () => {
  const bytes = await sealed();
  await assert.rejects(
    () => openBackupContainer(bytes.subarray(0, 43), PASSWORD),
    (e: unknown) => {
      assert.ok(e instanceof CorruptBackupContainerError);
      assert.match(e.message, /cut short/);
      return true;
    },
  );
});

test("a payload shorter than the authentication tag is corrupt", async () => {
  const bytes = await sealed();
  await assert.rejects(
    () =>
      openBackupContainer(
        bytes.subarray(0, BACKUP_CONTAINER_HEADER_BYTES + 15),
        PASSWORD,
      ),
    CorruptBackupContainerError,
  );
});

test("an empty payload of exactly header + tag still refuses to open", async () => {
  const bytes = await sealed();
  const bare = bytes.subarray(0, BACKUP_CONTAINER_HEADER_BYTES + 16);
  await assert.rejects(
    () => openBackupContainer(bare, PASSWORD),
    WrongBackupPasswordError,
  );
});

test("detection is by magic bytes, so a zip is never called encrypted", async () => {
  assert.equal(isEncryptedBackup(await sealed()), true);
  assert.equal(isEncryptedBackup(Uint8Array.from([0x50, 0x4b, 3, 4])), false);
  assert.equal(isEncryptedBackup(Uint8Array.from([0x50])), false);
  assert.equal(isEncryptedBackup(new Uint8Array(0)), false);
  // A zip whose first bytes were replaced by the magic is detected as a
  // container and then refused on its own terms: an unknown version fails
  // closed, a known version with a broken body fails the tag. Neither is ever
  // handed to the zip parser.
  const relabelled = Uint8Array.from(await sealed());
  assert.equal(isEncryptedBackup(relabelled), true);
  relabelled[9] = 0; // version 0 — a container this app cannot read
  await assert.rejects(
    () => openBackupContainer(relabelled, PASSWORD),
    UnsupportedBackupContainerError,
  );
  relabelled[9] = BACKUP_CONTAINER_VERSION;
  for (let i = BACKUP_CONTAINER_HEADER_BYTES; i < relabelled.length; i++) {
    relabelled[i] = 0;
  }
  await assert.rejects(
    () => openBackupContainer(relabelled, PASSWORD),
    WrongBackupPasswordError,
  );
});

test("a header that is not this app's container is unsupported, not corrupt", async () => {
  const other = Uint8Array.from({ length: 200 }, (_, i) =>
    i < 8 ? "OTHERXXX".charCodeAt(i) : 0,
  );
  await assert.rejects(
    () => openBackupContainer(other, PASSWORD),
    UnsupportedBackupContainerError,
  );
});

test("every export gets a fresh salt and IV", async () => {
  const first = readContainerHeader(await sealed());
  const second = readContainerHeader(await sealed());
  assert.notDeepEqual([...first.salt], [...second.salt]);
  assert.notDeepEqual([...first.iv], [...second.iv]);
  // Same password, same archive, different envelope — so two backups of the
  // same library are not recognisable as the same bytes.
  const a = await sealed();
  const b = await sealed();
  assert.notDeepEqual([...a.subarray(44)], [...b.subarray(44)]);
});

test("encodeContainerHeader is pure and byte-exact", () => {
  const header = encodeContainerHeader({
    version: BACKUP_CONTAINER_VERSION,
    kdf: 1,
    cipher: 1,
    iterations: 0x000927c0,
    salt: new Uint8Array(16).fill(0xab),
    iv: new Uint8Array(12).fill(0xcd),
  });
  assert.equal(header.length, 44);
  expectBytes(
    header.subarray(0, 8),
    [...BACKUP_CONTAINER_MAGIC].map((c) => c.charCodeAt(0)),
  );
  expectBytes(header.subarray(8, 12), [0, 1, 1, 1]);
  expectBytes(header.subarray(12, 16), [0, 0x09, 0x27, 0xc0]);
  assert.deepEqual([...header.subarray(16, 32)], Array(16).fill(0xab));
  assert.deepEqual([...header.subarray(32, 44)], Array(12).fill(0xcd));
});

function expectBytes(value: Uint8Array, expected: number[]): void {
  assert.ok(
    value instanceof Uint8Array,
    `expected a Uint8Array, got ${Object.prototype.toString.call(value)}`,
  );
  assert.deepEqual(Array.from(value), expected);
}
