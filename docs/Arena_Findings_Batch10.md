# Purple Memo audit findings — Batch 10

- **Base commit:** `d7b9b47460f1c7ac62e3233b7b3ca34d2533ca88` (`dev` HEAD — the Batch 9 fix wave `8cdfb6e`, `7ecc612`, `f9e6782`, `b60b2ad`, `d7b9b47` is complete).
- **Working branch:** `arena/54b329c8-purplememo` (PR target: `dev`). **No source file was modified** — this document is the only change.
- **Scope — read in full, one at a time (line counts at the base):**
  1. `src/lib/globalSearch.ts` (335)
  2. `src/lib/searchContract.ts` (295)
  3. `src/lib/notes.ts` (276)
  4. `src/lib/search.ts` (58)
  5. `src/lib/notesView.ts` (50)
- **Seams read for context (not audited as findings on their own):** `src/components/GlobalSearchDialog.tsx` (374), `src/pages/NotesPage.tsx` (1189), `src/lib/noteReader.ts` (116), `src/lib/share.ts` (note reads only), `src/lib/settings.ts`, `src/lib/trash.ts`, `src/lib/loans.ts`, `src/lib/gallery.ts`, `src/lib/dates.ts`, `src/lib/format.ts`, `src/lib/types.ts`, `src/data/app.ts`, `src/data/driver.ts`, `src/App.tsx` (search-result routing), `src-tauri/src/schema.rs` (562 — the 31 tables, `notes_fts` and its triggers), `src-tauri/src/commands.rs` (`db_query`).
- **Tests read:** `src/lib/globalSearch.test.ts` (813), `src/lib/notes.test.ts` (354), `src/lib/search.test.ts` (100), `src/lib/notesView.test.ts` (138).
- **Method:** Every scoped file was read end to end, then each SQL builder was traced against the schema it queries and executed against a real SQLite database (`node:sqlite`) using the SQL that `buildSearchQuery` actually produces — the same technique the suite itself uses — to measure payload size, tokenization, folding and wildcard behaviour rather than to reason about them. Callers/callees were traced at every join the scope names. The G9 remainder (`length(<date>) = 10` guard) and the J1 projection-typing fix were re-verified as intact and are **not** re-reported. Prior findings F1–F12, B1–B14, C1–C6, D1–D12, E1–E14, G1–G14, H1–H10, I1–I4, J1–J8 were read and checked against; no re-report, no regression of a prior fix was found.
- **Test run (in scope only):**
  ```sh
  node --test src/lib/globalSearch.test.ts src/lib/notes.test.ts src/lib/search.test.ts src/lib/notesView.test.ts
  ```
  Result: **53/53 passed** (`node v22.22.3`; the sandbox has no `node_modules`, so suites that need the React/Vite toolchain were not run — out of scope for this batch).

---

## Summary

| ID | Severity | Grounded in | Summary |
|---|---|---|---|
| **K1** | **Med** | `globalSearch.ts`, `notes.ts` | The global search ships whole note and journal bodies over IPC on every keystroke (`SELECT n.*` / `SELECT *`), and issues its nine per-entity queries sequentially — the row count is capped, the payload is not (measured 541 KB + 270 KB for 15 rows) |
| **K2** | **Low-med** | `globalSearch.ts`, `searchContract.ts` | The result "excerpt" is the first 140 characters of the row, not a snippet around the match; a journal result shows the same opening text twice and neither slice contains the term that matched |
| **K3** | **Low-med** | `searchContract.ts`, `globalSearch.ts`, `schema.rs` | The notes query searches the FTS `folder` column (the collection name), which the contract's `searchable` list omits and `SEARCH_EXCLUSIONS` explicitly forbids — the contract contradicts the SQL it generates |
| **K4** | **Low-med** | `searchContract.ts`, `search.ts` | FTS folds case and strips diacritics; `LIKE` folds ASCII only and is accent-sensitive — the same term returns different rows per entity type, which the contract's comment calls costless |
| **K5** | **Low-med** | `notes.ts`, `search.ts`, `types.ts` | `notesRepo.search()` is typed `NoteRow[]` although its SQL truncates `content` to 200 characters — the J1 remedy (`NoteListRow`) was applied to `listNotes`/`listNoteTitles` but not to the FTS search path, whose unchecked generic lets any caller claim any row shape |
| **K6** | **Low** | `globalSearch.ts`, `searchContract.ts` | `%` and `_` in the user's term are not escaped before being bound into a `LIKE` pattern, so `_` matches any character and widens both the match and the ranking |
| **K7** | **Low** | `searchContract.ts`, `globalSearch.ts`, `GlobalSearchDialog.tsx` | `isSearchable` strips every character that is not a letter or digit, so a term made only of Burmese combining marks ("ံး") is refused and the search silently does nothing |
| **K8** | **Low** | `search.ts`, `globalSearch.ts`, `NotesPage.tsx` | The in-page note search orders by `rank` alone — no tie-break — while the global search, on the same index, promises and enforces a total order |
| **K9** | **Low** | `notesView.ts`, `NotesPage.tsx` | The Notes page's mount-time settings read can overwrite a view-mode/collapse change the writer has already made, leaving the UI and the stored value disagreeing |
| **K10** | **Low** | `globalSearch.ts` | `daysAgo` is exported search-layer API whose `?? 1970` / `?? 1` fallbacks are dead code; a malformed date makes `toISOString()` throw `RangeError` (no production caller today) |
| **K11** | **Low** | `notes.ts` | `noteExcerpt` truncates on an ASCII space, so Burmese excerpts are cut mid-word, contradicting its own "word boundary" comment |
| **K12** | **Low** | `globalSearch.test.ts`, `globalSearch.ts` | The test named "an empty title still produces a usable row" asserts that nothing is found and never exercises the empty-title fallback it names |
| **K13** | **Low** | `searchContract.ts`, `gallery.ts`, `schema.rs` | `SEARCH_EXCLUSIONS` says photo captions "stay searchable from the note that holds them"; the caption lives only in `photos.note` and is in no searchable column, so it is not findable at all |

