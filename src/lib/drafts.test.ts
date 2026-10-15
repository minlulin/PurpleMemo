// Unit tests for the draft persistence helpers (M-01: auto-lock/navigation
// must never destroy unsaved editor content). Runs under `node --test` with
// Node's type-stripping — no JSX, `.ts` imports only.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  appendJournalBlock,
  clearJournalDraft,
  clearNoteDraft,
  type DraftStore,
  draftBaseMatches,
  journalDraftKey,
  loadJournalDraft,
  loadNoteDraft,
  noteDraftKey,
  noteEditorDiffersFromRow,
  parseJournalDraft,
  parseNoteDraft,
  saveJournalDraft,
  saveNoteDraft,
  storedNoteForm,
} from "./drafts.ts";

/**
 * In-memory stand-in for the settings repo with the same JSON semantics:
 * values round-trip through JSON.stringify and a parse failure reads as null
 * (mirroring settingsRepo.getJSON).
 */
function memoryStore(): DraftStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async getJSON<T>(key: string): Promise<T | null> {
      const raw = data.get(key);
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },
    async setJSON(key: string, value: unknown): Promise<void> {
      data.set(key, JSON.stringify(value));
    },
    async remove(key: string): Promise<void> {
      data.delete(key);
    },
  };
}

const NOTE_DRAFT = {
  baseUpdatedAt: "2026-10-14",
  savedAt: 1_760_000_000_000,
  title: "Groceries",
  content: "- rice\n- oil",
  tags: "home, errands",
  collection: 3,
} as const;

test("note draft round-trip: save → load → clear", async () => {
  const store = memoryStore();
  assert.equal(await loadNoteDraft(store, 7), null);
  await saveNoteDraft(store, 7, { ...NOTE_DRAFT });
  assert.deepEqual(await loadNoteDraft(store, 7), { ...NOTE_DRAFT });
  await clearNoteDraft(store, 7);
  assert.equal(await loadNoteDraft(store, 7), null);
});

test("journal draft round-trip, including a day with no entry row", async () => {
  const store = memoryStore();
  const withRow = {
    baseUpdatedAt: "2026-10-14",
    savedAt: 1_760_000_000_000,
    content: "Today I…",
  };
  await saveJournalDraft(store, "2026-10-14", withRow);
  assert.deepEqual(await loadJournalDraft(store, "2026-10-14"), withRow);
  // A brand-new day has no entry yet: base null, still restorable.
  const fresh = {
    baseUpdatedAt: null,
    savedAt: 1_760_000_000_001,
    content: "unsaved…",
  };
  await saveJournalDraft(store, "2026-10-15", fresh);
  assert.deepEqual(await loadJournalDraft(store, "2026-10-15"), fresh);
  await clearJournalDraft(store, "2026-10-14");
  assert.equal(await loadJournalDraft(store, "2026-10-14"), null);
  // The other day's draft is untouched by the first day's clear.
  assert.deepEqual(await loadJournalDraft(store, "2026-10-15"), fresh);
});

test("a corrupt settings value reads as no draft, not as a crash", async () => {
  const store = memoryStore();
  store.data.set(noteDraftKey(7), "{not json");
  assert.equal(await loadNoteDraft(store, 7), null);
  // Well-formed JSON with the wrong shape is rejected too.
  store.data.set(noteDraftKey(7), JSON.stringify(["array"]));
  assert.equal(await loadNoteDraft(store, 7), null);
  store.data.set(
    noteDraftKey(7),
    JSON.stringify({ ...NOTE_DRAFT, collection: "not-a-number" }),
  );
  assert.equal(await loadNoteDraft(store, 7), null);
  store.data.set(
    journalDraftKey("2026-10-14"),
    JSON.stringify({ baseUpdatedAt: 42, savedAt: 1, content: "x" }),
  );
  assert.equal(await loadJournalDraft(store, "2026-10-14"), null);
});

test("parse helpers accept every valid variant", () => {
  assert.deepEqual(parseNoteDraft({ ...NOTE_DRAFT, collection: "none" }), {
    ...NOTE_DRAFT,
    collection: "none",
  });
  assert.equal(parseNoteDraft(null), null);
  assert.equal(parseNoteDraft("draft"), null);
  assert.equal(parseNoteDraft(undefined), null);
  assert.deepEqual(
    parseJournalDraft({ baseUpdatedAt: null, savedAt: 2, content: "" }),
    { baseUpdatedAt: null, savedAt: 2, content: "" },
  );
  assert.equal(parseJournalDraft({ baseUpdatedAt: null, savedAt: 2 }), null);
});

