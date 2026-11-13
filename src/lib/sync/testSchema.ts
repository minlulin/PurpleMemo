/**
 * The fixture a sync test runs on: the Stage 1 tables, the tables the Trash
 * delete path reads, Budget's two, and the real sync storage.
 *
 * The sync DDL is sliced out of `src-tauri/src/schema.rs` rather than retyped,
 * for the reason `store.test.ts` gives: a copy here would let the test and the
 * app disagree about the schema the repositories actually write into.
 *
 * Since Stage 1's recording, a repository write commits its outbox op in the
 * same batch (§6.1) — so any test that exercises a mutating repository method
 * against real SQLite needs these tables, even when the test is about
 * something else entirely.
 *
 * Two statements of the real v9 block are deliberately not applied:
 *
 *  * `ALTER TABLE reminders ADD COLUMN created_by_device_id` — a fixture that
 *    cares about that column declares it, and a fixture that has no
 *    `reminders` table must not be forced to grow one;
 *  * the seeded identity `INSERT` — replaced by a device id the caller names,
 *    so a two-device test can give each store its own (§4.2's tie-break).
 */
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  BatchStatement,
  DataDriver,
  ExecuteOutcome,
  Queryable,
} from "../../data/driver.ts";

const SCHEMA_RS = readFileSync(
  new URL("../../../src-tauri/src/schema.rs", import.meta.url),
  "utf8",
);

/** The device id a fixture is stamped under when the caller does not choose. */
export const FIXTURE_DEVICE_ID = "11111111-1111-4111-8111-111111111111";

/**
 * The Stage 1 tables, the tables the Trash delete path reads, and Budget's two.
 *
 * `reminders.created_by_device_id` is declared here because the v9 baseline
 * block's `ALTER TABLE` is skipped — this fixture cares about that column, so
 * it states the column.
 */
export const STAGE_ONE_FIXTURE = `
CREATE TABLE collections (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  title TEXT NOT NULL,
  due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  title TEXT NOT NULL,
  remind_at TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly', 'monthly')),
  note TEXT NOT NULL DEFAULT '',
  fired INTEGER NOT NULL DEFAULT 0 CHECK (fired IN (0, 1)),
  created_at TEXT NOT NULL,
  created_by_device_id TEXT
);
CREATE TABLE shopping_lists (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE shopping_items (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE habits (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE habit_logs (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  habit_id INTEGER NOT NULL REFERENCES habits(id) ON DELETE CASCADE,
  log_date TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 1 CHECK (done IN (0, 1)),
  UNIQUE (habit_id, log_date)
);
CREATE TABLE wallets (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE expense_categories (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE expense_entries (
  id INTEGER PRIMARY KEY,
  uid TEXT,
  amount_cents INTEGER NOT NULL,
  category_id INTEGER NOT NULL REFERENCES expense_categories(id),
  wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  entry_date TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE links (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'related',
  type_a TEXT NOT NULL,
  id_a INTEGER NOT NULL,
  type_b TEXT NOT NULL,
  id_b INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE photo_refs (
  id INTEGER PRIMARY KEY,
  photo_id INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL
);
CREATE TABLE inbox_items (
  id INTEGER PRIMARY KEY,
  converted_type TEXT,
  converted_id INTEGER
);
CREATE TABLE trash_items (
  id INTEGER PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id INTEGER NOT NULL CHECK (entity_id > 0),
  snapshot TEXT NOT NULL CHECK (json_valid(snapshot)),
  deleted_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- The real schema gives every synced table a UNIQUE uid (schema.rs's per-table
-- indexes); a snapshot's upsert targets exactly that constraint.
CREATE UNIQUE INDEX idx_collections_uid ON collections(uid);
CREATE UNIQUE INDEX idx_notes_uid ON notes(uid);
CREATE UNIQUE INDEX idx_tasks_uid ON tasks(uid);
CREATE UNIQUE INDEX idx_reminders_uid ON reminders(uid);
CREATE UNIQUE INDEX idx_shopping_lists_uid ON shopping_lists(uid);
CREATE UNIQUE INDEX idx_shopping_items_uid ON shopping_items(uid);
CREATE UNIQUE INDEX idx_habits_uid ON habits(uid);
CREATE UNIQUE INDEX idx_habit_logs_uid ON habit_logs(uid);
CREATE UNIQUE INDEX idx_wallets_uid ON wallets(uid);
CREATE UNIQUE INDEX idx_expense_categories_uid ON expense_categories(uid);
CREATE UNIQUE INDEX idx_expense_entries_uid ON expense_entries(uid);
`;

