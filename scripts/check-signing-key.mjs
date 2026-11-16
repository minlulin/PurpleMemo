#!/usr/bin/env node
/**
 * Signing-key gate check.
 *
 * The updater's only trust anchor is the public key in
 * `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. Every installed copy
 * verifies an update against the pubkey compiled into its own binary, so one
 * property decides whether updates work at all: the private key at the release
 * path must be the pair that pubkey names.
 *
 * That is what this check fails on. A renamed, swapped or freshly generated pair
 * at `.keys/updater.key` signs perfectly well — every other gate step stays
 * green — and breaks only at install time on a user's machine.
 *
 * The password state is reported, never failed. The trusted pair is passwordless
 * by the owner's decision (2026-11-16): the pinned Tauri signer has only
 * `generate` and `sign`, so a password cannot be added to the existing pair
 * without replacing it, and a replacement pair signs updates no existing install
 * accepts. Custody of the file on the owner's PC is the protection instead; the
 * rules are in `docs/RELEASE.md`, "Signing key custody".
 *
 * Non-failing outcomes, like `check-hooks.mjs`'s warnings:
 *  - no `.keys/updater.key` (a fresh clone, a source tarball): nothing to check;
 *  - no installed Tauri CLI: the private half cannot be probed.
 *
 * The comment line of a minisign key is untrusted metadata and is never
 * compared: `tauri.conf.json`'s own comment carries a one-nibble difference from
 * the key id in its bytes. Ids and public keys are compared as bytes, and a key
 * id is printed the way minisign prints it (its stored bytes reversed).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY_PATH = ".keys/updater.key";
const PUB_PATH = ".keys/updater.key.pub";
const CONF_PATH = "src-tauri/tauri.conf.json";
const CLI = "node_modules/@tauri-apps/cli/tauri.js";

// A minisign secret-key blob is 158 bytes; far below that is not a key.
const MIN_SECRET_BLOB_BYTES = 100;

const CUSTODY = '  Custody rules: docs/RELEASE.md -> "Signing key custody".';
const MISMATCH_REMEDY = [
  "  Put the trusted pair back at .keys/updater.key and .keys/updater.key.pub.",
  "  Do not generate a new pair: the pubkey is compiled into every installed",
  "  copy, so a new pair cannot sign an update any of them will accept.",
  CUSTODY,
].join("\n");
const CORRUPT_REMEDY = [
  "  Restore the trusted pair from the owner's custody copy; do not generate a",
  "  replacement pair.",
  CUSTODY,
].join("\n");

function fail(reason, remedy) {
  console.error(`check-signing-key: FAILED — ${reason}\n${remedy}`);
  process.exit(1);
}

function skip(reason) {
  console.log(`check-signing-key: skipped — ${reason}`);
  process.exit(0);
}

/** Tauri writes key files as base64 of the minisign text; bare text is accepted too. */
function minisignText(value, label) {
  const text = String(value).trim();
  if (text.startsWith("untrusted comment:")) return text;
  const decoded = Buffer.from(text, "base64").toString("utf8");
  if (!decoded.startsWith("untrusted comment:")) {
    throw new Error(`${label} is not a minisign key file`);
  }
  return decoded;
}

function bodyOf(value, label) {
  const [, body] = minisignText(value, label)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return Buffer.from(body ?? "", "base64");
}

/** The id as minisign prints it: the stored id bytes in reverse order. */
function idHex(blob) {
  return Buffer.from(blob.subarray(2, 10))
    .reverse()
    .toString("hex")
    .toUpperCase();
}

function publicKeyOf(value, label) {
  const blob = bodyOf(value, label);
  if (blob.length !== 42) {
    throw new Error(`${label} does not hold a 42-byte minisign public key`);
  }
  return blob;
}

if (!existsSync(KEY_PATH)) {
  skip(`no ${KEY_PATH} in this checkout, so there is nothing to check.`);
}

let trusted;
try {
  const config = JSON.parse(readFileSync(CONF_PATH, "utf8"));
  trusted = publicKeyOf(
    config.plugins?.updater?.pubkey ?? "",
    `${CONF_PATH} pubkey`,
  );
} catch (error) {
  fail(
    `${CONF_PATH} carries no readable plugins.updater.pubkey (${error.message}).`,
    CORRUPT_REMEDY,
  );
}