test("draftBaseMatches: restore only onto the exact row state", () => {
  assert.equal(draftBaseMatches("2026-10-14", "2026-10-14"), true);
  assert.equal(draftBaseMatches("2026-10-13", "2026-10-14"), false);
  // Journal: no entry row on either side.
  assert.equal(draftBaseMatches(null, null), true);
  // Draft written against a day that now has an entry row is stale.
  assert.equal(draftBaseMatches(null, "2026-10-14"), false);
  assert.equal(draftBaseMatches("2026-10-14", null), false);
});

test("storedNoteForm mirrors handleSave's normalization exactly", () => {
  assert.deepEqual(
    storedNoteForm({
      title: "  ",
      content: "text",
      tags: " a , b ,, ",
      collection: "none",
    }),
    { title: "Untitled", content: "text", tags: "a,b", collection_id: null },
  );
  assert.deepEqual(
    storedNoteForm({
      title: "Keep",
      content: "",
      tags: "",
      collection: 12,
    }),
    { title: "Keep", content: "", tags: "", collection_id: 12 },
  );
});

test("noteEditorDiffersFromRow: real edits differ, cosmetics do not", () => {
  const row = {
    title: "Keep",
    content: "body",
    tags: "a,b",
    collection_id: 3,
  };
  // Editor in a different but equivalent spelling of the stored row.
  assert.equal(
    noteEditorDiffersFromRow(
      { title: "Keep", content: "body", tags: "a, b", collection: 3 },
      row,
    ),
    false,
  );
  // Blank title vs the row's "Untitled" is not a real change.
  assert.equal(
    noteEditorDiffersFromRow(
      { title: "", content: "body", tags: "a,b", collection: 3 },
      { ...row, title: "Untitled" },
    ),
    false,
  );
  // Each field's real difference is detected.
  assert.equal(
    noteEditorDiffersFromRow(
      { title: "Keep", content: "body!", tags: "a,b", collection: 3 },
      row,
    ),
    true,
  );
  assert.equal(
    noteEditorDiffersFromRow(
      { title: "Keep", content: "body", tags: "a,b,c", collection: 3 },
      row,
    ),
    true,
  );
  assert.equal(
    noteEditorDiffersFromRow(
      { title: "Keep", content: "body", tags: "a,b", collection: "none" },
      row,
    ),
    true,
  );
});

test("regression: the lock round-trip preserves an unsaved edit", async () => {
  // 1. User opens a saved note and types — the page writes a draft.
  const store = memoryStore();
  const savedRow = {
    title: "Plan",
    content: "first",
    tags: "",
    collection_id: null,
  };
  await saveNoteDraft(store, 11, {
    baseUpdatedAt: "2026-10-14",
    savedAt: Date.now(),
    title: savedRow.title,
    content: "first — unsaved continuation",
    tags: savedRow.tags,
    collection: "none",
  });
  // 2. Auto-lock unmounts the page; unlock remounts it and re-reads.
  const restored = await loadNoteDraft(store, 11);
  assert.ok(restored !== null);
  assert.equal(draftBaseMatches(restored.baseUpdatedAt, "2026-10-14"), true);
  assert.equal(restored.content, "first — unsaved continuation");
  assert.equal(
    noteEditorDiffersFromRow(
      {
        title: restored.title,
        content: restored.content,
        tags: restored.tags,
        collection: restored.collection,
      },
      savedRow,
    ),
    true,
  );
  // 3. Saving the note clears the draft; a later lock finds nothing stale.
  await clearNoteDraft(store, 11);
  assert.equal(await loadNoteDraft(store, 11), null);
});
test("draft keys are namespaced: notes vs journals never collide", () => {
  assert.equal(noteDraftKey(7), "draft:note:7");
  assert.equal(journalDraftKey("2026-10-14"), "draft:journal:2026-10-14");
  assert.notEqual(noteDraftKey(1), noteDraftKey(2));
  assert.notEqual(journalDraftKey("2026-10-14"), journalDraftKey("2026-10-15"));
});
test("appendJournalBlock joins with a break, or stands alone when empty", () => {
  assert.equal(
    appendJournalBlock("", "# Untitled\n\nbody"),
    "# Untitled\n\nbody",
  );
  assert.equal(
    appendJournalBlock("prior reflection", "# Note\n\ntext"),
    "prior reflection\n\n---\n\n# Note\n\ntext",
  );
});
