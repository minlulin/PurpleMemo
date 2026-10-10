// Notes repository (§2.4): CRUD, collections, tags, pin/archive, FTS search.
// Tags are stored comma-separated in the DB; parsed/joined at this edge.

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import { searchNotes } from "./search.ts";
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
}

export function createNotesRepo(driver: DataDriver) {
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
      await driver.execute("DELETE FROM collections WHERE id = ?", [id]);
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
      return driver.query<NoteRow>(
        `SELECT * FROM notes${clause} ORDER BY pinned DESC, updated_at DESC, id DESC`,
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

    async deleteNote(id: number): Promise<void> {
      await driver.execute("DELETE FROM notes WHERE id = ?", [id]);
    },

    /** FTS over title/content/tags/folder (§2.4) — empty input returns []. */
    async search(
      input: string,
      opts: { includeArchived?: boolean } = {},
    ): Promise<NoteRow[]> {
      return searchNotes(driver, input, opts) as Promise<NoteRow[]>;
    },
  };
}

export type NotesRepo = ReturnType<typeof createNotesRepo>;
