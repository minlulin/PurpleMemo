# Purple Memo: Personal Workspace Gaps & Roadmap

**Purpose:** A practical, people-first roadmap for evolving Purple Memo into a dependable personal notebook and life workspace. This is a planning document; it does not authorize implementing every item at once.

**Product direction:** Purple Memo is for one person, works offline, and keeps the user's information under their control. The goal is not to copy every feature from a large productivity suite. The goal is to make it easy to capture, connect, find, remember, protect, and recover the things that matter in one person's life.

## 1. What the app already covers

The repository already includes a broad foundation:

- Notes with collections, archive/pin support, and full-text search over notes.
- Journal entries.
- Tasks and reminders, including recurring behavior.
- Contacts and contact details/tags.
- Memories and upcoming-date/birthday helpers.
- Photo gallery and photo references from some features.
- Personal finance and small-business tracking: wallets, income/expenses, budgets, loans, jobs, and payables.
- Habits, shopping lists, and an encrypted personal vault.
- App lock, auto-lock settings, database encryption, backup/restore, and an opt-in local-network dashboard share.
- A factory-reset implementation is being developed on the current work branch; run the full Rust and desktop checks before treating it as release-ready.

This is already more than a simple memo pad. The roadmap should improve connections and reliability across these features rather than add unrelated modules indiscriminately.

## 2. Product principles

1. **Capture before categorization.** A thought should be saveable in seconds; organization can happen later.
2. **Connections should be useful, not decorative.** A link must help the user move between related information and understand why it is connected.
3. **Offline-first and private by default.** No account, cloud service, or network dependency should be required for core use.
4. **Recovery is part of the feature.** Deletion, backups, restore, and reset need clear, tested outcomes.
5. **Small coherent releases.** Ship one vertical slice, validate it on the actual desktop platforms, then proceed.
6. **Keep the user's data portable.** The user should not be trapped in a proprietary archive.
7. **Avoid overbuilding.** Prefer search, backlinks, and a good daily view over a graph visualization or a complex project-management system unless real users need those later.

## 3. Priority summary

| Priority | Gap | Why it matters |
|---|---|---|
| P0 | Cross-feature connections and backlinks | Personal information becomes more useful when a note, person, task, memory, journal entry, or photo can be understood in context. |
| P0 | Encrypted, verifiable backups | The current ZIP backup is not encrypted as a whole; it excludes the database key, but ordinary exported rows and photos may still be readable. |
| P1 | Fast capture / Inbox | Captures ideas before they are forgotten, without requiring a decision about where they belong. |
| P1 | Global search | Search currently focuses on notes; users need to find information across the workspace. |
| P1 | Dependable reminders and a daily review | A reminder is only useful if delivery and overdue behavior are trustworthy. |
| P1 | Recovery from accidental edits/deletes | Confirmation prompts do not provide undo or restore. |
| P2 | Human-readable exports | Markdown, CSV, and vCard exports make personal data portable and useful outside Purple Memo. |
| P2 | Localization and accessibility | Improve everyday use for different languages, date conventions, vision, motor, and keyboard needs. |
| P2 | Recurring commitments view | Bring bills, repeating reminders, and tasks into one understandable upcoming view. |

Priorities are relative: do not begin a lower-priority feature while a higher-priority data-safety issue is unresolved.

## 4. Feature plan: connect information across Purple Memo

### 4.1 User outcome

A person can write a note about a repair, link it to the relevant contact, job, photos, and follow-up task, then open any of those items and see the relationship in both directions. The user can also link one note to another using a familiar, Obsidian-like workflow.

Example:

- A note: “Replace the kitchen water pump.”
- Linked contact: the repair shop.
- Linked job: the repair's amount, status, and warranty.
- Linked photos: before/after pictures.
- Linked task: “Call the shop next Tuesday.”
- Backlinks on each item show the other related items.

### 4.2 Recommended first version (MVP)

Build a **link picker plus backlinks**, not a visual graph first.

