//! Baseline schema — the single source of table structure (§4).
//!
//! 29 tables at `PRAGMA user_version = 1`: 28 regular tables + the
//! `notes_fts` FTS5 virtual table (its `_data`/`_idx`/`_docsize`/`_config`
//! shadow tables are FTS internals, not part of the 29).
//!
//! No SQL migrations ever (§4): a future schema change ships as an old-version
//! backup export imported by the new version, so this baseline only ever runs
//! against a fresh, empty database.

/// The schema version stamped on the baseline.
pub const SCHEMA_VERSION: i64 = 1;

/// The full baseline DDL + seed data. Applied inside a single transaction by
/// `db::init_schema`, which then stamps `user_version`.
pub const BASELINE_SQL: &str = r#"
-- ============================================================
-- Notes & collections (§2.4)
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

-- FTS5 index over title/content/tags/folder (§2.4). Plain (non-external)
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

CREATE TRIGGER notes_fts_au AFTER UPDATE ON notes BEGIN
  UPDATE notes_fts
  SET title = new.title,
      content = new.content,
      tags = new.tags,
      folder = COALESCE((SELECT name FROM collections WHERE id = new.collection_id), '')
  WHERE rowid = new.id;
END;

-- ============================================================
-- Journal (§2.5)
-- ============================================================
CREATE TABLE journal_entries (
  id         INTEGER PRIMARY KEY,
  entry_date TEXT NOT NULL UNIQUE,
  content    TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ============================================================
-- Budget tracker (§2.1) — money is integer cents everywhere
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

-- Per-category monthly cap (§2.1); warnings at 80% / over, never blocks.
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
-- Business tracker (§2.2)
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
-- Loans (§2.3) — state (open/partial/overdue/closed) is derived, not stored
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
-- Shopping list (§2.6)
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
-- Personal (§2.7)
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
-- Gallery (§2.7) — files live under photos/<yyyy>/<mm>/<sha256>.<ext>
-- (§4); the DB keeps the relative path.
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
-- Vault (§5.3) — AES-256-GCM ciphertext; salt + IV per item (plain base64)
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
-- Settings (§2.8/§2.9, §5) — key/value: PIN hash, security question, theme…
-- ============================================================
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

-- ============================================================
-- Seed data (§2.1, §2.2): default wallets + seeded categories. One-time
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