---

## Findings

### K1 — Med — The global search transfers whole note and journal bodies across IPC on every keystroke, and runs its nine per-entity queries sequentially

**Evidence:**
- `src/lib/globalSearch.ts:180–183` — the query prefix is `SELECT n.* FROM notes_fts JOIN notes n ON n.id = notes_fts.rowid` for the FTS entity and `SELECT * FROM ${spec.table}` for every `LIKE` entity.
- `src/lib/globalSearch.ts:95,109–119` — what the UI actually needs is at most 140 characters per row (`EXCERPT_CHARS = 140`); `excerptOf` reads `row[spec.excerpt]` and flattens it in JavaScript.
- `src/lib/globalSearch.ts:271–283` — one query per contract entity, awaited inside a `for` loop: nine `db_query` round trips, one after another, per search.
- `src-tauri/src/commands.rs:167–174` — `db_query` returns the whole row set as JSON (`Vec<JsonObj>`), so every selected column crosses the IPC boundary; `src-tauri/src/db.rs` serialises the statement's column map.
- Measured with the real SQL `buildSearchQuery` produces, against `node:sqlite`: 10 notes with 54 KB bodies → the notes query returned **541,473 bytes** of JSON; 5 journal entries with 54 KB bodies → **270,411 bytes**.
- The notes repository already has the bounded projection this layer lacks: `src/lib/notes.ts:93` (`LIST_CONTENT_CHARS = 200`) and `:114–119` (`substr(content, 1, 200) AS content`); the share snapshot reads notes through it (`src/lib/share.ts:427`).

**What is wrong:** The *count* of rows is bounded — per entity by `LIMIT ${spec.cap + 1}` (`globalSearch.ts:199`) and in total by `SEARCH_TOTAL_CAP = 40` — but the *size* of each row is not. Every note body and every journal entry body is selected, serialised, shipped to the webview and only then truncated to 140 characters in JavaScript. The nine per-entity queries are then serialised behind one another, so one keystroke costs nine round trips deep.

**User impact:** The cost of the search box scales with the size of the user's writing rather than with the size of the result list. With 54 KB journal entries the measured payload is ~270 KB of JSON per debounced keystroke for a list that renders 5 × 140 characters, and the writer waits for nine IPC round trips before the first group appears. This is the I3 over-fetch pattern (share snapshot reads) reappearing in the search path, which was not covered by the Batch 8 fix wave.

**Fix direction:** Project only the columns a result needs — the id, the contract's title column(s), a bounded excerpt (`substr(<content>, 1, N)`), the date column and the inactive column — instead of `*` / `n.*`; and issue the per-entity queries concurrently, since the group order is fixed by the contract and not by completion order, so one keystroke becomes one round trip's latency instead of nine.

---

### K2 — Low-med — The result excerpt is the head of the row, not a snippet around the match

