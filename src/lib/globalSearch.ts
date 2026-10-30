// Global search.
//
// Reads the approved contract (`searchContract.ts`) and runs it: one bounded
// query per entity, results grouped, capped, and ordered the same way every
// time. Nothing here decides what is searchable — that is the contract's job,
// and the two are kept apart so a privacy decision cannot quietly become a
// query detail.
//
// Two rules worth stating before the code:
//
// 1. **No user text reaches SQL as syntax.** Notes use the existing FTS5 MATCH
//    builder, wrapped in the contract's column filter so the match covers the
//    searchable columns and nothing else (`{title content tags} : …`, D1(a));
//    every token is quoted by `buildMatchQuery`. Everything else binds a GLOB
//    pattern built by `globTerm` (K4/K6): every character of the term becomes
//    the class its fold reaches, so the term matches the way the notes index
//    folds it, and the user's own `%`, `_`, `*` and `\` are ordinary text.
//    Table and column names come from the contract, which is code-owned.
// 2. **Ordering is deterministic.** Within a type: notes by FTS rank then date
//    then id; the rest by "does the title start with this", then date, then id.
//    Across types: the contract's own order, with the total cap trimming from the
//    end. The same query and the same data always produce the same list, which
//    is what lets Up/Down mean something while someone types.
// 3. **The payload is bounded like the list (K1).** A capped row count is not a
//    capped payload: every query projects only the columns a result reads, with
//    the long text cut by SQL to a prefix, so one keystroke ships kilobytes and
//    not the user's whole notebook over the IPC boundary. The per-entity queries
//    are issued together — the group order is the contract's, not the network's.

import type { DataDriver, Queryable } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import { buildMatchQuery } from "./search.ts";
import {
  globExpression,
  globTerm,
  isSearchable,
  normalizeTerm,
  SEARCH_CONTRACT,
  SEARCH_TOTAL_CAP,
  type SearchEntitySpec,
} from "./searchContract.ts";
import type { LinkableEntity, LinkableEntityType } from "./types.ts";

/** One hit, already flattened for the UI. */
export interface SearchResult {
  type: SearchEntitySpec["type"];
  label: string;
  /** Row id — the key `opens.key` names. */
  id: number | null;
  /** `entry_date` for a journal entry: it has no meaningful row navigation. */
  dateKey: string | null;
  title: string;
  excerpt: string | null;
  date: string | null;
  /** "Archived", "Done", "Paid" — or null when the row is plainly live. */
  state: string | null;
  /** The entity key a relationship-style jump would use, when there is one. */
  entity: LinkableEntity | null;
  /** Owning list for shopping items, so a result opens the right list. */
  parentId: number | null;
}

export interface SearchGroup {
  type: SearchEntitySpec["type"];
  label: string;
  results: SearchResult[];
  /** True when this entity matched more rows than its cap allowed. */
  capped: boolean;
}

/**
 * A side channel reporting whether the total cap hid anything (DECISION 1a).
 *
 * The trimmed groups are indistinguishable from naturally-small ones once
 * `applyTotalCap` returns — that is the gap: the dialog used to say
 * "40 results" with no hint that a trailing group was sliced or entire groups
 * were dropped. The flag travels beside the return value rather than inside it,
 * so `applyTotalCap`'s pinned return shape (and test) stays untouched; the
 * dialog folds it into a footer note.
 */
export interface TotalCapReport {
  /** True when fewer results came back than were matched. */
  truncated: boolean;
}

export interface SearchOptions {
  /** Hide archived/completed rows unless this is true. */
  includeInactive?: boolean;
  /** Only these entity types; empty or omitted means all of them. */
  types?: SearchEntitySpec["type"][];
  /** Only rows whose date column is on or after this `yyyy-mm-dd`. */
  since?: string;
  /** Only rows whose date column is on or before this `yyyy-mm-dd`. */
  until?: string;
  totalCap?: number;
  /** Injectable clock, so "last 30 days" is testable. */
  today?: string;
  /**
   * Receives "did the total cap trim anything?" (DECISION 1a). Filled during
   * the call, before it resolves.
   */
  totalCapReport?: TotalCapReport;
}

const EXCERPT_CHARS = 140;

/**
 * How much of a long text column crosses the IPC boundary when the excerpt
 * falls back to the head of the row (K1).
 *
 * Well above the 140 characters the UI displays, so the SQL-side cut cannot
 * starve the display cap even after whitespace flattening; well below a user's
 * prose, which is the point — this bounds the payload, not the writing.
 */
