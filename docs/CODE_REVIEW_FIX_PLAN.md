# Code Review Fix Plan

> **Source:** Code-level review conducted 2026-10-16.  
> **Scope:** All source files under `src/` and `src-tauri/src/`.  
> **Status legend:** 🔴 High · 🟡 Medium · 🟢 Low

Issues are listed in priority order. Each entry records the exact change
needed so any session can pick one up cold.

---

## FIX-01 🔴 — Mutex poisoning leaves the app permanently wedged

**Files:** [`src-tauri/src/commands.rs`](../src-tauri/src/commands.rs) (line 58–63)

### Problem

`lock_conn` maps a `PoisonError` to a static error string and returns `Err`.
Because `Mutex::lock` returns a `PoisonError` whenever a thread panicked
while holding the guard, every subsequent command fails with
`"database mutex poisoned"` and there is no path back except restarting the
app. SQLite connections are not inherently broken by a panic in the caller —
the cursor is closed and the connection is intact.

### Current code

```rust
fn lock_conn(state: &AppState) -> CmdResult<MutexGuard<'_, Connection>> {
    state.conn.lock().map_err(|_| "database mutex poisoned".to_string())
}
```

### Fix

Recover the inner guard instead of refusing it. The data inside the mutex
is the rusqlite `Connection`; it is not in an inconsistent state after a
panic in one of the commands.

```rust
fn lock_conn(state: &AppState) -> CmdResult<MutexGuard<'_, Connection>> {
    // Recover from a poisoned mutex: a panic in any command drops the guard
    // atomically, leaving the Connection in a clean state. Refusing all future
    // commands (the previous behaviour) was more harmful than the panic itself.
    Ok(state.conn.lock().unwrap_or_else(|e| e.into_inner()))
}
```

Apply the same pattern to the three `lock()` calls in
[`src-tauri/src/share.rs`](../src-tauri/src/share.rs) (`ShareState::lock`,
`ShareState::consent_lock`, and the snapshot lock in `publish`).

### Test to add (Rust)

```rust
#[test]
fn poisoned_db_mutex_recovers() {
    // Simulate what happens after a command panics mid-execution.
    let mutex = std::sync::Mutex::new(42u32);
    let _ = std::panic::catch_unwind(|| {
        let _guard = mutex.lock().unwrap();
        panic!("simulated panic");
    });
    // The mutex is poisoned; recovery yields the inner value.
    let val = mutex.lock().unwrap_or_else(|e| e.into_inner());
    assert_eq!(*val, 42);
}
```

---

## FIX-02 🔴 — `batch()` silently double-runs `reject_dangerous_statement`

**File:** [`src-tauri/src/db.rs`](../src-tauri/src/db.rs) (lines 564–586)

### Problem

`batch()` validates every statement up front, then calls `execute()` per
statement. `execute()` also calls `reject_dangerous_statement`. If `execute`
is ever changed to skip the guard (as a performance optimisation), the
pre-check in `batch` silently becomes the only barrier — and callers of
`execute` lose their protection. The duplication also makes reading
harder: it is unclear which guard is load-bearing.

### Fix

Extract a private `execute_inner` that skips the guard; keep `execute` as the
public, guarded entry point. `batch` pre-validates and then calls
`execute_inner`.

```rust
/// Run a single write statement **without** the statement guard.
/// Only `batch` (which pre-validates the whole list) and tests may use this.
fn execute_inner(
    conn: &Connection,
    sql: &str,
    params: &[JsonValue],
) -> Result<ExecuteOutcome, String> {
    let params = json_params(params)?;
    let rows_affected = conn
        .execute(sql, rusqlite::params_from_iter(params.iter()))
        .map_err(|e| format!("execute failed: {e}\nSQL: {sql}"))?;
    Ok(ExecuteOutcome {
        rows_affected: rows_affected as u64,
        last_insert_rowid: conn.last_insert_rowid(),
    })
}

/// Run a single write statement (guarded). Public API.
pub fn execute(
    conn: &Connection,
    sql: &str,
    params: &[JsonValue],
) -> Result<ExecuteOutcome, String> {
    reject_dangerous_statement(sql)?;
    execute_inner(conn, sql, params)
}

pub fn batch(conn: &Connection, statements: &[BatchStatement]) -> Result<(), String> {
    for (idx, stmt) in statements.iter().enumerate() {
        reject_dangerous_statement(&stmt.sql)
            .map_err(|e| format!("batch statement {idx} rejected: {e}"))?;
    }
    conn.execute_batch("BEGIN")
        .map_err(|e| format!("batch begin failed: {e}"))?;
    for (idx, stmt) in statements.iter().enumerate() {
        if let Err(e) = execute_inner(conn, &stmt.sql, &stmt.params) {  // ← changed
            return Err(format!(
                "{rollback_note}: {e}",
                rollback_note = rollback_after_failure(conn, &format!("statement {idx}"))
            ));
        }
    }
    // ... commit unchanged
}
```

