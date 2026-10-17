// FTS search helper (§2.4): turns free-form user input into a safe FTS5 MATCH
// expression. Every token is double-quoted (so FTS operators and punctuation
// in user input stay literal) with a `*` suffix for prefix matching; tokens
// are AND-ed. The P1 spike found plain INSERT/UPDATE/DELETE works on fts5
// tables in this SQLCipher build — MATCH queries are unaffected.

import type { DataDriver, Queryable } from "../data/driver.ts";

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
 */
export async function searchNotes<T extends Queryable>(
  driver: DataDriver,
  input: string,
  opts: { includeArchived?: boolean; collectionId?: number } = {},
): Promise<T[]> {
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
    SELECT n.*
    FROM notes_fts
    JOIN notes n ON n.id = notes_fts.rowid
    WHERE ${clauses.join(" AND ")}
    ORDER BY rank
  `;
  return driver.query<T>(sql, params);
}
