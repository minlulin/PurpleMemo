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

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SOURCE = readFileSync(
  new URL("./SettingsPage.tsx", import.meta.url),
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
