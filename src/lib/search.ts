// FTS search helper: turns free-form user input into a safe FTS5 MATCH
// expression. Every token is double-quoted (so FTS operators and punctuation
// in user input stay literal) with a `*` suffix for prefix matching; tokens
// are AND-ed. The P1 spike found plain INSERT/UPDATE/DELETE works on fts5
// tables in this SQLCipher build — MATCH queries are unaffected.
//
// It also owns two things that are not obviously its: the LIST projection's
// content cap (the browse SELECT in `notes.ts` builds the same row type and
// imports the number from here, so the two cannot drift apart — K5), and the
// in-page search's total order (K8), which is the same order the global
// search enforces over this same index.

import type { DataDriver } from "../data/driver.ts";
import type { NoteListRow } from "./types.ts";

/**
 * How much of `content` the LIST projection ships — the prefix
 * {@link NoteListRow} documents (J1, K5).
 *
 * It lives here rather than in `notes.ts` because notes.ts already imports
 * this module: ONE literal, so the browse SELECT and this FTS SELECT cannot
 * drift into disagreeing while both answer `NoteListRow`. The type says
 * "a 200-character prefix"; a second, silently different number would make
 * that sentence a lie.
 */
export const LIST_CONTENT_CHARS = 200;

/** Build a MATCH expression, or "" when there is nothing searchable. */
export function buildMatchQuery(input: string): string {
  const tokens = input
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
}

/**
 * Full-text search over notes (title/content/tags/folder via `notes_fts`).
 * Returns [] for empty input. Rank ordering puts best matches first.
 *
 * `collectionId` scopes the search the same way `listNotes` scopes the browse
 * list (review P2-13). Without it the sidebar's collection filter was honoured
 * only when the search box was empty: clicking a collection while a query was
 * active highlighted it and reloaded, then showed matches from every
 * collection — the filter looked applied and was not. Omitted (`undefined`)
 * means "all collections", which is also what the page passes for the "all"
 * selection, so the two paths cannot disagree about what "no filter" means.
 *
 * Answers {@link NoteListRow}s, deliberately: the SQL cuts `content` to
 * {@link LIST_CONTENT_CHARS} characters, which is the LIST projection's
 * contract (J1/K5) — the old `Promise<T[]>` let any caller name any row shape
 * for it, and `notesRepo.search` named the FULL body type for a truncated
 * row. Non-generic on purpose: one projection, one row type, so a projection
 * and its type cannot drift apart.
 *
 * Ordered by `rank, n.updated_at DESC, n.id DESC` (K8). bm25 rank is not a
 * total order — two notes of equal score have no defined relative position, so
 * the list under the search box could reorder between two identical searches
 * — while the global search, over this same index, promises and enforces one.
 * The tie-break is the browse list's own order, so a search and the list it
 * replaced agree on what "the same rows" means.
 */
export async function searchNotes(
  driver: DataDriver,
  input: string,
  opts: { includeArchived?: boolean; collectionId?: number } = {},
): Promise<NoteListRow[]> {
  const match = buildMatchQuery(input);
  if (match === "") return [];
  // Both clauses are bound, and both are omitted rather than filled with a
  // sentinel when they do not apply — an extra `AND n.collection_id = NULL`
  // would match nothing at all.
  const clauses = [`notes_fts MATCH ?`];
  const params: unknown[] = [match];
  if (!opts.includeArchived) {
    clauses.push("n.archived = 0");
  }
  if (opts.collectionId !== undefined) {
    clauses.push("n.collection_id = ?");
    params.push(opts.collectionId);
  }
  const sql = `
    SELECT n.id, n.title, substr(n.content, 1, ${LIST_CONTENT_CHARS}) AS content, n.tags, n.collection_id, n.pinned, n.archived, n.created_at, n.updated_at
    FROM notes_fts
    JOIN notes n ON n.id = notes_fts.rowid
    WHERE ${clauses.join(" AND ")}
    ORDER BY rank, n.updated_at DESC, n.id DESC
  `;
  return driver.query<NoteListRow>(sql, params);
}