**Evidence:**
- `src/lib/globalSearch.ts:108–119` — `excerptOf` takes `row[spec.excerpt]`, collapses whitespace and returns the **first** 140 characters (`trimTo(flat, EXCERPT_CHARS)`).
- `src/lib/globalSearch.ts:97–106` — the title is the first non-empty of the contract's title columns, capped at 80 characters.
- `src/lib/searchContract.ts:87` (note: `excerpt: "content"`), `:127–129` (journal: `title: ["content"]` **and** `excerpt: "content"` — the same column).
- `src/lib/globalSearch.ts:143–146` + `src/lib/search.ts:10–17` — both match modes know exactly where the term matched (FTS5 `bm25`/`snippet`, `LIKE` + `instr`), and the code discards that information.

**What is wrong:** A search result shows the beginning of the row, not the part of the row that matched. A note matched because of a word at character 5,000 is presented with its first 140 characters — the term is nowhere on screen, so the row gives the user no reason to believe it matched at all. For a journal entry it is worse: the title is the first 80 characters of `content` and the excerpt is the first 140 characters of the same `content`, so one result shows the same opening text twice, and neither slice contains the term that produced the hit.

**User impact:** Results cannot be triaged without opening every row. For notes the title often carries the meaning, which limits the damage; for journal entries — prose the user wrote about a day — the excerpt is actively misleading, because it looks like a relevant quote and is not.

**Fix direction:** Build the excerpt around the match: `snippet(notes_fts, 1, …)` for the FTS entity and a window around `instr(<column>, <term>)` for the `LIKE` entities, keeping the head-slice only as the fallback for a row that matched on its title column.

---

### K3 — Low-med — The notes query searches the FTS `folder` column (the collection name), which the contract says is not searchable

**Evidence:**
- `src-tauri/src/schema.rs:176` — `CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, tags, folder);`; the triggers write the collection name into `folder` (`:178–187`, `:193–201`).
- `src/lib/searchContract.ts:85` — the note spec's searchable columns are `["title", "content", "tags"]`; the field is documented at `:42` as *"Columns the query looks in, in the order they are reported."*
- `src/lib/searchContract.ts:233–234` — `SEARCH_EXCLUSIONS` lists *"wallets, categories, shops, lists, habits, recurring_payments, photo_refs, **collections**"* as deliberately not searchable, and `:208–213` says a change there "needs MinLulin's approval and a documented note in `docs/RELEASE.md`".
- `src/lib/globalSearch.ts:143–146,180–183` — the FTS branch matches the whole virtual table (`notes_fts MATCH ?`), which searches **every** indexed column, `folder` included; the `searchable` array is never used to build this query (`likeExpression` is reached only on the `like` branch, `:148`).
- Measured: a note whose title/content/tags contained only "milk" and whose `folder` was "SecretFolder" was returned by a global search for "SecretFolder"; the same match restricted to `{title content tags} : "SecretFolder"*` returned nothing.

**What is wrong:** The contract is the single place the UI, the caps and the SQL are supposed to agree (`searchContract.ts:11–16`). For the notes entity it does not describe the query that is actually run: the match covers a fourth, undeclared column. Two statements in the same file — "the note spec searches title/content/tags" and "collections are not searchable" — are both false for the SQL that file generates.

**User impact:** Searching a collection name returns every note filed under it, in the Note group, although none of those notes mention the name anywhere — a result set that looks like a relevance failure ("why did this match?"). It also means the search index carries a copy of every collection name, which the exclusions list says should not be indexed at all.

**Fix direction:** Make the contract and the SQL agree — either restrict the FTS match to the contract's columns (`notes_fts MATCH '{title content tags} : …'`, verified to work) so the exclusions hold, or declare `folder` searchable in the note spec and amend the exclusions entry. The product choice is in **DECISION 1**.

---

### K4 — Low-med — The FTS path and the LIKE path fold case and accents differently, so one query returns different rows per entity type

**Evidence:**
- `src/lib/searchContract.ts:250–260` — `likeExpression` builds `lower(<col>) LIKE ?`; `:262–278` — `normalizeTerm` lowercases with the Unicode-aware `String.prototype.toLowerCase()`.
- `src/lib/searchContract.ts:273–274` — the comment: *"LIKE also does not fold case for non-ASCII, which costs nothing for Burmese (it has no case) and is handled by `lower()` on the column for ASCII."*
- `src/lib/search.ts:10–17` — the FTS path hands the raw token to FTS5, whose `unicode61` tokenizer folds case and strips diacritics.
- Measured against SQLite: `lower('CAFÉ')` → `cafÉ`, `'CAFÉ' LIKE '%café%'` → false. In an FTS5 table holding `Café`, the match `"cafe"*` returned the row and `"CAFÉ"*` returned the row; in the `LIKE` branch the same term found `Café` but found nothing for `cafe` and nothing for `CAFÉ`.

