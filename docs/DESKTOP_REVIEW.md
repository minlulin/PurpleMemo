# Desktop review

Reviewed: 2026-11-19
Subject: the desktop side of the app — the Tauri backend in `src-tauri/src/` and
the desktop shell.
Scope: boot, tray and close-to-tray, the lifecycle barrier, the IPC command
surface, the database and key lifecycle, factory reset, the pre-import safety
copy, file writes, the pairing listener's state, and the desktop UI paths
(`src/App.tsx`, `src/pages/SettingsPage.tsx`, `src/components/PairingPanel.tsx`,
`src/data/driver.ts`, `src/lib/settings.ts`, `src/lib/appLock.ts`,
`src/lib/drafts.ts`, `src/lib/backup.ts`, `src/lib/update.ts`).

This is a review record. Findings are kept with the mechanism that produces
them, so each can be verified or dismissed by reading the code it names. D1 and
D2 were fixed in follow-up changes; the rest are open, each with a suggested
fix. The Android companion is out of scope.

**Method:** static review of the code, plus a read of the earlier
full-repository audit for the areas it already closed. Nothing was built or
run for this review: no Rust build, no `cargo test`, no app launch, no UI
interaction. Findings that describe runtime behaviour are reasoned from lock
scope, thread context and flag ordering, not observed.

## Verdict

The desktop core is in unusually good shape. Boot ordering (interrupted-reset
recovery before any key work, mint-once, undo-own-database-before-discarding
the key), the key-export/restore path, atomic file writes, the reset engine's
"key last" ordering and its durable marker, the import exclusion window, and
the photo path grammar are all deliberate, commented and pinned by tests.

The residue is at the edges: one hot-path lock taken on the wrong thread, one
guard that starts later than the rule it implements, one statement channel
that escapes a barrier it claims to respect, and a set of UI/i18n loose ends.
None of them threatens data at rest; two of them are user-visible.

| ID | Severity | Area | Finding | Status |
|----|----------|------|---------|--------|
| D1 | Medium | Tray | The window-close handler takes the database connection lock on the event-loop thread | Fixed |
| D2 | Medium-low | Reset | Closing during a factory reset hides a terminal session instead of exiting | Fixed |
| D3 | Medium-low (latent) | DB guard | `db_query` can write, and writes bypass the lifecycle barrier | Open |
| D4 | Low | Settings | A failed update check also says "No newer release is published yet." | Open |
| D5 | Low | Pairing | The pairing panel polls once per second forever after its code is dead | Open |
| D6 | Low | i18n | The Burmese locale covers only part of the desktop surface | Open |

## D1 — Medium — The close handler takes the database lock on the event-loop thread

**Fixed in the change that added this review.** The finding is kept here with
its mechanism and its fix, so the reason the flag is a mirror and not a query
is written down.

`lib.rs` registered `watch_close_to_tray` on the main window, and
`close_to_tray_enabled` answered "should this close hide or quit?" by locking
`AppState.conn` and running `SELECT value FROM settings WHERE key =
'close_to_tray'` — on every close.

Window events are dispatched by the event loop, so the handler runs on the
loop thread and must not block. The connection mutex is held for whole
operations:

- `commands::db_batch` holds the guard across every statement of a batch, and
  the import path replays up to `MAX_BACKUP_ROWS` of them in one call;
- `commands::backup_safety_copy` holds it across `PRAGMA wal_checkpoint` **and**
  `fs::copy` of the database file.

Clicking the window's close button during an import or a pre-import safety
copy therefore stalled the main thread until the batch or the copy finished:
no repaint, no tray menu, no dialog. At best the close was merely late; the
user's reasonable reading was that the app had hung.

**Fix.** The decision is now made from memory, never from the database:

- `CLOSE_TO_TRAY` is an `AtomicBool` seeded ON, so the fail-safe default
  (missing row, unreadable row, failed boot) is unchanged and needs no
  migration;
- `refresh_close_to_tray(conn)` publishes the stored row into that mirror, and
  runs at boot, after a backup import (which replaces the `settings` table the
  row lives in), and — via the new `close_to_tray_set` command — whenever the
  Settings toggle persists a new value;