/** The v8 sync-storage DDL, exactly as the migration carries it. */
function migrationDdl(): string {
  const match = /pub const MIGRATION_7_8: &str = r#"([\s\S]*?)"#;/.exec(
    SCHEMA_RS,
  );
  if (!match?.[1]) {
    throw new Error("MIGRATION_7_8 not found in src-tauri/src/schema.rs");
  }
  return match[1];
}

/** The v9 row-stamp DDL, sliced out of `BASELINE_SQL`. */
function rowStampDdl(): string {
  const match =
    /-- v9: the stamp of the value[\s\S]*?CREATE INDEX idx_sync_row_stamps_uid ON sync_row_stamps\(entity_uid\);/.exec(
      SCHEMA_RS,
    );
  if (!match?.[0]) {
    throw new Error("sync_row_stamps DDL not found in src-tauri/src/schema.rs");
  }
  return match[0];
}

/** A statement with its comment lines dropped, so the head can be read. */
function withoutComments(statement: string): string {
  return statement
    .split("\n")
    .filter((line) => !line.trim().startsWith("--"))
    .join("\n")
    .trim();
}

/** Whether this statement is safe to apply to a bare fixture (see above). */
function fixtureSafe(statement: string): boolean {
  const head = withoutComments(statement).toUpperCase();
  return !(
    head.startsWith("ALTER TABLE") || head.startsWith("INSERT INTO SYNC_STATE")
  );
}

/** Every sync-storage statement a fixture needs, in order. */
export function syncStorageDdl(): string {
  return `${migrationDdl()}\n${rowStampDdl()}\n`
    .split(";")
    .map(withoutComments)
    .filter((statement) => statement.length > 0 && fixtureSafe(statement))
    .map((statement) => `${statement};`)
    .join("\n");
}

/** Lay the sync-storage tables and this fixture's own identity onto `db`. */
export function applySyncStorage(
  db: DatabaseSync,
  deviceId: string = FIXTURE_DEVICE_ID,
): void {
  db.exec(syncStorageDdl());
  db.prepare(
    `INSERT INTO sync_state (id, device_id, data_generation, lamport, last_seq, re_pair_required, updated_at)
     VALUES (1, ?, 1, 0, 0, 0, '2026-11-01')`,
  ).run(deviceId);
}

/** A store under test: the database, and the driver over it. */
export interface SyncFixture {
  db: DatabaseSync;
  driver: DataDriver;
}

/**
 * An in-memory database carrying `STAGE_ONE_FIXTURE` plus the sync storage.
 *
 * The driver is the app's contract in miniature: a batch is BEGIN/COMMIT with
 * ROLLBACK on the first failed statement, which is what makes an atomicity
 * claim testable at all. Foreign keys are ON, because the cascade is half of
 * what §5.2 is about.
 */
export function openSyncStore(deviceId?: string): SyncFixture {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(STAGE_ONE_FIXTURE);
  applySyncStorage(db, deviceId);
  const run = (sql: string, params: unknown[] = []): void => {
    db.prepare(sql).run(...(params as never[]));
  };
  const driver = {
    query: async <T extends Queryable>(
      sql: string,
      params: unknown[] = [],
    ): Promise<T[]> => db.prepare(sql).all(...(params as never[])) as T[],
    execute: async (
      sql: string,
      params: unknown[] = [],
    ): Promise<ExecuteOutcome> => {
      const result = db.prepare(sql).run(...(params as never[]));
      return {
        rowsAffected: Number(result.changes),
        lastInsertRowid: Number(result.lastInsertRowid),
      };
    },
    async batch(statements: BatchStatement[]): Promise<void> {
      db.exec("BEGIN");
      try {
        for (const statement of statements) {
          run(statement.sql, statement.params ?? []);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  } as unknown as DataDriver;
  return { db, driver };
}
