// Unit tests for the notes feature helpers (§2.4: 140-char plain-text excerpts).
// Runs under `node --test` with Node's type-stripping — no JSX, `.ts` imports only.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { EXCERPT_MAX_CHARS, noteExcerpt } from "./notes.ts";

test("noteExcerpt strips markdown syntax to plain text (§2.4)", () => {
  const md = [
    "# Title",
    "",
    "> Quote line",
    "",
    "- item one",
    "- item two",
    "",
    "**bold** and _under_ with [site](http://a.b/c) and ![pic](p.png) plus `code`",
    "",
    "***",
  ].join("\n");
  assert.equal(
    noteExcerpt(md),
    "Title Quote line item one item two bold and under with site and pic plus code",
  );
});

test("noteExcerpt keeps fenced code text but drops the fence markers", () => {
  assert.equal(
    noteExcerpt("Intro\n\n```ts\nlet x = 1;\n```\n"),
    "Intro let x = 1;",
  );
});

test("noteExcerpt cap is 140 chars, counted with the ellipsis", () => {
  assert.equal(EXCERPT_MAX_CHARS, 140);
  const long = "word ".repeat(100);
  const out = noteExcerpt(long);
  assert.ok(out.length <= EXCERPT_MAX_CHARS, `length ${out.length} > 140`);
  assert.ok(out.endsWith("…"), `must end with ellipsis: ${out.slice(-5)}`);
  assert.ok(out.startsWith("word"), `must keep the head: ${out.slice(0, 20)}`);
  assert.ok(!out.includes("  "), "no double spaces");
});

test("noteExcerpt returns short content unchanged", () => {
  assert.equal(noteExcerpt("hello world"), "hello world");
  assert.equal(noteExcerpt("  padded  \n"), "padded");
});

test("noteExcerpt maps empty and symbol-only content to an empty string", () => {
  assert.equal(noteExcerpt(""), "");
  assert.equal(noteExcerpt("   \n\t  "), "");
  assert.equal(noteExcerpt("***\n---\n"), "");
});
