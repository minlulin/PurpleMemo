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
 */
export async function searchNotes<T extends Queryable>(
  driver: DataDriver,
  input: string,
  opts: { includeArchived?: boolean } = {},
): Promise<T[]> {
  const match = buildMatchQuery(input);
  if (match === "") return [];
  const archivedClause = opts.includeArchived ? "" : " AND n.archived = 0";
  const sql = `
    SELECT n.*
    FROM notes_fts
    JOIN notes n ON n.id = notes_fts.rowid
    WHERE notes_fts MATCH ?${archivedClause}
    ORDER BY rank
  `;
  return driver.query<T>(sql, [match]);
}