1. Add a small “Linked items” area to note detail/edit screens.
2. Let the user search for and link existing notes, tasks, contacts, memories, journal entries, and photos. Add other entity types only when their UI can display a meaningful link.
3. Display linked items as readable chips/cards with type, title/name, and a safe in-app open action.
4. Show backlinks: “Also linked from …” on linked items, especially notes and contacts.
5. Allow removing a relationship without deleting either item.
6. Handle deleted targets gracefully: remove or mark dangling relationships, never silently open the wrong item if IDs are reused.
7. Provide a creation shortcut from the picker only after the basic link workflow is reliable.

### 4.3 Note-to-note links

After the general link picker works:

- Support an explicit internal-link syntax such as `[[Note title]]` in note text.
- Resolve links to stable note IDs, not titles alone. Titles can change and multiple notes can share a title.
- Provide autocomplete/disambiguation in the editor, showing collection and a short excerpt for duplicate titles.
- Render resolved links as internal navigation; unresolved text remains visible and can be fixed later.
- Add backlinks to note detail and search results.
- Treat links as data, not trusted HTML. Rendering must use the app's internal route/navigation mechanism and must not permit an internal-link label to become an arbitrary external URL.
- Decide how links survive note rename, archive, deletion, restore, and backup import before shipping.

### 4.4 Data model and compatibility decisions

Use a stable, explicit relationship model. A reasonable candidate is a `links` table with source type/ID, target type/ID, relationship kind, and creation time, indexed in both directions and protected against exact duplicates. Because a relationship to several entity tables is polymorphic, ordinary foreign keys cannot cover every target; add application-level existence checks and transactional cleanup on deletion. Alternatively, use entity-specific link tables if they make integrity and migrations safer. Choose based on tested failure behavior, not just schema compactness.

Before implementation, decide and document:

- Canonical entity type names and which types are linkable in v1.
- Whether links are directed or conceptually mutual. For most “related item” links, store one canonical edge and query both directions for backlinks.
- Delete behavior: cascade the relationship, retain a tombstone, or mark it unresolved. Never let an old ID accidentally resolve to a newly created, unrelated item.
- Backup format behavior: links must be exported/imported with their referenced rows, and old backup formats must continue to import.
- Search behavior: decide whether linked entity names appear as search matches or only as context.
- Transaction boundaries: adding/removing a link and validating both endpoints must be atomic.

The app currently uses a baseline schema with a version stamp and relies heavily on backup import as its forward-compatibility seam. A new persistent table therefore requires an explicit schema/backup compatibility plan and migration tests; do not merely add a table to the UI.

### 4.5 Acceptance criteria for connections

- A user can link and unlink the supported entity types without risking deletion of the entities themselves.
- Links are visible from both ends and open the correct item.
- Duplicate titles are unambiguous; renaming a target does not break its links.
- Deleting/restoring/importing an item has defined, tested link behavior.
- A full backup round-trip preserves all links and their endpoints.
- Search, keyboard navigation, dark/light themes, and accessibility remain usable.
- No graph/network visualization is required for the MVP; backlinks and a link picker deliver the main value first.

## 5. Full gaps and staged delivery plan

### Phase 0 — Trust and safety foundations

**0.1 Encrypted backups and restore verification**

- Add optional password-protected encryption for the complete backup archive, not just vault entries.
- Keep key derivation and archive limits explicit; do not place a password or master key in logs or ordinary app state longer than necessary.
- Add a verification step that confirms archive integrity and lets the user inspect what will be restored before replacement.
- Test wrong password, corrupt archive, interrupted export/import, large libraries, and restore on a clean profile.
- Explain that backups stored on removable media or shared folders need protection too.

**0.2 Factory reset validation**

- Validate the current branch's factory reset end-to-end on supported desktop operating systems.
- Confirm database records, settings/PIN, vault rows, photo originals/thumbnails, and relevant local logs are removed; default seed data returns; fresh setup is offered on next load.
- Test failure paths (database reset failure, file deletion failure, app restart) and show actionable warnings rather than claiming a complete reset when remnants remain.
- Document that ordinary deletion is not forensic secure erasure and that OS backups may retain copies.

**0.3 Reminder reliability investigation**

- Verify whether reminders fire when the app is minimized, closed, the computer sleeps, or the OS denies notifications.
- If delivery requires the app to remain open, say so plainly and design a native scheduling mechanism before promising reminders.
- Add delivery state, snooze, overdue recovery, and recurring-date tests only after the platform behavior is understood.

