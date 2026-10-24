#!/usr/bin/env node
/**
 * Token lint: fails the build when hex colors,
 * rgb()/hsl() literals or hardcoded px values appear anywhere outside
 * src/styles/tokens.css. Design values belong in tokens only.
 */
import { readdirSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";

// `src-tauri/share` holds the phone page and the modules it loads, embedded
// into the binary and served over the LAN. It is a second copy of the app's
// look with no build step of its own, so it belongs under the same rule.
const SCAN_ROOTS = ["src", "src-tauri/share"];
// tokens.css holds the design values; tokens.test.ts asserts on those
// exact values — both belong to the token domain.
const EXEMPT_FILES = new Set([
  "src/styles/tokens.css",
  "src/styles/tokens.test.ts",
]);
const EXTENSIONS = new Set([".css", ".html", ".ts", ".tsx"]);

const RULES = [
  { name: "hex color", pattern: /#[0-9a-fA-F]{3,8}\b/ },
  { name: "rgb()/hsl() color", pattern: /\b(?:rgba?|hsla?)\s*\(/i },
  { name: "hardcoded px value", pattern: /\b\d+(?:\.\d+)?px\b/i },
];

function collectFiles(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(path, files);
    } else if (EXTENSIONS.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

const violations = [];
const scanned = SCAN_ROOTS.flatMap((root) => collectFiles(root));

for (const file of scanned) {
  const normalized = file.replaceAll("\\", "/");
  if (EXEMPT_FILES.has(normalized)) continue;
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        const snippet = line.trim().slice(0, 120);
        violations.push(`${normalized}:${index + 1} [${rule.name}] ${snippet}`);
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    `token-lint: FAILED — ${violations.length} violation(s) outside the exempt token files:`,
  );
  for (const violation of violations) {
    console.error(`  ${violation}`);
  }
  process.exit(1);
}

console.log(`token-lint: OK — ${scanned.length} file(s) scanned`);
