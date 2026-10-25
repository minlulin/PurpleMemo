// Unit tests for Note Reader pop-up logic & navigation boundaries.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/** Pure helper to calculate note index and adjacent note navigation flags. */
export function getAdjacentNoteIndices(
  notes: { id: number }[],
  currentId: number | null,
): {
  currentIndex: number;
  hasPrev: boolean;
  hasNext: boolean;
  prevId: number | null;
  nextId: number | null;
} {
  if (currentId === null || notes.length === 0) {
    return {
      currentIndex: -1,
      hasPrev: false,
      hasNext: false,
      prevId: null,
      nextId: null,
    };
  }
  const currentIndex = notes.findIndex((n) => n.id === currentId);
  if (currentIndex === -1) {
    return {
      currentIndex: -1,
      hasPrev: false,
      hasNext: false,
      prevId: null,
      nextId: null,
    };
  }
  const hasPrev = currentIndex > 0;
  const hasNext = currentIndex < notes.length - 1;
  const prevNote = hasPrev ? notes[currentIndex - 1] : undefined;
  const nextNote = hasNext ? notes[currentIndex + 1] : undefined;
  return {
    currentIndex,
    hasPrev,
    hasNext,
    prevId: prevNote ? prevNote.id : null,
    nextId: nextNote ? nextNote.id : null,
  };
}

/** Pure helper to calculate word count for note content. */
export function countWords(content: string): number {
  const trimmed = content.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

test("countWords returns 0 for empty or whitespace-only content", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("   \n\t  "), 0);
});

test("countWords counts space-delimited and newline-delimited words accurately", () => {
  assert.equal(countWords("Hello world"), 2);
  assert.equal(
    countWords("# Title\n\nThis is a paragraph with several words."),
    9,
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

  // First item: hasNext is true, hasPrev is false
  const first = getAdjacentNoteIndices(list, 10);
  assert.equal(first.currentIndex, 0);
  assert.equal(first.hasPrev, false);
  assert.equal(first.hasNext, true);
  assert.equal(first.prevId, null);
  assert.equal(first.nextId, 20);

  // Middle item: both true
  const middle = getAdjacentNoteIndices(list, 20);
  assert.equal(middle.currentIndex, 1);
  assert.equal(middle.hasPrev, true);
  assert.equal(middle.hasNext, true);
  assert.equal(middle.prevId, 10);
  assert.equal(middle.nextId, 30);

  // Last item: hasNext is false, hasPrev is true
  const last = getAdjacentNoteIndices(list, 30);
  assert.equal(last.currentIndex, 2);
  assert.equal(last.hasPrev, true);
  assert.equal(last.hasNext, false);
  assert.equal(last.prevId, 20);
  assert.equal(last.nextId, null);
});

// Source pin: Verify NotesPage renders NoteReaderDialog and handles onOpenReader
const NOTES_PAGE = readFileSync(
  new URL("../pages/NotesPage.tsx", import.meta.url),
  "utf8",
);

test("NotesPage integrates NoteReaderDialog and reader trigger button", () => {
  assert.match(
    NOTES_PAGE,
    /<NoteReaderDialog\b/,
    "NotesPage must render NoteReaderDialog",
  );
  assert.match(
    NOTES_PAGE,
    /onOpenReader=\{/,
    "NoteEditor must be supplied onOpenReader",
  );
  assert.match(
    NOTES_PAGE,
    /className="editor-and-links"/,
    "NotesPage must use editor-and-links layout container",
  );
});
