#!/usr/bin/env node
/**
 * Peak-memory and timing harness for the backup export/import path.
 *
 * NOT part of `npm run verify`: it builds archives of tens to hundreds of
 * megabytes and is run by hand on the target Windows machine, once per
 * candidate archive cap, so the numeric limits recorded in the plan are
 * measured rather than guessed. Run with `--expose-gc` so the numbers report
 * what the operation costs instead of what the previous phase left behind:
 *
 *   node --expose-gc scripts/measure-backup-limits.mjs 64
 *   node --expose-gc scripts/measure-backup-limits.mjs 128 --import-only
 *
 * What it reproduces, with the same primitives the app uses:
 *   export  photo bytes -> fflate async zip -> PBKDF2-SHA256 600k ->
 *           AES-256-GCM over the whole archive (+ 44-byte header, 16-byte tag)
 *   import  container -> AES-256-GCM decrypt -> fflate unzipSync (the
 *           main-thread path the app really uses today) -> manifest rows
 *
 * Photo bytes are random on purpose: stored photos are already compressed, so
 * the zip that comes out is about as large as its input, which is the case the
 * memory limits have to survive.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { strToU8, unzipSync, zip } from "fflate";

const MIB = 1024 * 1024;
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const CONTAINER_HEADER_BYTES = 44;
const GCM_TAG_BYTES = 16;
/** Same count of photos per MiB of library the gallery realistically shows. */
const PHOTO_COUNT = 12;

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const targetMiB = Number(args.find((a) => /^\d+$/.test(a)) ?? 64);
const writeTo = flag("--write");
const readFrom = flag("--read");
const rowCount = Number(flag("--rows") ?? 20_000);