**What is wrong:** The two match modes disagree in both directions. The FTS path is accent- and case-insensitive for Latin text; the LIKE path is accent-sensitive and folds only ASCII. The contract documents only the LIKE behaviour and treats the limitation as harmless — true for Burmese, false for the accented Latin, Cyrillic and Greek text the same app stores. A note titled "Café" is found by "cafe"; a contact named "Café" is not.

**User impact:** The same term in the same search box yields a different recall depending on which table the row lives in. Searching for an accented name (or any non-ASCII capital — "Ärger", "École") finds the notes but not the tasks, contacts, journal or memories, and the uppercase spelling finds neither.

**Fix direction:** Pick one semantic and apply it to both paths — normalise the stored side as well (a folded copy of the searchable columns), or give the LIKE path a case/accent-insensitive comparison (a custom collation or ICU), or restrict the FTS tokenizer to match the LIKE path. At minimum, correct `:273–274` so it does not present an ASCII-only limitation as neutral.

---

### K5 — Low-med — `notesRepo.search()` is typed `NoteRow[]` although its SQL truncates `content` to 200 characters (the J1 remedy was not applied to this path)

**Evidence:**
- `src/lib/search.ts:50–57` — the SQL selects `substr(n.content, 1, 200) AS content`; the result is cast to the caller's unchecked generic `T` (`searchNotes<T extends Queryable>`, `:31`).
- `src/lib/notes.ts:269–274` — `async search(...): Promise<NoteRow[]> { return searchNotes(driver, input, opts) as Promise<NoteRow[]>; }` — the declared type says "full body".
- `src/lib/types.ts:34–41` — J1's remedy and its wording: *"The `"list"` projection … `content` is cut by SQL to a 200-character prefix … Structurally a `NoteRow` (the type system cannot express 'truncated'), so this alias names the contract instead: read a body through `getNote`, never off a list row (J1)."*
- `src/lib/notes.ts:169` — `listNotes` answers `Promise<NoteListRow[]>` (J1 applied); `src/lib/notes.ts:183–186` — `listNoteTitles` answers `Promise<NoteTitleRow[]>` (J1 applied).
- `src/lib/search.test.ts:30–41` — the test pins the SQL shape but never the row type.

**What is wrong:** J1 established that a truncated projection must not be presented as a full row. The fix covered `listNotes` and `listNoteTitles`; the FTS search path was left as it was, and because `searchNotes` hands the caller an unchecked generic, `notesRepo.search` may claim any row shape for any projection — including the one shape J1 said must be named `NoteListRow`. J1 itself is fixed and is not re-reported here; this is the remaining path in the same class.

**User impact:** A caller that reads `.content` off a search result receives the first 200 characters under a type that promises the whole body — the exact trap J1 was raised for. The only current caller (`src/pages/NotesPage.tsx:518–524`) uses those rows for the card excerpt and the id list only, so no live misreading exists; the exposure is latent and the type no longer tells the truth.

**Fix direction:** Give the search path the J1 vocabulary (`Promise<NoteListRow[]>`, or a dedicated `NoteSearchRow`), and narrow `searchNotes`'s generic so a projection and its row type cannot drift apart — a non-generic return type, or a projection parameter that selects the type.

---

### K6 — Low — LIKE wildcards in the user's term are not escaped, so `_` and `%` widen the match and the ranking

**Evidence:**
- `src/lib/globalSearch.ts:148–150` — the term is bound as `%${term}%` with no escaping of the LIKE metacharacters.
- `src/lib/searchContract.ts:256–260` — the pattern itself is `lower(<col>) LIKE ?`, assembled from contract-owned column names.
- `src/lib/globalSearch.ts:186–194` — the ranking parameter is the same unescaped term with a trailing `%` (`${term}%`).
- Measured: tasks titled `a_b_c` and `axbxc` were **both** returned for the term `a_b`; the term `a%` returned both rows as well.

**What is wrong:** `%` and `_` are LIKE wildcards, so a term containing them matches more than the text the user typed — and the widened term also widens the "title starts with the term" ranking test, so the ordering is widened too. The FTS path does not have this problem (the token is quoted, and `_` is a tokenizer separator there, so `a_b` is the phrase "a b"), so the two modes disagree yet again.