No new tests needed — the existing guard tests already cover `execute` and
`batch` independently.

---

## FIX-03 🟡 — `createShareTicker` missing `inFlight` guard

**File:** [`src/lib/session.ts`](../src/lib/session.ts)

### Problem

`createReminderTicker` has an `inFlight` guard so concurrent ticks are
no-ops. `createShareTicker` does not. If `ports.status()` or `ports.publish()`
are slow and the interval fires again, the `wasRunning` flag can be read
by the newer tick mid-flight of the older one, causing a spurious
"stopped" note on the wrong tick.

### Fix

```typescript
export function createShareTicker(ports: ShareTickPorts): () => Promise<void> {
  let wasRunning = false;
  let inFlight = false;                          // ← add
  return async () => {
    if (inFlight) return;                        // ← add
    inFlight = true;                             // ← add
    try {
      const info = await ports.status();
      if (ports.isCancelled()) return;
      if (!info.running) {
        if (wasRunning && info.note) ports.onNote(info.note);
        wasRunning = false;
        return;
      }
      wasRunning = true;
      await ports.publish();
    } catch {
      // best-effort — see function doc
    } finally {
      inFlight = false;                          // ← add
    }
  };
}
```

### Test to add (`src/lib/share.test.ts`)

```typescript
test("concurrent ticks do not double-fire onNote", async () => {
  // … set up a slow status() that resolves after 20 ms, trigger tick twice
  // before the first resolves, assert onNote called at most once.
});
```

---

## FIX-04 🟡 — Missing indexes on hot foreign-key columns

**File:** [`src-tauri/src/schema.rs`](../src-tauri/src/schema.rs)

### Problem

Two columns that are frequently used as filter/join keys have no index:

| Column | Table | Query shape |
|---|---|---|
| `notes.collection_id` | `notes` | `SELECT … FROM notes WHERE collection_id = ?` |
| `contact_channels.contact_id` | `contact_channels` | `SELECT … FROM contact_channels WHERE contact_id = ?` |

Both are currently full-table scans. At small row counts this is
imperceptible; it becomes visible as the user accumulates data.

### Fix

Add two lines to the index block at the bottom of `BASELINE_SQL`:

```sql
-- ============================================================
-- Indexes on hot paths
-- ============================================================
CREATE INDEX idx_income_entries_date   ON income_entries(entry_date);
CREATE INDEX idx_expense_entries_date  ON expense_entries(entry_date);
CREATE INDEX idx_recurring_next_due    ON recurring_payments(next_due_date);
CREATE INDEX idx_jobs_status           ON jobs(status);
CREATE INDEX idx_loans_due             ON loans(due_date);
CREATE INDEX idx_habit_logs_habit      ON habit_logs(habit_id);
CREATE INDEX idx_tasks_due             ON tasks(due_date);
CREATE INDEX idx_photo_refs_entity     ON photo_refs(entity_type, entity_id);
-- NEW:
CREATE INDEX idx_notes_collection      ON notes(collection_id);
CREATE INDEX idx_contact_channels_contact ON contact_channels(contact_id);
```

> **Note:** Because the schema has no migrations, these indexes will only
> exist in databases created after this change. Existing databases are
> unaffected (which is intentional per the "no migrations ever" policy in
> §4 of PLAN.md). The performance gap closes naturally as users export +
> re-import their data.

### Test to add (Rust, in `db.rs` test block)

```rust
#[test]
fn expected_indexes_exist() {
    let (_dir, conn) = open_baseline("indexes");
    for name in [
        "idx_notes_collection",
        "idx_contact_channels_contact",
    ] {
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='index' AND name=?",
                [name],
                |r| r.get(0),
            )
            .expect("index query");
        assert_eq!(count, 1, "index {name} must exist in the baseline schema");
    }
}
```

---

