//! Schema versions, the baseline DDL, and one migration per version step
//!
//!
//! 39 tables at `PRAGMA user_version = 9`: 38 regular tables + the
//! `notes_fts` FTS5 virtual table (its `_data`/`_idx`/`_docsize`/`_config`
//! shadow tables are FTS internals, not part of the 38).
//!
//! Seven of the 38 are device-local sync storage (`sync_*`): the six from
//! [`MIGRATION_7_8`] that hold the durable outbox, tombstones, peer cursors and
//! the device identity of docs/ANDROID_SYNC_PROTOCOL.md §1.2/§5/§6/§10, plus
//! [`migration_8_9`]'s `sync_row_stamps` — the §4.2 stamp of the value each row
//! currently holds, which a snapshot must carry so §4's merge has an input.
//! They are deliberately absent from `BACKUP_TABLES`: §10.3 forbids device
//! state travelling with user data.
//!
//! **Migrations are forward-only and sequential.** `db::init_schema` reads
//! `user_version`, applies every step from there to [`SCHEMA_VERSION`] in
//! order, each in its own transaction that stamps the new version only after
//! the step succeeded, and fails closed on anything it does not understand: a
//! database newer than this build is refused without a single write, and so is
//! a gap in the step list.
//!
//! Adding a version means three edits, in this order: bump [`SCHEMA_VERSION`],
//! add the `MIGRATION_N_N+1` const below, and add it to `db::migration_step`.
//! The same change also goes into `BASELINE_SQL`, because a fresh install must
//! land on the current version in one step — a test asserts the two agree.

/// The schema version this build expects and stamps.
use std::sync::OnceLock;

pub const SCHEMA_VERSION: i64 = 9;

/// Relationships between notes, tasks and contacts.
///
/// Every constraint here is load-bearing, not decoration:
///
/// * `UNIQUE (kind, type_a, id_a, type_b, id_b)` makes a duplicate impossible
///   once the pair is canonical, so "link these" twice is one row, not two.
/// * The ordering CHECK stores each pair once, smaller endpoint first. Related
///   links are conceptually MUTUAL, so the reverse of a relationship is the
///   same relationship; without this the same pair could be stored twice, once
///   in each direction, and each side would show one and the other two.
/// * `CHECK (NOT (type_a = type_b AND id_a = id_b))` refuses a note linked to
///   itself.
/// * Neither endpoint carries a foreign key. The type pair is polymorphic, so
///   SQLite cannot express it, and a foreign key would break the agreed Trash
///   lifecycle: a link row is REMOVED with the entity and lives inside its
///   snapshot until restored. Application code owns endpoint
///   existence; `entityLinks.ts` checks both endpoints and inserts in one
///   statement so a ghost endpoint cannot be created.
pub const MIGRATION_2_3: &str = r#"
CREATE TABLE links (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'related' CHECK (kind IN ('related')),
  type_a     TEXT NOT NULL CHECK (type_a IN ('note', 'task', 'contact')),
  id_a       INTEGER NOT NULL CHECK (id_a > 0),
  type_b     TEXT NOT NULL CHECK (type_b IN ('note', 'task', 'contact')),
  id_b       INTEGER NOT NULL CHECK (id_b > 0),
  created_at TEXT NOT NULL,
  CHECK (NOT (type_a = type_b AND id_a = id_b)),
  CHECK (type_a < type_b OR (type_a = type_b AND id_a < id_b)),
  UNIQUE (kind, type_a, id_a, type_b, id_b)
);

-- Both directions are queried, so both are indexed: listing what a note is
-- related to is the same query as listing what is related to that note.
CREATE INDEX idx_links_a ON links(type_a, id_a);
CREATE INDEX idx_links_b ON links(type_b, id_b);
"#;

// Trash and recoverable deletion.
//
// A versioned snapshot Trash preserves child rows, links, and attachments
// atomically, and is the only design in which link rows can travel with the
// trashed entity.
//
// Trash tables store snapshots of entities that can be restored.
// Each snapshot contains the full state needed for recovery, and multiple
// snapshots of the same entity can exist (different deletion times).
//
// Restore uses snapshot data to recreate the entity and remaps ID collisions
// by allocating new IDs and updating all references atomically.
pub const MIGRATION_3_4: &str = r#"
-- Trash table stores snapshots of deletable entities
CREATE TABLE trash_items (
  id             INTEGER PRIMARY KEY,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('note', 'task', 'contact', 'memory', 'journal_entry')),
  entity_id      INTEGER NOT NULL CHECK (entity_id > 0),
  snapshot       TEXT NOT NULL CHECK (json_valid(snapshot)),
  deleted_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);

-- Index for efficient lookup by entity type/original ID
CREATE INDEX idx_trash_items_entity ON trash_items(entity_type, entity_id);
-- Index for efficient purge by date
CREATE INDEX idx_trash_items_deleted ON trash_items(deleted_at);
"#;

// Constraint and index repair.
//
// `photo_refs` was created without a uniqueness rule, and the gallery's
// `addRef` inserts blindly. The page happens to check first, so the UI cannot
// create a duplicate today — but a backup import, a restore, or a second
// caller can. Existing databases may already hold duplicates, so the step
// de-duplicates before adding the constraint; the surviving row is the oldest
// (lowest `id`), which is the one the user has been seeing first.
//
// `reminders` has never had an index, so the 30-second poll full-scanned it.
// The poll's predicate is `fired = 0 AND remind_at <= ?`, which is the order
// of the composite index too.
pub const MIGRATION_4_5: &str = r#"
DELETE FROM photo_refs
 WHERE id NOT IN (
   SELECT MIN(id) FROM photo_refs GROUP BY photo_id, entity_type, entity_id
 );

