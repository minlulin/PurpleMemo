// Notes repository: CRUD, collections, tags, pin/archive, FTS search.
// Tags are stored comma-separated in the DB; parsed/joined at this edge.

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import { LIST_CONTENT_CHARS, searchNotes } from "./search.ts";
import {
  deleteStatements,
  outboxStatements,
  readRowId,
  readRowUid,
} from "./sync/store.ts";
import { createTrashRepo } from "./trash.ts";
import type {
  CollectionRow,
  NoteListRow,
  NoteRow,
  NoteTitleRow,
} from "./types.ts";
import { newUid } from "./uid.ts";

export interface NoteInput {
  title: string;
  content: string;
  tags?: string[];
  collectionId?: number | null;
}

export interface NoteFilter {
  collectionId?: number;
  includeArchived?: boolean;
  /**
   * Row cap, applied in SQL. The LAN share only publishes 20 excerpts, so it
   * asks for 20 rows instead of loading every note body and discarding the
   * rest. Browsing leaves it unset.
   */
  limit?: number;
  /**
   * Column set — which decides the row TYPE as much as the SQL (J1): `"full"`
   * selects every column and the whole body; `"list"` (the default) selects
   * every column but truncates `content` in SQL to a preview prefix — enough
   * to excerpt. The two-column `"title"` projection lives on its own typed
   * method, `listNoteTitles`, which answers {@link NoteTitleRow}.
   */
  projection?: "full" | "list";
}

/**
 * Split a comma-separated tag string into clean tags (the editor's input
 * shape → the row's stored shape). Shared by the Notes editor and the draft
 * helpers so both normalize identically.
 */
export function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** Plain-text excerpt cap for list views (— 140 chars, ellipsis included). */
export const EXCERPT_MAX_CHARS = 140;

/**
 * Grapheme and word segmenters for {@link excerptHead} — created once and
 * lazily: constructing one loads ICU segmentation data (~13 ms measured), and
 * `noteExcerpt` runs per rendered row. Both apply their segmentation
 * dictionaries whatever locale is asked for (measured on the Myanmar script),
 * so no locale is threaded through the excerpt — it has none to thread.
 */
let graphemeSegmenter: Intl.Segmenter | undefined;
let wordSegmenter: Intl.Segmenter | undefined;

/**
 * The head of `plain` that fits `maxChars` GRAPHEME CLUSTERS — `plain` itself
 * when it fits — cut at a word boundary when the cap runs out inside a word
 * (K11).
 *
 * The cap counts clusters, not UTF-16 units. A unit budget showed a Burmese
 * excerpt (≈1.6 units per visible character) only ~90 characters where a
 * Latin one got 140, and showed a line of emoji half that; counting clusters
 * also makes the cut un-splittable BY CONSTRUCTION, because a surrogate pair
 * or a base and its combining mark are ONE cluster — `slice(0, n)`, which the
 * old code cut at, could land between them and leave a lone surrogate or a
 * base missing its vowel.
 *
 * The word pass then drops the partial trailing word. Burmese is written
 * without inter-word spaces, so the old `lastIndexOf(" ")` found no boundary
 * at all and every Burmese excerpt ended mid-word — while the doc comment
 * promised a word boundary. This is the same `Intl.Segmenter` word granularity
 * the reader's word counter uses (`noteReader.ts`); the cut only ever moves
 * BACK, so the head ends on a cluster boundary and, where one exists, a word
 * end. When the first word alone overruns the budget, the cluster boundary is
 * kept rather than returning an empty head. (`maxChars` of 1 leaves room only
 * for the ellipsis — the cap is meant to hold it too.)
 *
 * Both walks stop at the budget, never at the end of the body: O(maxChars),
 * ~0.02 ms whether the note is 140 units or 4,000 — it runs per rendered row.
 */
function excerptHead(plain: string, maxChars: number): string {
  graphemeSegmenter ??= new Intl.Segmenter(undefined, {
    granularity: "grapheme",
  });
  const steps = graphemeSegmenter.segment(plain)[Symbol.iterator]();
  let count = 0;
  let budget = 0;
  for (let step = steps.next(); !step.done; step = steps.next()) {
    count += 1;
    const end = step.value.index + step.value.segment.length;
    if (count === maxChars - 1) budget = end; // one slot of the cap is the …
    if (count === maxChars) break;
  }
  if (count < maxChars) return plain; // fewer clusters than the cap
  if (steps.next().done) return plain; // exactly the cap — nothing to cut

  wordSegmenter ??= new Intl.Segmenter(undefined, { granularity: "word" });
  for (const word of wordSegmenter.segment(plain)) {
    const end = word.index + word.segment.length;
    if (end <= budget) continue;
    return word.index > 0 ? plain.slice(0, word.index) : plain.slice(0, budget);
  }
  return plain.slice(0, budget);
}

