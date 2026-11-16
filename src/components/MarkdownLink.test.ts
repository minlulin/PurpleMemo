// MarkdownLink / markdown headings: rendered where it can be rendered, wiring
// where it cannot.
//
// The heading ids (Decision 2, audit A4) used to be asserted by reading the
// component's source. That is exactly the check that missed A4: the source said
// `scope.alloc(text)` and looked per-document, while the second note to render
// an `# Introduction` still came out as `introduction-1`, so its own
// `[Jump](#introduction)` scrolled nowhere. String matching cannot see output.
//
// So the ids are rendered for real here: `markdownHeadings.ts` holds the
// heading components and the per-document scope, and it has no JSX, so plain
// `node --test` can import it and `renderToString` it (this project still has
// no React testing library, and `*.test.tsx` neither matches the test glob nor
// loads under plain node — the dead-test incident of `a6e8162`).
//
// The two remaining source checks are the ones a render cannot reach: every
// page's `ReactMarkdown` passing `urlTransform` (M5) and the opener receiving a
// normalized URL (M6). Mounting those pages needs the Tauri bridge, a database
// and translations; the strings it must contain are wiring, not behavior.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { ReactElement, ReactNode } from "react";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { headingComponents, MarkdownDocument } from "./markdownHeadings.ts";

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

type Heading = (typeof headingComponents)["h1"];

/** A heading ELEMENT — never `h1("…")`, which would call hooks outside a render. */
function heading(tag: Heading, ...children: ReactNode[]): ReactElement {
  return createElement(tag, null, ...children);
}

/** One rendered markdown document, exactly as a preview wraps it. */
function renderDocument(documentKey: string, children: ReactElement[]): string {
  return renderToString(
    createElement(MarkdownDocument, { documentKey }, ...children),
  );
}

/** What react-markdown emits for `[Jump](#introduction)`. */
const jumpToIntroduction = createElement(
  "a",
  { href: "#introduction" },
  "Jump",
);

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
    linkSrc.includes("export { markdownUrlTransform }"),
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

test("two documents each own their `#introduction` anchor (A4)", () => {
  // The bug: one session-wide scope for the whole app. The first note took
  // `introduction`, so the second note — a different document — rendered
  // `introduction-1` and its `[Jump](#introduction)` found nothing.
  const noteA = renderDocument("note:1", [
    heading(headingComponents.h1, "Introduction"),
    jumpToIntroduction,
  ]);
  const noteB = renderDocument("note:2", [
    heading(headingComponents.h1, "Introduction"),
    jumpToIntroduction,
  ]);

  for (const [label, html] of [
    ["first note", noteA],
    ["second note", noteB],
  ] as const) {
    assert.match(
      html,
      /<h1 id="introduction">Introduction<\/h1>/,
      `${label}: its heading must render the plain \`introduction\` id`,
    );
    assert.match(
      html,
      /<a href="#introduction">Jump<\/a>/,
      `${label}: its in-document anchor must be present in the same render`,
    );
    assert.doesNotMatch(
      html,
      /introduction-\d/,
      `${label}: a document that allocates \`introduction\` once must never see a numbered duplicate`,
    );
  }
});

test("duplicates are deduplicated inside a document, not across documents (A4)", () => {
  // Dedup still has to work where it is needed: two headings with the same text
  // in ONE note must not share an id, or the second one is unreachable.
  const noteA = renderDocument("note:1", [
    heading(headingComponents.h1, "Introduction"),
    heading(headingComponents.h1, "Introduction"),
  ]);
  assert.match(
    noteA,
    /<h1 id="introduction">/,
    "first heading keeps the base id",
  );
  assert.match(
    noteA,
    /<h1 id="introduction-1">/,
    "the duplicate inside the same document takes the next id",
  );

  // A different document starts from scratch: it must not inherit A's counter
  // (that is what `introduction-2` in the old session-wide scope looked like).
  const noteB = renderDocument("note:2", [
    heading(headingComponents.h1, "Introduction"),
  ]);
  assert.match(
    noteB,
    /<h1 id="introduction">/,
    "a new document starts at the base id",
  );
  assert.doesNotMatch(noteB, /introduction-\d/, "and never at A's count");
});

test("every heading level renders an id from its text (Decision 2)", () => {
  for (const [tag, Component] of Object.entries(headingComponents)) {
    const html = renderDocument(`level:${tag}`, [
      heading(Component, "Section"),
    ]);
    assert.match(
      html,
      new RegExp(`<${tag} id="section">Section</${tag}>`),
      `${tag}: must render with the slug of its text — an id-less heading is an unreachable anchor`,
    );
  }
});

test("a heading's id is its text, not its markup (Decision 2)", () => {
  // Titles are styled inline all the time (`## *Intro*duction`); the slug has
  // to come from the text runs, not from the element names.
  const html = renderDocument("note:styled", [
    heading(
      headingComponents.h2,
      createElement("em", null, "Intro"),
      " duction",
    ),
  ]);
  assert.match(
    html,
    /<h2 id="intro-duction"><em>Intro<\/em> duction<\/h2>/,
    "the id must be built from the rendered text, with the markup kept in the label",
  );
});

test("a heading rendered outside any MarkdownDocument still gets an id (fallback)", () => {
  // The pre-A4 session scope survives as a safety net so an unwrapped preview
  // renders ids instead of crashing. It is not the contract — the contract is
  // the per-document scope above — so this only pins that it still exists.
  const html = renderToString(heading(headingComponents.h1, "Loose heading"));
  assert.match(html, /<h1 id="loose-heading">Loose heading<\/h1>/);
});