CREATE UNIQUE INDEX idx_photo_refs_unique
  ON photo_refs(photo_id, entity_type, entity_id);

CREATE INDEX idx_reminders_fired_at ON reminders(fired, remind_at);
"#;

/// Hot-path indexes and a narrower FTS maintenance trigger
/// (docs/AUDIT.md PERF-09 and SCHEMA-03).
///
/// Every index below answers a query the repository actually runs, in the
/// form it runs it:
///
/// * `idx_notes_browse` — the browse list's
///   `WHERE archived = 0 ORDER BY pinned DESC, updated_at DESC, id DESC`.
///   Without it SQLite materialises the whole table and sorts it.
/// * `idx_photos_created` — the gallery grid, newest first.
/// * `idx_memories_date` — the month feed and On-this-day scans.
/// * `idx_habit_logs_date` — the habit month grid and the dashboard tick.
/// * `idx_income_cat_date` / `idx_expense_cat_date` — per-category spend for a
///   month: the equality column first, then the range the summary filters on.
/// * `idx_jobs_shop` — receivables grouped by shop.
/// * `idx_payables_paid_due` — unpaid payables by due date.
/// * `idx_shopping_order` — a list's items in their stored order.
///
/// The trigger change matters because `notes_fts` was 2.2x the size of the
/// notes it indexes: `AFTER UPDATE ON notes` rewrote the FTS row for a pin,
/// an archive, or any other column the index does not even store.
/// `AFTER UPDATE OF title, content, tags, collection_id` fires only when one
/// of the indexed columns is actually in the UPDATE's SET list, which is
/// exactly when the FTS row can differ. Triggers cannot be altered, so the
/// old one is dropped and recreated with the same body.
pub const MIGRATION_5_6: &str = r#"
CREATE INDEX idx_notes_browse ON notes(archived, pinned DESC, updated_at DESC, id DESC);
CREATE INDEX idx_photos_created ON photos(created_at);
CREATE INDEX idx_memories_date ON memories(memory_date);
CREATE INDEX idx_habit_logs_date ON habit_logs(log_date);
CREATE INDEX idx_income_cat_date ON income_entries(category_id, entry_date);
CREATE INDEX idx_expense_cat_date ON expense_entries(category_id, entry_date);
CREATE INDEX idx_jobs_shop ON jobs(shop_id);
CREATE INDEX idx_payables_paid_due ON payables(paid, due_date);
CREATE INDEX idx_shopping_order ON shopping_items(list_id, sort_order);

DROP TRIGGER notes_fts_au;

CREATE TRIGGER notes_fts_au AFTER UPDATE OF title, content, tags, collection_id ON notes BEGIN
  UPDATE notes_fts
  SET title = new.title,
      content = new.content,
      tags = new.tags,
      folder = COALESCE((SELECT name FROM collections WHERE id = new.collection_id), '')
  WHERE rowid = new.id;
END;
"#;

/// Quick capture. The two conversions that create a
/// row (note, task) and the one that appends to today's journal entry all run
/// as one `driver.batch`, which is what makes a double-click produce exactly
/// one target.
///
/// `converted_type` / `converted_id` are HISTORICAL metadata: they record
/// which row a capture produced, so a retry returns that row instead of
/// creating a second one, and an audit can trace the capture. They survive a
/// later hard delete of the target, which is why they are not a foreign key.
pub const MIGRATION_1_2: &str = r#"
CREATE TABLE inbox_items (
  id             INTEGER PRIMARY KEY,
  -- Same whitespace rule as MIGRATION_1_2 — one-argument trim() strips spaces
  -- only, so "\n\t" would pass it. A test asserts the two definitions match.
  body           TEXT NOT NULL
                 CHECK (length(trim(body, char(9)||char(10)||char(11)||char(12)||char(13)||' ')) > 0),
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'converted', 'archived')),
  converted_type TEXT CHECK (converted_type IN ('note', 'task', 'journal')),
  converted_id   INTEGER,
  created_at     TEXT NOT NULL,
  CHECK (
    (status = 'converted' AND converted_type IS NOT NULL AND converted_id IS NOT NULL)
    OR
    (status <> 'converted' AND converted_type IS NULL AND converted_id IS NULL)
  )
);

-- The only query this table is asked at scale is "the open ones, newest
-- first", which is this index and nothing else.
CREATE INDEX idx_inbox_items_status ON inbox_items(status, id);
"#;

/// Cross-device identity for the 17 synced tables
/// (docs/ANDROID_DESIGN.md, "Cross-device UID contract").
///
/// Each row gets a UUID v4 the client that creates it mints locally, so an
/// offline phone and a desktop can both create records without coordination
/// and pair later without renumbering anything.
///
/// The column is added as NULLABLE, then backfilled, then given a UNIQUE
/// index. It is NOT `NOT NULL` like the contract asks, for one concrete
/// reason: SQLite refuses `ALTER TABLE ... ADD COLUMN` with UNIQUE, and it
/// refuses NOT NULL without a default — so the faithful shape needs the
/// 12-step table rebuild for all 17 tables, and a DROP TABLE on a parent
/// (`shopping_lists`, `habits`, `collections`) fires its children's
/// ON DELETE CASCADE the moment it runs. Rebuilding them to gain a constraint
/// would delete the data it was meant to protect. NULL is therefore permitted
/// by the schema and forbidden by the repositories: every create path supplies
/// a uid, and `uid.test.ts` / the repo tests pin it. The unique index still
/// gives what sync identity actually needs — no two rows share a uid.
///
/// The seeded wallets and categories are records too, so the baseline mints
/// their uids as well rather than leaving the five defaults NULL forever.
pub const UID_V4_SQL: &str = "lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random() % 4)), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6)))";

