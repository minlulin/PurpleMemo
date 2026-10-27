# Findings — deep audit of the largest source files (2026-10-26)

Line numbers are against this branch at `784db12` (base `2064081`, `dev`).
Nothing here is fixed by this document — it records what was found, with the
evidence for each claim, so the fixes can be reviewed separately.

Scope: `BudgetPage.tsx` (1915 lines), `SettingsPage.tsx`, `BusinessPage.tsx`
(1664), `NotesPage.tsx` (1147), `DashboardPage.tsx` (945), `App.tsx`, and the
modules they sit on (`budget.ts`, `exports.ts`, `backup.ts`, `trash.ts`,
`csv.ts`, `journal.ts`, `drafts.ts`, `entityPicker.ts`, `entityLinks.ts`,
`money.ts`, `dates.ts`, `format.ts`, `contacts.ts`), plus `db.rs`, `share.rs`,
`photos.rs` and `schema.rs`. The point of the exercise was the big files: the
repo-wide review passes summarise them, and a defect in a 1900-line page needs
two distant halves of the file held in mind at once, which a scan does not do.

## Summary

| # | Area | Severity | Finding |
|---|------|----------|---------|
| F1 | `lib/budget.ts` | High | Wallet/category delete fails with a raw `FOREIGN KEY constraint failed` when only a recurring rule references the row |
| F2 | `BudgetPage.tsx` | Med-high | Month view shows the previous month's totals under the new month's heading |
| F3 | `BudgetPage.tsx` | Med | `LimitsView` / `RecurringView` refreshes have no cancellation, so an older response can overwrite a newer one |
| F4 | `BudgetPage.tsx` | Med | Cross-table id comparisons discard an in-progress edit when an unrelated row is deleted |
| F5 | `NotesPage.tsx` | Med | Note/collection creation has no double-submit guard |
| F6 | `ContactsPage.tsx`, `GalleryPage.tsx`, `BudgetPage.tsx` | Med | Unguarded inline add-forms; two of the tables have no UNIQUE, so the duplicates are real data |
| F7 | `lib/exports.ts` | Med-low | `journalExportPath` is the one export path built without `sanitizeFilePart` |
| F8 | `BusinessPage.tsx`, `lib/navigation.ts` | Low-med | Three untranslated "row is gone" strings; the central helper for them is dead code |
| F9 | `SettingsPage.tsx` | Low | Share button sticks on "Copied" |
| F10 | `lib/budget.ts` | Low | `convertEntry` omits the `note` fallback its three siblings have |
| F11 | `BudgetPage.tsx`, `DashboardPage.tsx` | Low | `today` captured at render time feeds money writes |
| F12 | `lib/entityPicker.ts` | Low | Dead ternary: both branches of `includeInactive` are identical |

## F1 — Deleting a wallet or expense category hits an opaque foreign-key error

`src/lib/budget.ts:363` (`deleteWallet`), `:472` (`deleteExpenseCategory`)

Both functions exist to prevent exactly this error — the comment reads
"Rather than surface that as an opaque foreign-key error, the usage is checked
and named" — but the usage query counts only entries:

```sql
SELECT (SELECT COUNT(*) FROM income_entries  WHERE wallet_id = ?)
    + (SELECT COUNT(*) FROM expense_entries WHERE wallet_id = ?) AS uses
```

`recurring_payments.category_id` and `recurring_payments.wallet_id`
(`src-tauri/src/schema.rs:312-313`) are plain `REFERENCES` with no
`ON DELETE` action, and a recurring rule is the most common thing pointing at a
wallet that has no entries yet. `PRAGMA foreign_keys` is ON (`db.rs:487`,
pinned by `foreign_keys_and_checks_enforced`), so SQLite refuses the delete.

Reproduced against the repo's own DDL:

```
deleteWallet() sees uses = 0 -> proceeds to DELETE
SQLite instead says: FOREIGN KEY constraint failed
deleteExpenseCategory() sees uses = 0 -> proceeds to DELETE
SQLite instead says: FOREIGN KEY constraint failed
```

User-visible effect: the Manage view promises Delete "only while a row is
unused", enables it, shows a usage badge of 0 — and then the delete is
impossible with a message that names no table and suggests no action.

Fix: follow `business.ts:223 deleteShop`, which already handles this correctly —
null the references, then delete, in one `driver.batch`:

```sql
UPDATE recurring_payments SET wallet_id = NULL WHERE wallet_id = ?;
DELETE FROM wallets WHERE id = ?;
```

