#!/usr/bin/env node
/**
 * Dead-reference check: every path the source mentions has to exist.
 *
 * Five comments and markdown files pointed at an audit document in `docs/` and
 * at its findings batch after both had been deleted, and nothing noticed for
 * weeks: a comment is never executed and a markdown link is never followed by
 * the build. The code went on pointing at a file that was no longer there, and
 * the same rot waits for the next document somebody moves.
 *
 * Two shapes are checked, both unambiguous:
 *  - `docs/<path>` mentioned in a comment, a test title or a markdown file —
 *    the usual way to point at a runbook, and the exact shape that rotted;
 *  - every relative link and link definition in a tracked markdown file, which
 *    is how the README points at `docs/`, `src/` and `LICENSE`.
 *
 * Only comments and prose are scanned in source files. A string literal in code
 * is often a deliberate non-path — `links.test.ts` hands the link router a docs
 * page path to prove it gets blocked — and a fixture that names a file which
 * must not exist is not a dead reference. `stripCode` blanks the code and keeps
 * the comments, preserving line numbers.
 *
 * Resolution is against the tracked file list, not the filesystem, so a
 * reference is case-exact: a link that works on Windows and breaks on Linux is
 * still dead. A directory counts as existing when tracked files live under it.
 *
 * Deliberately not failing:
 *  - paths that escape the repository (`../..`), which are not ours to resolve;
 *  - links with a scheme (`https:`, `mailto:`) or a bare anchor (`#section`), and
 *    anything inside a URL: `…/tauri-docs/…/plugin/updater.mdx` and the NIST
 *    link in the vendored AES copy are upstream addresses, not paths here;
 *  - `src-tauri/share/_crypto/` is a byte-for-byte copy of `@noble/ciphers`
 *    (enforced by `check-versions.mjs`), so its comments belong to upstream;
 *  - `docs/…` tokens containing `*`, `<`, `{` or `$`, which are globs or
 *    templates rather than references.
 *
 * A checkout without git warns and skips, like `check-hooks.mjs`. There is no
 * directory-walk fallback on purpose: a walk cannot honour `.gitignore`, so
 * inside a checkout it would scan ignored scratch and report the paths those
 * files quote as dead references — the ignored audit report on this machine
 * alone produced seventeen. A gate whose verdict depends on which ignored files
 * happen to be lying around answers wrongly, and answering wrongly is worse
 * than saying it did not run: there is no reference set to check against, and
 * every other step of `npm run verify` needs a checkout anyway.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, normalize, sep } from "node:path";

const ROOT = process.cwd();

/** Every file tracked by git — the resolution set and the files to scan. */
function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch (error) {
    const why =
      error?.code === "ENOENT"
        ? "git is not installed, so there is no tracked-file list to resolve against."
        : "not a git checkout, so there is no tracked-file list to resolve against.";
    console.warn(`check-references: WARNING — ${why}`);
    process.exit(0);
  }
}

const COMMENT_ONLY = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
  ".rs",
  ".css",
]);
const WHOLE_TEXT = new Set([
  ".md",
  ".json",
  ".toml",
  ".yml",
  ".yaml",
  ".txt",
  ".sh",
  ".html",
]);

/**
 * Blank out code, keep comments, same length so line numbers still line up.
 *
 * Not a parser: it tracks `//`, `/* *\/`, `"`, `` ` `` and (for JS/TS) `'`.
 * Single quotes are left alone in Rust, where `'a` is a lifetime and treating
 * one as a string would swallow the rest of the line — a missed comment is a
 * missed check, never a false failure.
 */
function stripCode(text, singleQuotes) {
  const out = new Array(text.length);
  let state = "code";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === "code") {
      if (ch === "/" && (next === "/" || next === "*")) {
        state = next === "/" ? "line" : "block";
        out[i] = ch;
        out[i + 1] = next;
        i += 1;
      } else if (ch === '"' || ch === "`" || (singleQuotes && ch === "'")) {
        state = "quote";
        out[i] = " ";
      } else {
        out[i] = ch === "\n" ? "\n" : " ";
      }
      continue;
    }
    if (state === "line") {
      out[i] = ch;
      if (ch === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      out[i] = ch;
      if (ch === "*" && next === "/") {
        out[i + 1] = "/";
        i += 1;
        state = "code";
      }
      continue;
    }
    // Inside a string literal: nothing to keep, but the newlines matter.
    if (ch === "\\") {
      out[i] = " ";
      if (next !== undefined) out[i + 1] = next === "\n" ? "\n" : " ";
      i += 1;
    } else {
      out[i] = ch === "\n" ? "\n" : " ";
      if (ch === '"' || ch === "`" || (singleQuotes && ch === "'")) {
        state = "code";
      }
    }
  }
  return out.join("");
}

const files = trackedFiles();
const tracked = new Set(files);
const directories = new Set([""]);
for (const file of files) {
  const parts = file.split("/");
  for (let i = 1; i < parts.length; i += 1) {
    directories.add(parts.slice(0, i).join("/"));
  }
}

