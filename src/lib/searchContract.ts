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

/** ASCII letters: the only characters a diacritic may hang on (K4). */
const ASCII_LETTER = /[A-Za-z]/;

/**
 * Where SQLite's case-folding table and `String.prototype.toLowerCase`
 * disagree — the adjustment {@link foldChar} applies after lower-casing.
 *
 * Unicode case folding is not lower-casing: it unifies `ς` with `σ`, `ſ`
 * with `s`, `µ` with Greek `μ`, the Greek symbol variants with the letters
 * they stand for, and U+1FBE with iota. unicode61 case-folds, so the fold has
 * to as well, or a query would find a word on the notes page and miss the
 * same word in a task. Looked up on the raw character first and then on its
 * lower-cased form, so the uppercase variants (`ϴ`) follow their lowercase
 * one (`ϑ`).
 *
 * The identity entry (`Ϳ`) records the opposite case: a character the index
 * does NOT fold, added to Unicode after sqlite's table was generated.
 *
 * Every entry here was found by the parity test in `globalSearch.test.ts`,
 * which walks {@link FOLD_RANGES} and compares the two answers character by
 * character. When it names a character, add it here — do not teach the test
 * to look away.
 */
const CASE_FOLD: Readonly<Record<string, string>> = {
  µ: "μ", // MICRO SIGN case-folds to Greek mu, and lower-casing keeps it
  ς: "σ",
  // U+1FBE (GREEK PROSGEGRAMMENI) case-folds to iota — written escaped
  // because it renders identically to U+03B9 in every font.
  "\u1fbe": "\u03b9",
  ſ: "s",
  ẛ: "s",
  Ϳ: "Ϳ",
  ϐ: "β",
  ϑ: "θ",
  ϵ: "ε",
  ϰ: "κ",
  ϱ: "ρ",
  ϕ: "φ",
  ϖ: "π",
};

/**
 * How one character folds for search — the ONE semantic both match paths use
 * (K4).
 *
 * The notes path runs the `unicode61` tokenizer: it case-folds every script
 * and drops a single diacritic off an ASCII-lettered character, so `cafe`
 * finds `Café`. The LIKE path used to fold ASCII case through `lower()` and
 * compare accents as stored, so the same term answered with different rows
 * depending on which table the row lived in. The rule below reproduces what
 * `unicode61` does — measured against SQLite rather than assumed:
 *
 *   1. an ASCII letter carrying EXACTLY ONE combining mark folds to the bare
 *      letter (`É`→`e`, `İ`→`i`). Two marks stay two marks: `Ệ` (e with
 *      circumflex and dot below) keeps its spelling, because unicode61 does
 *      not strip it either — nor a decomposed mark sitting beside another.
 *   2. otherwise lower-case, adjusted by {@link CASE_FOLD}.
 *
 * What it leaves alone is deliberate: Burmese has no case and its marks are
 * letters rather than diacritics (K7); Greek tonos and the Cyrillic diaeresis
 * stay because unicode61 keeps them; `æ`, `ø`, `đ` and `ß` are letters, not
 * accented spellings of another one.
 *
 * Exported because the promise is testable: the parity test in
 * `globalSearch.test.ts` walks every character in {@link FOLD_RANGES} and
 * asserts the two paths answer with the same rows, so this rule cannot drift
 * away from the index silently.
 */
export function foldChar(ch: string): string {
  const decomposed = ch.normalize("NFD");
  const base = decomposed.charAt(0);
  const mark = decomposed.charAt(1);
  if (
    decomposed.length === 2 &&
    /\p{M}/u.test(mark) &&
    ASCII_LETTER.test(base)
  ) {
    return base.toLowerCase();
  }
  const lower = ch.toLowerCase();
  return CASE_FOLD[ch] ?? CASE_FOLD[lower] ?? lower;
}

/**
 * The code-point ranges this app's search folds — the scripts it stores text
 * in. Characters outside them keep their own spelling on the LIKE path; the
 * claim and the parity test cover exactly these ranges.
 */
export const FOLD_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x024f], // ASCII, Latin-1 Supplement, Latin Extended-A and B
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x04ff], // Cyrillic
  [0x1e00, 0x1eff], // Latin Extended Additional (the Vietnamese block)
  [0x1f00, 0x1fff], // Greek Extended
  [0x212a, 0x212b], // KELVIN SIGN and ANGSTROM SIGN, folding to k and a
];

/** Every character {@link foldChar} can reach, grouped by where it folds to. */
let foldGroups: Map<string, Set<string>> | undefined;

