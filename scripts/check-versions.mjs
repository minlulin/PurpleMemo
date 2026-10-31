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

// --- Vendored crypto (docs/AUDIT.md DUP-09) -------------------------------
// The LAN share page runs in a phone browser with no bundler, so
// `@noble/ciphers` is copied into `src-tauri/share/_crypto/` by hand. That copy
// was byte-identical to the installed package but nothing enforced it: a
// dependency bump would leave the phone page decrypting with the old library,
// and the only symptom would be a phone that cannot open the link.
const VENDORED = ["aes.js", "_polyval.js", "utils.js"];
const vendoredDir = "src-tauri/share/_crypto";
const packageDir = "node_modules/@noble/ciphers";

for (const name of VENDORED) {
  let vendored;
  let installed;
  try {
    vendored = readFileSync(`${vendoredDir}/${name}`);
  } catch (e) {
    console.error(
      `check-versions: FAILED — cannot read ${vendoredDir}/${name}: ${e instanceof Error ? e.message : String(e)}`,
    );
    process.exit(1);
  }
  try {
    installed = readFileSync(`${packageDir}/${name}`);
  } catch {
    // Dependencies not installed (a docs-only checkout): the version check
    // above still ran, and there is nothing to compare against.
    console.log(
      `check-versions: skipped vendored-crypto compare (${packageDir} not installed)`,
    );
    break;
  }
  if (!vendored.equals(installed)) {
    console.error(
      `check-versions: FAILED — ${vendoredDir}/${name} differs from ${packageDir}/${name}.\n` +
        "  The vendored copy is what the phone's share page runs. Refresh it with:\n" +
        `    cp ${packageDir}/{aes.js,_polyval.js,utils.js} ${vendoredDir}/\n` +
        "  and re-run the share tests before bumping @noble/ciphers.",
    );
    process.exit(1);
  }
}

// --- Limits that exist in both languages (docs/AUDIT.md DUP-10) -----------
// These values are enforced on ONE side and documented on the other: the Rust
// command refuses an oversized photo, the TypeScript exporter refuses to write
// an archive that restore would reject. They carried different names in the two
// languages and were kept in sync by nothing but care, so a rename or a value
// change in one place now fails the gate with the pair named.
const SHARED_LIMITS = [
  {
    what: "per-photo ceiling (25 MiB)",
    ts: { file: "src/lib/backup.ts", name: "MAX_BACKUP_PHOTO_BYTES" },
    rust: { file: "src-tauri/src/commands.rs", name: "MAX_SAVED_PHOTO_BYTES" },
  },
  {
    what: "LAN snapshot ceiling (512 KiB)",
    ts: { file: "src/lib/share.ts", name: "MAX_SNAPSHOT_BYTES" },
    rust: { file: "src-tauri/src/share.rs", name: "MAX_SNAPSHOT_BYTES" },
  },
];

/** `25 * 1024 * 1024` / `512 * 1024` -> a number, or null. */
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

console.log(`check-versions: OK — all three manifests agree on ${pkg}`);
