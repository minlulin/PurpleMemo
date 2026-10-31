> **Historical plan — not a requirement.**
> The work described here has shipped (see `src/`, `docs/RELEASE.md` and
> `docs/EXPORTS.md`); this file is kept only as the record of what was
> planned. Do not treat it as the current specification.

# Purple Memo — Import Feature Tasks (dev branch)

**Source:** `PurpleMemo_Import_Feature_Plan.md` (all §10 decisions settled
2026-10-25). Builds on the `dev` branch only — never touch `main`, never
merge; the owner merges when satisfied.

## How to work this plan (read first, every session)

- Work the tasks **in order**. Do **at most 2 tasks per session**, then STOP.
- After each pair (or single task, if the session ends), **report back** in
  the format at the bottom and wait. **Do not commit** until the owner says
  the pair is verified. One commit per verified pair, on `dev`.
- `npm run verify` must be **fully green** (JS gate *and* cargo) before any
  commit. No partial commits, no gate exceptions.
- **Hard constraints:** no schema change; no new dependency; no change to
  backup format or export formats; every user-facing string in EN **and**
  MY; no new files outside the ones each task names (plus tests).
- If a task cannot be completed exactly as written, stop and report the
  blocker. Do not improvise extra scope — and do not add vCard import; it
  is out of scope for this feature.

---

## Task 1 — CSV parser library + tests

**New file:** `src/lib/csv.ts` + `src/lib/csv.test.ts`.

**Behavior (from plan §3):**
- Parse a header row + data rows. Headers matched case-insensitively and
  trimmed. Unknown columns ignored.
- Quoted fields: embedded commas, embedded newlines, doubled quotes (`""`).
- Line endings CRLF and LF; strip a leading UTF-8 BOM.
- Missing required column (caller supplies the required list) → throw an
  Error naming the missing column, before any row is returned.
- Caps, checked **before** parsing: file > 5 MiB or rows > 5,000 → throw
  an Error stating the limit. (Row counting must not require a full parse
  first — count newline-terminated records cheaply, then parse.)