**User impact:** Searching `50%` matches every row containing `50`; searching `a_b` matches `axb`. The results look wrong without any indication why, and the contract's promise that a title starting with the query ranks first no longer means what it says.

**Fix direction:** Escape `%`, `_` and the escape character itself in the bound term and add `ESCAPE '\'` to the pattern; if wildcards are wanted as a feature, make that an explicit option rather than an accident of typing.

---

### K7 — Low — `isSearchable` refuses a term made only of Unicode marks, so a Burmese particle searches for nothing

**Evidence:**
- `src/lib/searchContract.ts:280–289` — `isSearchable` removes everything that is not `\p{L}` or `\p{N}` and requires a non-empty remainder.
- `src/lib/globalSearch.ts:268` — a non-searchable input returns no groups at all.
- `src/components/GlobalSearchDialog.tsx:76–88` — a non-searchable query takes the idle branch: no groups, no "no matches" line, no error.
- Measured: `"ံး"` (U+1036 U+1038 — two Burmese combining marks) and `"်"` (U+103A) strip to the empty string, so `isSearchable` is `false`; `"နဲ့"` keeps its consonant and is searchable.

**What is wrong:** Burmese vowel signs and tone marks are combining marks (`\p{M}`), not letters, so a term built only from marks is classified as "nothing worth searching" and the search silently does nothing. The refusal was designed for punctuation-only input — `"` and `-` are legitimate characters in the FTS expression builder — but marks are letters in the user's language.

**User impact:** A writer who types a Burmese particle or a tone-mark-only syllable gets no results and no message; the search box looks broken. The failure is silent because the dialog treats the query as idle rather than as a zero-match search.

**Fix direction:** Treat marks as searchable content — strip only punctuation/symbols and whitespace, or require "at least one character that is not whitespace and not a punctuation mark" — and keep the punctuation-only refusal for the characters the FTS builder actually treats as operators.

---

### K8 — Low — The in-page note search orders by rank alone, while the global search on the same index promises and enforces a total order

**Evidence:**
- `src/lib/search.ts:50–56` — the in-page FTS query ends with `ORDER BY rank` — no tie-break and no `LIMIT`.
- `src/lib/globalSearch.ts:195–196` — the global search's rule, stated in the code: *"A total order, always: the same query must not reorder between two runs"* (`, <date> DESC, id DESC`); the file header (`:15–19`) makes determinism a stated promise of the search feature.
- `src/pages/NotesPage.tsx:518–524` — the Notes page uses this path for the in-page search box.

**What is wrong:** bm25 rank is not a total order, so two notes with equal scores have no defined relative position, and the in-page search adds no tie-break — although the global search, over the same index and with the same builder, does. The in-page search also returns every match, where the global search caps at 10 per entity (the browse list is uncapped too, so the missing cap is context, not the defect).

**User impact:** Equally-scored notes can change places between two identical searches, so the list under the search box is not stable — precisely the property the global search's header rules out. A writer re-running the same search can find a different note under the arrow keys.

**Fix direction:** Give the in-page search the same total order (`ORDER BY rank, n.updated_at DESC, n.id DESC`) and, better, extract one shared query builder for both entry points so the global search and the page search cannot drift apart.

---

### K9 — Low — The Notes page's mount-time settings read can overwrite a view-mode or collapse change the writer has already made

**Evidence:**
- `src/pages/NotesPage.tsx:396–414` — the mount effect reads the stored mode and collapse flag and calls `setViewMode(mode)` / `setCollectionsCollapsed(collapsed)` when the read resolves; its only guard is `cancelled`, which is set on unmount.
- `src/pages/NotesPage.tsx:417–427` — `changeViewMode` / `changeCollectionsCollapsed` apply the new value immediately and persist it in the background (`void settingsRepo.setNotesViewMode(mode).catch(() => undefined)`).
- `src/lib/notesView.ts:1–6` — the module's own division of labour: *"the page owns the state and the settings store owns the persistence; this module owns what a stored value MEANS and where Ctrl+E takes you."*

**What is wrong:** The mount read and the writer's click are two writers of the same state with no ordering between them. If the click lands while the read is still in flight — the read is an IPC round trip and can queue behind a write — the read resolves afterwards and overwrites the writer's choice with the previously stored value, while the persisted value is already the new one. The UI and the repository then disagree, and the click looks as though it was undone.

**User impact:** Rare but real: the editor mode or the Collections sidebar silently reverts, and the change is lost on the next launch. `notesView.ts` itself is clean (see "checked and found clean"); the staleness is between the page's state and the repository it reads.

