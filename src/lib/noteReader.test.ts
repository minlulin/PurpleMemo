// Unit tests for Note Reader pop-up helpers, Burmese/English word counting,
// adjacent note bounds, and live-vs-switched reader view resolution.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  countWords,
  getAdjacentNoteIndices,
  resolveReaderView,
} from "./noteReader.ts";
import type { CollectionRow, NoteRow } from "./types.ts";

test("countWords returns 0 for empty or whitespace-only content", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("   \n\t  "), 0);
});

test("countWords counts real words without counting Markdown punctuation", () => {
  assert.equal(countWords("Hello world", "en"), 2);
  assert.equal(
    countWords("# Title\n\nThis is a paragraph with several words.", "en"),
    8,
  );
  // Burmese script does not separate every word with spaces; Intl.Segmenter
  // segments actual Burmese words instead of counting whole clauses as 1 word.
  assert.ok(
    countWords("မင်္ဂလာပါ သူငယ်ချင်း နေကောင်းလား", "my") > 3,
    "Burmese word segmenter must split compound phrases into words",
  );
});

test("getAdjacentNoteIndices handles empty list and missing currentId", () => {
  assert.deepEqual(getAdjacentNoteIndices([], 1), {
    currentIndex: -1,
    hasPrev: false,
    hasNext: false,
    prevId: null,
    nextId: null,
  });
  assert.deepEqual(getAdjacentNoteIndices([{ id: 1 }], null), {
    currentIndex: -1,
    hasPrev: false,
    hasNext: false,
    prevId: null,
    nextId: null,
  });
});

test("getAdjacentNoteIndices identifies first, middle, and last note bounds", () => {
  const list = [{ id: 10 }, { id: 20 }, { id: 30 }];

  const first = getAdjacentNoteIndices(list, 10);
  assert.equal(first.currentIndex, 0);
  assert.equal(first.hasPrev, false);
  assert.equal(first.hasNext, true);
  assert.equal(first.prevId, null);
  assert.equal(first.nextId, 20);

  const middle = getAdjacentNoteIndices(list, 20);
  assert.equal(middle.currentIndex, 1);
  assert.equal(middle.hasPrev, true);
  assert.equal(middle.hasNext, true);
  assert.equal(middle.prevId, 10);
  assert.equal(middle.nextId, 30);

  const last = getAdjacentNoteIndices(list, 30);
  assert.equal(last.currentIndex, 2);
  assert.equal(last.hasPrev, true);
  assert.equal(last.hasNext, false);
  assert.equal(last.prevId, 20);
  assert.equal(last.nextId, null);
});

const COLLECTIONS: CollectionRow[] = [
  { id: 1, name: "Personal", created_at: "2026-01-01" },
  { id: 2, name: "Work", created_at: "2026-01-01" },
];

const NOTE_A: NoteRow = {
  id: 10,
  title: "Note A",
  content: "Body A",
  tags: "a",
  collection_id: 1,
  pinned: 0,
  archived: 0,
  created_at: "2026-10-01",
  updated_at: "2026-10-02",
};

const NOTE_B: NoteRow = {
  id: 20,
  title: "Note B",
  content: "Body B",
  tags: "b",
  collection_id: null,
  pinned: 1,
  archived: 0,
  created_at: "2026-10-03",
  updated_at: "2026-10-04",
};

test("resolveReaderView reflects live editor edits, cleared titles, and unsaved collection changes", () => {
  assert.equal(
    resolveReaderView(
      null,
      null,
      { title: "", content: "", tags: "", collection: "none" },
      COLLECTIONS,
    ),
    null,
  );

  // Live editor populated for NOTE_A: cleared title stays "" (so NoteReaderDialog
  // shows Untitled instead of resurrecting "Note A"), and switching collection to
  // 2 ("Work") updates the reader's badge immediately before saving.
  const live = resolveReaderView(
    NOTE_A,
    10,
    { title: "", content: "Edited A", tags: "x, y", collection: 2 },
    COLLECTIONS,
  );
  assert.ok(live);
  assert.equal(live.note.title, "");
  assert.equal(live.note.content, "Edited A");
  assert.equal(live.note.tags, "x, y");
  assert.equal(live.note.collection_id, 2);
  assert.equal(live.collectionName, "Work");
});

test("resolveReaderView prevents a cross-note flash when switching notes before populate runs", () => {
  // User double-clicked NOTE_B while editor still holds NOTE_A (`editorNoteId = 10`).
  const switched = resolveReaderView(
    NOTE_B,
    10,
    { title: "Note A", content: "Body A", tags: "a", collection: 1 },
    COLLECTIONS,
  );
  assert.ok(switched);
  assert.equal(switched.note.id, 20);
  assert.equal(switched.note.title, "Note B");
  assert.equal(switched.note.content, "Body B");
  assert.equal(switched.note.tags, "b");
  assert.equal(switched.collectionName, null);
});

const NOTES_PAGE = readFileSync(
  new URL("../pages/NotesPage.tsx", import.meta.url),
  "utf8",
);
const READER_DIALOG = readFileSync(
  new URL("../components/NoteReaderDialog.tsx", import.meta.url),
  "utf8",
);

test("NotesPage and NoteReaderDialog import shared helpers from noteReader.ts", () => {
  assert.match(NOTES_PAGE, /<NoteReaderDialog\b/);
  assert.match(NOTES_PAGE, /onOpenReader=\{/);
  assert.match(NOTES_PAGE, /className="editor-and-links"/);
  assert.match(NOTES_PAGE, /from "\.\.\/lib\/noteReader\.ts"/);
  assert.match(READER_DIALOG, /from "\.\.\/lib\/noteReader\.ts"/);
});
