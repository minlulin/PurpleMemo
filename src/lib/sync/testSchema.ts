/**
 * The sync-storage DDL for tests that build their own fixture database.
 *
 * Sliced out of `src-tauri/src/schema.rs` rather than retyped, for the reason
 * `store.test.ts` gives: a copy here would let the test and the app disagree
 * about the schema the repositories actually write into.
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
 *  * the seeded identity `INSERT` — replaced by a fixed device id, so a test
 *    can name the device it expects instead of reading it back.
 */
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

const SCHEMA_RS = readFileSync(
  new URL("../../../src-tauri/src/schema.rs", import.meta.url),
  "utf8",
);

/** The device id every fixture built with this helper is stamped under. */
export const FIXTURE_DEVICE_ID = "11111111-1111-4111-8111-111111111111";

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
export function applySyncStorage(db: DatabaseSync): void {
  db.exec(syncStorageDdl());
  db.prepare(
    `INSERT INTO sync_state (id, device_id, data_generation, lamport, last_seq, re_pair_required, updated_at)
     VALUES (1, ?, 1, 0, 0, 0, '2026-11-01')`,
  ).run(FIXTURE_DEVICE_ID);
}