**Fix direction:** Make the load yield to the writer — track a "changed since mount" flag (a ref) and skip the loaded value when the writer has already chosen one, or load the preferences before the controls become interactive.

---

### K10 — Low — `daysAgo` is exported search-layer API whose fallbacks are dead code and whose malformed input throws

**Evidence:**
- `src/lib/globalSearch.ts:324–330` — `const [y, m, d] = today.split("-").map((part) => Number.parseInt(part, 10));` then `new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1))`, `setUTCDate(...)`, `date.toISOString().slice(0, 10)`.
- No production caller: the only uses are in the test (`src/lib/globalSearch.test.ts:525, 529, 537, 548`).
- Measured: `daysAgo(10, "")` and `daysAgo(10, "not-a-date")` both throw `RangeError: Invalid time value`; `daysAgo(10, "2026-13-45")` silently rolls over to `2027-02-04`.

**What is wrong:** `Number.parseInt` returns `NaN`, never `null`/`undefined`, so the `?? 1970` and `?? 1` guards can never fire — they read as validation but are not. A malformed `today` therefore produces an Invalid Date whose `toISOString()` throws.

**User impact:** None today (nothing in the app calls it; the dialog uses `<input type="date">`), but the helper is exported from the search layer with a doc comment that invites a caller, and the thrown `RangeError` would surface as an unhandled error wherever it is called next.

**Fix direction:** Validate the parsed components (finite numbers, month 1–12, day 1–31) and return a documented fallback instead of throwing, or remove the helper while it has no caller.

---

### K11 — Low — `noteExcerpt` truncates on an ASCII space, so Burmese excerpts are cut mid-word

**Evidence:**
- `src/lib/notes.ts:56–62` — the doc comment: *"truncates on a word boundary with a trailing ellipsis."*
- `src/lib/notes.ts:86–90` — `const boundary = cut.lastIndexOf(" "); const head = (boundary > 0 ? cut.slice(0, boundary) : cut).trimEnd();` — with no space in the text there is no boundary and the whole cut is used.
- Measured: a 200-unit Burmese text produced a 140-unit excerpt ending mid-word ("…တစ်ခုက…"), with no space anywhere in it.

**What is wrong:** Burmese (like Thai) is written without spaces between words, so the "word boundary" the comment promises does not exist and the excerpt always ends mid-syllable. The 140 cap is also counted in UTF-16 code units, so a Burmese excerpt carries noticeably fewer visible characters than a Latin one.

**User impact:** Card excerpts in the app's primary language end mid-word. Cosmetic, but it is the app's default reading surface and the code's own comment states a behaviour it does not deliver.

**Fix direction:** Use the `Intl.Segmenter` the word counter already uses (`src/lib/noteReader.ts:65–74`) to find a segment boundary, and count the cap in grapheme clusters rather than code units.

---

### K12 — Low — The test named "an empty title still produces a usable row" asserts the opposite and never exercises the fallback

**Evidence:**
- `src/lib/globalSearch.test.ts:665–677` — the test inserts a task with an empty title **and** an empty note, then asserts `groups.length === 0` twice. Its own comment says *"Search by the note field, since the title is empty"* — but the note field is empty too, so nothing can match.
- `src/lib/globalSearch.ts:98–106` — the behaviour the name points at, which the test never reaches: `titleOf` falls back to `${spec.label} ${String(row.id ?? "")}` when every title column is empty.

**What is wrong:** The fallback for an empty title — the case the test name is about — has no coverage. A regression that made an empty-titled row render an empty title would pass the suite, and the assertions as written pin the opposite of the promised behaviour.

**User impact:** A coverage hole on a documented behaviour rather than a live bug: the empty-title row is the one that must still be clickable in the results list.

**Fix direction:** Give the row a non-empty searchable column (a note, or a second title-bearing column), assert that the result carries a usable title, and keep the "nothing matches" assertion as a separate case for a genuinely empty row.

---

### K13 — Low — `SEARCH_EXCLUSIONS` says photo captions stay searchable from the note that holds them; they are not searchable at all

**Evidence:**
- `src/lib/searchContract.ts:225–227` — *"photos (note, taken_date) and photo bytes … Photo captions stay searchable from the note that holds them."*
- `src/lib/gallery.ts:222–232` and `:269–276` — the caption is stored in `photos.note` (and updated there).
- `src-tauri/src/schema.rs:462–471` — `photos.note` is a column of `photos`; nothing copies it into `notes`, and `photo_refs` (`schema.rs:473–478`) only links the photo to the note's id.
- `src/lib/searchContract.ts:79–206` and `src/lib/globalSearch.ts:180–183` — no contract row searches `photos`, and no searchable column carries the caption.

