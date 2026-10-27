// Pure helpers for the Notes workspace & full-view Note Reader dialog:
// adjacent-note bounds, locale-aware word counting (including Burmese script),
// and resolving the live editor state without a cross-note flash when
// switching notes.

import type { NoteEditorFields } from "./drafts.ts";
import type { Locale } from "./i18n.ts";
import type { CollectionRow, NoteRow } from "./types.ts";

export interface AdjacentNotes {
  currentIndex: number;
  hasPrev: boolean;
  hasNext: boolean;
  prevId: number | null;
  nextId: number | null;
}

/** Calculate note index and adjacent note navigation flags. */
export function getAdjacentNoteIndices(
  notes: readonly { id: number }[],
  currentId: number | null,
): AdjacentNotes {
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

const wordSegmenters = new Map<string, Intl.Segmenter>();

function wordSegmenter(locale: string): Intl.Segmenter {
  const cached = wordSegmenters.get(locale);
  if (cached !== undefined) return cached;
  const created = new Intl.Segmenter(locale, { granularity: "word" });
  wordSegmenters.set(locale, created);
  return created;
}

/**
 * Locale-aware word count. Uses `Intl.Segmenter` word granularity so scripts
 * without inter-word spaces (such as Burmese `my`) count actual words rather
 * than space-separated clauses, and Markdown punctuation (`#`, `---`, `*`) is
 * not counted as words.
 */
export function countWords(content: string, locale: Locale = "en"): number {
  const trimmed = content.trim();
  if (trimmed.length === 0) return 0;
  let count = 0;
  for (const segment of wordSegmenter(locale).segment(trimmed)) {
    if (segment.isWordLike) count += 1;
  }
  return count;
}

/**
 * Build the note and collection badge shown by `NoteReaderDialog`.
 *
 * When `editorNoteId === selected.id`, the editor state already holds this
 * note's live (possibly unsaved) fields — including an intentionally cleared
 * title or a changed collection dropdown. On the first render frame after
 * jumping to another note (double-clicking a card or pressing Prev/Next),
 * `selected` has moved before the populate effect has updated the editor
 * fields, so `selected` is returned directly instead of briefly pairing the
 * new note's id with the previous note's content.
 */
export function resolveReaderView(
  selected: NoteRow | null,
  editorNoteId: number | null,
  editor: NoteEditorFields,
  collections: readonly CollectionRow[],
): { note: NoteRow; collectionName: string | null } | null {
  if (selected === null) return null;
  const note: NoteRow =
    editorNoteId === selected.id
      ? {
          ...selected,
          title: editor.title,
          content: editor.content,
          tags: editor.tags,
          collection_id:
            editor.collection === "none" ? null : editor.collection,
        }
      : selected;
  const collectionName =
    note.collection_id === null
      ? null
      : (collections.find((c) => c.id === note.collection_id)?.name ?? null);
  return { note, collectionName };
}
