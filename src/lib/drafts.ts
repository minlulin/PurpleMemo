// Draft persistence for the two markdown editors: editor state lives
// in page component state and is only written by an explicit Save, so the
// auto-lock, section navigation and note/day switching used to throw
// unsaved text away without warning. Drafts ride the settings key-value table
// — the same SQLCipher-backed store as everything else — so unsaved
// text keeps the at-rest protection of the database instead of landing in a
// plaintext localStorage side channel.
//
// Every draft records the row's `updated_at` it was written against (the
// "base"). A draft is restored only while the base still matches the row;
// once the row moves on (a save elsewhere, a backup import), the draft is
// stale and is dropped rather than resurrected over newer data. Draft
// persistence is best-effort everywhere: a failed write or read must never
// interrupt typing — the explicit Save keeps reporting its own errors.

import { parseTags } from "./notes.ts";

/** The slice of a settings repo drafts need (structurally = settingsRepo). */
export interface DraftStore {
  getJSON<T>(key: string): Promise<T | null>;
  setJSON(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface NoteDraft {
  /** The note row's `updated_at` at the time this draft was written. */
  baseUpdatedAt: string;
  /** Epoch ms — internal bookkeeping, never displayed (dates are local). */
  savedAt: number;
  title: string;
  content: string;
  tags: string;
  collection: number | "none";
}

export interface JournalDraft {
  /** The entry's `updated_at`, or null while the day had no entry row. */
  baseUpdatedAt: string | null;
  savedAt: number;
  content: string;
}

/** The note editor's four fields, shaped exactly like the editor state. */
export interface NoteEditorFields {
  title: string;
  content: string;
  tags: string;
  collection: number | "none";
}

/** The note row slice a saved note is compared against. */
export interface StoredNoteForm {
  title: string;
  content: string;
  tags: string;
  collection_id: number | null;
}

/** The stored note's columns the discard path reloads the editor from. */
export interface NoteRowForEditor {
  title: string;
  content: string;
  tags: string;
  collection_id: number | null;
}

/**
 * The editor state a discard restores: the stored row, verbatim (review P2-6).
 *
 * This is the destructive half of the never-lose-text feature and it used to be
 * inlined in `NotesPage`, where nothing could reach it. It is deliberately NOT
 * `storedNoteForm` inverted — a discard must not normalize anything. It puts
 * back exactly the bytes the row holds, including a blank title and
 * `"a, b"` tag spacing, because "reload what is saved" is the whole promise; a
 * discard that came back subtly different would show the user text they never
 * had and call it the saved note.
 */
export function noteRowToEditor(row: NoteRowForEditor): NoteEditorFields {
  return {
    title: row.title,
    content: row.content,
    tags: row.tags,
    collection: row.collection_id ?? "none",
  };
}

export function noteDraftKey(id: number): string {
  return `draft:note:${id}`;
}

export function journalDraftKey(date: string): string {
  return `draft:journal:${date}`;
}

/**
 * What separates two appended journal blocks: a blank line, a thematic break,
 * a blank line.
 *
 * One definition for every appender. The Notes "Send to journal" path uses it
 * through {@link appendJournalBlock}; the quick-capture inbox binds it as a
 * parameter into an upsert, because that path must not read the day's content
 * first (see `lib/inbox.ts` — a read-then-write would lose a concurrent
 * append). Two literals would eventually disagree, and the disagreement would
 * only show up as a differently-shaped day.
 */
export const JOURNAL_BLOCK_SEPARATOR = "\n\n---\n\n";

/**
 * Append a `# heading + body` block to a journal entry, separating it from
 * the previous content with a thematic break. Shared by the Notes
 * "Send to journal" path so the stored entry and any unsaved journal draft
 * for the day are folded identically — otherwise a restored draft would hide
 * the appended note.
 */
export function appendJournalBlock(
  existingContent: string,
  block: string,
): string {
  return existingContent.length > 0
    ? `${existingContent}${JOURNAL_BLOCK_SEPARATOR}${block}`
    : block;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict shape check for a parsed settings payload. Anything malformed (a
 * corrupt row, a value written by a future/foreign code path) yields null so
 * the caller falls back to the saved row instead of crashing the editor.
 */
export function parseNoteDraft(raw: unknown): NoteDraft | null {
  if (!isRecord(raw)) return null;
  const { baseUpdatedAt, savedAt, title, content, tags, collection } = raw;
  if (typeof baseUpdatedAt !== "string") return null;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  if (typeof title !== "string") return null;
  if (typeof content !== "string") return null;
  if (typeof tags !== "string") return null;
  if (collection !== "none" && typeof collection !== "number") return null;
  if (typeof collection === "number" && !Number.isInteger(collection)) {
    return null;
  }
  return { baseUpdatedAt, savedAt, title, content, tags, collection };
}

export function parseJournalDraft(raw: unknown): JournalDraft | null {
  if (!isRecord(raw)) return null;
  const { baseUpdatedAt, savedAt, content } = raw;
  if (baseUpdatedAt !== null && typeof baseUpdatedAt !== "string") return null;
  if (typeof savedAt !== "number" || !Number.isFinite(savedAt)) return null;
  if (typeof content !== "string") return null;
  return { baseUpdatedAt, savedAt, content };
}

export async function loadNoteDraft(
  store: DraftStore,
  id: number,
): Promise<NoteDraft | null> {
  return parseNoteDraft(await store.getJSON<unknown>(noteDraftKey(id)));
}

export async function saveNoteDraft(
  store: DraftStore,
  id: number,
  draft: NoteDraft,
): Promise<void> {
  await store.setJSON(noteDraftKey(id), draft);
}

export async function clearNoteDraft(
  store: DraftStore,
  id: number,
): Promise<void> {
  await store.remove(noteDraftKey(id));
}

export async function loadJournalDraft(
  store: DraftStore,
  date: string,
): Promise<JournalDraft | null> {
  return parseJournalDraft(await store.getJSON<unknown>(journalDraftKey(date)));
}

export async function saveJournalDraft(
  store: DraftStore,
  date: string,
  draft: JournalDraft,
): Promise<void> {
  await store.setJSON(journalDraftKey(date), draft);
}

export async function clearJournalDraft(
  store: DraftStore,
  date: string,
): Promise<void> {
  await store.remove(journalDraftKey(date));
}

/**
 * A draft may only be restored onto the exact row state it was written for:
 * anything else (the row was saved or re-imported since) means the draft is
 * stale, and stale drafts are dropped, never merged.
 */
export function draftBaseMatches(
  draftBase: string | null,
  rowBase: string | null,
): boolean {
  return draftBase === rowBase;
}

/**
 * The note editor's fields normalized exactly the way `handleSave` writes
 * them (blank title → "Untitled", tags parsed and re-joined, `none` → null).
 * This is what the row contains after a save, so it is the right form for
 * asking "has the editor moved away from what is stored?" — without it a
 * cosmetic difference like `"a, b"` vs `"a,b"` would read as unsaved work.
 */
export function storedNoteForm(fields: NoteEditorFields): StoredNoteForm {
  return {
    title: fields.title.trim().length > 0 ? fields.title : "Untitled",
    content: fields.content,
    tags: parseTags(fields.tags).join(","),
    collection_id: fields.collection === "none" ? null : fields.collection,
  };
}

/**
 * True when the editor differs from the stored note — the trigger for both
 * the "Unsaved changes" badge and keeping (vs clearing) a draft after a save.
 */
export function noteEditorDiffersFromRow(
  fields: NoteEditorFields,
  row: StoredNoteForm,
): boolean {
  const stored = storedNoteForm(fields);
  return (
    stored.title !== row.title ||
    stored.content !== row.content ||
    stored.tags !== row.tags ||
    stored.collection_id !== row.collection_id
  );
}
