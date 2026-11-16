#!/usr/bin/env node
/**
 * Signing-key custody check (audit A2).
 *
 * The updater's only trust anchor is the public key in
 * `src-tauri/tauri.conf.json` → `plugins.updater.pubkey`. The private half lives
 * outside the repository (`.keys/updater.key`, gitignored). If it opens with no
 * password, then anything that can read the file — a copied project folder, a
 * machine backup, a disk image, a shared drive — can sign an update that every
 * installed copy accepts and runs with the app's privileges.
 *
 * **The file's header is not evidence.** It reads
 * `untrusted comment: rsign encrypted secret key` no matter what password was
 * used at generation, including the empty one, so a reviewer (or this audit's
 * first pass) can be misled by it. The only honest test is to try: sign a
 * throwaway file with an empty password and see whether the CLI succeeds. That
 * is what this check does, in a temp directory, and it never prints key
 * material or the password.
 *
 * It cannot rotate the key. Rotation needs the operator's new password and one
 * final release signed with the OLD key (installed copies verify against the
 * pubkey they were built with) — the procedure is in `docs/RELEASE.md`,
 * "Signing key custody".
 *
 * Non-failing, for the same reasons `check-hooks.mjs` warns rather than fails:
 *  - no `.keys/updater.key` (a fresh clone, a source tarball): nothing to
 *    protect here;
 *  - no installed Tauri CLI: a missing toolchain is not evidence either way.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KEY_PATH = ".keys/updater.key";
const CLI = "node_modules/@tauri-apps/cli/tauri.js";

const REMEDY = [
  "  Rotate to a password-protected key and treat this one as exposed:",
  "    1. npm run tauri -- signer generate -w .keys/updater.key.new  (choose a password)",
  "    2. put its public half in src-tauri/tauri.conf.json -> plugins.updater.pubkey",
  "    3. ship ONE release signed with the OLD key first — installed copies",
  "       verify against the pubkey they were built with — then publish the",
  "       build carrying the new pubkey.",
  '  Full procedure: docs/RELEASE.md -> "Signing key custody".',
].join("\n");

function fail(reason) {
  console.error(`check-signing-key: FAILED — ${reason}\n${REMEDY}`);
  process.exit(1);
}

function skip(reason) {
  console.log(`check-signing-key: skipped — ${reason}`);
  process.exit(0);
}

if (!existsSync(KEY_PATH)) {
  skip(`no ${KEY_PATH} in this checkout, so there is nothing to protect.`);
}
if (!existsSync(CLI)) {
  skip("the Tauri CLI is not installed, so the key cannot be probed.");
}

const dir = mkdtempSync(join(tmpdir(), "purple-memo-signing-key-"));
let opensWithNoPassword;
let probeError;
try {
  const probe = join(dir, "probe.txt");
  writeFileSync(probe, "purple-memo signing-key custody probe\n");
  try {
    execFileSync(
      process.execPath,
      [CLI, "signer", "sign", "-f", KEY_PATH, "-p", "", probe],
      { stdio: "pipe", timeout: 60_000 },
    );
    opensWithNoPassword = true;
  } catch (error) {
    opensWithNoPassword = false;
    probeError = error;
  }
} finally {
  // The probe's output (and any .sig it wrote) never leaves this directory.
  rmSync(dir, { recursive: true, force: true });
}

if (opensWithNoPassword) {
  fail(
    `${KEY_PATH} opens with an EMPTY password, so anyone who can read that file ` +
      "can sign an update every installed copy will accept and run.",
  );
}

// A probe that could not run at all is not a verdict. `execFileSync` only
// throws for a non-zero exit or a spawn failure; the CLI pre-check above rules
// out the most likely spawn failure, so anything else here means the key
// refused the empty password.
if (probeError?.code === "ENOENT" || probeError?.code === "ETIMEDOUT") {
  skip(
    `the signing probe could not run (${probeError.code}); run "npm run check:signing-key" by hand.`,
  );
}

console.log(`check-signing-key: OK — ${KEY_PATH} refuses an empty password.`);
