# Purple Memo — Codebase Audit Findings (2026-10-25)

**Scope:** full review of `src/` and `src-tauri/` on `dev` for wrong code,
missing pieces, hidden bugs and performance bottlenecks. Read-only: no code
was changed to produce this document. Tree state = end of plan Session D
(`npm run verify` green: 669 JS / 156 Rust tests, clippy `-D warnings`).

**Method:** pattern sweeps (TODO debt, swallowed catches, XSS sinks, loose
equality, type suppressions, listener/interval cleanup, sequential awaits,
`unwrap`/`expect`, date parsing, index keys) plus deep reads of the hot
paths: backup import, photo storage, global search, LAN share server,
reminder/share timers, notes payload, and the Session A–C tray/urgency code.

**Verdict:** unusually clean codebase — no TODO debt in first-party code, no
`as any`/`@ts-ignore` in app TS, no XSS sinks, dates consistently local,
every traced timer/listener cleaned up. Two real bugs, one significant
performance issue, one tray-related behavior to verify; everything else is
minor.

---

## 🟠 Bugs (actually wrong)

### 1. Dashboard "Snooze" buttons bypass i18n

- **Where:** `src/pages/DashboardPage.tsx:578` and `:632` render a bare
  English `Snooze`. The key `tasks.snooze` exists in EN + MY
  (`src/lib/i18n.ts:367`) and `src/pages/TasksPage.tsx:631` uses it.
- **Effect:** a Burmese user sees English only on the Dashboard — violates
  the project rule "every user-facing string in EN and MY", and the two
  pages disagree.
- **Fix:** replace both literals with `{t("tasks.snooze")}`.

### 2. Trash purge can fail forever, silently

- **Where:** `src/App.tsx:524` — `void trashRepo.purge().catch(() => {})`.
- **Effect:** every other swallowed error in the app has a documented safe
  direction; this one has no signal at all. If purge starts failing (locked
  file, disk error), Trash grows indefinitely and the user is told nothing —
  on an operation they explicitly expect to work.
- **Fix:** surface a one-shot toast (the existing notifyNote/toast channel)
  on purge failure; keep the operation best-effort.

### 3. Close can stall on a long DB batch

- **Where:** `src-tauri/src/lib.rs` — `close_to_tray_enabled` locks the
  connection mutex on the UI thread inside the window-event handler.
- **Effect:** a close landing mid-`db_batch` (large backup import) freezes
  the event loop until the batch finishes. No deadlock (commands take the
  lock per command), but a possible multi-second hang on close.
- **Acceptable as-is**; if it ever bites, read a cached toggle and re-check
  on a later close instead of locking on the UI thread.

---

## 🟡 Hidden behavior to verify

### 4. Reminder ticker throttling while trayed

- **Where:** `src/App.tsx:222` (30 s `setInterval`) + the new close-to-tray
  behavior (plan §B).
- **Effect:** Chromium throttles hidden-page timers (~1/min after 5 minutes
  hidden). While the window is hidden the 30 s poll may effectively run at
  60 s+, so "reminders keep firing" could mean "up to ~90 s late". This was
  already true for the *minimized* window; close-to-tray makes *hidden the
  app's normal state*, so it now matters much more.
- **Action:** §B.4 checklist item #4 should check reminder *latency*, not
  only arrival. If it bites: also tick on window-show/`visibilitychange`, or
  move the timer to Rust.

### 5. Midnight staleness (cosmetic)

- **Where:** `src/pages/DashboardPage.tsx` — `today` is computed per render
  with nothing forcing a render at 00:00.
- **Effect:** urgency badges and date labels stay stale past midnight until
  the next interaction. Self-heals; no data impact.

---

## 🟠 Performance bottlenecks

### 6. Whole-note corpus shipped over IPC on load (biggest win)

- **Where:** `src/lib/notes.ts:127` — `SELECT * FROM notes` returns full
  `content` for every note; called without a limit by
  `src/pages/NotesPage.tsx:477` (`includeArchived: true`) and by
  `src/pages/GalleryPage.tsx:173`, which only needs id/title for its link
  picker.
- **Effect:** every notebook body crosses the Tauri IPC as JSON on every
  load; cost grows linearly with years of markdown. The app's largest
  payload.
- **Fix:** list projection (title + snippet, or FTS snippet) for the
  sidebar; a title-only query for Gallery.

### 7. Dashboard does a full reload per click