**Exit gate:** backup safety and factory-reset behavior tested on the user's PC; reminder limitations understood and documented.

### Phase 1 — Personal knowledge connections (highest product priority)

1. Write the data-model and deletion/restore decision record from section 4.4.
2. Add the persistent link schema and its version/backup compatibility path.
3. Implement repository operations and unit tests with mock drivers.
4. Build the link picker for note-to-note and one or two high-value cross-feature types (recommended first: contacts and tasks).
5. Add backlinks and internal navigation.
6. Round-trip linked data through backup/restore and test deletion/rename/import edge cases.
7. Only then expand entity types to journal, memories, photos, jobs, and other domains.

**Ship criterion:** the user can connect a real-life note to relevant people and follow-up tasks, then find the same relationships from either side.

### Phase 2 — Fast capture and Inbox

- Add a fast “New memo” action available from the main app shell; evaluate a global desktop shortcut only if it works consistently and safely across platforms.
- Save to an Inbox by default, with no mandatory collection, tags, or date fields.
- Support quick conversion from Inbox item to note, task, journal entry, or reminder without losing the original text.
- Prevent duplicate creation on double-click/retry and preserve drafts after an app crash where feasible.

**Ship criterion:** a user can capture a thought in a few seconds and organize it later.

### Phase 3 — Global search and navigation

- Search notes, journal entries, tasks, contacts, memories, and other safe-to-index data from one place.
- Show result type, useful context, and a direct open action; support filters by type, date, archived state, and collection where applicable.
- Search linked names/aliases only where results remain understandable and privacy-preserving.
- Add keyboard shortcut and keyboard-only result selection.
- Test punctuation, Unicode/Burmese text, empty queries, large datasets, and query performance.

**Ship criterion:** a user can find an item without remembering which section contains it.

### Phase 4 — Daily review and commitments

- Add a focused “Today” view for due tasks, reminders, upcoming birthdays/memories, and optionally recurring financial commitments.
- Keep it a review surface, not a second place to maintain duplicate records.
- Add snooze/complete/reschedule actions with explicit feedback and a safe way to recover missed reminders.
- Avoid sending private note content in notification previews by default; make preview behavior configurable.

**Ship criterion:** the user can review today's commitments quickly and trust that actions update the source item.

### Phase 5 — Undo and history

- Introduce a Trash for user-visible deletions, with restore and permanent-delete actions.
- Define retention and storage limits so Trash does not grow without bounds.
- Consider note revision history separately; it has higher storage and privacy implications.
- Ensure factory reset bypasses Trash and clearly warns that it is permanent.

**Ship criterion:** routine deletion is recoverable, while reset remains an explicit irreversible operation.

### Phase 6 — Portability, localization, and polish

- Human-readable Markdown export for notes/journal, CSV for financial tables, and vCard for contacts.
- Add language/locale options, including Burmese UI copy and correct number/date formatting; keep stored dates locale-neutral.
- Improve text scaling, keyboard accessibility, screen-reader labels, contrast, and reduced-motion support.
- Add a lightweight first-run guide for PIN, database key, backup, and recovery.

**Ship criterion:** users can read and reuse their own data outside the app, and core flows remain comfortable across supported locales and assistive technologies.

## 6. How to work through the roadmap

For each feature, use the same release loop:

1. Write the user problem and the smallest useful outcome.
2. Record security, data-model, backup, and deletion implications before coding.
3. Implement one vertical slice (storage/repository → UI → tests), not a broad unfinished framework.
4. Add unit tests and boundary/failure tests; update backup format/schema compatibility tests where relevant.
5. Run the documented full local verification gate on the target PC and test the installed desktop app, not only a dev build.
6. Keep the feature behind a small release boundary; do not start the next phase until the current one is verified.
7. Update this roadmap with what shipped, what changed, and any limitation users should know.

## 7. Not planned by default

These should remain out of scope unless user research changes the product direction:

- Required accounts or cloud storage.
- Automatic cloud sync or multi-user collaboration.
- A complex project-management system.
- A graph visualization before link picker, backlinks, and search prove useful.
- AI features that upload or process private notes externally.

The app's offline, single-person identity is a strength. Preserve it while making local information more connected, findable, safe, and portable.