/// Schema v7, built from [`UID_TABLES`] so the table list and the DDL cannot
/// drift: three statements per table — add the column (NULLABLE, see the note
/// above), backfill every existing row with its own v4, then make duplicates
/// impossible.
///
/// Built once and cached (`OnceLock`, not `LazyLock`: the crate pins an MSRV
/// older than 1.80). Returned as `&'static str` because that is what
/// `db::migration_step` hands to the migration runner.
pub fn migration_6_7() -> &'static str {
    static SQL: OnceLock<String> = OnceLock::new();
    SQL.get_or_init(|| {
        UID_TABLES
            .iter()
            .map(|table| {
                format!(
                    "ALTER TABLE {table} ADD COLUMN uid TEXT;\n\
                     UPDATE {table} SET uid = {UID_V4_SQL} WHERE uid IS NULL;\n\
                     CREATE UNIQUE INDEX idx_{table}_uid ON {table}(uid);"
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    })
}

/// The 17 tables that carry a cross-device UID (the narrow sync core).
///
/// One list, not three copies: `MIGRATION_6_7`, the baseline's unique indexes
/// and the database tests that build pre-v7 fixtures all describe the same 17
/// tables, and a table missing from one of them would only show up as a sync
/// bug months later.
pub const UID_TABLES: [&str; 17] = [
    "collections",
    "notes",
    "tasks",
    "reminders",
    "wallets",
    "income_categories",
    "expense_categories",
    "income_entries",
    "expense_entries",
    "shops",
    "jobs",
    "loans",
    "habits",
    "habit_logs",
    "shopping_lists",
    "shopping_items",
    "vault_items",
];

/// Sync storage (docs/ANDROID_SYNC_PROTOCOL.md §1.2 device identity, §4.2
/// Lamport counter, §5 tombstones, §6.1–§6.2 durable outbox, §6.4–§6.5 per-peer
/// cursors and acks, §10 generation).
///
/// Every table here is DEVICE-LOCAL: it never enters a backup payload and is
/// never replicated (§10.3). That is why the six tables are absent from
/// `BACKUP_TABLES` while still being real tables of this schema.
///
/// The shape follows the clauses rather than the screens:
///
/// * `sync_state` is the one-row identity/clock row. `device_id` is minted once
///   per install by the same UUID expression as every synced row; a key-loss
///   wipe deletes the whole database, so the next boot is a first run and mints
///   a NEW id — a re-pair, never a reused identity (§1.2). `last_seq` is
///   durable separately from `sync_outbox` so pruning the outbox can never
///   rewind the operation sequence (§1.3).
/// * `sync_outbox` is one row per mutation, written in the SAME transaction as
///   the mutation (§6.1). `counter` is the Lamport stamp; `field_stamps` the
///   per-field stamps of §4.3; `payload` the field values.
/// * `sync_outbox_delivery` records which peer acknowledged which row — the
///   evidence §6.5 prunes on.
/// * `sync_tombstones` + `sync_tombstone_acks` are §5: a delete survives until
///   every known peer has acked it (§5.4). A cascaded child gets its OWN
///   tombstone (§5.2); the FK cascade must never be the only record.
/// * `sync_peers` holds the per-peer cursors (§6.4), the generation the peer
///   paired at (§10.2) and the revocation mark (§11.3).
///
/// `reminders.created_by_device_id` is the flagged §13.1 marker: nullable, and
/// nothing reads it until MinLulin decides who owns a reminder definition.
pub const MIGRATION_7_8: &str = r#"
CREATE TABLE sync_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  device_id        TEXT NOT NULL CHECK (length(device_id) = 36),
  data_generation  INTEGER NOT NULL DEFAULT 1 CHECK (data_generation > 0),
  lamport          INTEGER NOT NULL DEFAULT 0 CHECK (lamport >= 0),
  last_seq         INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  re_pair_required INTEGER NOT NULL DEFAULT 0 CHECK (re_pair_required IN (0, 1)),
  updated_at       TEXT NOT NULL
);

CREATE TABLE sync_outbox (
  id           INTEGER PRIMARY KEY,
  device_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL CHECK (seq > 0),
  op_id        TEXT NOT NULL UNIQUE,
  entity_table TEXT NOT NULL,
  entity_uid   TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('create', 'update', 'toggle', 'delete')),
  base_counter INTEGER NOT NULL DEFAULT 0 CHECK (base_counter >= 0),
  counter      INTEGER NOT NULL CHECK (counter > 0),
  field_stamps TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(field_stamps)),
  payload      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  created_at   TEXT NOT NULL,
  UNIQUE (device_id, seq)
);

CREATE INDEX idx_sync_outbox_seq ON sync_outbox(seq);
CREATE INDEX idx_sync_outbox_entity ON sync_outbox(entity_table, entity_uid);