- `close_to_tray_enabled` reads the mirror only, and still consults
  `reset_terminal` first.

"Read fresh on every close" became "published before the next close": every
path that can change the row now publishes it, so flipping the toggle in
Settings still applies to the very next close without a restart, which is the
property the original query existed for.

## D2 — Medium-low — Closing during a factory reset hides a terminal session

`db::close_connection_for_reset` empties `AppState.conn` early in the reset
engine, but `reset_terminal` is stored only after `run_factory_reset` returns.
In between — deleting the photo tree, the safety copies and the logs, which on
a large library is not instant — `close_to_tray_enabled` finds `conn` empty
and takes the default-on branch, i.e. **hide**.

So the reset result screen can end up behind a hidden window. The next launch
does not start fresh either: the single-instance handler raises the hidden
window onto the reset result, which makes that screen's "close Purple Memo and
start it yourself" guidance false for the launch.

This is the failure the `reset_terminal` flag exists to prevent (D6 in the
code's own notes); the guard simply starts too late.

**Fixed in a follow-up change.** The terminal flag is now raised immediately
after the durable marker is written, before the barrier and before the engine.
The marker is the honest boundary: once it lands the reset can no longer be
abandoned — an engine failure still leaves the marker, and the next boot's
recovery pass finishes the job — so the session is terminal from that point and
closing quits. A marker that could not be written still returns before the flag
is raised, so that session keeps ordinary close-to-tray, which is the rule the
flag has always been scoped to; the old placement, after the engine, was the
only window where the rule was false. A source pin in `commands.rs` holds the
order (marker → terminal → barrier → engine) and the single store.

## D3 — Medium-low, latent — `db_query` can write, and writes bypass the lifecycle barrier

`commands::db_query` takes only `lock_conn`; the module documentation says
reads "are not writers and do not admit". But `db::query_rows` applies the
same allowlist guard as the writers, and that allowlist admits `INSERT`,
`UPDATE`, `DELETE` and `WITH`. A statement sent to `db_query` therefore
executes with no lifecycle ticket — including while an import's exclusion
window is open and while a reset is draining writers.

No app code writes through `query` today (every `driver.query` under
`src/lib` is a `SELECT`), so this is a hole in a defence rather than a live
defect. It still contradicts the invariant the barrier documents ("every
WRITER … passes through the barrier"), and a future repository method that
writes via `query` would silently land inside the import window — exactly the
failure E5 exists to prevent. Same class as the earlier audit's A5: a guard
that claims more than it enforces.

**Fix.** Prefer precision over vocabulary: prepare the statement and refuse it
when `sqlite3_stmt_readonly` is false. That closes `WITH … DELETE` and every
future spelling of a write, instead of enumerating keywords again. Giving
`db_query` the same `admit()` call would additionally make the barrier uniform
at the command boundary.

## D4 — Low — A failed update check also claims no release is published

`SettingsPage.tsx` sets `updateChecked` in a `finally`, so it is set on
failure too, and the render shows "No newer release is published yet."
whenever `updateChecked && update === null && !updateDone`. A network error
therefore produces an error banner *and* an unrelated positive claim directly
below it.

**Fix.** Set `updateChecked` only on success, or make it a tri-state
(`clean` / `failed`).

## D5 — Low — The pairing panel polls forever after its code is dead

`PairingPanel.tsx` starts a one-second tick whenever a pairing id exists and
never stops it on a terminal phase. After the code expires, locks out, or the
listener is stopped (including by hiding to the tray), the tick keeps issuing
`pairing_status` IPC calls and taking the listener lock for as long as the
Settings page is open.

**Fix.** Stop the interval when the panel's phase is `expired`, `locked` or
`closed`; keep ticking for `used` while the offer has not expired, because a
phone can still be staged behind a spent code.

## D6 — Low — The Burmese locale covers only part of the desktop surface

`LOCALES` is `["en", "my"]`, and Settings mixes translated strings with
literal English: the section labels, "Lock after idle", "Current PIN",
"Change PIN", "Vault", "Encryption key export", "Pair a phone", "Updates",
"About", "No settings match …", and the messages produced by the PIN change,
key export and update handlers. Everything Rust originates is English-only as
well: the tray items, the boot-failure dialogs, and every error string returned
from a command. A Burmese user sees both languages on one page.

**Fix.** Route the remaining Settings copy through the message table, and make
the tray menu and boot dialogs read their labels from the same source (they are
built in Rust, so this needs either a small label table passed in from the
frontend or a Rust-side copy of the few strings).

## Improvements

1. **Backup memory is the largest desktop spike.** `readBackupData` issues
   `SELECT *` for 31 tables, then `JSON.stringify`s them, zips them and
   optionally seals the archive — a documented ~740 MB peak. Streaming each
   table's JSON into the archive, or moving the archive build into Rust behind
   the existing raw-IPC channel, would remove most of it.
2. **The safety copy no longer needs the connection lock for the copy itself.**
   `backup_safety_copy` opens the exclusion window first, so every ordinary
   writer is already refused; only the checkpoint/order needs the lock. Moving
   the `fs::copy` outside the guard removes a multi-hundred-millisecond stall
   from the connection. Do it after D3, so the copy is genuinely writer-free.
3. **Idle auto-lock has no re-check when the window comes back.** The clock is
   a 15-second interval compared against `performance.now()`, and nothing
   re-evaluates idle on focus or visibility restoration. A wall-clock baseline
   plus a check when the window becomes visible again covers sleep/resume and
   throttled background timers cheaply.
4. **The renderer trust boundary deserves one native confirmation.** The
   key-export command writes the master key to any path the renderer names.
   That is the documented decision in docs/RELEASE.md ("Renderer trust
   boundary"), but a native confirmation inside Rust before the write would
   make the path unreachable from a compromised renderer without changing any
   happy-path behaviour.
5. **One dead IPC surface.** `external_links::open_external_url` is registered
   on desktop and always returns an error, because the desktop uses the opener
   plugin. Either fall back to the opener in Rust or stop registering it there.

## Reviewed and found solid

Recorded so the next pass does not redo the work:

- **Boot** (`lib.rs::boot`): interrupted reset finished before any key work;
  minting allowed only with no database; a failed first run removes the
  provably-new database before discarding the key; boot failures reported
  through typed classes rather than message matching; the retry path reloads
  the window instead of leaving a screen whose commands all failed.
- **Watchdog** (`arm_watchdog` / `retire_watchdog`): one named wait state at a
  time, and the exit decision shares a lock with retirement, so a recovered
  session cannot be killed by a timer that outlived its dialog.
- **Key lifecycle** (`db.rs`): verify-before-use; a non-creating open for the
  restore probe; restore proves the key against the database before storing
  it; export writes an `O_EXCL`/`O_NOFOLLOW` temp and renames, and records a
  retained temp as its own disclosure.
- **Reset** (`reset.rs`): durable marker before the first deletion; listeners
  stopped first and the key deleted last; an aborting failure stops the run;
  every component reported separately.
- **Safety copy** (`safety_copy.rs`): one symlink/junction policy at every
  level, special files refused rather than skipped, every copied file flushed,
  and a unique destination so a second import cannot overwrite the first copy.
- **File writes** (`file_write.rs`): atomic temp-and-rename, empty payloads and
  directory destinations refused, unambiguous percent-encoding for a path in a
  header.
- **Photo paths** (`photos.rs`): content-addressed, strict grammar, traversal
  refusal, derived thumbnails, one mutex over saves and deletes.
- **Pairing listener state**: a window is bound to its pairing id, a lock bumps
  an epoch before reaping so a start in flight cannot bind behind the lock
  screen, and `pairing_close` resolves only once the port refuses connections.
- **Shell** (`App.tsx`): the lock shell's fail-closed classification
  (`classifyPin`, `shellStage`), drafts tied to the row's `updated_at` so a
  stale draft is dropped rather than resurrected, the reminder poll living in
  the shell, and the terminal reset screen outranking every other stage.
