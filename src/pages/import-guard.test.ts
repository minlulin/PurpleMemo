// The import confirm step is the only destructive action in the app, and
// `node --test` cannot mount a page component — so the ordering rule is pinned
// by reading the page source, the same way `submit-guards.test.ts` pins the
// busy flags.
//
// The rule: the pre-import safety copy is taken BEFORE the data is
// replaced, and a failure to take it stops the import. Both halves matter. An
// `importBackup` that runs first has already deleted the rows the copy was
// meant to protect; a `saveSafetyCopy` whose rejection is swallowed is a
// warning nobody reads.
//
// The second rule (E5): the copy and the replacement are ONE exclusion
// window. The lifecycle opens it at the safety copy in Rust; the frontend
// half is that `importBackup` claims the lease before its first write, every
// write carries it, and a `finally` releases it — so no ordinary writer can
// commit behind the snapshot on a slow import, and a failed import cannot
// leave the app write-blocked.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SOURCE = readFileSync(
  new URL("./SettingsPage.tsx", import.meta.url),
  "utf8",
);
const BACKUP_SOURCE = readFileSync(
  new URL("../lib/backup.ts", import.meta.url),
  "utf8",
);

/** The body of one `const name = async () => {…}` handler, by brace matching. */
function handlerSource(src: string, name: string): string {
  const start = src.search(new RegExp(`const ${name} = (async )?\\(`));
  assert.notEqual(start, -1, `${name} not found — renamed or removed?`);
  const open = src.indexOf("{", start);
  assert.notEqual(open, -1, `${name} has no body`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} body is not brace-balanced`);
}

test("the import takes a safety copy before it replaces anything", () => {
  const body = handlerSource(SOURCE, "confirmImport");
  const copy = body.indexOf("saveSafetyCopy");
  const importIndex = body.indexOf("importBackup");
  assert.notEqual(copy, -1, "confirmImport must take a pre-import copy");
  assert.notEqual(importIndex, -1, "confirmImport no longer imports?");
  assert.ok(
    copy < importIndex,
    "the copy must be written before the import deletes the data",
  );
});

test("a safety copy that fails is not swallowed", () => {
  const body = handlerSource(SOURCE, "confirmImport");
  const call = body.slice(
    body.indexOf("saveSafetyCopy"),
    body.indexOf("importBackup"),
  );
  // No `catch` between the copy and the import: the rejection reaches the
  // handler's own error path, which leaves `pending` in place and the database
  // untouched.
  assert.doesNotMatch(call, /\.catch\s*\(/);
  assert.match(body, /await backupRepo\.saveSafetyCopy\(/);
});

test("the import tells the user where the previous data went", () => {
  // A copy the user cannot find is a copy they will not trust.
  const body = handlerSource(SOURCE, "confirmImport");
  assert.match(body, /toast\.success\(/);
  assert.match(body, /path: safetyCopy/);
});

test("the import claims its exclusion lease before writing and releases it in finally", () => {
  // E5, frontend half: the lease is claimed before the first write — when
  // the safety copy has already opened the window, this attaches to the same
  // lease — and released in a `finally`, so a failed import closes the window
  // too instead of leaving the app write-blocked until a restart.
  const claim = BACKUP_SOURCE.indexOf("await driver.beginImportLease?.()");
  const apply = BACKUP_SOURCE.indexOf(
    "applyBackup(driver, parseBackupZip(bytes), lease)",
  );
  assert.notEqual(claim, -1, "importBackup must claim the window");
  assert.notEqual(apply, -1, "importBackup must apply with the lease");
  assert.ok(claim < apply, "the window must be claimed before the first write");
  assert.match(
    BACKUP_SOURCE,
    /finally \{\s*if \(lease !== undefined\) \{\s*await driver\.endImportLease\?\.\(lease\)\?\.catch/,
    "the window must be released in a finally, swallowing only the release error",
  );
});

test("every destructive import write carries the lease", () => {
  // The FK-off batch is the replacement itself; photo save/delete rewrite the
  // tree. Each must pass the lease, or Rust refuses its own import write
  // while the window is open — fail-closed, but a broken import all the same.
  for (const pattern of [
    /driver\.execute\("PRAGMA foreign_keys = OFF", undefined, lease\)/,
    /driver\.batch\(statements, lease\)/,
    // `\s*` because the FK restore is a fluent chain whose `await driver`\n    // wraps onto its own line in the source.
    /driver\s*\.execute\("PRAGMA foreign_keys = ON", undefined, lease\)/,
    /driver\.savePhoto\(entry\.bytes, ext, lease\)/,
    /driver\.deletePhoto\(path, lease\)/,
  ]) {
    assert.match(BACKUP_SOURCE, pattern, `missing lease: ${pattern}`);
  }
});