/** True when a repo-relative path names a tracked file or a populated dir. */
function exists(path) {
  return tracked.has(path) || directories.has(path);
}

function fromBase(path, base) {
  if (path.startsWith("/")) return path.slice(1);
  return normalize(join(base, path)).split(sep).join("/");
}

/**
 * Prose glues punctuation to a path ("see docs/RELEASE.md."). The longest
 * prefix that resolves wins; otherwise the reference is dead either way.
 */
function resolves(token, base) {
  if (exists(fromBase(token, base))) return true;
  const trimmed = token.replace(/[.,;:)\]"'`]+$/, "");
  return trimmed !== token && exists(fromBase(trimmed, base));
}

const problems = [];
let checked = 0;

const DOCS_TOKEN = /(^|[\s"'`(<{[*,])(docs\/[A-Za-z0-9._/-]+)/g;
// Upstream links are addresses, not references: `…/updater.mdx` is on GitHub,
// and the vendored crypto comments cite NIST. Blank them before matching.
const URL = /\b[a-z][a-z0-9+.-]*:\/\/\S+|\bwww\.\S+/gi;
// A byte-for-byte vendored dependency, kept in step by `check-versions.mjs`.
const VENDORED = "src-tauri/share/_crypto/";
const MD_LINK = /\[[^\]]*\]\(\s*<?([^)\s>]+)>?\s*(?:"[^"]*")?\)/g;
const MD_LINK_DEF = /^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s|$)/gm;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

for (const file of files) {
  const dot = file.lastIndexOf(".");
  const extension = dot === -1 ? "" : file.slice(dot).toLowerCase();
  const markdown = extension === ".md";
  if (file.startsWith(VENDORED)) continue;
  if (!markdown && !COMMENT_ONLY.has(extension) && !WHOLE_TEXT.has(extension)) {
    continue;
  }

  let raw;
  try {
    raw = readFileSync(join(ROOT, file), "utf8");
  } catch (error) {
    problems.push({
      file,
      line: 0,
      reference: String(error),
      kind: "unreadable",
    });
    continue;
  }
  // A NUL byte means binary wearing a text extension.
  if (raw.includes("\0")) continue;

  const text = COMMENT_ONLY.has(extension)
    ? stripCode(raw, extension !== ".rs")
    : raw;
  const base = dirname(file) === "." ? "" : dirname(file);

  text.split("\n").forEach((line, index) => {
    const lineNumber = index + 1;

    for (const match of line.replace(URL, " ").matchAll(DOCS_TOKEN)) {
      const token = match[2].replace(/[/:]+$/, "");
      if (!token.includes("/")) continue; // "docs/" alone names the folder
      if (/[*<{$]/.test(token)) continue; // glob or template
      checked += 1;
      // A docs path is repo-relative wherever it is written: `docs/RELEASE.md`
      // in `src/lib/x.ts` means the root's docs directory.
      if (!resolves(token, "")) {
        problems.push({
          file,
          line: lineNumber,
          reference: token,
          kind: "path",
        });
      }
    }

    if (!markdown) return;
    for (const match of line.matchAll(MD_LINK)) {
      const target = match[1];
      if (!target || target.startsWith("#") || HAS_SCHEME.test(target))
        continue;
      const path = target.split("#")[0].split("?")[0];
      if (!path) continue;
      checked += 1;
      if (path.startsWith("/")) {
        problems.push({
          file,
          line: lineNumber,
          reference: target,
          kind: "absolute link",
        });
      } else if (fromBase(path, base).startsWith("..")) {
      } else if (!resolves(path, base)) {
        problems.push({
          file,
          line: lineNumber,
          reference: target,
          kind: "link",
        });
      }
    }
  });

  if (!markdown) continue;
  for (const match of raw.matchAll(MD_LINK_DEF)) {
    const target = match[1];
    if (!target || target.startsWith("#") || HAS_SCHEME.test(target)) continue;
    const path = target.split("#")[0].split("?")[0];
    checked += 1;
    if (path.startsWith("/")) {
      problems.push({
        file,
        line: 0,
        reference: target,
        kind: "absolute link",
      });
    } else if (fromBase(path, base).startsWith("..")) {
    } else if (!resolves(path, base)) {
      problems.push({
        file,
        line: 0,
        reference: target,
        kind: "link definition",
      });
    }
  }
}

if (problems.length > 0) {
  console.error(
    `check-references: FAILED — ${problems.length} reference(s) point at a file that does not exist:`,
  );
  // One line per place: a dead path in a README is both a docs token and a
  // link, and printing it twice says nothing new.
  const printed = new Set();
  for (const { file, line, reference, kind } of problems) {
    const where = line > 0 ? `${file}:${line}` : file;
    const key = `${where} ${reference}`;
    if (printed.has(key)) continue;
    printed.add(key);
    console.error(`  ${where}  ${reference}  (${kind})`);
  }
  console.error(
    "  Fix the path or the prose: a reference a reader cannot follow is a\n" +
      "  comment that lies. If the document moved, say where it went.",
  );
  process.exit(1);
}

console.log(
  `check-references: OK — ${checked} reference(s) across ${files.length} tracked files resolve.`,
);