- Return type: `{ headers: string[], rows: Record<string, string>[] }`
  where every value is the raw string (mapping/validation is the caller's
  job, not the parser's).

**Tests:** quotes, embedded commas/newlines, doubled quotes, BOM, CRLF/LF,
unknown columns ignored, missing required column error, both caps refusing.

**Acceptance:** new tests pass; full gate green; diff touches only the two
new files.

## Task 2 — Tasks mapper + batch insert + tests

**New files:** `src/lib/taskImport.ts` + `src/lib/taskImport.test.ts`.
**No UI in this task.**

**Behavior (from plan §4, tasks format):**
- Input: parsed CSV rows (from Task 1's parser). Required column: `title`.
- Row mapping: `title` trimmed, non-empty (else row error);
  `due_date` empty or `YYYY-MM-DD` (else row error); `done` mapped from
  `true/false/yes/no/1/0` case-insensitively (else row error);
  `repeat` empty → `none`, else must be `none/daily/weekly/monthly`
  (else row error); `note` free text, may be empty.
- Output: `{ valid: TaskInsert[], errors: { row: number, reason: string }[] }`
  — row numbers are 1-based **data** rows (header is not row 1).
- Batch insert function: takes the valid rows and the driver, inserts all
  in **one batch** (one INSERT per row: title, due_date, done, repeat,
  note, created_at = now). Any statement failure rolls the whole batch
  back — assert this in a test, don't assume it.
- Duplicate policy: always insert as new. No dedupe, no merge.

**Tests:** every column rule + every row-error case; the tolerant `done`
mapping (all six spellings + one invalid value); rollback on a failing
row; empty-title and bad-date rows reported with correct row numbers.

**Acceptance:** new tests pass; full gate green; diff touches only the two
new files.

> **Session A = Task 1 + Task 2 → report → owner verification → commit.**

---

## Task 3 — Shared import dialog + template download

**New files:** `src/components/ImportDialog.tsx` (+ its styles in
`src/styles/app.css`, same file the app already uses for component styles).

**Behavior (from plan §6–§7):**
- Props: `title`, `templateCsv: string`, `templateName: string`,
  `onPick: () => Promise<string>` (file text — the caller owns the
  dialog-issued file read, same trust pattern as backup import),
  `parse: (text: string) => PreviewResult` (caller supplies mapper),
  `onConfirm: (validRows) => Promise<ImportSummary>`, `onClose`.
- Steps inside the dialog: (1) file picked → parse + validate in memory,
  **nothing written**; (2) preview: counts (rows OK / rows with errors),
  a scrollable table of the rows to import, per-row error lines
  (row number + reason); (3) confirm button **disabled when every row
  failed**; (4) on confirm, run `onConfirm`, then show the result counts
  ("Imported N … (M rows had errors and were skipped)") and close.
- "Download template CSV" button downloads `templateCsv` as `templateName`
  (plain anchor download — no Rust command needed).
- All strings through i18n (add the dialog's keys to `src/lib/i18n.ts`,
  EN + MY, in this task).

**Acceptance:** dialog renders preview counts + errors from a canned
parse result (test with a stubbed `parse`/`onConfirm` if the project has
a component-test setup; otherwise a careful manual checklist in the
report: all-rows-failed disables confirm, template downloads the exact
text). Full gate green.

## Task 4 — Tasks page wiring

**Files:** `src/pages/TasksPage.tsx` (+ i18n keys if any remain), no new
library files.

**Behavior:**
- "Import CSV" button on the Tasks page opens `ImportDialog` with the
  tasks template (header `title,due_date,done,repeat,note` + one example
  row) and the Task 2 mapper + batch insert as its `parse`/`onConfirm`.
- After a successful import, the task list refreshes and a toast shows the
  result counts from Task 3's dialog.
- File reading uses the existing dialog-issued file-read path (same as
  backup import) — do not invent a new native read path.

**Acceptance:** import a 3-row CSV (one row deliberately invalid) through
the built app flow in dev: 2 rows land, 1 error line shown, list refreshes.
Report the manual check honestly. Full gate green.

> **Session B = Task 3 + Task 4 → report → owner verification → commit.**

---

## Task 5 — Contacts mapper + batch insert + tests

**New files:** `src/lib/contactImport.ts` + `src/lib/contactImport.test.ts`.
**No UI in this task.**

**Behavior (from plan §4, contacts format):**
- Required column: `name`. Row mapping: `name` trimmed, non-empty (else
  row error); `phones`/`emails`/`others` split on `;`, empty items
  dropped, each value becomes one channel in listed order
  (kind = phone/email/other respectively); first channel overall becomes
  primary (`is_primary = 1`, the rest 0); `sort_order` follows listed
  order across all three columns; `address`/`notes` free text;
  `birthday` empty or `YYYY-MM-DD` (else row error); `tags` split on
  `;`, trimmed, duplicates dropped (the UNIQUE (contact_id, tag)
  constraint must never be tripped by one row).
- Output: same shape as Task 2 (`{ valid, errors }`), row numbers
  1-based data rows.
- Batch insert: one batch per import — contact row, then its channels,
  then its tags (same batch, so a failure rolls everything back).
  Assert the rollback in a test.
- Duplicate policy: always insert as new.

**Tests:** every column rule + row-error case; semicolon splitting
(including empty items and trailing `;`); primary = first channel only;
sort_order sequence; tag dedupe; rollback on failure.

**Acceptance:** new tests pass; full gate green; diff touches only the two
new files.

## Task 6 — Contacts page wiring

**Files:** `src/pages/ContactsPage.tsx` (+ remaining i18n keys).

**Behavior:** mirror of Task 4 for contacts — "Import CSV" button opens
`ImportDialog` with the contacts template (header
`name,phones,emails,others,address,birthday,notes,tags` + one example
row) and the Task 5 mapper + batch insert. List refreshes + result toast
after import. Same file-read path as Task 4.

**Acceptance:** import a 3-row CSV (one row deliberately invalid) through
the built app flow in dev: 2 contacts land with correct channels/tags,
1 error line shown, list refreshes. Report the manual check honestly.
Full gate green.

> **Session C = Task 5 + Task 6 → report → owner verification → commit.**

---

## Task 7 — Polish + final gate

**Files:** only fixes found in this pass; no new features.

**Checklist:**
- Re-read the plan §3–§8 and confirm every rule is implemented (caps,
  BOM, CRLF, unknown columns, row numbers, rollback, template text,
  disabled confirm, result counts).
- i18n pass: every new string exists in EN **and** MY; no hard-coded
  user-facing text in the new components.
- Run the full gate (`npm run verify`) and record JS + cargo test counts.
- Report any deviation from the plan as a deviation, not a silent fix.

**Acceptance:** full gate green; report lists the final counts and any
deviations. The owner then does the installed check before any merge.

> **Session D = Task 7 alone → report → owner verification → commit.**

---

## Report-back format (after each pair)

```
Tasks done: <numbers>
Files changed: <path — one-line summary, per file>
Tests added/changed: <names>
Gate: npm run verify — <green/red; JS test count; cargo test count>
Manual checks done: <what was actually tried in the built app, or "none this pair">
Anything deferred, surprising, or out of scope noticed: <or "none">
```

Then stop. The owner verifies (diff + gate re-run) before any commit.
