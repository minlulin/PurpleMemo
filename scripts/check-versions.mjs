#!/usr/bin/env node
/**
 * Version-consistency check: the release requires
 * `package.json`, `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` to
 * agree, and the tag keeps the `v` while the manifests do not. A drift is
 * exactly the mistake that makes the updater silently ignore a release or
 * loop offering an update the user already has, so this runs in `verify`
 * (like `check-hooks.mjs`) and fails loudly.
 */
import { readFileSync } from "node:fs";

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(
      `check-versions: FAILED — cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
}

function readCargoVersion(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    console.error(
      `check-versions: FAILED — cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
  const match = /^version\s*=\s*"([^"]+)"\s*$/m.exec(text);
  if (!match?.[1]) {
    console.error(
      `check-versions: FAILED — no [package] version found in ${path}`,
    );
    process.exit(1);
  }
  return match[1];
}

const pkg = readJson("package.json").version;
const tauri = readJson("src-tauri/tauri.conf.json").version;
const cargo = readCargoVersion("src-tauri/Cargo.toml");

for (const [name, value] of Object.entries({ pkg, tauri, cargo })) {
  if (typeof value !== "string" || value.length === 0) {
    console.error(`check-versions: FAILED — ${name} version is missing`);
    process.exit(1);
  }
}

if (pkg !== tauri || pkg !== cargo) {
  console.error(
    "check-versions: FAILED — versions disagree:\n" +
      `  package.json: ${pkg}\n` +
      `  src-tauri/tauri.conf.json: ${tauri}\n` +
      `  src-tauri/Cargo.toml: ${cargo}\n` +
      "  Bump all three together (docs/RELEASE.md step 3).",
  );
  process.exit(1);
}

// --- Limits that exist in both languages -----------
// These values are enforced on ONE side and documented on the other: the Rust
// command refuses an oversized photo, the TypeScript exporter refuses to write
// an archive that restore would reject. They carried different names in the two
// languages and were kept in sync by nothing but care, so a rename or a value
// change in one place now fails the gate with the pair named.
const SHARED_LIMITS = [
  {
    what: "per-photo ceiling (25 MiB)",
    ts: { file: "src/lib/backup.ts", name: "MAX_BACKUP_PHOTO_BYTES" },
    // The ceiling moved with the photo commands into `commands/photos.rs`
    // (P2/Session 3); a scan of `commands.rs` alone would find nothing and
    // this check would report the constant as missing.
    rust: {
      file: "src-tauri/src/commands/photos.rs",
      name: "MAX_SAVED_PHOTO_BYTES",
    },
  },
];

/** `25 * 1024 * 1024` -> a number, or null. */
function numericConstant(text, name) {
  const line = new RegExp(
    `(?:export )?(?:const|static) ${name}\\s*(?::[^=]+)?=\\s*([0-9_ *]+);`,
  ).exec(text);
  const expr = line?.[1];
  if (!expr) return null;
  const cleaned = expr.replace(/_/g, "");
  if (!/^[0-9 *]+$/.test(cleaned)) return null;
  return cleaned
    .split("*")
    .map((part) => Number(part.trim()))
    .reduce((a, b) => a * b, 1);
}

for (const limit of SHARED_LIMITS) {
  const tsValue = numericConstant(
    readFileSync(limit.ts.file, "utf8"),
    limit.ts.name,
  );
  const rustValue = numericConstant(
    readFileSync(limit.rust.file, "utf8"),
    limit.rust.name,
  );
  if (tsValue === null || rustValue === null) {
    console.error(
      `check-versions: FAILED — ${limit.what}: cannot read ${limit.ts.name} (${limit.ts.file}) ` +
        `or ${limit.rust.name} (${limit.rust.file}); a rename must update this check too.`,
    );
    process.exit(1);
  }
  if (tsValue !== rustValue) {
    console.error(
      `check-versions: FAILED — ${limit.what} disagrees across the boundary:\n` +
        `  ${limit.ts.file} ${limit.ts.name} = ${tsValue}\n` +
        `  ${limit.rust.file} ${limit.rust.name} = ${rustValue}`,
    );
    process.exit(1);
  }
}

