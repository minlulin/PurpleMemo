#!/usr/bin/env node
/**
 * Build the updater manifest (`latest.json`) for a hand-made release (§9).
 *
 * `tauri build` emits the signed installer and its `.sig`, but NOT this
 * manifest — upstream generates it only in the GitHub Action this project
 * does not use. The app refuses a release whose manifest is wrong (or whose
 * signature field holds a path instead of the signature), so this script
 * assembles and validates it locally.
 *
 * Usage:
 *   node scripts/make-latest-json.mjs \
 *     --version 0.2.0 \
 *     --asset src-tauri/target/release/bundle/nsis/purple-memo_0.2.0_x64-setup.exe \
 *     --notes-file RELEASE_NOTES.md \
 *     --repo minlulin/PurpleMemo \
 *     [--tag v0.2.0] [--out latest.json] [--platform windows-x86_64]
 *
 * Then upload the installer, its `.sig` and `latest.json` to a PUBLISHED
 * (non-draft, non-prerelease) GitHub release — see docs/RELEASE.md.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import {
  buildLatestJson,
  RELEASE_PLATFORM,
  releaseAssetUrl,
} from "../src/lib/release.ts";

function fail(message) {
  console.error(`make-latest-json: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const args = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (typeof flag !== "string" || !flag.startsWith("--")) {
      fail(`unexpected argument ${JSON.stringify(flag)}`);
    }
    if (value === undefined) fail(`${flag} needs a value`);
    args.set(flag.slice(2), value);
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const version = args.get("version");
const asset = args.get("asset");
if (!version) fail("--version is required (e.g. --version 0.2.0)");
if (!asset) fail("--asset is required (path to the built installer)");
if (!existsSync(asset)) fail(`installer not found: ${asset}`);

const sigPath = `${asset}.sig`;
if (!existsSync(sigPath)) {
  fail(
    `signature not found: ${sigPath} — build with the signing key set, see docs/RELEASE.md`,
  );
}

const tag = args.get("tag") ?? `v${version}`;
const out = args.get("out") ?? "latest.json";
const platform = args.get("platform") ?? RELEASE_PLATFORM;
const repo = args.get("repo") ?? "minlulin/PurpleMemo";
const notesFile = args.get("notes-file");
const notes = notesFile
  ? readFileSync(notesFile, "utf8").trim()
  : (args.get("notes") ?? "");

let manifest;
try {
  manifest = buildLatestJson({
    version,
    notes,
    // RFC 3339, UTC: an interchange timestamp, not a user-facing date (§4).
    pubDate: new Date().toISOString(),
    platform,
    signature: readFileSync(sigPath, "utf8").trim(),
    url: releaseAssetUrl(repo, tag, basename(asset)),
  });
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}

writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`make-latest-json: wrote ${out} for ${version} (${platform})`);
console.log(`make-latest-json: signature from ${sigPath}`);
console.log(`make-latest-json: asset url ${manifest.platforms[platform].url}`);
console.log(
  "make-latest-json: next — publish a NON-draft, NON-prerelease release with that installer, its .sig and latest.json:",
);
console.log(
  `  gh release create ${tag} --title "Purple Memo ${version}" --notes-file <notes> "${asset}" "${sigPath}" "${out}"`,
);