CREATE TABLE sync_outbox_delivery (
  outbox_id INTEGER NOT NULL REFERENCES sync_outbox(id) ON DELETE CASCADE,
  peer_id   TEXT NOT NULL,
  acked_at  TEXT NOT NULL,
  PRIMARY KEY (outbox_id, peer_id)
);

CREATE TABLE sync_tombstones (
  id           INTEGER PRIMARY KEY,
  entity_table TEXT NOT NULL,
  entity_uid   TEXT NOT NULL,
  counter      INTEGER NOT NULL CHECK (counter > 0),
  device_id    TEXT NOT NULL,
  op_id        TEXT NOT NULL,
  deleted_at   TEXT NOT NULL,
  UNIQUE (entity_table, entity_uid)
);

CREATE INDEX idx_sync_tombstones_entity ON sync_tombstones(entity_table, entity_uid);

CREATE TABLE sync_tombstone_acks (
  tombstone_id INTEGER NOT NULL REFERENCES sync_tombstones(id) ON DELETE CASCADE,
  peer_id      TEXT NOT NULL,
  acked_at     TEXT NOT NULL,
  PRIMARY KEY (tombstone_id, peer_id)
);

CREATE TABLE sync_peers (
  device_id    TEXT PRIMARY KEY,
  pairing_id   TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  public_key   TEXT,
  generation   INTEGER NOT NULL,
  cursor_in    INTEGER NOT NULL DEFAULT 0 CHECK (cursor_in >= 0),
  cursor_out   INTEGER NOT NULL DEFAULT 0 CHECK (cursor_out >= 0),
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);

ALTER TABLE reminders ADD COLUMN created_by_device_id TEXT;

INSERT INTO sync_state (id, device_id, data_generation, lamport, last_seq, re_pair_required, updated_at)
SELECT 1, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random() % 4)), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), 1, 0, 0, 0, strftime('%Y-%m-%d', 'now', 'localtime')
WHERE NOT EXISTS (SELECT 1 FROM sync_state);
"#;

/// The six device-local sync tables, in dependency order (parents first).
///
/// One list for the database tests: the fixtures that build a pre-v8 database
/// strip exactly these, and the migrated-structure test compares exactly these.
/// A name missing from it would leave a table behind in a fixture and only
/// surface as a migration collision.
#[cfg(test)]
pub const SYNC_STORAGE_TABLES: [&str; 7] = [
    "sync_state",
    "sync_outbox",
    "sync_outbox_delivery",
    "sync_tombstones",
    "sync_tombstone_acks",
    "sync_peers",
    "sync_row_stamps",
];

