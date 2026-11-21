#!/usr/bin/env node
/**
 * Android release APK gate (docs/ANDROID_DISTRIBUTION.md §3).
 *
 * Three checks used to live on a human's checklist on the release machine: is
 * the APK signed, is it arm64-only, and does it carry the version this release
 * bumped to. A checklist cannot fail a gate, and every one of those failures is
 * silent in the field:
 *
 *  - an unsigned or debug-key APK installs fine on a phone with "install
 *    unknown apps" enabled, and only breaks when the next release is refused
 *    with INSTALL_FAILED_UPDATE_INCOMPATIBLE;
 *  - a four-ABI APK runs perfectly well on an arm64 phone, so nothing looks
 *    wrong — it just carries three libraries nobody wants (decision 11);
 *  - a stale versionCode shows up only when the upgrade the user needs does
 *    not install over what they already have.
 *
 * So this step reads the artefact instead of trusting the command line that
 * produced it. It runs in `npm run verify` and skips, saying why, when no APK
 * exists — the normal state of a desktop checkout.
 *
 * A fourth check looks inside the Rust cdylib, because on 2026-11-18 a release
 * APK passed every check above, installed, and failed only on the phone with
 * `dlopen: cannot locate symbol "EVP_MAC_fetch"`: the make shim named one
 * response file per archive, OpenSSL's `libcrypto.a` is chunked over three `ar`
 * lines, and the archive shipped without crypto/evp. A Rust cdylib links
 * happily with undefined symbols, so nothing failed until the loader ran. The
 * check is therefore narrow on purpose: undefined `EVP_`/`CRYPTO_`/`OPENSSL_`/
 * `SSL_` dynamic symbols fail the gate, while the libc/libm/liblog symbols a
 * cdylib legitimately leaves to the loader do not.
 *
 * What it can and cannot prove: `apksigner` is the authority on the signature
 * (v1/v2/v3 schemes, certificate chain), so this script requires it rather than
 * parsing a signature block itself. It deliberately does NOT compare against
 * the keystore in key.properties: reading that file would mean handling the
 * store and key passwords in a gate that prints its own output, and the
 * property that actually needs proving is "signed, with the release identity,
 * for the version being handed over" — the signer's DN and digest are printed
 * so the operator can record them beside `git rev-parse HEAD`. Likewise, the
 * symbol table is read by the NDK's own `llvm-readelf` rather than by an ELF
 * parser written here.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DEFAULT_APK =
  "src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk";
/** Written by the Tauri CLI on every android build; carries the version code. */
const TAURI_PROPERTIES = "src-tauri/gen/android/app/tauri.properties";
const RELEASE_ABI = "arm64-v8a";
const RUST_LIBRARY = `lib/${RELEASE_ABI}/libpurple_memo_lib.so`;

/**
 * The proven failure class: crypto/evp objects missing from the statically
 * linked OpenSSL, leaving the cdylib's references unresolved.
 */
const OPENSSL_SYMBOL = /^(EVP|CRYPTO|OPENSSL|SSL)_/;

const BUILD_REMEDY = [
  "  Build the artefact this step expects:",
  "    npx tauri android build --apk --target aarch64",
  '  A bare "./gradlew build" or "assemble" is refused by the Gradle guard too,',
  "  because it packages the release variant with the template's default four ABIs.",
].join("\n");

const SDK_REMEDY = [
  "  This step needs the Android SDK build-tools (apksigner, plus aapt2 for the",
  "  manifest version). Set ANDROID_HOME to the SDK root, or install build-tools",
  "  through sdkmanager — an APK that cannot be verified must not be handed over.",
].join("\n");

const READELF_REMEDY = [
  "  This step needs llvm-readelf from the Android NDK to read the library's",
  "  dynamic symbols. Set ANDROID_NDK_HOME to an installed NDK, or install one",
  '  through the SDK manager (sdkmanager --install "ndk;27.3.13750724") — an',
  "  APK whose library cannot be verified must not be handed over.",
].join("\n");

function fail(reason, remedy) {
  console.error(
    `check-android-apk: FAILED — ${reason}${remedy ? `\n${remedy}` : ""}`,
  );
  process.exit(1);
}

function skip(reason) {
  console.log(`check-android-apk: skipped — ${reason}`);
  process.exit(0);
}