const EXCERPT_SQL_CHARS = 512;

/** The result column the SQL-built excerpt window arrives in (K2). */
const EXCERPT_ALIAS = "_excerpt";

/** Context characters kept before a match inside an excerpt window (K2). */
const EXCERPT_WINDOW_BEFORE = 30;

/** Total characters in an `instr`-anchored excerpt window (K2). */
const EXCERPT_WINDOW_CHARS = 100;

/** Title cap, shared with SQL: the journal's title slice is its first 80. */
const TITLE_CHARS = 80;

/** `notes_fts` column index of `content` (schema: title, content, tags, folder). */
const NOTES_FTS_EXCERPT_INDEX = 1;

/**
 * Token budget for FTS5 `snippet()`. Measured against SQLite: ~122 characters
 * for ordinary prose — under the 140-char display cap, so the window keeps
 * both flanks of the match instead of being cut by it.
 */
const SNIPPET_TOKENS = 24;

/**
 * The excerpt expression, bound to the match (K2).
 *
 * A result that shows the head of its row cannot be triaged: a note matched
 * at character 5,000 is presented with its first 140 characters, the term
 * nowhere on screen. So the excerpt is a window ANCHORED on the match —
 * FTS5 `snippet()` for the notes entity, `instr()` in SQL for the LIKE
 * entities — and the head of the row is only the fallback for a row whose
 * match lives in a different column (a title hit, say). The result arrives
 * under {@link EXCERPT_ALIAS}; LIKE windows bind `term` once per `instr`
 * use, and those params live in the SELECT list — they must LEAD the bound
 * parameter array, because the SELECT precedes the WHERE in the SQL.
 */
function excerptExpr(
  spec: SearchEntitySpec,
  alias: string,
  term: string,
  params: unknown[],
): string {
  const column = spec.excerpt;
  if (column === null) return "";
  if (spec.match === "fts") {
    // FTS5 builds the window itself, centered on the matched tokens in the
    // excerpt column. When the match was in another column (title, tags),
    // `snippet()` answers with THIS column's head — precisely the title-hit
    // fallback, no second expression needed. Empty prefix/suffix: the term
    // sits inline, and the dialog renders plain text.
    return `snippet(notes_fts, ${NOTES_FTS_EXCERPT_INDEX}, '', '', '…', ${SNIPPET_TOKENS}) AS ${EXCERPT_ALIAS}`;
  }
  const hit = `instr(lower(${alias}${column}), ?)`;
  if (spec.title[0] === column) {
    // The journal: the title IS the head of this same column. Anchoring the
    // window on a match inside the title prints the same text twice (K2), so
    // the window always continues from where the title's ellipsis stands — a
    // match inside the title is context enough, and a deeper match keeps its
    // own context.
    params.push(term, term);
    return `CASE WHEN ${hit} = 0 THEN substr(${alias}${column}, 1, ${EXCERPT_SQL_CHARS}) ELSE substr(${alias}${column}, max(${TITLE_CHARS}, ${hit} - ${EXCERPT_WINDOW_BEFORE}), ${EXCERPT_WINDOW_CHARS}) END AS ${EXCERPT_ALIAS}`;
  }
  params.push(term, term);
  return `CASE WHEN ${hit} > 0 THEN '…' || substr(${alias}${column}, max(1, ${hit} - ${EXCERPT_WINDOW_BEFORE}), ${EXCERPT_WINDOW_CHARS}) || '…' ELSE substr(${alias}${column}, 1, ${EXCERPT_SQL_CHARS}) END AS ${EXCERPT_ALIAS}`;
}

/**
 * The columns one result actually reads, and nothing else (K1).
 *
 * `db_query` returns every selected column as JSON, so a `SELECT *` here ships
 * the WHOLE note or journal body across the IPC boundary on every keystroke —
 * measured at 541 KB for fifteen 54 KB bodies — only for the UI to throw all
 * but 140 characters away. The projection is the exact set `toResults` reads:
 * the id, the contract's title column(s), the match-anchored excerpt window
 * (K2), the date column, the inactive column — plus the shopping item's
 * `list_id` (its `parentId`), the one field `toResults` reads beside the
 * contract's own columns.
 *
 * A title column that IS the long excerpt column (the journal's `content`)
 * arrives twice, in its two roles: the bounded head under its own name for
 * the title, the anchored window under {@link EXCERPT_ALIAS} for the
 * excerpt.
 */
