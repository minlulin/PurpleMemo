// Batch-12 D2 (docs/Arena_Findings_Batch12.md): heading ids for rendered
// Markdown. Pure logic lives in `./headingIds.ts` so `node --test` can
// exercise it directly — the component only owns the React side (one
// allocation per mounted heading).

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createHeadingIdScope, slugifyHeading } from "./headingIds.ts";

test("slugifyHeading: plain words become a dashed slug", () => {
  assert.equal(slugifyHeading("Introduction"), "introduction");
  assert.equal(slugifyHeading("Hello World"), "hello-world");
  assert.equal(slugifyHeading("  Padded   out  "), "padded-out");
});

test("slugifyHeading: keeps the script (Burmese headings stay readable)", () => {
  // `\w` would strip the whole heading and degrade every Burmese title to
  // `heading-N`; `\p{L}` keeps it. His notes are in Burmese.
  assert.equal(slugifyHeading("နိဒါန်း"), "နိဒါန်း");
  assert.equal(slugifyHeading("မှတ်စု ၁၂၃"), "မှတ်စု-၁၂၃");
});

test("slugifyHeading: empty or punctuation-only text still gets an id", () => {
  assert.equal(slugifyHeading(""), "heading");
  assert.equal(slugifyHeading("..."), "heading");
  assert.equal(slugifyHeading("!!! ???"), "heading");
});

test("scope: duplicate headings are deduplicated", () => {
  const scope = createHeadingIdScope();
  assert.equal(scope.alloc("Introduction"), "introduction");
  assert.equal(scope.alloc("Introduction"), "introduction-1");
  assert.equal(scope.alloc("Introduction"), "introduction-2");
});

test("scope: the edit-twice case can never collide", () => {
  // The old offset-reset cleared the map mid-document, so editing two
  // headings to the same text could hand out a duplicate id. The scope
  // only grows: an id handed out is never handed out again.
  const scope = createHeadingIdScope();
  assert.equal(scope.alloc("Introduction"), "introduction");
  assert.equal(scope.alloc("Introduction"), "introduction-1");
  assert.equal(scope.alloc("Intro"), "intro");
  assert.equal(scope.alloc("Intro"), "intro-1");
});

test("scope: separate scopes do not interfere", () => {
  const a = createHeadingIdScope();
  const b = createHeadingIdScope();
  assert.equal(a.alloc("Introduction"), "introduction");
  assert.equal(b.alloc("Introduction"), "introduction");
});