Nulling is safe by design: `markRecurringPaid` (`budget.ts:921`) resolves
`rule.category_id ?? fallback` / `rule.wallet_id ?? fallback` at mark-paid time
(review P3-30), so a rule with no wallet of its own falls back to the picker.
The same is not needed for `expense_limits`, which cascades.

## F2 — Month view renders the wrong month's numbers under the right heading

`src/pages/BudgetPage.tsx:947-978` (`MonthView`)

The effect sets `cancelled`, `display`, `error` and `loading` — but never
`setLoading(true)` when `yearMonth` changes. `YearView:1155` does exactly that,
and the sibling `EntriesView`/`ManageView` effects are structured so the list is
cleared while loading.

`label = monthLabel(yearMonth)` (`:978`) re-renders on the click while `display`
still holds the previous month, so clicking ‹ shows "November 2026" above
October's income, expense and limit figures for the length of the round trip. On
a money screen this is wrong data, not just a missing skeleton.

Fix: `setLoading(true)` (and clear `display`, or gate the table on `loading`) at
the top of the effect, as `YearView` does.

## F3 — Two refreshes can render a stale response

`src/pages/BudgetPage.tsx:1304` (`LimitsView.refresh`), `:1500`
(`RecurringView.refresh`)

Both are `useCallback`s invoked from an effect (`:1325`, `:1526`) keyed on a
changing value (`yearMonth`, `showInactive`), with no `cancelled` flag and no
sequence token — unlike `MonthView:956`, `YearView:1154` and
`EntriesView:515/554`, which all carry the guard. `LimitsView.refresh` awaits
`listExpenseCategories()` and then fans `limitStatusFor()` out per category, so
two quick month switches finish out of order reliably: December's header over
November's bars. `RecurringView.refresh` also calls `setLoading(false)`
unconditionally, so a slow first load can clear the busy state belonging to a
newer request and hide the skeleton mid-load.

Fix: the `let cancelled = false` / cleanup pattern already used three lines up
the file, or a monotonically increasing request token compared before `setRows`.

## F4 — Deleting a row in one table throws away an edit in another

`src/pages/BudgetPage.tsx:652` (`EntriesView.remove`), `:266`
(`ManageView.removeRow`)

```ts
if (editing?.id === entry.id) resetForm();   // :652
if (editing?.id === id) setEditing(null);    // :266
```

`income_entries` and `expense_entries` are separate tables with independent id
sequences, so their ids collide from 1 upward; `ManageView` mixes three tables
(wallets, expense categories, income categories). `editing` carries a `kind` in
both components, and neither comparison uses it. Deleting income entry #3
therefore calls `resetForm()` on the form being used to edit expense #3, losing
amount, date and note with no confirmation — the common case, not an edge case,
because the ids line up.

Fix: compare `kind` as well as `id`.

## F5 — Note and collection creation is not guarded against double submit

`src/pages/NotesPage.tsx:686` (`handleNew`), `:785` (`handleNewCollection`)

`handleNew` awaits `createNote` → `refresh()` → `setSelectedId(id)` with no busy
state, no ref, and the buttons at `:1008`/`:1044` carry no `disabled` (the Enter
handler at `:1001` calls the same function). Two clicks insert two "Untitled"
notes — `notes.title` is not unique — and the first is stranded, off-screen, in
the same collection. `handleNewCollection` instead ends in
`UNIQUE constraint failed: collections.name` (collections.name is unique), so the
collection saves and the user is shown a constraint error for a successful write.