function projectionList(
  spec: SearchEntitySpec,
  term: string,
  excerptParams: unknown[],
): string {
  const alias = spec.match === "fts" ? "n." : "";
  const seen = new Set<string>(["id"]);
  const columns = [`${alias}id`];
  const add = (column: string, bounded = false) => {
    if (seen.has(column)) return;
    seen.add(column);
    columns.push(
      bounded
        ? `substr(${alias}${column}, 1, ${EXCERPT_SQL_CHARS}) AS ${column}`
        : `${alias}${column}`,
    );
  };
  for (const column of spec.title) add(column, column === spec.excerpt);
  if (spec.excerpt !== null) {
    columns.push(excerptExpr(spec, alias, term, excerptParams));
  }
  if (spec.date !== null) add(spec.date);
  if (spec.inactive !== null) add(spec.inactive.column);
  if (spec.type === "shopping_item") add("list_id");
  return columns.join(", ");
}

/** First non-empty of the contract's title columns, trimmed and capped. */
function titleOf(row: Record<string, unknown>, spec: SearchEntitySpec): string {
  for (const column of spec.title) {
    const value = row[column];
    if (typeof value === "string" && value.trim().length > 0) {
      return trimTo(value.trim(), TITLE_CHARS);
    }
  }
  return `${spec.label} ${String(row.id ?? "")}`.trim();
}

/**
 * The excerpt: the SQL-built window around the match, flattened and capped.
 *
 * The window arrives anchored (K2) — head-of-row only when the match lived in
 * another column. The `…` markers say "context was omitted here"; they are
 * stripped before the title comparison so a task whose note merely repeats its
 * title still shows no excerpt, the way the old head-slice did.
 */
function excerptOf(
  row: Record<string, unknown>,
  spec: SearchEntitySpec,
): string | null {
  if (spec.excerpt === null) return null;
  const value = row[EXCERPT_ALIAS];
  if (typeof value !== "string") return null;
  const flat = value.replace(/\s+/g, " ").trim();
  const bare = flat.replace(/^…\s*/, "").replace(/\s*…$/, "");
  if (bare.length === 0 || bare === titleOf(row, spec)) return null;
  return trimTo(flat, EXCERPT_CHARS);
}