**What is wrong:** A caption typed in the gallery exists only in `photos.note`. It is not part of the owning note's title, content or tags, so it is in no searchable column and cannot be found by the global search or by the notes FTS. The exclusion's reassuring sentence is therefore not true of the caption field.

**User impact:** A caption the user typed is unfindable by text search, while the search documentation promises otherwise. There is no disclosure risk — the exclusion itself holds; only the sentence is wrong.

**Fix direction:** Correct the sentence to say that captions are not searchable at all, or make it true by carrying the caption into the owning note's searchable text — a product choice that should be settled with the exclusions owner rather than changed silently.

---

## DECISION — behaviour choices that need a human call

### Decision 1 — Should the global search match a collection name?

Documented as **K3**. The facts: `notes_fts` indexes the collection name in its `folder` column (`schema.rs:176, 178–201`), an FTS `MATCH` searches every indexed column, and the notes page's own search therefore matches collection names today — a behaviour the suite pins at the notes level (`src/lib/notes.test.ts:207–250`, the P3-4 regression). The global search's contract says the opposite twice: the note spec's searchable columns are `title/content/tags` (`searchContract.ts:85`) and `SEARCH_EXCLUSIONS` lists "collections" as deliberately not searchable (`searchContract.ts:233–234`), under a header that says such a change "needs MinLulin's approval and a documented note in `docs/RELEASE.md`" (`:208–213`).

Two defensible resolutions:
- **(a) Restrict the global search's FTS match to the contract's columns** (`{title content tags} : …`, verified to work against SQLite). The exclusions stay true; the price is that the two search entry points then differ — the notes page matches a folder name, the global search does not.
- **(b) Declare `folder` searchable** in the note spec and amend the exclusions entry. The two entry points stay consistent; the price is that collection names become searchable content, which the exclusions header says needs the owner's approval and a release note.

This is recorded as a decision rather than a plain bug because both resolutions are coherent and the choice is a product one, not a technical defect. Whichever is chosen, the contract and the SQL must say the same thing.

### Decision 2 — Should a fully repaid loan be hidden from the global search, like a paid job or a done task?

`src/lib/searchContract.ts:50–59` states the policy: *"Archived notes, completed tasks, paid payables and paid jobs are hidden unless the user asks for them — a search that surfaces a hundred finished things is not a search."* Four of the nine entities implement it. The loan spec does not (`searchContract.ts:178–191`, `inactive: null`), so a **closed** loan — fully repaid, `repaid_cents >= amount_cents`, `src/lib/loans.ts:19–27` — is always in the results, indistinguishable from an open one: `stateOf` returns `null` when `inactive` is `null` (`globalSearch.ts:204–219`), so the result carries no state at all.

The contract's `inactive` shape (a column and a value, `searchContract.ts:50–60`) cannot express this, because a loan's state is derived, not stored — filtering it would need a predicate rather than a column, and a "Closed" label would need the shape to grow. Note the deliberate counter-precedent: ticked-off shopping items **are** searchable, and that is stated in the spec's own `why` (`searchContract.ts:192–205`).

**Decision needed:** should a closed loan be filtered out (and shown with a "Closed" state when `includeInactive` is on), or is "always find the loan by the counterparty's name" the intended behaviour? If it should be filtered, the `inactive` contract needs to express a derived predicate rather than a column value.

---

## Checked and found clean

