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

console.log(`check-versions: OK — all three manifests agree on ${pkg}`);