function trimTo(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * The bound parameters and WHERE clauses for one entity.
 *
 * Every value is a `?`. The only interpolated pieces are the contract's own
 * column and table names (code-owned, never derived from input) and the fixed
 * integers of this file: the `substr` bounds, the snippet budget and the
 * `LIMIT`.
 */
export function buildSearchQuery(
  spec: SearchEntitySpec,
  input: string,
  options: SearchOptions,
): { sql: string; params: unknown[] } {
  const term = normalizeTerm(input);
  // Every column is qualified: the FTS query joins two tables, so a bare
  // `archived` is ambiguous there and only works by accident elsewhere.
  const alias = spec.match === "fts" ? "n." : "";
  const clauses: string[] = [];
  const whereParams: unknown[] = [];
  // The excerpt window binds the term inside the SELECT list (K2), whose
  // placeholders precede the WHERE's in the SQL — so its params must lead.
  const selectParams: unknown[] = [];
  const projection = projectionList(spec, term, selectParams);

  if (spec.match === "fts") {
    // The existing builder: every token quoted, AND-ed, prefix-matched.
    // Wrapped in the contract's column filter (K3 / D1(a)): an unfiltered
    // FTS5 MATCH covers EVERY indexed column, `folder` included — and
    // `folder` holds the collection name, which `SEARCH_EXCLUSIONS` lists
    // as deliberately not searchable. The notes PAGE keeps its own
    // whole-index search; only here, where the contract speaks, does the
    // match agree with it.
    clauses.push("notes_fts MATCH ?");
    whereParams.push(
      `{${spec.searchable.join(" ")}} : ${buildMatchQuery(input)}`,
    );
  } else {
    clauses.push(`(${globExpression(spec)})`);
    // One parameter per searchable column — the OR cannot share one. The
    // pattern is the term folded into character classes (K4) and wrapped for
    // "contains"; `globTerm` has already made the user's `%`, `_` and `\`
    // literal, so `a_b` finds `a_b` and nothing wider (K6).
    const pattern = `*${globTerm(input)}*`;
    for (const _ of spec.searchable) whereParams.push(pattern);
  }

  if (spec.inactive !== null && options.includeInactive !== true) {
    // Bound, not interpolated: 1 for the 0/1 flags, 'paid' for jobs.status.
    clauses.push(`${alias}${spec.inactive.column} IS NOT ?`);
    whereParams.push(spec.inactive.value);
  }
  if (options.since !== undefined && spec.date !== null) {
    // A range clause only matches a FULL `yyyy-mm-dd` value (G9 remainder):
    // a yearless contact birthday (`MM-DD`) would otherwise compare
    // lexicographically against the bound — silently below any `YYYY-…`
    // since bound. A yearless value is not a `yyyy-mm-dd` date, so it cannot
    // satisfy the clause's documented contract and is excluded instead. The
    // length guard is a no-op for every other spec, whose date columns are
    // always full dates.
    clauses.push(
      `${alias}${spec.date} IS NOT NULL AND length(${alias}${spec.date}) = 10 AND ${alias}${spec.date} >= ?`,
    );
    whereParams.push(options.since);
  }
  if (options.until !== undefined && spec.date !== null) {
    // Same full-date guard: `MM-DD` sorts below every `YYYY-…` bound, so an
    // until-only range used to pass EVERY yearless birthday unchallenged.
    clauses.push(
      `${alias}${spec.date} IS NOT NULL AND length(${alias}${spec.date}) = 10 AND ${alias}${spec.date} <= ?`,
    );
    whereParams.push(options.until);
  }

  const prefix =
    spec.match === "fts"
      ? `SELECT ${projection} FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid`
      : `SELECT ${projection} FROM ${spec.table}`;
  // A title that STARTS with the term outranks one that merely contains it,
  // which is what someone typing a name is looking for. Same folded term, one
  // trailing `*` — and `globTerm` already made any `*` in the term literal, so
  // the only wildcard in this pattern is ours.
  if (spec.match === "like" && spec.title[0] !== undefined) {
    whereParams.push(`${globTerm(input)}*`);
  }
  const rank =
    spec.match === "fts"
      ? "rank"
      : spec.title[0] === undefined
        ? "id DESC"
        : `(${spec.title[0]} GLOB ?) DESC`;
  // A total order, always: the same query must not reorder between two runs.
  const tieBreak = `, ${alias}${spec.date ?? "id"} DESC, ${alias}id DESC`;

  return {
    sql: `${prefix} WHERE ${clauses.join(" AND ")} ORDER BY ${rank}${tieBreak} LIMIT ${spec.cap + 1}`,
    // SELECT-list placeholders come first in the SQL text, so their params
    // lead the array (K2) — a bound parameter out of position is a SQL error.
    params: [...selectParams, ...whereParams],
  };
}

/**
 * "Archived" / "Done" / "Paid", when this row is one of those.
 *
 * SQLite hands back a number for a 0/1 column and a string for `status`, and a
 * driver behind an IPC boundary may hand back either, so both sides are
 * compared as text. Only ever reached when the caller asked for inactive rows:
 * by default they were filtered out in SQL.
 */
function stateOf(row: Record<string, unknown>, spec: SearchEntitySpec) {
  if (spec.inactive === null) return null;
  const value = row[spec.inactive.column];
  if (value === null || value === undefined) return null;
  return String(value) === String(spec.inactive.value)
    ? spec.inactive.label
    : null;
}

/** One entity's rows, already shaped for the UI. */
function toResults(rows: Queryable[], spec: SearchEntitySpec): SearchResult[] {
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === "number" ? row.id : null;
    const dateKey =
      spec.opens.key === "entry_date" && typeof row.entry_date === "string"
        ? row.entry_date
        : null;
    const entity: LinkableEntity | null =
      spec.type === "note" || spec.type === "task" || spec.type === "contact"
        ? { type: spec.type as LinkableEntityType, id: id as number }
        : null;
    return {
      type: spec.type,
      label: spec.label,
      id,
      dateKey,
      title: titleOf(row, spec),
      excerpt: excerptOf(row, spec),
      date: spec.date === null ? null : date(row[spec.date]),
      state: stateOf(row, spec),
      entity,
      parentId:
        spec.type === "shopping_item" && typeof row.list_id === "number"
          ? row.list_id
          : null,
    };
  });
}