/**
 * Markdown → plain-text excerpt capped at `maxChars` grapheme clusters.
 * Strips the common CommonMark syntax (fences keep their body, images
 * collapse to alt text, links to their label), collapses whitespace, and
 * truncates at a word boundary with a trailing ellipsis — a boundary
 * `Intl.Segmenter` finds, so space-less scripts such as Burmese no longer end
 * mid-word (K11). Deliberately regex-based and approximate — an excerpt only
 * needs to read cleanly, not to be a full parser.
 */
export function noteExcerpt(
  content: string,
  maxChars = EXCERPT_MAX_CHARS,
): string {
  const plain = content
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1") // fenced code: keep body
    .replace(/^\s*```.*$/gm, "") // unclosed fence markers
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links -> label
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // ATX headings
    .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "") // horizontal rules
    .replace(/^\s*[-*+]\s+/gm, "") // unordered list bullets
    .replace(/^\s*\d+\.\s+/gm, "") // ordered list numbers
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/__([^_]+)__/g, "$1") // bold (underscore)
    .replace(/\*([^*]+)\*/g, "$1") // italic
    .replace(/\b_([^_\s]+)_\b/g, "$1") // italic (underscore, word-bounded
    //                                 // so snake_case_names survive)
    .replace(/\B~+([^~]+)~+\B/g, "$1") // strikethrough
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= maxChars) return plain;
  // Fewer units than the cap means fewer clusters than the cap — the common
  // short-input fast path. The real logic is `excerptHead` (K11): it counts
  // the cap in grapheme clusters, reserves one cluster for the ellipsis, and
  // drops the partial trailing word at a word boundary. `trimEnd` can only
  // cut the head back to another cluster boundary (a space is its own
  // cluster), so alignment survives it.
  const head = excerptHead(plain, maxChars);
  if (head === plain) return plain;
  return `${head.trimEnd()}…`;
}

// The LIST projection's content cap lives in search.ts (K5): this SELECT
// and the FTS SELECT answer the SAME NoteListRow, so the two literals were
// ONE contract — imported, not repeated, and drift between them is now a
// compile error rather than a row that reads 200 characters here and 200
// there.

/**
 * The one place the browse SELECT is assembled, so the three projections
 * cannot drift apart: same WHERE, same ORDER BY, same optional cap — only the
 * column list differs, and it alone decides the row type each caller gets (J1).
 */
function noteListQuery(
  filter: NoteFilter,
  projection: "full" | "list" | "title",
): { sql: string; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.collectionId !== undefined) {
    where.push("collection_id = ?");
    params.push(filter.collectionId);
  }
  if (!filter.includeArchived) where.push("archived = 0");
  const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
  const limit = filter.limit !== undefined ? " LIMIT ?" : "";
  if (filter.limit !== undefined) params.push(filter.limit);
  const columns =
    projection === "full"
      ? "*"
      : projection === "title"
        ? "id, title"
        : `id, title, substr(content, 1, ${LIST_CONTENT_CHARS}) AS content, tags, collection_id, pinned, archived, created_at, updated_at`;
  return {
    sql: `SELECT ${columns} FROM notes${clause} ORDER BY pinned DESC, updated_at DESC, id DESC${limit}`,
    params,
  };
}

/**
 * A note's boolean flags are writes like any other: the row changes, so an op
 * records it in the same batch (§6.1). One column per call, so the op's
 * payload names exactly the field the user flipped.
 */
async function writeNoteFlag(
  driver: DataDriver,
  id: number,
  column: "pinned" | "archived",
  value: number,
): Promise<void> {
  const uid = await readRowUid(driver, "notes", id);
  await driver.batch([
    { sql: `UPDATE notes SET ${column} = ? WHERE id = ?`, params: [value, id] },
    ...outboxStatements(
      uid
        ? [
            {
              table: "notes" as const,
              uid,
              kind: "update",
              fields: { [column]: value },
            },
          ]
        : [],
    ),
  ]);
}

export function createNotesRepo(
  driver: DataDriver,
  trash = createTrashRepo(driver),
) {
  return {
    async listCollections(): Promise<CollectionRow[]> {
      return driver.query<CollectionRow>(
        "SELECT * FROM collections ORDER BY name",
      );
    },

    /**
     * Create a collection.
     *
     * There is deliberately NO rename: `notes_fts.folder` stores a copy of this
     * name at index time, so a bare `UPDATE collections SET name = ?` would
     * leave every note in it findable under the old folder until each note was
     * next edited (docs/AUDIT.md SCHEMA-05). If rename ever ships, it must run
     * `UPDATE notes SET collection_id = collection_id WHERE collection_id = ?`
     * in the same batch — that fires the FTS maintenance trigger.
     */
    async createCollection(name: string): Promise<number> {
      const created = todayLocal();
      const uid = newUid();
      // §6.1: the row and its op commit together, so the insert commits through
      // a batch and the id is read back under the uid this device minted.
      await driver.batch([
        {
          sql: "INSERT INTO collections (name, created_at, uid) VALUES (?, ?, ?)",
          params: [name, created, uid],
        },
        ...outboxStatements([
          {
            table: "collections",
            uid,
            kind: "create",
            fields: { name, created_at: created },
          },
        ]),
      ]);
      return readRowId(driver, "collections", uid);
    },

    async deleteCollection(id: number): Promise<void> {
      const uid = await readRowUid(driver, "collections", id);
      // The notes filed here lose their link in this same batch, so each of
      // them is a note mutation travelling with its own op — a peer that only
      // heard about the delete would keep pointing at a collection that is gone.
      const unfiled = await driver.query<{ uid: string | null }>(
        "SELECT uid FROM notes WHERE collection_id = ? ORDER BY id",
        [id],
      );
      const relinked = unfiled
        .map((row) => row.uid)
        .filter((note: string | null): note is string =>
          Boolean(note && note.length > 0),
        )
        .map((note) => ({
          table: "notes" as const,
          uid: note,
          kind: "update" as const,
          fields: { collection_uid: null },
        }));
      // One batch, notes first: clearing membership via the FK's
      // ON DELETE SET NULL is an FK action, which does NOT fire the notes
      // UPDATE trigger — deleting alone left the collection's name in
      // `notes_fts.folder`, still matching search until each note was next
      // edited (review P3-4). Touching the rows here fires the trigger and
      // retires the name in the same transaction as the delete.
      await driver.batch([
        {
          sql: "UPDATE notes SET collection_id = NULL WHERE collection_id = ?",
          params: [id],
        },
        { sql: "DELETE FROM collections WHERE id = ?", params: [id] },
        ...outboxStatements(relinked),
        // §5.2: the collection itself was deleted, so it leaves a tombstone.
        ...deleteStatements(uid ? [{ table: "collections", uid }] : []),
      ]);
    },

    /**
     * The browse list, answering complete rows. The default `"list"`
     * projection hands back a 200-char `content` PREVIEW, excerpted straight
     * from the row; ask for `"full"` when the body itself is needed — an
     * in-memory search over `content`, an editor. The two-column
     * `"title"` projection is deliberately NOT reachable here: it answers a
     * narrower type, so it lives on `listNoteTitles` (J1).
     */
    async listNotes(filter: NoteFilter = {}): Promise<NoteListRow[]> {
      const { sql, params } = noteListQuery(
        filter,
        filter.projection ?? "list",
      );
      return driver.query<NoteListRow>(sql, params);
    },

    /**
     * The `id, title` projection, for the picker lists that render a label
     * and nothing else. Typed {@link NoteTitleRow} — the other seven
     * `NoteRow` columns are ABSENT at runtime, and this type is what makes
     * reading one a compile error instead of a `TypeError` (J1).
     */
    async listNoteTitles(filter: NoteFilter = {}): Promise<NoteTitleRow[]> {
      const { sql, params } = noteListQuery(filter, "title");
      return driver.query<NoteTitleRow>(sql, params);
    },

    async getNote(id: number): Promise<NoteRow | undefined> {
      const rows = await driver.query<NoteRow>(
        "SELECT * FROM notes WHERE id = ?",
        [id],
      );
      return rows[0];
    },

    async createNote(input: NoteInput): Promise<number> {
      const today = todayLocal();
      // The uid is minted here, on the client that creates the record, so this
      // note is sync-ready before the app has ever paired.
      const uid = newUid();
      const tags = (input.tags ?? []).join(",");
      const collectionId = input.collectionId ?? null;
      // The op names the parent by UID: a local `collection_id` would mean a
      // different collection on the peer (§3.4, §8.4).
      const collectionUid =
        collectionId === null
          ? null
          : ((await readRowUid(driver, "collections", collectionId)) ?? null);
      await driver.batch([
        {
          sql: `INSERT INTO notes (title, content, tags, collection_id, pinned, archived, created_at, updated_at, uid)
             VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?)`,
          params: [
            input.title,
            input.content,
            tags,
            collectionId,
            today,
            today,
            uid,
          ],
        },
        ...outboxStatements([
          {
            table: "notes",
            uid,
            kind: "create",
            fields: {
              title: input.title,
              content: input.content,
              tags,
              collection_uid: collectionUid,
              pinned: 0,
              archived: 0,
              created_at: today,
              updated_at: today,
            },
          },
        ]),
      ]);
      return readRowId(driver, "notes", uid);
    },

    async updateNote(id: number, fields: Partial<NoteInput>): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      // The op's payload is the same set of fields, in the row's own spelling:
      // the wire maps `collection_id` to the parent's uid at upload time
      // (`LOCAL_FOREIGN_KEYS`), which is the transport's job, not the write's.
      const changed: Record<string, unknown> = {};
      if (fields.title !== undefined) {
        sets.push("title = ?");
        params.push(fields.title);
        changed.title = fields.title;
      }
      if (fields.content !== undefined) {
        sets.push("content = ?");
        params.push(fields.content);
        changed.content = fields.content;
      }
      if (fields.tags !== undefined) {
        const tags = fields.tags.join(",");
        sets.push("tags = ?");
        params.push(tags);
        changed.tags = tags;
      }
      if (fields.collectionId !== undefined) {
        sets.push("collection_id = ?");
        params.push(fields.collectionId);
        // The payload names the parent by uid, like the create above.
        changed.collection_uid =
          fields.collectionId === null
            ? null
            : ((await readRowUid(driver, "collections", fields.collectionId)) ??
              null);
      }
      if (sets.length === 0) return;
      const updated = todayLocal();
      sets.push("updated_at = ?");
      params.push(updated);
      changed.updated_at = updated;
      params.push(id);
      const uid = await readRowUid(driver, "notes", id);
      await driver.batch([
        { sql: `UPDATE notes SET ${sets.join(", ")} WHERE id = ?`, params },
        ...outboxStatements(
          uid
            ? [
                {
                  table: "notes" as const,
                  uid,
                  kind: "update",
                  fields: changed,
                },
              ]
            : [],
        ),
      ]);
    },

    async setPinned(id: number, pinned: boolean): Promise<void> {
      await writeNoteFlag(driver, id, "pinned", pinned ? 1 : 0);
    },

    async setArchived(id: number, archived: boolean): Promise<void> {
      await writeNoteFlag(driver, id, "archived", archived ? 1 : 0);
    },

    /** Move the note and its relationship/photo references into Trash. */
    async deleteNote(id: number): Promise<void> {
      // §5: the tombstone rides in the trash batch itself, so the row, its
      // snapshot and its tombstone are one transaction.
      const uid = await readRowUid(driver, "notes", id);
      await trash.trashEntity(
        "note",
        id,
        uid ? deleteStatements([{ table: "notes", uid }]) : [],
      );
    },

    /**
     * FTS over title/content/tags/folder — empty input returns [].
     *
     * Takes the same `collectionId` filter as `listNotes` so the sidebar
     * selection scopes a search exactly as it scopes the browse list (P2-13);
     * when the search box is empty the page calls `listNotes` with the same
     * filter, and both agree on what "no filter" means.
     *
     * Answers {@link NoteListRow}, not `NoteRow` (K5): the SQL cuts `content`
     * to the LIST preview, so the old `Promise<NoteRow[]>` annotation was
     * un-checkable — it asserted a full body off a truncated row, and the cast
     * hid it. The type now matches the row the search actually hands back,
     * which means the full body comes from `getNote` after a row is opened.
     */
    async search(
      input: string,
      opts: { includeArchived?: boolean; collectionId?: number } = {},
    ): Promise<NoteListRow[]> {
      return searchNotes(driver, input, opts);
    },
  };
}
