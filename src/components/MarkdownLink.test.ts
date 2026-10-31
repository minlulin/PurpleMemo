// Batch-12 M5/M6/D2 wiring (docs/Arena_Findings_Batch12.md), pinned by
// reading the component's source — the same trick the page suites use,
// because `node --test` cannot import JSX: this project has no React
// testing library, and `*.test.tsx` neither matches the test glob nor
// loads under plain node (the dead-test incident of `a6e8162`).
//
// What is asserted is the wiring that makes the behaviour hold:
//
//   M5  every ReactMarkdown in the app gets `urlTransform` so `tel:`
//       survives react-markdown's default allowlist;
//   M6  the opener receives a normalized URL (`new URL(href).href`),
//       not the raw href, so `HTTPS://…` matches the opener's lowercase
//       scope;
//   D2  the shared components render h1-h6 with ids from the heading-id
//       module (allocation itself is unit-tested in `headingIds.test.ts`).

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const linkSrc = readFileSync(
  new URL("./MarkdownLink.tsx", import.meta.url),
  "utf8",
);

function pageSrc(name: string): string {
  return readFileSync(new URL(`../pages/${name}`, import.meta.url), "utf8");
}

function dialogSrc(name: string): string {
  return readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
}

test("every ReactMarkdown site wires the tel:-preserving urlTransform (M5)", () => {
  for (const [label, src] of [
    ["NotesPage", pageSrc("NotesPage.tsx")],
    ["JournalPage", pageSrc("JournalPage.tsx")],
    ["NoteReaderDialog", dialogSrc("NoteReaderDialog.tsx")],
  ] as const) {
    assert.ok(
      src.includes("urlTransform={markdownUrlTransform}"),
      `${label}: its ReactMarkdown must pass urlTransform so tel: links survive`,
    );
  }
  assert.ok(
    linkSrc.includes("export { markdownUrlTransform, urlTransform }"),
    "MarkdownLink: the transform must stay re-exported for the callers",
  );
});

test("the opener receives a normalized URL, never the raw href (M6)", () => {
  assert.ok(
    /route === "external" && href !== undefined \? new URL\(href\)\.href : undefined/.test(
      linkSrc,
    ),
    "MarkdownLink: the value handed to the opener must be new URL(href).href",
  );
  assert.ok(
    !/external =\n.*\? href : undefined/.test(linkSrc),
    "MarkdownLink: the raw href must not reach the opener anymore",
  );
});

test("the shared components render h1-h6 with heading ids (D2)", () => {
  for (const tag of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
    assert.ok(
      new RegExp(`^\\s*${tag},`, "m").test(linkSrc) ||
        linkSrc.includes(`\n  ${tag},`),
      `markdownComponents: ${tag} must be overridden with the id-rendering heading`,
    );
  }
  assert.ok(
    linkSrc.includes("headingScope.alloc(text)"),
    "MarkdownLink: headings must allocate from the heading-id scope",
  );
  assert.ok(
    linkSrc.includes("../lib/headingIds.ts"),
    "MarkdownLink: the id logic must come from the tested lib module",
  );
});
