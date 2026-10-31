//! Schema versions, the baseline DDL, and one migration per version step
//!
//!
//! 32 tables at `PRAGMA user_version = 6`: 31 regular tables + the
//! `notes_fts` FTS5 virtual table (its `_data`/`_idx`/`_docsize`/`_config`
//! shadow tables are FTS internals, not part of the 31).
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
pub const SCHEMA_VERSION: i64 = 6;

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

/// The full baseline DDL + seed data. Applied inside a single transaction by
/// `db::init_schema`, which then stamps `user_version`.
pub const BASELINE_SQL: &str = r#"
-- ============================================================
-- Notes & collections
-- ============================================================
CREATE TABLE collections (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE notes (
  id            INTEGER PRIMARY KEY,
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
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE income_categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE expense_categories (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE income_entries (
  id           INTEGER PRIMARY KEY,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  category_id  INTEGER NOT NULL REFERENCES income_categories(id),
  wallet_id    INTEGER NOT NULL REFERENCES wallets(id),
  entry_date   TEXT NOT NULL,
  note         TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL
);

CREATE TABLE expense_entries (
  id           INTEGER PRIMARY KEY,
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
  name       TEXT NOT NULL,
  phone      TEXT NOT NULL DEFAULT '',
  address    TEXT NOT NULL DEFAULT '',
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE jobs (
  id            INTEGER PRIMARY KEY,
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
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE shopping_items (
  id         INTEGER PRIMARY KEY,
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
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE habit_logs (
  id       INTEGER PRIMARY KEY,
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  done     INTEGER NOT NULL DEFAULT 1 CHECK (done IN (0, 1)),
  UNIQUE (habit_id, log_date)
);

CREATE TABLE tasks (
  id         INTEGER PRIMARY KEY,
  title      TEXT NOT NULL,
  due_date   TEXT,
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  repeat     TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE reminders (
  id         INTEGER PRIMARY KEY,
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
"#;