let secretBlob;
try {
  secretBlob = bodyOf(readFileSync(KEY_PATH, "utf8"), KEY_PATH);
} catch (error) {
  fail(
    `${KEY_PATH} exists but cannot be read or parsed (${error.message}).`,
    CORRUPT_REMEDY,
  );
}
if (secretBlob.length < MIN_SECRET_BLOB_BYTES) {
  fail(
    `${KEY_PATH} exists but cannot be parsed — its body is ${secretBlob.length} bytes, not a ` +
      "minisign secret key.",
    CORRUPT_REMEDY,
  );
}

// The public half written beside the key is a second witness to which pair is on
// disk, and unlike a signature it survives a password.
let sidecar;
if (existsSync(PUB_PATH)) {
  try {
    sidecar = publicKeyOf(readFileSync(PUB_PATH, "utf8"), PUB_PATH);
  } catch (error) {
    fail(
      `${PUB_PATH} exists but cannot be read or parsed (${error.message}).`,
      CORRUPT_REMEDY,
    );
  }
  if (!sidecar.subarray(10, 42).equals(trusted.subarray(10, 42))) {
    fail(
      `${PUB_PATH} is key ${idHex(sidecar)}, but ${CONF_PATH} trusts ${idHex(trusted)}.`,
      MISMATCH_REMEDY,
    );
  }
}

if (!existsSync(CLI)) {
  skip(
    sidecar
      ? `the Tauri CLI is not installed so the private half cannot be probed; ${PUB_PATH} matches the shipped pubkey.`
      : "the Tauri CLI is not installed, so the key cannot be probed.",
  );
}

const dir = mkdtempSync(join(tmpdir(), "purple-memo-signing-key-"));
let signature;
let probeError;
try {
  const probe = join(dir, "probe.txt");
  writeFileSync(probe, "purple-memo signing-key gate probe\n");
  try {
    execFileSync(
      process.execPath,
      [CLI, "signer", "sign", "-f", KEY_PATH, "-p", "", probe],
      {
        stdio: "pipe",
        timeout: 60_000,
      },
    );
    signature = bodyOf(
      readFileSync(`${probe}.sig`, "utf8"),
      "the probe signature",
    );
  } catch (error) {
    probeError = error;
  }
} finally {
  // The probe's output (and any .sig it wrote) never leaves this directory.
  rmSync(dir, { recursive: true, force: true });
}

const stderr = String(probeError?.stderr ?? "");
const spawnFailed =
  probeError?.code === "ENOENT" || probeError?.code === "ETIMEDOUT";

if (signature) {
  if (!signature.subarray(2, 10).equals(trusted.subarray(2, 10))) {
    fail(
      `${KEY_PATH} signs with key ${idHex(signature)}, but ${CONF_PATH} trusts ` +
        `${idHex(trusted)} — a build signed here is refused by every installed copy.`,
      MISMATCH_REMEDY,
    );
  }
  console.log(
    `check-signing-key: OK — ${KEY_PATH} is the trusted pair (${idHex(trusted)}) and opens ` +
      "with an EMPTY password. That is the owner's decision (2026-11-16), not a defect: " +
      "the signer cannot re-encrypt this pair, so custody is the protection — " +
      'docs/RELEASE.md -> "Signing key custody".',
  );
  process.exit(0);
}

if (spawnFailed) {
  skip(
    `the signing probe could not run (${probeError.code}); run "npm run check:signing-key" by hand.`,
  );
}

// The one refusal that means "this key still needs its password". Anything else
// the signer prints (a decode error, a missing comment, a truncated body) is a
// key file that cannot be used at all.
if (/Wrong password for that key/.test(stderr)) {
  console.log(
    sidecar
      ? `check-signing-key: OK — ${KEY_PATH} refuses an empty password, so it is ` +
          `password-protected; ${PUB_PATH} matches key ${idHex(trusted)}.`
      : `check-signing-key: OK — ${KEY_PATH} refuses an empty password, so it is ` +
          "password-protected; with no public half beside it, the pair it belongs to " +
          'could not be verified here. Custody: docs/RELEASE.md -> "Signing key custody".',
  );
  process.exit(0);
}

fail(
  `${KEY_PATH} exists but the signer cannot use it` +
    (stderr.trim()
      ? `: ${stderr.trim().split(/\r?\n/)[0]}`
      : ` (exit ${probeError?.status}).`),
  CORRUPT_REMEDY,
);
