// Notes editor view modes + collections collapse, the pure half.
// Runs under `node --test` with Node's type-stripping — no JSX, `.ts` imports
// only. The page cannot be unit-tested here, so the decision logic the page
// delegates to is pinned instead: what a stored value parses to, and where
// Ctrl+E takes you from each mode.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DEFAULT_VIEW_MODE,
  type NotesViewMode,
  parseCollectionsCollapsed,
  parseViewMode,
  toggleViewMode,
} from "./notesView.ts";

test("parseViewMode: a stored value must be one of the three modes", () => {
  assert.equal(parseViewMode("edit"), "edit");
  assert.equal(parseViewMode("split"), "split");
  assert.equal(parseViewMode("read"), "read");
});

test("parseViewMode: malformed or missing values fall back to split", () => {
  // The default is today's behaviour (side-by-side), and a corrupt settings
  // row must never surface as an error to the writer.
  assert.equal(parseViewMode(null), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode(undefined), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode("EDIT"), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode("reading"), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode(1), DEFAULT_VIEW_MODE);
  assert.equal(parseViewMode({ mode: "read" }), DEFAULT_VIEW_MODE);
  assert.equal(DEFAULT_VIEW_MODE, "split");
});

test("toggleViewMode (Ctrl+E): Edit <-> Read, Split -> Read", () => {
  // So a second press returns to Edit (spec item 3).
  assert.equal(toggleViewMode("read"), "edit");
  assert.equal(toggleViewMode("edit"), "read");
  assert.equal(toggleViewMode("split"), "read");
  // Exhaustive: every mode has exactly one destination, so adding a fourth
  // mode cannot silently fall through to itself.
  const modes: NotesViewMode[] = ["edit", "split", "read"];
  for (const mode of modes) {
    const next = toggleViewMode(mode);
    assert.ok(modes.includes(next), `${mode} toggled to an unknown mode`);
    assert.notEqual(next, mode, `${mode} toggled to itself`);
  }
});

test("parseCollectionsCollapsed: only a stored true collapses", () => {
  // Same privacy-default shape as notification_preview: absent, corrupt and
  // unexpected values all answer expanded — the sidebar a fresh install sees.
  assert.equal(parseCollectionsCollapsed(true), true);
  assert.equal(parseCollectionsCollapsed(false), false);
  assert.equal(parseCollectionsCollapsed(null), false);
  assert.equal(parseCollectionsCollapsed(undefined), false);
  assert.equal(parseCollectionsCollapsed("true"), false);
  assert.equal(parseCollectionsCollapsed(1), false);
});

// -- Draft-safety source pin --------------------------------------------------
//
// The page can't be mounted under `node --test`, so the one rule that costs a
// writer their text is pinned at the source seam — the same trick
// `app-shortcuts.test.ts` uses on the shell: switching modes must HIDE panes,
// never unmount them, or the draft, undo history, cursor and scroll position
// go with the unmount.

const NOTES_PAGE = readFileSync(
  new URL("../pages/NotesPage.tsx", import.meta.url),
  "utf8",
);
const APP_CSS = readFileSync(
  new URL("../styles/app.css", import.meta.url),
  "utf8",
);

/** The `.editor-split` block, from its opening div to the actions row. */
function editorSplitBlock(): string {
  const start = NOTES_PAGE.indexOf("editor-split mode-");
  assert.notEqual(
    start,
    -1,
    "the editor-split div no longer carries a mode class",
  );
  const end = NOTES_PAGE.indexOf('className="editor-actions"', start);
  assert.notEqual(end, -1, "the editor-actions row is gone");
  return NOTES_PAGE.slice(start, end);
}

test("mode reaches the DOM only as a CSS class on .editor-split", () => {
  assert.match(
    NOTES_PAGE,
    /className=\{`editor-split mode-\$\{p\.viewMode\}`\}/,
    "the view mode must drive a class, not what renders",
  );
});

test("both panes render unconditionally, exactly once each", () => {
  const block = editorSplitBlock();
  assert.equal(
    (block.match(/<textarea/g) ?? []).length,
    1,
    "the markdown textarea must be rendered once, not per mode",
  );
  assert.equal(
    (block.match(/editor-preview/g) ?? []).length,
    1,
    "the preview pane must be rendered once, not per mode",
  );
  // The violation this pins: JSX guarded on the mode (`{p.viewMode ===
  // "edit" && (` or `{p.viewMode ? (`) around pane content.
  assert.doesNotMatch(
    block,
    /\{\s*p\.viewMode\s*(===|!==|\?)[^{]*&&\s*\(/,
    "a pane is conditionally rendered by mode — draft safety forbids it",
  );
});

test("the hidden panes are hidden by CSS, not removed", () => {
  // The mechanism the pin above depends on: mode rules in app.css hide the
  // inactive pane and the drag handle with display:none.
  for (const pattern of [
    /\.editor-split\.mode-edit > \.editor-pane-box:last-child/,
    /\.editor-split\.mode-read > \.editor-pane-box:first-child/,
    /\.editor-split\.mode-edit > \.editor-resize-handle/,
  ]) {
    assert.match(APP_CSS, pattern, "mode hiding rule missing from app.css");
  }
  const ruleBlock = APP_CSS.slice(
    APP_CSS.indexOf(".editor-split.mode-edit >"),
    APP_CSS.indexOf(".editor-split.mode-edit >") + 400,
  );
  assert.match(ruleBlock, /display:\s*none/, "hiding must be display:none");
});
