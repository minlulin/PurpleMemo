#!/usr/bin/env node
/**
 * Dead-code check: two rules, both deliberately zero-false-positive, that no
 * compiler or linter in this project can express.
 *
 * 1. **An exported declaration referenced nowhere.** `tsc` with
 *    `noUnusedLocals` catches a dead *local*, but an `export` opts the name out
 *    of that check permanently: the leftover compiles, lints, and either ships
 *    or is quietly tree-shaken away while nothing calls it. One review pass on
 *    2026-11-15 removed six such leftovers (`stampAfter`, `SYNC_STATE_ID`,
 *    `seedTombstone`, `killPeer`, `SNAPSHOT_PULL_DISCLOSURE`,
 *    `clipboardProbeRead`), each of whose only reference was its own
 *    declaration.
 *
 * 2. **A source module nothing imports.** The bundler drops it, `tsc` is happy,
 *    and the only symptom is a file someone edits a year later and wonders why
 *    nothing happened. Nothing else in the gate walks the import graph, so this
 *    is where it gets walked.
 *
 * What is NOT flagged, on purpose:
 *
 *   - an export used only inside its own file (an `export` where `const` would
 *     do). That is an over-broad keyword, not dead code, and it is widespread
 *     in this tree; flagging it would bury the real findings.
 *   - an export whose only consumer is a test, and a module only a test
 *     imports. Tests are consumers: `mock-driver.ts`, `envelope.ts`,
 *     `frame.ts` and `harness.ts` exist to check the wire against Rust.
 *   - `src/main.tsx`, `*.test.ts` and `scripts/*.mjs` as orphan candidates:
 *     they are entry points (`index.html`, the `node --test` glob, npm). They
 *     are still walked as importers, which is what keeps `src/lib/release.ts`
 *     alive — its only importer is `scripts/make-latest-json.mjs`.
 *
 * The scan is textual and word-based, like `token-lint.mjs`, so a name
 * mentioned in a comment or a string counts as a reference. That biases the
 * check towards missing dead code rather than failing a good build, which is
 * the right trade for a gate that blocks every push.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, sep } from "node:path";

const norm = (path) => path.split(sep).join("/");

// --- Shared file walking ------------------------------------------------------
const DECL_ROOTS = ["src"];
const DECL_EXTENSIONS = new Set([".ts", ".tsx"]);

/** Everything whose text can count as a reference. */
const REFERENCE_ROOTS = ["src", "scripts"];
const REFERENCE_FILES = ["vite.config.ts", "index.html"];
const REFERENCE_EXTENSIONS = new Set([".ts", ".tsx", ".mjs", ".js", ".html"]);

function collect(dir, extensions, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      collect(path, extensions, files);
    } else if (extensions.has(extname(entry.name))) {
      files.push(path);
    }
  }
  return files;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

const isTestFile = (file) => /\.test\.tsx?$/.test(file);

// =============================================================================
// Rule 1 — modules nothing imports
// =============================================================================

const MODULE_EXTENSIONS = new Set([".ts", ".tsx"]);
/** `from "x"`, `import("x")` and side-effect `import "x"`. */
const IMPORT_PATTERN =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
/** Assets and data, not modules to walk. */
const NON_MODULE_SPECIFIER =
  /\.(css|json|md|png|jpe?g|svg|webp|gif|woff2?|ttf|otf|wasm)$/i;
const RESOLVE_SUFFIXES = [
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  "/index.ts",
  "/index.tsx",
];

/**
 * Resolve a relative specifier to a file in the tree. Returns null for package
 * imports and assets (nothing to walk), `{ unresolved }` for a relative import
 * that names no file, and `{ path }` otherwise.
 *
 * A `.js`/`.mjs` specifier also tries its TypeScript spelling, because ESM
 * rules and bundler rules disagree about the extension and this gate must not
 * be the thing that breaks a correct import.
 */
function resolveImport(importer, specifier) {
  if (!specifier.startsWith(".")) return null;
  if (NON_MODULE_SPECIFIER.test(specifier)) return null;
  const base = norm(join(dirname(importer), specifier));
  const stripped = base.replace(/\.(m?js)$/, "");
  const candidates = [
    base,
    ...RESOLVE_SUFFIXES.map((suffix) => base + suffix),
    `${stripped}.ts`,
    `${stripped}.tsx`,
  ];
  const found = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  return found ? { path: norm(found) } : { unresolved: base };
}

const moduleFiles = collect("src", MODULE_EXTENSIONS).map(norm);
const importerFiles = [
  ...moduleFiles,
  ...collect("scripts", new Set([".mjs"])).map(norm),
];

