// Notes repository: CRUD, collections, tags, pin/archive, FTS search.
// Tags are stored comma-separated in the DB; parsed/joined at this edge.

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import { searchNotes } from "./search.ts";
import { createTrashRepo } from "./trash.ts";
import type { CollectionRow, NoteRow } from "./types.ts";

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
 * Markdown → plain-text excerpt capped at `maxChars`. Strips the common
 * CommonMark syntax (fences keep their body, images collapse to alt text,
 * links to their label), collapses whitespace, and truncates on a word
 * boundary with a trailing ellipsis. Deliberately regex-based and approximate —
 * an excerpt only needs to read cleanly, not to be a full parser.
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
  const cut = plain.slice(0, Math.max(1, maxChars - 1));
  const boundary = cut.lastIndexOf(" ");
  const head = (boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd();
  return `${head}…`;
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

    async createCollection(name: string): Promise<number> {
      const r = await driver.execute(
        "INSERT INTO collections (name, created_at) VALUES (?, ?)",
        [name, todayLocal()],
      );
      return r.lastInsertRowid;
    },

    async deleteCollection(id: number): Promise<void> {
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
      ]);
    },

    async listNotes(filter: NoteFilter = {}): Promise<NoteRow[]> {
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
      return driver.query<NoteRow>(
        `SELECT * FROM notes${clause} ORDER BY pinned DESC, updated_at DESC, id DESC${limit}`,
        params,
      );
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
      const r = await driver.execute(
        `INSERT INTO notes (title, content, tags, collection_id, pinned, archived, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, 0, ?, ?)`,
        [
          input.title,
          input.content,
          (input.tags ?? []).join(","),
          input.collectionId ?? null,
          today,
          today,
        ],
      );
      return r.lastInsertRowid;
    },

    async updateNote(id: number, fields: Partial<NoteInput>): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (fields.title !== undefined) {
        sets.push("title = ?");
        params.push(fields.title);
      }
      if (fields.content !== undefined) {
        sets.push("content = ?");
        params.push(fields.content);
      }
      if (fields.tags !== undefined) {
        sets.push("tags = ?");
        params.push(fields.tags.join(","));
      }
      if (fields.collectionId !== undefined) {
        sets.push("collection_id = ?");
        params.push(fields.collectionId);
      }
      if (sets.length === 0) return;
      sets.push("updated_at = ?");
      params.push(todayLocal());
      params.push(id);
      await driver.execute(
        `UPDATE notes SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
    },

    async setPinned(id: number, pinned: boolean): Promise<void> {
      await driver.execute("UPDATE notes SET pinned = ? WHERE id = ?", [
        pinned ? 1 : 0,
        id,
      ]);
    },

    async setArchived(id: number, archived: boolean): Promise<void> {
      await driver.execute("UPDATE notes SET archived = ? WHERE id = ?", [
        archived ? 1 : 0,
        id,
      ]);
    },

    /** Move the note and its relationship/photo references into Trash. */
    async deleteNote(id: number): Promise<void> {
      await trash.trashEntity("note", id);
    },

    /**
     * FTS over title/content/tags/folder — empty input returns [].
     *
     * Takes the same `collectionId` filter as `listNotes` so the sidebar
     * selection scopes a search exactly as it scopes the browse list (P2-13);
     * when the search box is empty the page calls `listNotes` with the same
     * filter, and both agree on what "no filter" means.
     */
    async search(
      input: string,
      opts: { includeArchived?: boolean; collectionId?: number } = {},
    ): Promise<NoteRow[]> {
      return searchNotes(driver, input, opts) as Promise<NoteRow[]>;
    },
  };
}
