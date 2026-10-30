// The search contract.
//
// One table, approved before it was implemented, that says for every entity:
// what is searched, what a result is titled with, where an excerpt comes from,
// which date sorts it, what counts as "archived", how many rows it may
// contribute, and WHY it is searchable at all.
//
// It exists as data rather than as twelve hand-written queries for three
// reasons:
//
//   - the UI groups, the caps and the SQL all read from this one place, so the
//     help text cannot describe a column the query does not search;
//   - adding an entity is a row here plus a case in the navigation map, not a
//     new bespoke query;
//   - the exclusions are as much a part of the contract as the inclusions. What
//     is NOT searchable, and why, is the half that protects the user's data.
//
// Nothing in here interpolates user input. Table and column names come from
// this file (code-owned); every value is bound.

import type { PageKey } from "./navigation.ts";
import type { LinkableEntityType } from "./types.ts";

/** How a type of entity is matched. Only notes have a full-text index. */
export type SearchMatch = "fts" | "like";

/** One entity's row in the contract. */
export interface SearchEntitySpec {
  /** What a result opens as. Journal/memory/job rows open their own page. */
  type:
    | LinkableEntityType
    | "journal"
    | "memory"
    | "job"
    | "payable"
    | "loan"
    | "shopping_item";
  /** Singular noun, used as the group heading and in the row's type label. */
  label: string;
  table: string;
  match: SearchMatch;
  /**
   * Columns the query looks in, in the order they are reported. For the FTS
   * entity these are also the columns the MATCH is restricted to (D1(a)):
   * an unfiltered match covers every indexed column, `folder` included, and
   * the collection name is on the exclusions list.
   */
  searchable: string[];
  /** Columns concatenated into the displayed title (first non-empty wins). */
  title: string[];
  /** Column for the second line, or null when the entity has no long text. */
  excerpt: string | null;
  /** Date column for the "when" line, or null when the entity has no date. */
  date: string | null;
  /**
   * What counts as "not active", and the word the UI uses for it. Archived
   * notes, completed tasks, paid payables and paid jobs are hidden unless the
   * user asks for them — a search that surfaces a hundred finished things is
   * not a search.
   *
   * `value` is what the column holds when the row is inactive: 1 for the 0/1
   * flags (`archived`, `done`, `paid`) and 'paid' for `jobs.status`. It is
   * bound like any other value, so this stays data and not SQL.
   */
  inactive: { column: string; label: string; value: number | string } | null;
  /** Rows this entity may contribute before the total cap bites. */
  cap: number;
  /** Why this entity is in the contract at all. */
  why: string;
  /**
   * The page a result opens, and the key it opens with. Null `key` means the
   * page has no exact-row navigation yet.
   */
  opens: { page: PageKey; key: string | null };
}

/**
 * The approved contract, in group order.
 *
 * Notes first because they are the only entity with a real full-text index and
 * the richest text; the rest follow by how likely a user is to be looking for
 * that thing by name.
 */
export const SEARCH_CONTRACT: SearchEntitySpec[] = [
  {
    type: "note",
    label: "Note",
    table: "notes",
    match: "fts",
    searchable: ["title", "content", "tags"],
    title: ["title"],
    excerpt: "content",
    date: "updated_at",
    inactive: { column: "archived", label: "Archived", value: 1 },
    cap: 10,
    why: "The user's own writing, and the only entity with a maintained FTS5 index (notes_fts), so it can be searched properly rather than approximately.",
    opens: { page: "notes", key: "id" },
  },
  {
    type: "task",
    label: "Task",
    table: "tasks",
    match: "like",
    searchable: ["title", "note"],
    title: ["title"],
    excerpt: "note",
    date: "due_date",
    inactive: { column: "done", label: "Done", value: 1 },
    cap: 10,
    why: "Tasks are short, numerous and usually searched by the words in the title. A title that starts with the query sorts above one that merely contains it.",
    opens: { page: "tasks", key: "id" },
  },
  {
    type: "contact",
    label: "Contact",
    table: "contacts",
    match: "like",
    searchable: ["name", "address", "notes"],
    title: ["name"],
    excerpt: "notes",
    date: "birthday",
    inactive: null,
    cap: 10,
    why: "Contacts are looked up by name far more often than by anything else, and a phone number typed into the address field is a normal way to search.",
    opens: { page: "contacts", key: "id" },
  },
  {
    type: "journal",
    label: "Journal",
    table: "journal_entries",
    match: "like",
    searchable: ["content"],
    title: ["content"],
    excerpt: "content",
    date: "entry_date",
    inactive: null,
    cap: 5,
    why: "Journal entries are prose the user wrote about a day, and finding the day is usually the point. The title is a slice of the entry's content; the entry date is shown on the date line and is what sorts it.",
    opens: { page: "journal", key: "entry_date" },
  },
  {
    type: "memory",
    label: "Memory",
    table: "memories",
    match: "like",
    searchable: ["title", "note"],
    title: ["title"],
    excerpt: "note",
    date: "memory_date",
    inactive: null,
    cap: 5,
    why: "Memories are dated reflections; the title is what a person remembers and the date is what sorts them.",
    opens: { page: "memories", key: "id" },
  },
  {
    type: "job",
    label: "Job",
    table: "jobs",
    match: "like",
    searchable: ["title", "note"],
    title: ["title"],
    excerpt: "note",
    date: "job_date",
    inactive: { column: "status", label: "Paid", value: "paid" },
    cap: 5,
    why: "A job is found by what it is called and when it was done. Amounts are deliberately not part of the searchable text — see the exclusions. A job already settled is as finished as a ticked-off task.",
    opens: { page: "business", key: "id" },
  },
  {
    type: "payable",
    label: "Payable",
    table: "payables",
    match: "like",
    searchable: ["title", "note"],
    title: ["title"],
    excerpt: "note",
    date: "due_date",
    inactive: { column: "paid", label: "Paid", value: 1 },
    cap: 5,
    why: "Owed money is searched by what it is for, and a paid one is usually not what someone is looking for mid-month.",
    opens: { page: "business", key: "id" },
  },
  {
    type: "loan",
    label: "Loan",
    table: "loans",
    match: "like",
    searchable: ["counterparty", "note"],
    title: ["counterparty"],
    excerpt: "note",
    date: "due_date",
    inactive: null,
    cap: 5,
    why: "A loan belongs to a person or shop, and the counterparty's name is the only thing anyone searches it by.",
    opens: { page: "loans", key: "id" },
  },
  {
    type: "shopping_item",
    label: "Shopping item",
    table: "shopping_items",
    match: "like",
    searchable: ["text"],
    title: ["text"],
    excerpt: null,
    date: null,
    inactive: null,
    cap: 5,
    why: "A ticked-off shopping list is the classic 'did I already buy that' search. Nothing but the item text is read.",
    opens: { page: "shopping", key: "id" },
  },
];