const edges = new Map();
const unresolved = [];
for (const file of importerFiles) {
  const targets = [];
  for (const match of readFileSync(file, "utf8").matchAll(IMPORT_PATTERN)) {
    const target = resolveImport(file, match[1]);
    if (target === null) continue;
    if (target.unresolved) {
      unresolved.push(`${file} -> ${target.unresolved}`);
      continue;
    }
    targets.push(target.path);
  }
  edges.set(file, targets);
}

/** Entry points: the Vite/HTML entry, the `node --test` glob, and npm scripts. */
const roots = importerFiles.filter(
  (file) =>
    file === "src/main.tsx" || isTestFile(file) || file.startsWith("scripts/"),
);

const reachable = new Set();
const queue = [...roots];
while (queue.length > 0) {
  const file = queue.pop();
  if (reachable.has(file)) continue;
  reachable.add(file);
  for (const target of edges.get(file) ?? []) queue.push(target);
}

const orphans = moduleFiles.filter((file) => !reachable.has(file));

// =============================================================================
// Rule 2 — exports referenced nowhere
// =============================================================================

/** `export function foo`, `export const BAR`, `export type Baz`, ... */
const DECLARATION =
  /^export\s+(?:async\s+)?(?:function|const|let|class|type|interface|enum)\s+([A-Za-z0-9_$]+)/gm;
/** `export default function App` — the name still has to be referenced. */
const DEFAULT_DECLARATION =
  /^export\s+default\s+(?:async\s+)?(?:function|class)\s+([A-Za-z0-9_$]+)/gm;
/**
 * `export { a, b as c };` — a named export list. A list that carries `from` is
 * a re-export, a pass-through rather than a declaration, and is skipped.
 */
const EXPORT_LIST = /^export\s*\{([^}]+)\};?$/gm;

// One pass over one token map, rather than a regex per export: the whole tree
// is ~250 files and stays well under a second.
const referenceFiles = [
  ...REFERENCE_ROOTS.flatMap((root) => collect(root, REFERENCE_EXTENSIONS)),
  ...REFERENCE_FILES.filter((file) => existsSync(file)),
];

const counts = new Map();
for (const file of referenceFiles) {
  const text = readFileSync(file, "utf8");
  for (const [name] of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
}

const declarationFiles = DECL_ROOTS.flatMap((root) =>
  collect(root, DECL_EXTENSIONS),
).filter((file) => !isTestFile(norm(file)));

const dead = [];
let exportCount = 0;
const seen = new Set();

function consider(file, name, index, text) {
  exportCount += 1;
  const key = `${norm(file)}#${name}`;
  if (seen.has(key)) return;
  seen.add(key);
  // Exactly one occurrence in the whole tree = the declaration and nothing
  // else, which is the only case with no legitimate reading.
  if ((counts.get(name) ?? 0) <= 1) {
    dead.push(`${norm(file)}:${lineOf(text, index)}  ${name}`);
  }
}

for (const file of declarationFiles) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(DECLARATION)) {
    consider(file, match[1], match.index, text);
  }
  for (const match of text.matchAll(DEFAULT_DECLARATION)) {
    consider(file, match[1], match.index, text);
  }
  for (const match of text.matchAll(EXPORT_LIST)) {
    if (/\bfrom\b/.test(match[1])) continue;
    for (const part of match[1].split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0];
      if (!name || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) continue;
      consider(file, name, match.index, text);
    }
  }
}

// =============================================================================
// Report
// =============================================================================

const failures = [];

if (unresolved.length > 0) {
  failures.push(
    `\n  ${unresolved.length} relative import(s) resolve to no file:\n` +
      unresolved.map((entry) => `    ${entry}`).join("\n") +
      "\n  Fix the specifier (or teach scripts/dead-code.mjs its resolution\n" +
      "  rule) — an import nothing can resolve is dead code by definition.",
  );
}

if (orphans.length > 0) {
  failures.push(
    `\n  ${orphans.length} module(s) nothing imports nor is reachable from an\n` +
      "  entry point (src/main.tsx, a test, or scripts/):\n" +
      orphans.map((file) => `    ${file}`).join("\n") +
      "\n  A module the app never loads is dead: delete it, or import it where\n" +
      "  it belongs. If it is a new entry point, add it to `roots` above.",
  );
}

if (dead.length > 0) {
  failures.push(
    `\n  ${dead.length} export(s) referenced nowhere in the codebase:\n` +
      dead.map((entry) => `    ${entry}`).join("\n") +
      "\n  An export whose name appears only in its own declaration is dead\n" +
      "  code: delete it (and the file, if that was all it held) rather than\n" +
      "  leaving it for the next reader to trust.",
  );
}

if (failures.length > 0) {
  console.error(`dead-code: FAILED —${failures.join("\n")}`);
  process.exit(1);
}

console.log(
  `dead-code: OK — ${moduleFiles.length} module(s) all reachable, ` +
    `${exportCount} export(s) across ${declarationFiles.length} file(s), every one referenced`,
);