## FIX-05 🟡 — `backup.ts` FK pragma not restored on catastrophic failure

**File:** [`src/lib/backup.ts`](../src/lib/backup.ts)

### Problem

```typescript
await driver.execute("PRAGMA foreign_keys = OFF");
try {
  await driver.batch(statements);
} finally {
  await driver.execute("PRAGMA foreign_keys = ON");  // can throw
}
```

If `driver.execute("PRAGMA foreign_keys = ON")` in the `finally` block
throws (e.g., the connection died during the batch), the exception from
`finally` silently swallows the original batch error, and the FK state is
left `OFF` for the rest of the session. Subsequent writes that violate
FK constraints will succeed silently.

### Fix

Wrap the restore in its own try/catch so the original error propagates:

```typescript
await driver.execute("PRAGMA foreign_keys = OFF");
try {
  await driver.batch(statements);
} finally {
  await driver.execute("PRAGMA foreign_keys = ON").catch(() => {
    // Best-effort: FK restore failing is logged here but must not mask
    // the batch error (or the import success) that the caller needs to see.
    console.error("[backup] failed to restore foreign_keys = ON after import");
  });
}
```

### Test to add (`src/lib/backup.test.ts`)

```typescript
test("FK is restored even when batch throws", async () => {
  // Use a mock driver whose batch() rejects; verify execute("PRAGMA foreign_keys = ON")
  // is still called, and that the original batch error propagates.
});
```

---

## FIX-06 🟡 — `timestamp_utc()` algorithm untested on specific known dates

**File:** [`src-tauri/src/lib.rs`](../src-tauri/src/lib.rs) (lines 441–462)

### Problem

The hand-rolled RFC 3339 formatter (days-from-civil algorithm) is tested
only for shape (length, format characters, range checks). Epoch, year
boundaries, and leap years are not pinned against known-correct values.

### Fix

Add specific regression anchors to the existing
`key_export_log_tests` module (or a new `timestamp_tests` module):

```rust
#[cfg(test)]
mod timestamp_tests {
    use super::timestamp_utc;

    /// The function is not easily injectable with a custom epoch, so we
    /// test by round-tripping the current timestamp through the shape check
    /// AND pin two static values via a helper that takes seconds directly.
    fn from_secs(secs: u64) -> String {
        // Temporarily set via a test helper; requires extracting the core
        // date math into `fn format_timestamp_utc(secs: u64) -> String`.
        // See refactor note below.
        todo!()
    }

    #[test]
    fn unix_epoch() {
        assert_eq!(from_secs(0), "1970-01-01T00:00:00Z");
    }

    #[test]
    fn year_2021_new_year() {
        // 2021-01-01T00:00:00Z = 1609459200
        assert_eq!(from_secs(1609459200), "2021-01-01T00:00:00Z");
    }

    #[test]
    fn leap_day_2024() {
        // 2024-02-29T12:00:00Z = 1709208000
        assert_eq!(from_secs(1709208000), "2024-02-29T12:00:00Z");
    }
}
```

**Required refactor:** extract the date-math body into
`fn format_timestamp_utc(secs: u64) -> String` and have `timestamp_utc`
call `SystemTime::now()` and pass the result to it. This makes the
algorithm unit-testable in isolation without a real clock.

---

## FIX-07 🟢 — Duplicate `bytes_to_hex` in `db.rs` and `photos.rs`

**Files:**
- [`src-tauri/src/db.rs`](../src-tauri/src/db.rs) line 224
- [`src-tauri/src/photos.rs`](../src-tauri/src/photos.rs) line 58 (inline)

### Fix

Move to `lib.rs` as `pub(crate) fn bytes_to_hex(bytes: &[u8]) -> String`
and call it from both sites. No test needed — the function is already
exercised by the key-mint and photo-save tests.

```rust
// lib.rs (add to pub(crate) utilities section)
pub(crate) fn bytes_to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
```

```rust
// db.rs — replace the local copy:
use crate::bytes_to_hex;

// photos.rs — replace the inline loop:
let hash: String = bytes_to_hex(digest.as_slice());
```

---

## FIX-08 🟢 — Dead code in `verifyPin` (`undefined` guards on Uint8Array)

**File:** [`src/lib/crypto.ts`](../src/lib/crypto.ts)

### Problem

```typescript
for (let i = 0; i < hash.length; i++) {
  const h = hash[i];
  const e = expected[i];
  if (h === undefined || e === undefined) return false;  // dead — length is equal
  diff |= h ^ e;
}
```

