# PurpleMemo — P1 Session 1: make the read path non-blocking, part 1 (`db_query` / `db_execute`) (PC agent session)

## Context

The Arena full review (2026-11-23) found **B3 (MEDIUM)**: the read path
runs synchronously on the main thread. `db_query`, `db_execute`,
`db_begin` / `commit` / `rollback` / `reset_txn`, `photo_read`,
`photo_delete`, `db_key_save` and the pairing status reads are all
non-`async` commands, which Tauri executes on the main thread. Only
`db_batch`, `photo_save`, backup/export and `factory_reset` were moved
to `spawn_blocking`. Every page's reads therefore serialize on the UI
thread; a slow FTS query or a large scan janks the app.

This is **P1, Session 1 of 2–3**. It converts exactly two commands —
`db_query` and `db_execute` — to `async` + `spawn_blocking`, following
the existing `db_batch` pattern. The transaction commands, the photo
reads, `db_key_save` and the pairing status reads are **out of scope**
for this session (Session 2, after this pattern is proven). B6 (single
connection) is accepted and is **not** in scope: do not introduce a
second connection or a read-only pool.

Verified against this tree before this prompt was written
(dev tip `6d8b599`): `db_query` is `src-tauri/src/commands.rs:180`,
`db_execute` is `:191`, both sync; `db_batch` (`:214`) is the
`async` + `spawn_blocking` pattern to follow.

## Rules

- One session, **one commit on dev**, then STOP and report. No merge, no
  version bump, no tag, no release, nothing published.
- The full gate (`npm run verify`) must be GREEN.
- **No behaviour change.** Same SQL allowlist enforcement
  (`reject_dangerous_statement`), same txn-flag guard, same error
  mapping, same return shapes. The renderer calls
  (`src/data/ipc.ts` / driver) stay byte-identical — invoking an
  `async` Tauri command from the renderer is transparent, so no
  renderer change is needed or wanted.
- **No device work in this session.** No APK build, no emulator, no
  phone test. The device proof for this change happens in the combined
  rebuild + test round after all remaining items are done (the owner
  runs it on his phone then).
- The IPC pin stays at **46** (`src/data/ipc.test.ts`): converting a
  command to `async` does not add or remove a command, so the pin does
  not move. Do not "fix" it.

## Fixes

1. **Convert `db_query` to `async` + `spawn_blocking`.**
   Follow the `db_batch` pattern in the same file: the `async` command
   body does the cheap argument validation, then moves the blocking
   work into `tauri::async_runtime::spawn_blocking`.
   - The `AppState.conn` mutex is locked **inside** the blocking
     closure, never held across an `.await`. The single connection
     still serializes every read and write, exactly as before —
     ordering is preserved by the mutex, not by the thread.
   - The allowlist check and the txn-flag guard keep their exact
     current semantics (a `db_query` that writes, or that tries to
     BEGIN/COMMIT around the txn flag, is refused exactly as today).
2. **Convert `db_execute` the same way**, same rules as item 1.
3. **Pin the new shape with tests.** Add or extend a Rust test that
   fails if either command regresses to a synchronous signature, and
   keep the existing `db_query`/`db_execute` behaviour tests green
   (including `db_query_cannot_commit_or_begin_around_the_txn_flag`
   and `db_query_refuses_statements_that_write` in `db.rs`). A test
   that only re-asserts the old behaviour is not enough — the
   async-ness itself must be pinned, so a future edit cannot silently
   move the read path back onto the main thread.

## Report

The commit sha, the gate's result line, what changed per command, the
new/updated tests, and any deviation — in the same format as the
biometric session reports.