function foldedGroups(): Map<string, Set<string>> {
  if (foldGroups !== undefined) return foldGroups;
  const groups = new Map<string, Set<string>>();
  const letter = /\p{L}/u;
  for (const [from, to] of FOLD_RANGES) {
    for (let cp = from; cp <= to; cp += 1) {
      const ch = String.fromCodePoint(cp);
      // Only letters are collected, so a class can never hold GLOB's own
      // punctuation (`]`, `^`, `-`): a non-letter folds to itself and is
      // emitted raw below.
      if (!letter.test(ch)) continue;
      const key = foldChar(ch);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, new Set([ch]));
      else group.add(ch);
    }
  }
  foldGroups = groups;
  return groups;
}

/**
 * The term as a GLOB pattern that matches the term itself — folded (K4) and
 * escaped (K6), in one step.
 *
 * Each character becomes a character class holding every character the fold
 * maps to the same place, so `cafe` finds `Café`, `CAFÉ` and `café` in a task
 * exactly as it finds them in a note — while the column stays as stored,
 * which is what makes one comparison possible without `lower()`, without an
 * `ESCAPE` clause and without a schema migration. A character with nothing to
 * fold into is emitted as itself.
 *
 * GLOB's metacharacters — `*`, `?`, `[` — go inside a class of one, so they
 * match literally. `%` and `_` are not metacharacters in GLOB at all, and
 * that is K6: `a_b` finds `a_b` and never `axb`, `50%` finds `50% off` and
 * never `discount 50`, and a trailing lone backslash is an ordinary character
 * where the old LIKE pattern made it malformed. There is no escape clause for
 * a later reader to forget. The caller may wrap the result in `*…*`
 * (contains) or `…*` (prefix): every `*` the user typed is already literal.
 *
 * NFC-normalised and trimmed like `normalizeTerm`, but deliberately NOT
 * lower-cased: the classes carry both cases, and JavaScript's lower-casing
 * turns `İ` into two code points, which a single-character class cannot
 * absorb — the index folds it to `i`, and so does this.
 */
export function globTerm(input: string): string {
  const term = input.normalize("NFC").trim();
  const groups = foldedGroups();
  let pattern = "";
  for (const ch of term) {
    if (ch === "*" || ch === "?" || ch === "[") {
      pattern += `[${ch}]`;
      continue;
    }
    const group = groups.get(foldChar(ch));
    if (group === undefined) {
      pattern += ch;
      continue;
    }
    // A letter from outside the ranges can still fold into a group; keep it
    // in the class or its own spelling would not match.
    const members = group.has(ch) ? group : new Set([...group, ch]);
    pattern += members.size === 1 ? ch : `[${[...members].join("")}]`;
  }
  return pattern;
}

/**
 * The columns a folded entity searches, as one expression (K4).
 *
 * `col GLOB ?`, one per searchable column, with the term's pattern bound to
 * each. The fold lives in the pattern rather than in the column, so the
 * comparison is case- and accent-insensitive for every character in
 * {@link FOLD_RANGES} instead of `lower(col) LIKE ?`'s ASCII half of it — and
 * the OR still cannot share one parameter.
 */
export function globExpression(spec: SearchEntitySpec): string {
  return spec.searchable.map((column) => `${column} GLOB ?`).join(" OR ");
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
 * **One folding semantic, both paths (K4).** The notes path folds through
 * unicode61; the LIKE path folds through {@link foldChar} and {@link globTerm},
 * which reproduce what unicode61 does — case-fold every script, drop one
 * diacritic off an ASCII letter — so `cafe` finds `Café` in a task exactly as
 * it finds it in a note, and `CAFÉ` finds both.
 *
 * What this function is left doing is the text side of that: NFC + lower case
 * for the `instr()` excerpt anchor in `globalSearch.ts`, which pairs with
 * SQL's `lower(col)`. What still differs between the paths is tokenization
 * rather than folding — unicode61 cuts a word at a combining mark and at `_`,
 * where a character class matches the text as written — and that is stated
 * here rather than presented as handled.
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
 *
 * Marks count as content (K7). Burmese writes its vowels and tones as combining
 * marks, so a mark is a letter's worth of meaning there — stripping `\p{M}`
 * refused a term like a bare vowel sign while still accepting the same sign
 * attached to a consonant, i.e. the refusal fired on valid Burmese and only
 * on it. Real FTS operators (`"`, `-`, `(`, `*`, `^`) are all non-mark
 * punctuation, so the punctuation-only refusal is untouched.
 */
export function isSearchable(input: string): boolean {
  return normalizeTerm(input).replace(/[^\p{L}\p{N}\p{M}]/gu, "").length > 0;
}

/** Rows per entity before the total cap applies. */
export const SEARCH_TOTAL_CAP = 40;

/** How long the shell waits after the last keystroke before searching. */
export const SEARCH_DEBOUNCE_MS = 150;