/// The full baseline DDL + seed data. Applied inside a single transaction by
/// `db::init_schema`, which then stamps `user_version`.
/// Schema v8 → v9: `sync_row_stamps`, the stamp of the value each row holds.
///
/// §8.4's snapshot must be a read of the 17 tables "plus their tombstones", and
/// §9.5 merges a shared UID by comparing stamps — but the entity tables never
/// carried one: `sync_outbox` holds the stamps of *operations* and is pruned
/// once every live peer acks (§6.5), so a row delivered months ago has no
/// stamp left to send. This table is that missing durable copy: one row per
/// entity, written in the same batch as the mutation
/// (`store.ts::outboxStatements`) and backfilled here.
///
/// The backfill stamps every row that exists at migration time with this
/// device's current Lamport counter and `migration-8-9` as the operation id.
/// That is the honest reading: before this version the database has no
/// per-row history, so "as of v9" is the oldest stamp it can claim — and it is
/// older than any edit written afterwards. A row with no stamp row at all (a
/// fresh install's seeded wallets, say) reads as counter 0, which is the same
/// statement: pre-history.
pub fn migration_8_9() -> &'static str {
    static SQL: OnceLock<String> = OnceLock::new();
    SQL.get_or_init(|| {
        let backfill = UID_TABLES
            .iter()
            .map(|table| {
                format!(
                    "INSERT INTO sync_row_stamps (entity_table, entity_uid, counter, device_id, op_id, field_stamps, updated_at)\n\
                     SELECT '{table}', uid,\n\
                            (SELECT lamport FROM sync_state WHERE id = 1),\n\
                            (SELECT device_id FROM sync_state WHERE id = 1),\n\
                            'migration-8-9', '{{}}',\n\
                            strftime('%Y-%m-%dT%H:%M:%fZ', 'now')\n\
                     FROM {table} WHERE uid IS NOT NULL\n\
                     ON CONFLICT(entity_table, entity_uid) DO NOTHING;"
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        format!(
            "CREATE TABLE sync_row_stamps (\n\
  entity_table TEXT NOT NULL,\n\
  entity_uid   TEXT NOT NULL,\n\
  counter      INTEGER NOT NULL CHECK (counter >= 0),\n\
  device_id    TEXT NOT NULL,\n\
  op_id        TEXT NOT NULL,\n\
  field_stamps TEXT NOT NULL DEFAULT '{{}}' CHECK (json_valid(field_stamps)),\n\
  updated_at   TEXT NOT NULL,\n\
  PRIMARY KEY (entity_table, entity_uid)\n\
);\n\n\
CREATE INDEX idx_sync_row_stamps_uid ON sync_row_stamps(entity_uid);\n\n\
{backfill}"
        )
    })
}

pub const BASELINE_SQL: &str = r#"
-- ============================================================
-- Notes & collections
-- ============================================================
CREATE TABLE collections (
  id         INTEGER PRIMARY KEY,
  uid        TEXT,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE notes (
  id            INTEGER PRIMARY KEY,
  uid           TEXT,
  title         TEXT NOT NULL DEFAULT '',
  content       TEXT NOT NULL DEFAULT '',
  tags          TEXT NOT NULL DEFAULT '',
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  pinned        INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived      INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

-- FTS5 index over title/content/tags/folder. Plain (non-external)
-- FTS table kept in sync by triggers; folder is the collection name at
-- index time. SQLite 3.51 supports plain INSERT/UPDATE/DELETE statements
-- directly on fts5 tables, so the triggers use those instead of the legacy
-- special 'delete' INSERT command (which errors on this SQLCipher build).
CREATE VIRTUAL TABLE notes_fts USING fts5(title, content, tags, folder);

CREATE TRIGGER notes_fts_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(rowid, title, content, tags, folder)
  VALUES (
    new.id,
    new.title,
    new.content,
    new.tags,
    COALESCE((SELECT name FROM collections WHERE id = new.collection_id), '')
  );
END;

CREATE TRIGGER notes_fts_ad AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE rowid = old.id;
END;

-- Only the indexed columns: a pin, an archive or any other non-FTS column
-- used to rewrite this row anyway, which left `notes_fts` at 2.2x the size of
-- the notes it indexes (docs/AUDIT.md SCHEMA-03; see MIGRATION_5_6).
CREATE TRIGGER notes_fts_au AFTER UPDATE OF title, content, tags, collection_id ON notes BEGIN
  UPDATE notes_fts
  SET title = new.title,
      content = new.content,
      tags = new.tags,
      folder = COALESCE((SELECT name FROM collections WHERE id = new.collection_id), '')
  WHERE rowid = new.id;
END;

-- ============================================================
-- Quick capture inbox — see MIGRATION_1_2 above for the
-- rationale. The DDL is repeated rather than shared: `BASELINE_SQL` is one
-- raw string, and a test asserts the migrated structure matches this one.
-- ============================================================
CREATE TABLE inbox_items (
  id             INTEGER PRIMARY KEY,
  -- Same whitespace rule as MIGRATION_1_2 — one-argument trim() strips spaces
  -- only, so "\n\t" would pass it. A test asserts the two definitions match.
  body           TEXT NOT NULL
                 CHECK (length(trim(body, char(9)||char(10)||char(11)||char(12)||char(13)||' ')) > 0),
  status         TEXT NOT NULL DEFAULT 'open'
                 CHECK (status IN ('open', 'converted', 'archived')),
  converted_type TEXT CHECK (converted_type IN ('note', 'task', 'journal')),
  converted_id   INTEGER,
  created_at     TEXT NOT NULL,
  CHECK (
    (status = 'converted' AND converted_type IS NOT NULL AND converted_id IS NOT NULL)
    OR
    (status <> 'converted' AND converted_type IS NULL AND converted_id IS NULL)
  )
);

CREATE INDEX idx_inbox_items_status ON inbox_items(status, id);

-- ============================================================
-- Relationships — see MIGRATION_2_3 above for the
-- reasoning behind every constraint. Repeated rather than shared:
-- BASELINE_SQL is one raw string, and a test asserts the migrated
-- structure matches this one.
-- ============================================================
CREATE TABLE links (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL DEFAULT 'related' CHECK (kind IN ('related')),
  type_a     TEXT NOT NULL CHECK (type_a IN ('note', 'task', 'contact')),
  id_a       INTEGER NOT NULL CHECK (id_a > 0),
  type_b     TEXT NOT NULL CHECK (type_b IN ('note', 'task', 'contact')),
  id_b       INTEGER NOT NULL CHECK (id_b > 0),
  created_at TEXT NOT NULL,
  CHECK (NOT (type_a = type_b AND id_a = id_b)),
  CHECK (type_a < type_b OR (type_a = type_b AND id_a < id_b)),
  UNIQUE (kind, type_a, id_a, type_b, id_b)
);

CREATE INDEX idx_links_a ON links(type_a, id_a);
CREATE INDEX idx_links_b ON links(type_b, id_b);

-- ============================================================
-- Journal
-- ============================================================
CREATE TABLE journal_entries (
  id         INTEGER PRIMARY KEY,
  entry_date TEXT NOT NULL UNIQUE,
  content    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================
-- Budget tracker — money is integer cents everywhere
-- ============================================================
CREATE TABLE wallets (
  id         INTEGER PRIMARY KEY,
  uid        TEXT,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE income_categories (
  id         INTEGER PRIMARY KEY,
  uid        TEXT,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE expense_categories (
  id         INTEGER PRIMARY KEY,
  uid        TEXT,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE income_entries (
  id           INTEGER PRIMARY KEY,
  uid          TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  category_id  INTEGER NOT NULL REFERENCES income_categories(id),
  wallet_id    INTEGER NOT NULL REFERENCES wallets(id),
  entry_date   TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

CREATE TABLE expense_entries (
  id           INTEGER PRIMARY KEY,
  uid          TEXT,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  category_id  INTEGER NOT NULL REFERENCES expense_categories(id),
  wallet_id    INTEGER NOT NULL REFERENCES wallets(id),
  entry_date   TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

-- Per-category monthly cap ; warnings at 80% / over, never blocks.
CREATE TABLE expense_limits (
  id          INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL UNIQUE REFERENCES expense_categories(id) ON DELETE CASCADE,
  limit_cents INTEGER NOT NULL CHECK (limit_cents > 0)
);

CREATE TABLE recurring_payments (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  amount_cents  INTEGER NOT NULL CHECK (amount_cents > 0),
  category_id   INTEGER REFERENCES expense_categories(id),
  wallet_id     INTEGER REFERENCES wallets(id),
  frequency     TEXT NOT NULL CHECK (frequency IN ('weekly', 'monthly', 'quarterly', 'yearly')),
  next_due_date TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at    TEXT NOT NULL
);

-- ============================================================
-- Business tracker
-- ============================================================
CREATE TABLE shops (
  id         INTEGER PRIMARY KEY,
  uid        TEXT,
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL DEFAULT '',
  address    TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY,
  uid           TEXT,
  title         TEXT NOT NULL,
  shop_id       INTEGER REFERENCES shops(id),
  total_cents   INTEGER NOT NULL CHECK (total_cents > 0),
  paid_cents    INTEGER NOT NULL DEFAULT 0 CHECK (paid_cents >= 0),
  job_date      TEXT NOT NULL,
  warranty_days INTEGER,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paid')),
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);

CREATE TABLE payables (
  id           INTEGER PRIMARY KEY,
  title        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  shop_id      INTEGER REFERENCES shops(id),
  due_date     TEXT,
  paid         INTEGER NOT NULL DEFAULT 0 CHECK (paid IN (0, 1)),
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

-- ============================================================
-- Loans — state (open/partial/overdue/closed) is derived, not stored
-- ============================================================
CREATE TABLE loans (
  id           INTEGER PRIMARY KEY,
  uid          TEXT,
  counterparty TEXT NOT NULL,
  direction    TEXT NOT NULL CHECK (direction IN ('lent', 'borrowed')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  repaid_cents INTEGER NOT NULL DEFAULT 0 CHECK (repaid_cents >= 0),
  due_date     TEXT,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

-- ============================================================
-- Shopping list
-- ============================================================
CREATE TABLE shopping_lists (
  id         INTEGER PRIMARY KEY,
  uid        TEXT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE shopping_items (
  id         INTEGER PRIMARY KEY,
  uid        TEXT,
  list_id    INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  text       TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);

-- ============================================================
-- Personal
-- ============================================================
CREATE TABLE habits (
  id         INTEGER PRIMARY KEY,
  uid        TEXT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE habit_logs (
  id       INTEGER PRIMARY KEY,
  uid      TEXT,
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  done     INTEGER NOT NULL DEFAULT 1 CHECK (done IN (0, 1)),
  UNIQUE (habit_id, log_date)
);

CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY,
  uid        TEXT,
  title      TEXT NOT NULL,
  due_date   TEXT,
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  repeat     TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE reminders (
  id         INTEGER PRIMARY KEY,
  uid        TEXT,
  title      TEXT NOT NULL,
  remind_at  TEXT NOT NULL,
  repeat     TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
  note       TEXT NOT NULL DEFAULT '',
  fired      INTEGER NOT NULL DEFAULT 0 CHECK (fired IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE contacts (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  address    TEXT NOT NULL DEFAULT '',
  birthday   TEXT,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE contact_channels (
  id         INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('phone', 'email', 'other')),
  value      TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE contact_tags (
  id         INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  UNIQUE (contact_id, tag)
);

CREATE TABLE memories (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  memory_date TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

-- ============================================================
-- Gallery — files live under photos/<yyyy>/<mm>/<sha256>.<ext>
-- ; the DB keeps the relative path.
-- ============================================================
CREATE TABLE photos (
  id         INTEGER PRIMARY KEY,
  rel_path   TEXT NOT NULL UNIQUE,
  sha256     TEXT NOT NULL,
  ext        TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  taken_date TEXT,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE photo_refs (
  id          INTEGER PRIMARY KEY,
  photo_id    INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('note', 'memory', 'job')),
  entity_id   INTEGER NOT NULL
);

-- ============================================================
-- Vault — AES-256-GCM ciphertext; salt + IV per item (plain base64)
-- ============================================================
CREATE TABLE vault_items (
  id         INTEGER PRIMARY KEY,
  uid        TEXT,
  title      TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  salt       TEXT NOT NULL,
  iv         TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================
-- Trash and recoverable deletion. A versioned snapshot Trash so
-- child rows, links and attachments survive until a restore. Snapshot data
-- is JSON stored as TEXT; entities are restored with ID-collision remapping
-- handled by the application layer.
-- ============================================================
CREATE TABLE trash_items (
  id             INTEGER PRIMARY KEY,
  entity_type    TEXT NOT NULL CHECK (entity_type IN ('note', 'task', 'contact', 'memory', 'journal_entry')),
  entity_id      INTEGER NOT NULL CHECK (entity_id > 0),
  snapshot       TEXT NOT NULL CHECK (json_valid(snapshot)),
  deleted_at     TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_trash_items_entity ON trash_items(entity_type, entity_id);
CREATE INDEX idx_trash_items_deleted ON trash_items(deleted_at);

-- ============================================================
-- Settings — key/value: PIN hash, security question, theme…
-- ============================================================
-- `value` must stay NOT NULL: the backup import uses a deliberately failing
-- INSERT of a NULL value into this column as its foreign-key canary
-- (`backup.ts`, docs/AUDIT.md SCHEMA-04), and a default or a dropped NOT NULL
-- would turn that canary into a silent no-op. A Rust test pins the flag.
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============================================================
-- Indexes on hot paths
-- ============================================================
CREATE INDEX idx_income_entries_date ON income_entries(entry_date);
CREATE INDEX idx_expense_entries_date ON expense_entries(entry_date);
CREATE INDEX idx_recurring_next_due ON recurring_payments(next_due_date);
CREATE INDEX idx_jobs_status ON jobs(status);
CREATE INDEX idx_loans_due ON loans(due_date);
CREATE INDEX idx_habit_logs_habit ON habit_logs(habit_id);
CREATE INDEX idx_tasks_due ON tasks(due_date);
CREATE INDEX idx_photo_refs_entity ON photo_refs(entity_type, entity_id);
CREATE INDEX idx_notes_collection ON notes(collection_id);
CREATE INDEX idx_contact_channels_contact ON contact_channels(contact_id);
CREATE INDEX idx_reminders_fired_at ON reminders(fired, remind_at);
-- A photo may be linked to one entity once: see MIGRATION_4_5.
CREATE UNIQUE INDEX idx_photo_refs_unique
  ON photo_refs(photo_id, entity_type, entity_id);

-- The audit's hot-path set: see MIGRATION_5_6 for what each one serves.
CREATE INDEX idx_notes_browse ON notes(archived, pinned DESC, updated_at DESC, id DESC);
CREATE INDEX idx_photos_created ON photos(created_at);
CREATE INDEX idx_memories_date ON memories(memory_date);
CREATE INDEX idx_habit_logs_date ON habit_logs(log_date);
CREATE INDEX idx_income_cat_date ON income_entries(category_id, entry_date);
CREATE INDEX idx_expense_cat_date ON expense_entries(category_id, entry_date);
CREATE INDEX idx_jobs_shop ON jobs(shop_id);
CREATE INDEX idx_payables_paid_due ON payables(paid, due_date);
CREATE INDEX idx_shopping_order ON shopping_items(list_id, sort_order);


-- Cross-device identity (docs/ANDROID_DESIGN.md, UID contract). One UUID v4
-- per synced row, minted by the client that creates it; NULL only for rows a
-- test fixture inserted without one, which is why the column is nullable
-- rather than NOT NULL — SQLite cannot add a NOT NULL column to a populated
-- table without rebuilding it (see MIGRATION_6_7).
CREATE UNIQUE INDEX idx_collections_uid ON collections(uid);
CREATE UNIQUE INDEX idx_notes_uid ON notes(uid);
CREATE UNIQUE INDEX idx_tasks_uid ON tasks(uid);
CREATE UNIQUE INDEX idx_reminders_uid ON reminders(uid);
CREATE UNIQUE INDEX idx_wallets_uid ON wallets(uid);
CREATE UNIQUE INDEX idx_income_categories_uid ON income_categories(uid);
CREATE UNIQUE INDEX idx_expense_categories_uid ON expense_categories(uid);
CREATE UNIQUE INDEX idx_income_entries_uid ON income_entries(uid);
CREATE UNIQUE INDEX idx_expense_entries_uid ON expense_entries(uid);
CREATE UNIQUE INDEX idx_shops_uid ON shops(uid);
CREATE UNIQUE INDEX idx_jobs_uid ON jobs(uid);
CREATE UNIQUE INDEX idx_loans_uid ON loans(uid);
CREATE UNIQUE INDEX idx_habits_uid ON habits(uid);
CREATE UNIQUE INDEX idx_habit_logs_uid ON habit_logs(uid);
CREATE UNIQUE INDEX idx_shopping_lists_uid ON shopping_lists(uid);
CREATE UNIQUE INDEX idx_shopping_items_uid ON shopping_items(uid);
CREATE UNIQUE INDEX idx_vault_items_uid ON vault_items(uid);

-- ============================================================
-- Sync storage — see MIGRATION_7_8 for why each column exists. Repeated
-- rather than shared because BASELINE_SQL is one raw string; a test asserts
-- the migrated structure matches this one.
-- ============================================================
CREATE TABLE sync_state (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  device_id        TEXT NOT NULL CHECK (length(device_id) = 36),
  data_generation  INTEGER NOT NULL DEFAULT 1 CHECK (data_generation > 0),
  lamport          INTEGER NOT NULL DEFAULT 0 CHECK (lamport >= 0),
  last_seq         INTEGER NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  re_pair_required INTEGER NOT NULL DEFAULT 0 CHECK (re_pair_required IN (0, 1)),
  updated_at       TEXT NOT NULL
);

CREATE TABLE sync_outbox (
  id           INTEGER PRIMARY KEY,
  device_id    TEXT NOT NULL,
  seq          INTEGER NOT NULL CHECK (seq > 0),
  op_id        TEXT NOT NULL UNIQUE,
  entity_table TEXT NOT NULL,
  entity_uid   TEXT NOT NULL,
  op           TEXT NOT NULL CHECK (op IN ('create', 'update', 'toggle', 'delete')),
  base_counter INTEGER NOT NULL DEFAULT 0 CHECK (base_counter >= 0),
  counter      INTEGER NOT NULL CHECK (counter > 0),
  field_stamps TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(field_stamps)),
  payload      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload)),
  created_at   TEXT NOT NULL,
  UNIQUE (device_id, seq)
);

CREATE INDEX idx_sync_outbox_seq ON sync_outbox(seq);
CREATE INDEX idx_sync_outbox_entity ON sync_outbox(entity_table, entity_uid);

CREATE TABLE sync_outbox_delivery (
  outbox_id INTEGER NOT NULL REFERENCES sync_outbox(id) ON DELETE CASCADE,
  peer_id   TEXT NOT NULL,
  acked_at  TEXT NOT NULL,
  PRIMARY KEY (outbox_id, peer_id)
);

CREATE TABLE sync_tombstones (
  id           INTEGER PRIMARY KEY,
  entity_table TEXT NOT NULL,
  entity_uid   TEXT NOT NULL,
  counter      INTEGER NOT NULL CHECK (counter > 0),
  device_id    TEXT NOT NULL,
  op_id        TEXT NOT NULL,
  deleted_at   TEXT NOT NULL,
  UNIQUE (entity_table, entity_uid)
);

CREATE INDEX idx_sync_tombstones_entity ON sync_tombstones(entity_table, entity_uid);

CREATE TABLE sync_tombstone_acks (
  tombstone_id INTEGER NOT NULL REFERENCES sync_tombstones(id) ON DELETE CASCADE,
  peer_id      TEXT NOT NULL,
  acked_at     TEXT NOT NULL,
  PRIMARY KEY (tombstone_id, peer_id)
);

CREATE TABLE sync_peers (
  device_id    TEXT PRIMARY KEY,
  pairing_id   TEXT,
  display_name TEXT NOT NULL DEFAULT '',
  public_key   TEXT,
  generation   INTEGER NOT NULL,
  cursor_in    INTEGER NOT NULL DEFAULT 0 CHECK (cursor_in >= 0),
  cursor_out   INTEGER NOT NULL DEFAULT 0 CHECK (cursor_out >= 0),
  revoked_at   TEXT,
  created_at   TEXT NOT NULL
);

-- v9: the stamp of the value a row currently holds (§4.2). `sync_outbox`
-- carries the stamps of operations and is pruned once every peer acks (§6.5),
-- so a snapshot needs this durable per-row copy. Counter 0 means pre-history:
-- the row predates any stamp this database can claim.
CREATE TABLE sync_row_stamps (
  entity_table TEXT NOT NULL,
  entity_uid   TEXT NOT NULL,
  counter      INTEGER NOT NULL CHECK (counter >= 0),
  device_id    TEXT NOT NULL,
  op_id        TEXT NOT NULL,
  field_stamps TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(field_stamps)),
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (entity_table, entity_uid)
);

CREATE INDEX idx_sync_row_stamps_uid ON sync_row_stamps(entity_uid);

-- The flagged §13.1 marker: nullable and unread until that decision is made.
ALTER TABLE reminders ADD COLUMN created_by_device_id TEXT;

INSERT INTO sync_state (id, device_id, data_generation, lamport, last_seq, re_pair_required, updated_at)
SELECT 1, lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random() % 4)), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))), 1, 0, 0, 0, strftime('%Y-%m-%d', 'now', 'localtime')
WHERE NOT EXISTS (SELECT 1 FROM sync_state);

-- ============================================================
-- Seed data : default wallets + seeded categories. One-time
-- baseline seeds only — user deletions stick, nothing re-seeds later.
-- ============================================================
INSERT INTO wallets (name, created_at) VALUES
  ('Cash',       strftime('%Y-%m-%d', 'now', 'localtime')),
  ('Kpay',       strftime('%Y-%m-%d', 'now', 'localtime')),
  ('Wave Money', strftime('%Y-%m-%d', 'now', 'localtime')),
  ('CB Pay',     strftime('%Y-%m-%d', 'now', 'localtime')),
  ('Banking',    strftime('%Y-%m-%d', 'now', 'localtime'));

INSERT INTO expense_categories (name, created_at) VALUES
  ('Food',      strftime('%Y-%m-%d', 'now', 'localtime')),
  ('Transport', strftime('%Y-%m-%d', 'now', 'localtime')),
  ('Rent',      strftime('%Y-%m-%d', 'now', 'localtime')),
  ('Health',    strftime('%Y-%m-%d', 'now', 'localtime')),
  ('Education', strftime('%Y-%m-%d', 'now', 'localtime')),
  ('Bills',     strftime('%Y-%m-%d', 'now', 'localtime')),
  ('Other',     strftime('%Y-%m-%d', 'now', 'localtime'));

INSERT INTO income_categories (name, created_at) VALUES
  ('Business', strftime('%Y-%m-%d', 'now', 'localtime')),
  ('Salary',   strftime('%Y-%m-%d', 'now', 'localtime')),
  ('Gift',     strftime('%Y-%m-%d', 'now', 'localtime')),
  ('Other',    strftime('%Y-%m-%d', 'now', 'localtime'));

-- Seeded rows are records: give them the identity every synced row carries
-- (the same UUID v4 expression MIGRATION_6_7 backfills with).
UPDATE wallets SET uid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random() % 4)), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) WHERE uid IS NULL;
UPDATE expense_categories SET uid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random() % 4)), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) WHERE uid IS NULL;
UPDATE income_categories SET uid = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)), 2) || '-' || substr('89ab', 1 + (abs(random() % 4)), 1) || substr(hex(randomblob(2)), 2) || '-' || hex(randomblob(6))) WHERE uid IS NULL;
"#;