The inconsistency is inside the same file: `handleToJournal:824` has a
`toJournalRef` in-flight guard added under review P3-29 ("a second click before
the first lands … appends the same block again"), and `handleDiscardDraft:669`
refuses work "while a save is in flight (review P2-6)", describing the
interleaving as "a real bug, not a theoretical one". The two create paths never
got the same treatment. (`handleDelete` is genuinely safe — `trash.ts` guards
its delete with `snapshotGuard`, and `handleArchive` recomputes from the row
rather than from live state.)

## F6 — Unguarded inline add-forms, and two tables where the duplicate survives

- `src/pages/ContactsPage.tsx:307` `addChannel`, `:344` `addTag`
- `src/pages/GalleryPage.tsx:284` `addLink`
- `src/pages/BudgetPage.tsx:168 / :182 / :194` `addWallet` /
  `addExpenseCategory` / `addIncomeCategory`

None of these sets any state before its `await`, so nothing disables the control
for the duration of the IPC round trip; all six are `<form onSubmit>` paths,
where a second Enter is never blocked. `EntriesView.submit:595` at least flips
`saving` (which disables its button) but has no `if (saving) return` — its
sibling `createRule` in the same file has both halves.

What a double submit costs depends on the table:

- `contact_channels` and `photo_refs` have **no UNIQUE constraint**, so the
  duplicate row is written: the same phone number twice on a contact card (and
  twice in the vCard/CSV export), the same note linked twice to a photo.
  `addLink`'s only protection is `selectedRefs.some(...)`, read from state that
  cannot yet contain what the first click inserted.
- Wallets, categories and collections are name-UNIQUE, so the write succeeds and
  the second call reports the constraint error — with the first call's
  `setDraft("")` and the error racing to decide what the form looks like.

Why the repo's own gate missed it: `src/pages/submit-guards.test.ts` exists to
pin this convention and does enumerate `createRule`, `addJob`, `pay`,
`addContact`, `addHabit`, `addShop`, `addTask`, `saveActive`, `runFactoryReset`,
`doExport`, `confirmImport` and more — but for the two largest pages it covers
only `BudgetPage.createRule` and `NotesPage.saveActive`. The unlisted handlers
are precisely the ones above. A regression test row per handler would have failed
on all of them.

## F7 — One export path is built without sanitising

`src/lib/exports.ts:291` (`journalExportPath`), used at `:781`

Note files go through `sanitizeFilePart(note.title, "note")` (`:285`); journal
entries are written to `journal/${entry_date}.md` straight from the row. The
app's own writer always produces `YYYY-MM-DD`, and `journal.ts` does not
validate, and `schema.rs` puts no `CHECK` on `entry_date` (it is `UNIQUE` only) —
so a date arriving from a restored archive or an imported payload becomes a path
that escapes the `journal/` folder when the zip is unpacked (a `.md` file written
outside the export directory).

Fix: validate `^\d{4}-\d{2}-\d{2}$` in `journal.createEntry` (the write side) and
run the path component through `sanitizeFilePart` (the read side).

Related and lower: the finance queries inside `collect()` `INNER JOIN`
categories and wallets, while the jobs/payables queries deliberately `LEFT JOIN`
their shop for the "parent gone, keep the row" reason. It is unreachable today
(foreign keys are enforced, and the backup canary refuses a payload with dangling
refs), but the asymmetry means that if a relaxed path ever appears, money rows
would vanish from `income.csv`/`expenses.csv` **and** from `counts`, which is
derived from the same joined rows — so nothing in the archive would reveal the
loss, while `summary.json` totals (computed elsewhere) would keep counting them.

## F8 — Three untranslated strings, and a dead helper that should own them

`src/pages/BusinessPage.tsx:500`, `:1035`, `:1286`

```ts
setError("That job is no longer in this view — it may have changed or been deleted.");
```

The catalog has `notes.missing`, `tasks.missing`, `contacts.missing` and
`inbox.convertedGone` for this exact message class, so the Business focus flow is
the only one that renders English to a Burmese user — and it bypasses `t()` in a
page that translates everything else around it.

Meanwhile `src/lib/navigation.ts:97 missingRowMessage()` — the helper written for
precisely this message — is exported, referenced by nothing (including no test),
and its text duplicates `notes.missing` verbatim. The drift between an intended
single source and per-page strings is how the untranslated ones got in.

Fix: add `business.jobMissing` / `business.payableMissing` (EN + MY) and delete
`missingRowMessage` or make the pages use it through `t()`.

## F9 — Share button stays on "Copied"

`src/pages/SettingsPage.tsx:623` (`copyShareLink`) sets `shareCopied(true)`; only
`startShare`/`stopShare` (`:581`, `:605`) clear it. Re-publishing a snapshot while
the share stays on leaves the control asserting "Copied" for a link nobody copied.
The sibling actions in that block also `setError("")` first, and copy does not, so
an earlier error message persists next to a successful copy.

Fix: reset `shareCopied` (and `setError("")`) when the snapshot changes and when
copy starts, mirroring start/stop.

## F10 — `convertEntry` drops the note fallback

`src/lib/budget.ts:666`

`EntryInput.note` is optional (`:41`). `createIncomeEntry`, `createExpenseEntry`
and `updateExpenseEntry` all bind `input.note ?? ""` (`:524`, `:540`, `:810`);
`convertEntry` binds `input.note` into a `NOT NULL` column, so a caller that
omits the field gets `NOT NULL constraint failed: expense_entries.note` instead
of an empty note. Only `BudgetPage:621` calls it today and it always passes a
trimmed string, which is why this has not surfaced — the type allows the bug.

## F11 — `today` captured at render time, used for money writes

`src/pages/BudgetPage.tsx:1472` in `RecurringView` (`const today =
todayLocal()`) feeds `recurringDisplay(r, today)` (`:1725`, the Overdue badge and
the occurrence list), `markRecurringPaid(rule.id, today, booking)` (`:1565`) and
the initial `nextDue` (`:1496`). The Budget page has no timer of its own, so a
view opened before midnight books and labels occurrences against yesterday until
it remounts. `DashboardPage.tsx:105` has the same shape but re-renders on its
30-second reminders tick, so it self-heals.

Fix: read the date inside the handler (`markPaid`) and the effect that derives
overdue state, rather than in the component body.

## F12 — Dead ternary

`src/lib/entityPicker.ts:161-163`

```ts
const offered = options.includeInactive
  ? [...live, ...inactive]
  : [...live, ...inactive];
```

Both branches are the same, so the flag does nothing at this site. Output is
still correct only because candidates are filtered per row earlier; a reader
trying to work out whether "include inactive" is honoured gets no answer here.
Either drop the ternary or move the filtering it implies.

## Checked and found clean

Recording this bounds the audit. These were examined and are correct as written:

- `lib/money.ts`, `lib/dates.ts`, `lib/format.ts` — `parseMMK`/`fromCents`
  (including `1e100` and thousands separators), `limitsForMonth`,
  `budgetStatus`, `shiftYearMonth`'s clamp, local-not-UTC date handling.
- `lib/csv.ts` + `lib/taskImport.ts` — `csvText` ↔ `unescapeSpreadsheetCell`
  round-trip for `=`, `+`, `-`, `@`, quotes, commas and embedded newlines;
  `parseCsv`'s quote/cap/blank-row handling; vCard folding and unfolding.
- `lib/backup.ts` — `BACKUP_TABLES` matches `schema.rs` exactly in both
  directions, manifest/version checks, the restore canary and the
  safety-copy-before-import ordering.
- `lib/trash.ts` — the column lists match the DDL for all five entity types,
  id reallocation on restore, link re-canonicalisation, photo-file GC, and the
  1000-row eviction order.
- `App.tsx` — `loadSecurity`/`lockNow`/`enterWorkspace`, idle and blur locking,
  global shortcuts, `shellStage`, and the not-awaited `saveActiveDraft` on the
  save path (`markSaved` is synchronous before the await, so it is safe).
- `src-tauri/src/db.rs` — `reject_dangerous_statement`, value mapping, the
  transaction helpers, `batch` pre-validating the whole list before `BEGIN`, and
  `rollback_after_failure` reporting a failed rollback rather than hiding it.
- `src-tauri/src/share.rs` — Host allowlisting, CSP, `no-store`, `nosniff`, the
  consent token (single use, burned on a wrong token, 120 s TTL), the worker cap
  that drops rather than queues, and the 405/421 paths.
- `src-tauri/src/photos.rs` — extension whitelist, sha256-derived path, atomic
  write, no traversal.
- Repo-wide: no `addEventListener`/`setInterval` imbalance in any file (no
  listener leaks), no `||`-inside-a-comparator bug at any `.sort(` site, no
  `unwrap()`/`expect()`/`panic!` outside `#[cfg(test)]` other than the two safe
  mutex locks (`commands.rs:83`, `share.rs:342`), and the EN/MY catalogs match
  on keys, placeholders and plural forms, with the only identical values being
  the two proper nouns (`lock.pinLabel`, `notes.markdown`).

## Why the existing gates miss these

None of the twelve is a type error or a lint error. Each needs two places held in
mind at once — a usage query against a `REFERENCES` clause with no action, an
effect against the state it renders while it runs, a page handler against the
convention thirty other handlers follow. The JS suite also structurally cannot see
F1: `budget.test.ts` runs on the mock driver, which does not enforce foreign
keys, so the "friendly check, then delete" path only fails against real SQLite —
and `src-tauri` has no `*.test.rs` pinning the repo-level usage queries.

Two cheap structural follow-ups, in order of value:

1. one `submit-guards.test.ts` row per handler in F5/F6, which turns the whole
   class into a compile-time convention rather than a reviewer's memory;
2. a test for F1 that asserts the usage query covers every table whose DDL
   references `wallets` or `expense_categories` — that can be generated from
   `schema.rs`, so it cannot drift when a new child table appears.
