// Batch-4 journal/inbox gates (findings D1 and D2 in
// docs/Arena_Findings_Batch4.md).
//
// `node --test` cannot mount a page component, so each rule is pinned by
// reading the page source — the same trick submit-guards.test.ts uses on the
// busy flags.
//
//   D1  the inbox journal conversion reads the day's PRE-append base before
//       the batch and folds the same block into a draft written against it,
//       so a restored draft can neither hide the appended block (the next
//       Save would wipe it) nor drop the user's unsaved typing;
//   D2  Save refuses an editor whose text belongs to another day, and its
//       completion writes only land while the load generation that produced
//       the snapshot is still the current one.
//
// D3 (HabitsPage's toggle guard) is pinned in submit-guards.test.ts, which
// owns the guard shape.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function readPage(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

/**
 * The body of one handler, by brace matching. Accepts both binding shapes
 * this file meets: `const name = (…) => {…}` / `const name = useCallback(…)`
 * and `function name(…) {…}`.
 */
function handlerSource(src: string, name: string): string {
  const start = src.search(
    new RegExp(`(?:const ${name} = |function ${name}\\()`),
  );
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

test("the inbox conversion folds the day's draft, base read first (D1)", () => {
  const src = readPage("InboxPage.tsx");
  const body = handlerSource(src, "convert");

  const baseAt = body.indexOf("journalRepo.getEntry(");
  const convertAt = body.indexOf("inboxRepo.convert(");
  const foldAt = body.indexOf("foldJournalDraft(");
  assert.notEqual(baseAt, -1, "convert must read the day's pre-append base");
  assert.ok(
    baseAt < convertAt,
    "the base must be read BEFORE the batch — the batch rewrites updated_at",
  );
  assert.ok(
    convertAt < foldAt,
    "the fold runs only after the conversion has succeeded",
  );
  assert.match(
    body,
    /target === "journal" && row\.status === "open"/,
    "only a row this call actually appends to may be folded — an early return appends nothing",
  );

  const fold = handlerSource(src, "foldJournalDraft");
  assert.match(
    fold,
    /draftBaseMatches\(draft\.baseUpdatedAt, baseBefore\)/,
    "only a draft written against the pre-append base is folded; any other stays stale",
  );
  assert.match(
    fold,
    /appendJournalBlock\(draft\.content, journalBlock\(body\)\)/,
    "the draft gains the exact block the row gained — through the same journalBlock helper the batch uses",
  );
  assert.match(
    fold,
    /baseUpdatedAt: todayLocal\(\)/,
    "the folded draft is rebased onto the row's post-append stamp, so it restores",
  );
});

test("Save refuses an editor that belongs to another day (D2)", () => {
  const src = readPage("JournalPage.tsx");
  const body = handlerSource(src, "handleSave");

  const guard = body.indexOf("loadedForRef.current !== activeDate");
  const write = body.indexOf("journalRepo.upsertEntry(");
  assert.notEqual(
    guard,
    -1,
    "handleSave must refuse while the loaded day is not the day on screen",
  );
  assert.ok(
    guard < write,
    "the refusal must come before the write — otherwise the previous day's text is upserted into the clicked day",
  );
  assert.match(
    body,
    /if \(seq === loadSeqRef\.current\) \{/,
    "the completion writes (entryBase, savedContent, the draft) must be gated on the load generation",
  );

  assert.match(
    handlerSource(src, "loadEntry"),
    /loadedForRef\.current = date;/,
    "the load must publish the day its text belongs to, with the text",
  );
  assert.match(
    src,
    /disabled=\{saving \|\| loading\}/,
    "the Save button must grey out while the day loads",
  );
});