/**
 * What is deliberately NOT searchable, and why.
 *
 * This is the half of the contract that protects the user. Every entry is a
 * refusal, not an oversight: if one of these ever becomes searchable it needs
 * MinLulin's approval and a documented note in `docs/RELEASE.md`.
 */
export const SEARCH_EXCLUSIONS: { what: string; why: string }[] = [
  {
    what: "vault_items (title and ciphertext)",
    why: "The vault is the one place the user stores secrets on purpose. A search index, a result list and a typed query would each be another copy of that content sitting in a place nobody thought about when they were typing.",
  },
  {
    what: "settings (PIN hash, security answer hash, vault salt, auto-lock)",
    why: "Security metadata. Nothing here helps anyone find a note, and a search result is a place a secret would end up on screen.",
  },
  {
    what: "photos (note, taken_date) and photo bytes",
    why: "The file bytes are the user's photographs; a caption search would put image metadata into a text surface. Photo captions stay searchable from the note that holds them.",
  },
  {
    what: "income_entries and expense_entries (note)",
    why: "Their useful fields are amounts and dates, which search does not handle, and the note field is personal finance detail. Money is findable through the budget and business pages, where it is already organised.",
  },
  {
    what: "wallets, categories, shops, lists, habits, recurring_payments, photo_refs, collections",
    why: "Almost all of these are short closed vocabularies the user picks from rather than writes. They are reachable by scrolling a page, and indexing them would only add noise to every search.",
  },
  {
    what: "links, inbox_items",
    why: "Derived and recent. A relationship is found from its endpoint, and the inbox is a short list that is always on screen.",
  },
];

/** The contract row for a type, or undefined for something not searchable. */
export function specFor(
  type: SearchEntitySpec["type"],
): SearchEntitySpec | undefined {
  return SEARCH_CONTRACT.find((spec) => spec.type === type);
}

/**
 * The columns a LIKE entity searches, as one expression.
 *
 * A LIKE match is case-insensitive only for ASCII in SQLite, so Burmese text
 * is matched by the caller passing a normalized term — `normalizeTerm` below.
 * `lower(col) LIKE ?` keeps one comparison for every column.
 */
export function likeExpression(spec: SearchEntitySpec): string {
  return spec.searchable
    .map((column) => `lower(${column}) LIKE ?`)
    .join(" OR ");
}

/**
 * The search term, prepared for a bound SQL parameter.
 *
 * NFC + lowercase, and deliberately **no** combining-mark stripping. Only the
 * query side can be normalized — the stored column is compared as it is — so
 * stripping marks here would break exactly the text it was meant to help:
 * measured against SQLite, a term with its marks stripped matches nothing,
 * while the same term normalized to NFC matches both "café" and "cafe" + a
 * combining acute. Burmese vowel signs are stored as their own codepoints, so
 * NFC leaves them alone and they keep matching.
 *
 * `LIKE` also does not fold case for non-ASCII, which costs nothing for
 * Burmese (it has no case) and is handled by `lower()` on the column for ASCII.
 */
export function normalizeTerm(input: string): string {
  return input.normalize("NFC").toLowerCase().trim();
}

/**
 * Is this input worth searching at all?
 *
 * Punctuation-only input returns false rather than searching for nothing:
 * `"` and `-` are legitimate characters in the FTS expression builder, and a
 * search box that briefly shows an error for them is worse than one that waits.
 */
export function isSearchable(input: string): boolean {
  return normalizeTerm(input).replace(/[^\p{L}\p{N}]/gu, "").length > 0;
}

/** Rows per entity before the total cap applies. */
export const SEARCH_TOTAL_CAP = 40;

/** How long the shell waits after the last keystroke before searching. */
export const SEARCH_DEBOUNCE_MS = 150;