`Uint8Array` indexing within bounds always returns a `number`, never
`undefined`. Since `hash.length === expected.length` is verified on the
line above the loop, the guards can never trigger. TypeScript nonetheless
infers the type as `number | undefined` (typed array index signature),
hence the guards passing lint. They create a false impression that the
code defends against an edge case it actually cannot reach.

### Fix

```typescript
// Both arrays have the same verified length; Uint8Array indexing within
// bounds always returns number — no undefined check needed.
for (let i = 0; i < hash.length; i++) {
  diff |= (hash[i] as number) ^ (expected[i] as number);
}
```

---

## FIX-09 🟢 — `lock_conn` error text is an implementation detail

**File:** [`src-tauri/src/commands.rs`](../src-tauri/src/commands.rs) line 62

After FIX-01 this path becomes unreachable for poison. The message should
nonetheless be user-facing if it ever surfaces (e.g., a platform-level
mutex failure).

### Fix

```rust
// Before:
.map_err(|_| "database mutex poisoned".to_string())

// After (only relevant if the recovery in FIX-01 is not applied):
.map_err(|_| "database is temporarily unavailable — restart Purple Memo".to_string())
```

Apply FIX-01 first; this becomes a belt-and-suspenders cleanup.

---

## FIX-10 🟢 — `db_commit` flag stuck on failure, no documented recovery sequence

**File:** [`src-tauri/src/commands.rs`](../src-tauri/src/commands.rs) lines 127–135)

### Problem

When `db_commit` fails, `txn_open` stays `true` so the caller can still
roll back. This is intentional, but if `db_rollback` subsequently also
fails (dead connection), `txn_open` remains `true` for the rest of the
session and every future `db_batch` is blocked. There is no escape hatch
and no documentation of the expected recovery sequence.

### Fix

1. Add a `db_reset_txn` command that clears the flag unconditionally —
   gated behind a comment explaining it is a last-resort break-glass:

   ```rust
   /// Clear the manual-transaction flag without touching the DB.
   ///
   /// Break-glass only: use this if `db_commit` AND `db_rollback` both
   /// failed (e.g., connection died) and the flag is stuck, which would
   /// block every future `db_batch`. A lost transaction means the rows
   /// from the last `db_begin` are gone; the caller is responsible for
   /// re-reading and reconciling state.
   #[tauri::command]
   pub fn db_reset_txn(state: State<'_, AppState>) -> CmdResult<()> {
       state.txn_open.store(false, Ordering::SeqCst);
       Ok(())
   }
   ```

2. Document the recovery contract in the `db_commit` doc comment:
   > On failure the open flag stays set so the caller may still call
   > `db_rollback`. If rollback also fails, call `db_reset_txn` to
   > clear the flag; the uncommitted rows are lost.

3. Register the new command in [`lib.rs`](../src-tauri/src/lib.rs):
   ```rust
   commands::db_reset_txn,
   ```

4. Expose it in the `DataDriver` interface in
   [`src/data/driver.ts`](../src/data/driver.ts):
   ```typescript
   resetTxn(): Promise<void>;
   // implementation: () => invoke("db_reset_txn")
   ```

---

## Implementation Order

| # | Fix | Effort | Risk |
|---|---|---|---|
| FIX-01 | Mutex poison recovery | Small | Low — recovery is safe for SQLite |
| FIX-02 | `execute_inner` split | Small | Low — pure refactor |
| FIX-03 | Share ticker `inFlight` guard | Tiny | None |
| FIX-04 | Schema indexes | Tiny (2 SQL lines) | None — new DBs only |
| FIX-05 | FK pragma restore | Tiny | None |
| FIX-06 | `timestamp_utc` refactor + tests | Medium | Low — test-only behaviour change |
| FIX-07 | Deduplicate `bytes_to_hex` | Small | None |
| FIX-08 | Dead `undefined` guards in `verifyPin` | Tiny | None |
| FIX-09 | Error message wording | Trivial | None |
| FIX-10 | `db_reset_txn` break-glass | Small | Low — new command, additive |

Recommended sequencing: **FIX-01 → FIX-02 → FIX-03 → FIX-05** in one
sitting (all Rust/TS guard fixes), then **FIX-04 + FIX-07 + FIX-08 + FIX-09**
as a cleanup pass, then **FIX-06 + FIX-10** as standalone tasks.