/** First line of tool output, for a message that stays one line. */
function firstLine(text) {
  return (
    String(text ?? "")
      .trim()
      .split(/\r?\n/)
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

/**
 * Entries from a zip's central directory, with what it takes to read each one.
 * An APK is a zip, and the ABI an artefact carries is visible in its file names
 * — no unzip binary, no decompression, and no dependency needed for that. The
 * offsets are here for `extractEntry`.
 */
function zipEntries(bytes) {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  if (bytes.length < 22) throw new Error("the file is too small to be a zip");
  let eocd = -1;
  const oldest = Math.max(0, bytes.length - 22 - 0xffff);
  for (let at = bytes.length - 22; at >= oldest; at -= 1) {
    if (bytes.readUInt32LE(at) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const count = bytes.readUInt16LE(eocd + 10);
  const start = bytes.readUInt32LE(eocd + 16);
  if (count === 0xffff || start === 0xffffffff) {
    throw new Error("a ZIP64 archive, which this check does not read");
  }
  const entries = [];
  let at = start;
  for (let index = 0; index < count; index += 1) {
    if (bytes.readUInt32LE(at) !== CENTRAL) {
      throw new Error(`central directory entry ${index} is not a header`);
    }
    const method = bytes.readUInt16LE(at + 10);
    const compressedSize = bytes.readUInt32LE(at + 20);
    const uncompressedSize = bytes.readUInt32LE(at + 24);
    const nameLength = bytes.readUInt16LE(at + 28);
    const extraLength = bytes.readUInt16LE(at + 30);
    const commentLength = bytes.readUInt16LE(at + 32);
    const localHeaderOffset = bytes.readUInt32LE(at + 42);
    const name = bytes.toString("utf8", at + 46, at + 46 + nameLength);
    if (compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      throw new Error(
        `${name} is a ZIP64 entry, which this check does not read`,
      );
    }
    entries.push({
      name,
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * One entry's bytes: past the local header, then stored as-is or inflated.
 * `zlib.inflateRawSync` is stdlib, so the Windows release machine needs no
 * unzip binary and this check gains no dependency.
 */
function extractEntry(bytes, entry) {
  const LOCAL = 0x04034b50;
  if (bytes.readUInt32LE(entry.localHeaderOffset) !== LOCAL) {
    throw new Error(`${entry.name}'s local file header is not a header`);
  }
  const nameLength = bytes.readUInt16LE(entry.localHeaderOffset + 26);
  const extraLength = bytes.readUInt16LE(entry.localHeaderOffset + 28);
  const start = entry.localHeaderOffset + 30 + nameLength + extraLength;
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  throw new Error(`${entry.name} uses compression method ${entry.method}`);
}

/** `36.0.0` style directory names, newest first. */
function compareVersionDirs(a, b) {
  const parts = (value) =>
    value.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

function buildToolDirectories() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(
    Boolean,
  );
  const found = [];
  for (const root of roots) {
    const parent = join(root, "build-tools");
    if (!existsSync(parent)) continue;
    for (const version of readdirSync(parent)) {
      found.push({ version, path: join(parent, version) });
    }
  }
  return found.sort((a, b) => compareVersionDirs(a.version, b.version));
}

/**
 * The newest build-tools copy of `name`. On Windows the wrappers are `.bat`,
 * which Node cannot exec directly (a deliberate post-CVE restriction), so the
 * callers below go through `cmd /c` for those — see `run`.
 */
function findBuildTool(name) {
  const suffixes =
    process.platform === "win32" ? [".exe", ".bat", ".cmd", ""] : [""];
  for (const directory of buildToolDirectories()) {
    for (const suffix of suffixes) {
      const path = join(directory.path, `${name}${suffix}`);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

function run(tool, args) {
  const isBatch = /\.(bat|cmd)$/i.test(tool);
  const command = isBatch ? (process.env.ComSpec ?? "cmd.exe") : tool;
  const argv = isBatch ? ["/d", "/c", tool, ...args] : args;
  const result = spawnSync(command, argv, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    return { status: null, output: String(result.error.message) };
  }
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** An executable on `PATH`, or null. `readelf` is a Linux system fallback. */
function findOnPath(name) {
  const suffixes =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    for (const suffix of suffixes) {
      const path = join(directory, `${name}${suffix}`);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/**
 * `llvm-readelf` from the NDK, which is where a machine that builds the APK
 * always has one: `ANDROID_NDK_HOME` first, then the newest `ndk/*` under
 * `ANDROID_HOME`/`ANDROID_SDK_ROOT`, then a system `readelf` on `PATH`.
 */
function findSymbolTool() {
  const name =
    process.platform === "win32" ? "llvm-readelf.exe" : "llvm-readelf";
  const ndkRoots = [];
  if (process.env.ANDROID_NDK_HOME) ndkRoots.push(process.env.ANDROID_NDK_HOME);
  for (const root of [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
  ].filter(Boolean)) {
    const parent = join(root, "ndk");
    if (!existsSync(parent)) continue;
    for (const version of readdirSync(parent).sort(compareVersionDirs)) {
      ndkRoots.push(join(parent, version));
    }
  }
  for (const ndk of ndkRoots) {
    const prebuilt = join(ndk, "toolchains", "llvm", "prebuilt");
    if (!existsSync(prebuilt)) continue;
    for (const host of readdirSync(prebuilt)) {
      const path = join(prebuilt, host, "bin", name);
      if (existsSync(path)) return path;
    }
  }
  return findOnPath("readelf");
}

/**
 * Undefined dynamic symbol names in `llvm-readelf --dyn-syms` output. A table's
 * rows read
 *
 *   3: 0000000000000000  0 FUNC  GLOBAL DEFAULT  UND EVP_MAC_fetch@OPENSSL_3.0.0
 *
 * so the name is the token after the `Ndx` column that says `UND`, minus its
 * `@version` suffix. The first row (the null symbol) has no name and is not
 * counted. Pure, and exported for the fail-path test, which cannot be run
 * against the broken artefact from 97d9398 — it no longer exists.
 */
export function undefinedSymbols(output) {
  const names = [];
  for (const line of String(output ?? "").split(/\r?\n/)) {
    const tokens = line.trim().split(/\s+/);
    if (!/^\d+:$/.test(tokens[0] ?? "")) continue;
    const index = tokens.indexOf("UND");
    if (index < 0) continue;
    const name = tokens[index + 1];
    if (!name || name.startsWith("(")) continue;
    names.push(name.replace(/@.*$/, ""));
  }
  return names;
}

/** The subset of undefined names in the OpenSSL family — the whole verdict. */
export function opensslSymbols(names) {
  return names.filter((name) => OPENSSL_SYMBOL.test(name));
}

/**
 * The Rust library's symbols, read with the NDK's own tool. Fails closed when
 * no tool exists: an APK whose library cannot be verified is not handed over,
 * the same rule `SDK_REMEDY` states for apksigner.
 */
function symbolEvidence(apkBytes, entry) {
  const tool = findSymbolTool();
  if (!tool) {
    fail(
      `no llvm-readelf to read ${RUST_LIBRARY}'s dynamic symbols.`,
      READELF_REMEDY,
    );
  }
  let library;
  try {
    library = extractEntry(apkBytes, entry);
  } catch (error) {
    return {
      error: `${RUST_LIBRARY} could not be extracted from the APK (${error.message}).`,
      remedy: BUILD_REMEDY,
    };
  }
  const directory = mkdtempSync(join(tmpdir(), "purple-memo-apk-"));
  try {
    const path = join(directory, "libpurple_memo_lib.so");
    writeFileSync(path, library);
    const result = run(tool, ["--dyn-syms", path]);
    if (result.status !== 0) {
      return {
        error: `${tool} could not read ${RUST_LIBRARY} (${firstLine(result.output)}).`,
        remedy: READELF_REMEDY,
      };
    }
    const names = undefinedSymbols(result.output);
    return {
      tool,
      undefinedCount: names.length,
      offending: opensslSymbols(names),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** The opening line of the failure: every offending name, or the first 20. */
function offendingList(names) {
  const shown = names.slice(0, 20);
  const lines = shown.map((name) => `    ${name}`);
  if (names.length > shown.length) {
    lines.push(`    … and ${names.length - shown.length} more`);
  }
  return lines.join("\n");
}

/**
 * The version the artefact must carry, established without duplicating Tauri's
 * versionCode formula: the CLI derives the code from the manifests, so the code
 * is trustworthy exactly when the generated file postdates the bump. Requiring
 * its versionName to equal `package.json` is what proves that.
 */
function expectedVersion() {
  let text;
  try {
    text = readFileSync(join(REPO, TAURI_PROPERTIES), "utf8");
  } catch {
    fail(
      `${TAURI_PROPERTIES} is missing, so the version this APK must carry cannot be established.`,
      [
        "  That file is gitignored and written by the Tauri CLI on every android build.",
        "  Build the release with `npx tauri android build --apk --target aarch64`,",
        "  then run this step again against the artefact it produced.",
      ].join("\n"),
    );
  }
  const code = /^tauri\.android\.versionCode\s*=\s*(\d+)\s*$/m.exec(text)?.[1];
  const name = /^tauri\.android\.versionName\s*=\s*(\S+)\s*$/m.exec(text)?.[1];
  if (!code || !name) {
    fail(
      `${TAURI_PROPERTIES} carries no readable versionCode/versionName pair.`,
      BUILD_REMEDY,
    );
  }
  const declared = JSON.parse(
    readFileSync(join(REPO, "package.json"), "utf8"),
  ).version;
  if (name !== declared) {
    fail(
      `${TAURI_PROPERTIES} says versionName ${name}, but package.json says ${declared}: ` +
        "the generated file predates the version bump, so its versionCode is not this release's.",
      [
        "  Delete it and rebuild — the CLI rewrites it from the manifests:",
        `    rm ${TAURI_PROPERTIES}`,
        "    npx tauri android build --apk --target aarch64",
      ].join("\n"),
    );
  }
  return { code, name };
}

/** versionCode/versionName as the APK itself reports them. */
function apkVersion(apk) {
  for (const tool of ["aapt2", "aapt"]) {
    const path = findBuildTool(tool);
    if (!path) continue;
    const result = run(path, ["dump", "badging", apk]);
    if (result.status !== 0) {
      return {
        error: `${tool} could not read the APK: ${firstLine(result.output)}`,
      };
    }
    const code = /versionCode='(\d+)'/.exec(result.output)?.[1];
    const name = /versionName='([^']*)'/.exec(result.output)?.[1];
    if (!code || name === undefined) {
      return { error: `${tool} reported no versionCode/versionName` };
    }
    return { code, name, tool };
  }
  return { error: "no aapt2 or aapt in the Android SDK build-tools" };
}

/** apksigner's verdict: exit status is the authority, the certs are the record. */
function signature(apk) {
  const path = findBuildTool("apksigner");
  if (!path) return { error: "no apksigner in the Android SDK build-tools" };
  const result = run(path, ["verify", "-v", "--print-certs", apk]);
  if (result.status !== 0) {
    return {
      error: `apksigner verify refused the APK: ${firstLine(result.output)}`,
    };
  }
  const signers = new Set(
    [...result.output.matchAll(/Signer #(\d+)/g)].map((match) => match[1]),
  );
  const digest = /certificate SHA-256 digest:\s*([0-9a-f]+)/i.exec(
    result.output,
  )?.[1];
  const subject = /certificate DN:\s*(.+)/i.exec(result.output)?.[1]?.trim();
  return { signers: signers.size, digest, subject };
}

function main() {
  const apkArgument = process.argv.indexOf("--apk");
  const requested = apkArgument > 0 ? process.argv[apkArgument + 1] : undefined;
  const apkPath = resolve(
    REPO,
    requested ?? process.env.PM_ANDROID_APK ?? DEFAULT_APK,
  );
  const explicit = Boolean(requested ?? process.env.PM_ANDROID_APK);

  if (!existsSync(apkPath)) {
    if (explicit) {
      fail(`there is no APK at ${apkPath}.`, BUILD_REMEDY);
    }
    skip(
      `no release APK at ${relative(REPO, apkPath)} — nothing to verify. ` +
        'Build one with "npx tauri android build --apk --target aarch64".',
    );
  }
  const bytes = readFileSync(apkPath);
  const expected = expectedVersion();

  let entries;
  try {
    entries = zipEntries(bytes);
  } catch (error) {
    fail(
      `${relative(REPO, apkPath)} is not a readable APK/zip (${error.message}).`,
      BUILD_REMEDY,
    );
  }

  const nativeLibraries = entries
    .map((entry) => entry.name)
    .filter((entry) => entry.startsWith("lib/") && entry.endsWith(".so"));
  const abis = [
    ...new Set(nativeLibraries.map((entry) => entry.split("/")[1])),
  ].sort();

  if (abis.length === 0) {
    fail(
      `${relative(REPO, apkPath)} carries no native library at all — the Rust side is missing.`,
      BUILD_REMEDY,
    );
  }
  if (abis.join(",") !== RELEASE_ABI) {
    fail(
      `the APK carries ${abis.join(", ")} native libraries; release is ${RELEASE_ABI} only ` +
        "(docs/ANDROID_DESIGN.md decision 11).",
      BUILD_REMEDY,
    );
  }
  const rustLibrary = entries.find((entry) => entry.name === RUST_LIBRARY);
  if (!rustLibrary) {
    fail(
      `the APK has no ${RUST_LIBRARY}, so the release build of the Rust library was not packaged.`,
      BUILD_REMEDY,
    );
  }

  const symbols = symbolEvidence(bytes, rustLibrary);
  if (symbols.error) {
    fail(symbols.error, symbols.remedy);
  }
  if (symbols.offending.length > 0) {
    fail(
      `${RUST_LIBRARY} carries ${symbols.offending.length} undefined OpenSSL ` +
        "symbol(s): the library was packaged without its crypto/evp objects, and " +
        `the phone refuses to load it (dlopen: cannot locate symbol "${symbols.offending[0]}").\n` +
        offendingList(symbols.offending),
      [
        "  Rebuild with the environment docs/ANDROID_TOOLCHAIN.md §2 describes, so the",
        "  make shim archives the whole of libcrypto.a, then run this step again:",
        "    npx tauri android build --apk --target aarch64",
      ].join("\n"),
    );
  }

  const observed = apkVersion(apkPath);
  if (observed.error) {
    fail(observed.error, SDK_REMEDY);
  }
  if (String(observed.code) !== String(expected.code)) {
    fail(
      `the APK declares versionCode ${observed.code}, but this release's version ` +
        `(${expected.name}) carries ${expected.code} — this is a stale or foreign artefact.`,
      BUILD_REMEDY,
    );
  }
  if (observed.name !== expected.name) {
    fail(
      `the APK declares versionName "${observed.name}", but the release is ${expected.name}.`,
      BUILD_REMEDY,
    );
  }

  const signed = signature(apkPath);
  if (signed.error) {
    fail(`the APK is not verified as signed — ${signed.error}.`, SDK_REMEDY);
  }
  if (signed.signers > 1) {
    fail(
      `the APK has ${signed.signers} signers; a release APK is signed by one key.`,
      BUILD_REMEDY,
    );
  }
  if (!signed.digest) {
    fail(
      "apksigner verified the APK but reported no certificate digest, so the signer is unknown.",
      SDK_REMEDY,
    );
  }
  if (/android debug/i.test(signed.subject ?? "")) {
    fail(
      `the APK is signed with the Android DEBUG key (${signed.subject}), not the release key. ` +
        "A debug-signed APK installs on a phone but no release can ever upgrade over it.",
      [
        "  Create the keystore and key.properties as docs/ANDROID_DISTRIBUTION.md §1",
        "  describes, then rebuild the release APK.",
      ].join("\n"),
    );
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex").toUpperCase();
  console.log(
    [
      `check-android-apk: OK — ${relative(REPO, apkPath)}`,
      `  signed by ${signed.subject ?? "<unnamed subject>"}`,
      `  certificate SHA-256 ${signed.digest.toUpperCase()}`,
      `  ${RELEASE_ABI} only (${nativeLibraries.length} native librar${nativeLibraries.length === 1 ? "y" : "ies"})`,
      `  versionCode ${observed.code}, versionName ${observed.name}`,
      `  ${symbols.offending.length} undefined EVP/CRYPTO/OPENSSL symbols in libpurple_memo_lib.so ` +
        `(${symbols.undefinedCount} undefined symbols scanned)`,
      `  symbols read with ${symbols.tool}`,
      `  APK SHA-256 ${sha256}`,
    ].join("\n"),
  );
}

// Importable by scripts/check-android-apk.test.mjs, which proves the symbol
// verdict without an APK; running the file still runs the gate.
if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