- **Where:** `src/pages/DashboardPage.tsx:150` — one Complete / Reschedule /
  Snooze / Acknowledge re-runs ~10 queries plus the habit-progress pass;
  memories, warranties and receivable are refetched for a single-row change.
- **Effect:** tens of ms on local SQLite — waste, not a stall. Fix by
  reloading only the affected section, or accept and document.

### 8. Database file never shrinks

- **Where:** no `VACUUM` anywhere (WAL `checkpoint(TRUNCATE)` does run).
- **Effect:** trash purge deletes rows but the SQLCipher file only grows.
  Disk-only concern; free pages are reused.

### 9. Sequential loops on cold paths (noted, not flagged)

- `src/lib/vault.ts:369` — PBKDF2 derivation per item on password change.
- `src/lib/trash.ts:562`, `:756` — per-photo ref checks on restore/purge.
- Both are O(n) round trips on restore/migration paths only.

### 10. Share snapshot vs Dashboard skew (decision, not accident)

- **Where:** `src/lib/share.ts:262` still snapshots `dueTasks(today)` while
  the Dashboard now shows **all** open tasks.
- **Effect:** the phone view omits future-dated open tasks. Plan §A scoped
  share out deliberately — recorded here so it stays a decision.

---

## Missing

- **Settings i18n is partial:** section headings ("Notifications",
  "Vault", "Updates"), the preview-checkbox paragraph and update buttons in
  `src/pages/SettingsPage.tsx` are hardcoded English against the EN+MY rule
  (pre-existing; the tray plan only added keys for its own new strings).
- **No runtime error log:** only `boot-error.log` exists; failures after
  boot live in the console and vanish — no durable trace for bug reports.
- **Autostart on login** absent (deliberate, plan §B.2.8) and
  **notifications while the PC is off/asleep** impossible (documented).
  Listed for completeness, not as defects.
- **No page/component tests:** known tradeoff, documented in plan §A.5;
  UI acceptance is the §B.4 checklist + owner's installed check.

---

## Verified solid (checked, not assumed)

- **Dates:** all day math parses local (`…T00:00:00`); the UTC-shift bug
  class is absent; birthday math (`contacts.ts`) confirmed local.
- **Backup import:** zip-slip impossible — photo entries are only map keys;
  files are content-addressed by Rust under the strict grammar
  `photos/<yyyy>/<mm>/<64 hex>.<1–8 alnum>`, extension validated. Zip-bomb
  bounds (entry count, expanded bytes, photo count/size, manifest size) plus
  a real-byte recount after unzip; `PRAGMA foreign_keys` restored.
- **Photo storage:** `O_EXCL` temp + rename, hash verification of existing
  files, write lock closes the save/delete race.
- **Search:** FTS5 MATCH with quoted tokens and bound parameters — no user
  text reaches SQL as syntax; table/column names are contract-owned.
- **LAN share server:** network path never touches the DB, keyring or
  filesystem; AES-GCM key travels only in the URL fragment; bind is
  consent-token gated; 4 workers with a capacity rule; audit lines structurally
  cannot carry the key.
- **XSS surface:** no `innerHTML` / `eval` / `dangerouslySetInnerHTML` in
  first-party code; CSP `script-src 'self'`; navigation plugin pins
  same-origin.
- **`db_query`:** accepts webview SQL by design, but filters
  `PRAGMA KEY/REKEY`, `ATTACH/DETACH` server-side — the dangerous escapes
  are closed.
- **Timers/listeners:** every `setInterval`/`addEventListener` traced has
  cleanup; reminder/share ticker callbacks are memoized (`useCallback`/
  `useMemo`) so the 30 s timers are not re-created per render.
- **Rust:** no `unwrap`/`expect` in production code (locks recover via
  `into_inner`); `cargo clippy -D warnings` green.
- **Suppressions:** all `biome-ignore` comments carry reasons; vendored
  `_crypto` files are byte-identical package sources.

## Accepted risks (documented upstream, restated)

1. LAN share cannot authenticate the server — an active network attacker can
   replace the page and capture the fragment key (`share.rs` header docs).
2. `db_query` runs webview-supplied SQL inside the app's own trust boundary
   (mitigated by CSP + no XSS sinks + PRAGMA filtering).

## Suggested order for a fix pass

1. Finding 1 (Dashboard Snooze i18n) — two-line fix.
2. Finding 2 (silent trash purge) — one toast on failure.
3. Finding 6 (notes payload) — projection queries for Notes list + Gallery.
4. Finding 4 (throttling) — measure in the §B.4 installed check first.