function date(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Run the contract.
 *
 * Empty or punctuation-only input returns no groups and no error: the FTS
 * builder turns `"` into an operator, and a search box that flashes a SQL error
 * at someone who typed a quote is the worst possible answer.
 */
export async function globalSearch(
  driver: DataDriver,
  input: string,
  options: SearchOptions = {},
): Promise<SearchGroup[]> {
  if (!isSearchable(input)) return [];
  const wanted = new Set(options.types ?? []);
  const specs = SEARCH_CONTRACT.filter(
    (spec) => wanted.size === 0 || wanted.has(spec.type),
  );
  // Issued together, not one behind the other (K1): nine sequential IPC round
  // trips per keystroke bought nothing, because the group order is the
  // contract's — `Promise.all` answers in input order no matter which query
  // finishes first.
  const rowSets = await Promise.all(
    specs.map((spec) => {
      const { sql, params } = buildSearchQuery(spec, input, options);
      return driver.query(sql, params);
    }),
  );
  const groups = specs.map((spec, index): SearchGroup => {
    const rows = rowSets[index] ?? [];
    // One row over the cap tells us it bit, without a second COUNT query.
    const capped = rows.length > spec.cap;
    return {
      type: spec.type,
      label: spec.label,
      results: toResults(rows.slice(0, spec.cap), spec),
      capped,
    };
  });
  return applyTotalCap(
    groups,
    options.totalCap ?? SEARCH_TOTAL_CAP,
    options.totalCapReport,
  );
}

/**
 * The total cap, applied across groups in contract order.
 *
 * Groups that end up empty are dropped rather than shown as headings with
 * nothing under them.
 *
 * Pass a `report` to learn whether this trimmed anything (DECISION 1a): the
 * return value alone cannot say, because a sliced trailing group and a
 * naturally small one look identical once returned — and a wholly dropped
 * group leaves no trace at all. Optional, so existing callers and the pinned
 * behaviour test are unaffected.
 */
export function applyTotalCap(
  groups: SearchGroup[],
  totalCap: number,
  report?: TotalCapReport,
): SearchGroup[] {
  const out: SearchGroup[] = [];
  let left = totalCap;
  for (const group of groups) {
    if (left <= 0) break;
    const results = group.results.slice(0, left);
    left -= results.length;
    if (results.length > 0) out.push({ ...group, results });
  }
  // "Fewer out than in" covers both ways the cap hides a match: slicing the
  // trailing group, and dropping a later non-empty group entirely.
  if (report !== undefined) {
    report.truncated = resultCount(out) < resultCount(groups);
  }
  return out;
}

/**
 * `yyyy-mm-dd` for "N days ago", for the date filter.
 *
 * A `today` that is not a real, zero-padded calendar date is IGNORED and the
 * answer is computed from the current date instead — `daysAgo(10,
 * "not-a-date")` degrades to "10 days ago from now" rather than throwing
 * (K10). The old `?? 1970` / `?? 1` fallbacks could never fire:
 * `Number.parseInt` answers NaN, never null, so malformed input sailed past
 * them into `toISOString()`, which threw `RangeError` out of a search-layer
 * export — and out-of-range components did not throw at all, so
 * `2026-13-45` rolled over to 2027-02-04 as if it were a date. Validation is
 * format plus calendar reality: three zero-padded groups, then a round-trip
 * through Date (below), so an impossible day counts as malformed too. This
 * helper feeds `since`/`until`, where the only answer a caller can act on is
 * "N days ago from a real day" — never a throw from a filter.
 */
export function daysAgo(days: number, today: string = todayLocal()): string {
  // `isoDate(todayLocal())` is always a date; the final `new Date()` is the
  // type-level term that makes `toISOString()` unreachable-by-throwing, not
  // a validation claim.
  const from = isoDate(today) ?? isoDate(todayLocal()) ?? new Date();
  from.setUTCDate(from.getUTCDate() - days);
  return from.toISOString().slice(0, 10);
}

/**
 * `raw` as a UTC date at midnight, or null when it is not a real
 * `yyyy-mm-dd` calendar date (K10). The regex checks the shape; the
 * round-trip checks the day actually exists — `2026-13-45` and `2026-02-31`
 * parse into Date (which rolls them over) but do not survive being read back,
 * so they are rejected instead of silently shifting the window.
 */
function isoDate(raw: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date;
}

/** How many results in total, for the "showing N" line. */
export function resultCount(groups: SearchGroup[]): number {
  return groups.reduce((n, group) => n + group.results.length, 0);
}