- **Parameterisation / injection.** Every user-supplied value in this layer is bound: the FTS expression is built by `buildMatchQuery` (`search.ts:10–17` — each token double-quoted, embedded `"` doubled, `*` prefix suffix) and passed as a parameter (`globalSearch.ts:143–146`); the LIKE terms are bound (`globalSearch.ts:148–150`); the inactive flag and both date bounds are bound (`:153–178`). The only interpolated fragments are the contract's own table/column names (`searchContract.ts`, code-owned) and `LIMIT <int>` from `spec.cap` (`:199`). The suite's "no value is ever interpolated into the SQL" test (`globalSearch.test.ts:784–802`) checks placeholder/param parity for every contract row and passes.
- **The G9 remainder is intact.** The generic full-date guard is present on both bounds — `length(<date>) = 10` inside the `since` and `until` clauses (`globalSearch.ts:160–177`) — so a yearless `MM-DD` birthday can no longer satisfy a range; both G9 remainder tests (`globalSearch.test.ts:567–613`) pass. Not re-reported.
- **The J1 projection-typing fix is intact on the paths it covered.** `listNoteTitles` answers `NoteTitleRow[]` and selects exactly `id, title` (`notes.ts:183–186`); the `"title"` projection is unreachable from `listNotes` (`notes.ts:100–126, 169–172`); `listNotes` answers `NoteListRow[]` (`notes.ts:169`); the J1 source pins pass (`notes.test.ts:252–353`). Not re-reported. (The remaining gap on the search path is K5.)
- **Cross-entity disclosure.** Vault items, settings, photos, income/expense entries, wallets, categories, shops, lists, habits, recurring payments, photo refs, links and inbox items are absent from `SEARCH_CONTRACT` (`searchContract.ts:79–206`); the suite asserts the forbidden tables are absent *and* that a vault row cannot surface (`globalSearch.test.ts:276–328`). Trashed records cannot surface either: `trashEntity` deletes the source row (`trash.ts:472`) and the `notes_fts_ad` trigger removes the FTS row with it (`schema.rs:189–191`); `trash_items` itself is not searchable.
- **Inactive-row filtering.** Archived notes, done tasks, paid jobs and paid payables are excluded unless `includeInactive` is set, using the contract's own column/value pairs (`globalSearch.ts:153–157`; `searchContract.ts:50–59`), and the state word comes from the contract rather than from the column name (`stateOf`, `globalSearch.ts:204–219`) — asserted by `globalSearch.test.ts:448–496`.
- **Ordering, caps and the total-cap report.** The global search's order is total (rank → date → id for notes; prefix-match → date → id for the rest, `globalSearch.ts:189–196`), the per-entity cap is enforced and reported without a second COUNT query (`:199, 274–282`), and `applyTotalCap` trims from the end, drops emptied groups and reports truncation through the additive side channel (`:303–322`) — all pinned by `globalSearch.test.ts:498–508, 679–782` and passing.
- **The result payload is enough to open the exact row.** `toResults` carries the id, the journal's `entry_date` key, the shopping item's parent list id, and a linkable entity for note/task/contact (`globalSearch.ts:222–250`); `src/App.tsx:339–353` routes each result to the page the contract names (`opens.page`), and the journal/business/shopping/loan targets are honoured at `src/App.tsx:986–1046`. The suite pins the payload (`globalSearch.test.ts:642–663`).
- **The notes repository's write paths.** `createNote`/`updateNote` bind every value and stamp `updated_at` (`notes.ts:196–240`); `setPinned`/`setArchived` use the 0/1 flags (`:242–254`); `deleteCollection` retires the collection name from `notes_fts.folder` in the same batch as the delete (`:145–159`), pinned by the P3-4 regression test (`notes.test.ts:207–250`).
- **`notesView.ts` itself.** `parseViewMode` and `parseCollectionsCollapsed` fall back exactly as documented — absent, corrupt and unexpected values all land on "split" / expanded (`notesView.ts:17–50`) — and `toggleViewMode` gives every mode exactly one destination and never returns itself (`:24–41`); all pinned by `notesView.test.ts:16–64`. The draft-safety pins hold as well: the mode reaches the DOM only as a CSS class and both panes stay mounted (`notesView.test.ts:71–138`).
- **`noteExcerpt`'s markdown stripping.** Fences, inline code, images, links, headings, quotes, rules, list bullets, bold/italic/strikethrough are removed in a safe order and `snake_case_names` survive (`notes.ts:67–85`), pinned by `notes.test.ts:44–90`. Only the truncation boundary is at issue (K11).
- **`buildMatchQuery`'s quoting.** Every token is double-quoted with embedded quotes doubled and a `*` prefix suffix, so FTS operators typed by the user stay literal (`search.ts:10–17`); the suite drives the operator-shaped inputs (`"`, `milk"`, `AND`, `OR NOT`, `NEAR(a b)`, `*`, `^milk`, `a OR`, `(`, `col:milk`) through the real SQLite fixture (`globalSearch.test.ts:348–369`) and they neither throw nor act as syntax.
- **NFC normalization of the term.** `normalizeTerm` composes and lowercases without stripping combining marks, so both the composed and the decomposed spelling of a word match the stored text (`searchContract.ts:262–278`), pinned by `globalSearch.test.ts:371–403`. (The ASCII-only folding consequence is K4.)