if (!Number.isFinite(targetMiB) || targetMiB <= 0) {
  console.error(
    "usage: measure-backup-limits.mjs <MiB> [--rows N] [--write <file>]\n" +
      "       measure-backup-limits.mjs --read <container>",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Memory sampling. `rss` is the honest number for "did this exhaust the
// machine"; `heapUsed + external` is the part that would freeze or OOM the
// webview, since every archive buffer is an ArrayBuffer (external), not a
// string. Chromium's own accounting differs, so both are reported.
// ---------------------------------------------------------------------------

const peak = { rss: 0, js: 0 };
let sampling = false;

function sample() {
  if (!sampling) return;
  const m = process.memoryUsage();
  if (m.rss > peak.rss) peak.rss = m.rss;
  const js = m.heapUsed + m.external;
  if (js > peak.js) peak.js = js;
}

const sampler = setInterval(sample, 5);
sampler.unref?.();

function startPhase(label) {
  global.gc?.();
  const base = process.memoryUsage();
  peak.rss = base.rss;
  peak.js = base.heapUsed + base.external;
  sampling = true;
  return { label, base, t0: performance.now() };
}

function endPhase(phase) {
  // Sample once more BEFORE the flag drops: a synchronous step (unzipSync,
  // JSON.parse) never yields, so the interval never runs during it and this
  // last reading is the only one that sees its peak.
  sample();
  sampling = false;
  const ms = performance.now() - phase.t0;
  return {
    label: phase.label,
    seconds: Number((ms / 1000).toFixed(2)),
    peakRssMiB: Number((peak.rss / MIB).toFixed(1)),
    rssDeltaMiB: Number(((peak.rss - phase.base.rss) / MIB).toFixed(1)),
    peakJsMiB: Number((peak.js / MIB).toFixed(1)),
    jsDeltaMiB: Number(
      ((peak.js - (phase.base.heapUsed + phase.base.external)) / MIB).toFixed(
        1,
      ),
    ),
  };
}

const mib = (bytes) => Number((bytes / MIB).toFixed(1));

// ---------------------------------------------------------------------------
// Fixture: incompressible photo bytes + a manifest with representative rows.
// ---------------------------------------------------------------------------

function makePhotos(totalBytes) {
  const per = Math.floor(totalBytes / PHOTO_COUNT);
  const photos = [];
  for (let i = 0; i < PHOTO_COUNT; i++) {
    const bytes = new Uint8Array(per);
    for (let off = 0; off < bytes.length; off += 0x8000) {
      crypto.getRandomValues(
        bytes.subarray(off, Math.min(off + 0x8000, bytes.length)),
      );
    }
    photos.push({
      path: `photos/2026/10/${i.toString(16).padStart(64, "0")}.jpg`,
      bytes,
    });
  }
  return photos;
}

function manifestBytes(photoCount) {
  const rows = [];
  for (let i = 0; i < rowCount; i++) {
    rows.push({
      id: i + 1,
      title: `Note ${i}`,
      content: `Body ${i} — မြန်မာဘာသာ text so the manifest is not unrealistically small.`,
      collection_id: null,
      archived: i % 7 === 0 ? 1 : 0,
      created_at: "2026-10-18T09:00",
      updated_at: "2026-10-18T09:00",
    });
  }
  return strToU8(
    JSON.stringify({
      app: "purple-memo",
      version: 1,
      exportedAt: new Date().toISOString(),
      data: { notes: rows, photos: new Array(photoCount).fill({}) },
    }),
  );
}

async function deriveKey(password, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    strToU8(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const results = [];
let container = null;

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

if (readFrom === null) {
  const photos = makePhotos(targetMiB * MIB);

  const zipPhase = startPhase("export: zip");
  const files = { "backup.json": manifestBytes(photos.length) };
  for (const photo of photos) files[photo.path] = photo.bytes;
  const archive = await new Promise((resolve, reject) =>
    zip(files, (error, data) => (error ? reject(error) : resolve(data))),
  );
  results.push(endPhase(zipPhase));
  const zipSeconds = results[results.length - 1].seconds;

  // The export path releases the photo buffers before it encrypts, because the
  // encrypted container is a second full-size buffer of the same library.
  photos.length = 0;
  for (const key of Object.keys(files)) {
    if (key !== "backup.json") delete files[key];
  }
  global.gc?.();

  const keyPhase = startPhase("export: PBKDF2-SHA256 600k");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await deriveKey("correct horse battery staple", salt);
  results.push(endPhase(keyPhase));

  const encryptPhase = startPhase("export: AES-256-GCM whole archive");
  const header = new Uint8Array(CONTAINER_HEADER_BYTES);
  header.set(strToU8("PURPLEBK"), 0);
  header[8] = 0;
  header[9] = 1; // container version 1, big-endian
  header[10] = 1; // KDF id: PBKDF2-SHA256
  header[11] = 1; // cipher id: AES-256-GCM
  header.set(
    [
      (PBKDF2_ITERATIONS >>> 24) & 0xff,
      (PBKDF2_ITERATIONS >>> 16) & 0xff,
      (PBKDF2_ITERATIONS >>> 8) & 0xff,
      PBKDF2_ITERATIONS & 0xff,
    ],
    12,
  );
  header.set(salt, 16);
  header.set(iv, 32);
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: header, tagLength: 128 },
    key,
    archive,
  );
  const sealedBytes = new Uint8Array(sealed);
  container = new Uint8Array(CONTAINER_HEADER_BYTES + sealedBytes.length);
  container.set(header, 0);
  container.set(sealedBytes, CONTAINER_HEADER_BYTES);
  results.push(endPhase(encryptPhase));

  console.log(
    `\n=== export, library ${targetMiB} MiB, ${rowCount} manifest rows ===`,
  );
  for (const r of results)
    console.log(`  ${r.label.padEnd(34)} ${JSON.stringify(r)}`);
  console.log(
    `  zip ${mib(archive.length)} MiB, container ${mib(container.length)} MiB ` +
      `(= archive + ${CONTAINER_HEADER_BYTES + GCM_TAG_BYTES})`,
  );
  console.log(`  zip wall clock ${zipSeconds}s`);
  if (writeTo !== null) {
    writeFileSync(writeTo, container);
    console.log(`  container written to ${writeTo}`);
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

if (readFrom !== null) {
  container = new Uint8Array(readFileSync(readFrom));
}

if (container !== null) {
  const decryptPhase = startPhase("import: AES-256-GCM authenticate+decrypt");
  let plaintext = null;
  try {
    const header = container.subarray(0, CONTAINER_HEADER_BYTES);
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: header.subarray(32, 44),
        additionalData: header,
        tagLength: 128,
      },
      await deriveKey("correct horse battery staple", header.subarray(16, 32)),
      container.subarray(CONTAINER_HEADER_BYTES),
    );
    plaintext = new Uint8Array(opened);
  } catch (error) {
    const refused = {
      ...endPhase(decryptPhase),
      note: `refused: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
    };
    results.push(refused);
    console.log(`  ${refused.label.padEnd(34)} ${JSON.stringify(refused)}`);
    plaintext = null;
  }
  if (plaintext !== null) results.push(endPhase(decryptPhase));
  const decryptSeconds = results[results.length - 1].seconds;

  if (plaintext !== null) {
    // unzipSync is what parseBackupZip really calls: main-thread work, so it
    // is reported separately from the async steps above.
    const unzipPhase = startPhase("import: unzipSync (MAIN THREAD)");
    let expanded = 0;
    const entries = unzipSync(plaintext);
    for (const data of Object.values(entries)) expanded += data.length;
    results.push(endPhase(unzipPhase));
    const unzipMs = Math.round(performance.now() - unzipPhase.t0);

    const rowsPhase = startPhase("import: manifest parse + row objects");
    const manifest = JSON.parse(
      new TextDecoder().decode(entries["backup.json"]),
    );
    let rowCount = 0;
    for (const rows of Object.values(manifest.data)) rowCount += rows.length;
    results.push(endPhase(rowsPhase));

    console.log(`\n=== import, container ${mib(container.length)} MiB ===`);
    for (const r of results.filter((r) => r.label.startsWith("import")))
      console.log(`  ${r.label.padEnd(34)} ${JSON.stringify(r)}`);
    console.log(
      `  expanded ${mib(expanded)} MiB, ${rowCount} rows, ` +
        `main-thread unzipSync blocked ${unzipMs}ms, decrypt ${decryptSeconds}s`,
    );
  }
}

clearInterval(sampler);