// --- Pinned toolchains ---------------------------------------------------------
// `.nvmrc` and `rust-toolchain.toml` are what a fresh clone actually installs;
// `engines.node` and `rust-version` are what npm, the gate and clippy believe.
// They drifted apart once (F10), and a stale `rust-version` quietly changes
// which clippy lints run, so the pairs are asserted rather than remembered.

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (e) {
    console.error(
      `check-versions: FAILED — cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
}

const nvmNode = readText(".nvmrc").trim().split(/\r?\n/)[0].trim();
const enginesNode = readJson("package.json").engines?.node ?? "";
if (!nvmNode) {
  console.error("check-versions: FAILED — .nvmrc names no Node version");
  process.exit(1);
}
if (enginesNode !== `>=${nvmNode}`) {
  console.error(
    "check-versions: FAILED — the pinned Node versions disagree:\n" +
      `  .nvmrc: ${nvmNode}\n` +
      `  package.json engines.node: ${enginesNode || "(missing)"}\n` +
      `  Set engines.node to ">=${nvmNode}" so npm enforces the version` +
      " the gate runs on (README, Development).",
  );
  process.exit(1);
}

const toolchainChannel = /^\s*channel\s*=\s*"([^"]+)"\s*$/m.exec(
  readText("rust-toolchain.toml"),
)?.[1];
const cargoRustVersion = /^rust-version\s*=\s*"([^"]+)"\s*$/m.exec(
  readText("src-tauri/Cargo.toml"),
)?.[1];
if (!toolchainChannel || !cargoRustVersion) {
  console.error(
    "check-versions: FAILED — cannot read the pinned Rust version:\n" +
      `  rust-toolchain.toml [toolchain] channel: ${toolchainChannel ?? "(missing)"}\n` +
      `  src-tauri/Cargo.toml rust-version: ${cargoRustVersion ?? "(missing)"}\n` +
      "  A rename must update this check too.",
  );
  process.exit(1);
}
if (toolchainChannel !== cargoRustVersion) {
  console.error(
    "check-versions: FAILED — the pinned Rust versions disagree:\n" +
      `  rust-toolchain.toml: ${toolchainChannel}\n` +
      `  src-tauri/Cargo.toml rust-version: ${cargoRustVersion}\n` +
      "  Bump both together: clippy checks against rust-version while the" +
      " gate builds with the toolchain.",
  );
  process.exit(1);
}

// The notes promise the user which schema their database becomes, and the
// migration is forward-only, so a stale number there is a wrong upgrade
// promise: the notes said "schema v12" while `SCHEMA_VERSION` was 14.
const schemaVersion = /pub const SCHEMA_VERSION: i64 = (\d+);/.exec(
  readText("src-tauri/src/schema.rs"),
)?.[1];
const namedSchema = [
  ...readText("RELEASE_NOTES.md").matchAll(/schema v(\d+)/gi),
].map((match) => match[1]);
if (
  schemaVersion === undefined ||
  namedSchema.length === 0 ||
  namedSchema.some((named) => named !== schemaVersion)
) {
  const named = [...new Set(namedSchema)].map((v) => `schema v${v}`).join(", ");
  console.error(
    "check-versions: FAILED — the release notes and the schema disagree:\n" +
      `  src-tauri/src/schema.rs: SCHEMA_VERSION = ${schemaVersion ?? "(unreadable)"}\n` +
      `  RELEASE_NOTES.md: ${named || "names no schema version"}\n` +
      "  The notes must name the schema the code actually applies.",
  );
  process.exit(1);
}

console.log(
  `check-versions: OK — all three manifests agree on ${pkg}; ` +
    `Node ${nvmNode} and Rust ${toolchainChannel} are pinned on both sides; ` +
    `RELEASE_NOTES.md names schema v${schemaVersion}`,
);
