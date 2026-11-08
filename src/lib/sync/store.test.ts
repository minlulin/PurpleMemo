/**
 * Storage tests for the v8 sync tables (`src/lib/sync/store.ts`).
 *
 * No mocks: every test runs the real DDL on a real SQLite database
 * (`node:sqlite`), sliced out of `src-tauri/src/schema.rs` rather than retyped,
 * so the storage layer is exercised against the schema the app actually ships.
 * Foreign keys are ON, because the cascade and `ON DELETE CASCADE` behaviour is
 * half of what these tests are about.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { BatchStatement, DataDriver } from "../../data/driver.ts";
import {
  ackStatements,
  applyStatements,
  collectTombstonesStatements,
  deleteStatements,
  outboxStatements,
  pendingCount,
  readOutbox,
  readPeers,
  readState,
  readTombstones,
  registerPeerStatements,
  restoreStatements,
  revokePeerStatements,
} from "./store.ts";

const SCHEMA_RS = readFileSync(
  new URL("../../../src-tauri/src/schema.rs", import.meta.url),
  "utf8",
);

/** The v8 sync-storage DDL, exactly as the migration carries it. */
function migrationDdl(): string {
  const match = /pub const MIGRATION_7_8: &str = r#"([\s\S]*?)"#;/.exec(
    SCHEMA_RS,
  );
  assert.ok(match?.[1], "MIGRATION_7_8 not found in src-tauri/src/schema.rs");
  return match[1];
}

/** The pre-v8 tables these tests mutate (the columns they actually touch). */
const V7_FIXTURE = `
CREATE TABLE collections (
  id INTEGER PRIMARY KEY, uid TEXT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY, uid TEXT, title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '',
  collection_id INTEGER REFERENCES collections(id) ON DELETE SET NULL,
  pinned INTEGER NOT NULL DEFAULT 0, archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY, uid TEXT, title TEXT NOT NULL, due_date TEXT,
  done INTEGER NOT NULL DEFAULT 0, repeat TEXT NOT NULL DEFAULT 'none',
  note TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
);
CREATE TABLE reminders (
  id INTEGER PRIMARY KEY, uid TEXT, title TEXT NOT NULL, remind_at TEXT NOT NULL,
  repeat TEXT NOT NULL DEFAULT 'none', note TEXT NOT NULL DEFAULT '',
  fired INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE shopping_lists (
  id INTEGER PRIMARY KEY, uid TEXT, name TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE shopping_items (
  id INTEGER PRIMARY KEY, uid TEXT,
  list_id INTEGER NOT NULL REFERENCES shopping_lists(id) ON DELETE CASCADE,
  text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0
);
`;

interface Store {
  db: DatabaseSync;
  driver: DataDriver;
}

function openStore(): Store {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(V7_FIXTURE);
  db.exec(migrationDdl());
  const run = (sql: string, params: unknown[] = []): void => {
    db.prepare(sql).run(...(params as never[]));
  };
  // The storage layer only needs query/execute/batch, and the batch shape is
  // the point: BEGIN/COMMIT around every statement, ROLLBACK on the first
  // failure — the same contract the app's SQLite driver has.
  const driver = {
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
      db.prepare(sql).all(...(params as never[])) as T[],
    execute: async (sql: string, params: unknown[] = []): Promise<void> =>
      run(sql, params),
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

function count(db: DatabaseSync, sql: string, params: string[] = []): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return row?.n ?? 0;
}

const UID_NOTE = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
const UID_PEER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UID_PEER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function insertNote(uid = UID_NOTE): BatchStatement {
  return {
    sql: "INSERT INTO notes (uid, title, content, tags, created_at, updated_at) VALUES (?, 'Note', 'body', '', '2026-11-08', '2026-11-08')",
    params: [uid],
  };
}

test("an outbox row and its mutation commit or roll back together", async () => {
  const { db, driver } = openStore();

  await driver.batch([
    insertNote(),
    ...outboxStatements([
      {
        table: "notes",
        uid: UID_NOTE,
        kind: "create",
        fields: { title: "Note" },
      },
    ]),
  ]);
  assert.equal(count(db, "SELECT count(*) AS n FROM notes"), 1);
  assert.equal(count(db, "SELECT count(*) AS n FROM sync_outbox"), 1);
  const state = await readState(driver);
  assert.equal(state.lamport, 1, "the counter advanced with the mutation");
  assert.equal(state.lastSeq, 1);

  // (a) the mutation fails: the outbox row and the counter bump must go too.
  await assert.rejects(
    driver.batch([
      { sql: "INSERT INTO notes (title) VALUES (NULL)" },
      ...outboxStatements([
        {
          table: "notes",
          uid: "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b",
          kind: "create",
        },
      ]),
    ]),
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM notes"), 1);
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sync_outbox"),
    1,
    "a rolled-back mutation left an outbox row behind",
  );
  assert.equal((await readState(driver)).lamport, 1);

  // (b) the outbox write fails: the mutation must not survive either. A CHECK
  // violation on `op` stands in for a full disk or a constraint added later.
  await assert.rejects(
    driver.batch([
      insertNote("0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c"),
      {
        sql: "INSERT INTO sync_outbox (device_id, seq, op_id, entity_table, entity_uid, op, counter, created_at) VALUES ('d', 9, 'op', 'notes', ?, 'explode', 1, 'now')",
        params: [UID_NOTE],
      },
    ]),
  );
  assert.equal(
    count(db, "SELECT count(*) AS n FROM notes"),
    1,
    "a failed outbox write committed its mutation",
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM sync_outbox"), 1);
});

test("the operation sequence and the Lamport counter never rewind, even after pruning", async () => {
  const { db, driver } = openStore();
  await driver.batch(
    registerPeerStatements({ deviceId: UID_PEER_A, generation: 1 }),
  );

  await driver.batch(
    outboxStatements([{ table: "notes", uid: UID_NOTE, kind: "create" }]),
  );
  // The peer acks sequence 1, so the row is pruned and the outbox looks empty.
  await driver.batch(ackStatements(UID_PEER_A, 1));
  assert.equal(count(db, "SELECT count(*) AS n FROM sync_outbox"), 0);

  await driver.batch(
    outboxStatements([
      { table: "notes", uid: UID_NOTE, kind: "update", fields: { title: "B" } },
    ]),
  );
  const rows = await readOutbox(driver);
  assert.equal(rows.length, 1);
  assert.equal(
    rows[0]?.seq,
    2,
    "a pruned outbox must not hand out sequence 1 again (§1.3)",
  );
  assert.equal(rows[0]?.counter, 2, "the Lamport counter is durable too");
  assert.equal((await readState(driver)).lastSeq, 2);
});

test("a deleted row leaves a tombstone, and a cascaded child gets its own", async () => {
  const { db, driver } = openStore();
  await driver.batch([
    {
      sql: "INSERT INTO shopping_lists (uid, name, created_at) VALUES ('11111111-1111-4111-8111-111111111111', 'Groceries', '2026-11-08')",
    },
    {
      sql: "INSERT INTO shopping_items (uid, list_id, text) VALUES ('22222222-2222-4222-8222-222222222222', 1, 'milk')",
    },
    ...outboxStatements([
      {
        table: "shopping_lists",
        uid: "11111111-1111-4111-8111-111111111111",
        kind: "create",
      },
      {
        table: "shopping_items",
        uid: "22222222-2222-4222-8222-222222222222",
        kind: "create",
      },
    ]),
  ]);

  // The delete: the parent row goes, the FK cascade removes the child row, and
  // BOTH must be recorded as tombstones — the cascade is not the record (§5.2).
  await driver.batch([
    { sql: "DELETE FROM shopping_lists WHERE id = 1" },
    ...deleteStatements([
      { table: "shopping_lists", uid: "11111111-1111-4111-8111-111111111111" },
      { table: "shopping_items", uid: "22222222-2222-4222-8222-222222222222" },
    ]),
  ]);

  assert.equal(count(db, "SELECT count(*) AS n FROM shopping_items"), 0);
  const tombstones = await readTombstones(driver);
  assert.equal(
    tombstones.length,
    2,
    "the cascaded child needs its own tombstone",
  );
  assert.deepEqual(tombstones.map((t) => t.entity_uid).sort(), [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ]);
  for (const tombstone of tombstones) {
    assert.ok(tombstone.counter > 0);
    assert.ok(tombstone.op_id.length > 0);
  }
  const deletes = (await readOutbox(driver)).filter(
    (row) => row.op === "delete",
  );
  assert.equal(deletes.length, 2, "each tombstone travels as a delete op");
});

test("the cursor moves only inside the transaction that applied its effects", async () => {
  const { db, driver } = openStore();
  await driver.batch(
    registerPeerStatements({ deviceId: UID_PEER_A, generation: 1 }),
  );

  await driver.batch(
    applyStatements(UID_PEER_A, 5, [
      {
        sql: "INSERT INTO notes (uid, title, content, tags, created_at, updated_at) VALUES (?, 'Peer note', '', '', '2026-11-08', '2026-11-08')",
        params: ["33333333-3333-4333-8333-333333333333"],
      },
    ]),
  );
  let peer = (await readPeers(driver))[0];
  assert.equal(peer?.cursor_in, 5);

  // A batch that fails half-way must leave the cursor where it was, so the
  // peer resends rather than having its operations skipped (§6.4).
  await assert.rejects(
    driver.batch(
      applyStatements(UID_PEER_A, 9, [
        { sql: "INSERT INTO notes (title) VALUES (NULL)" },
      ]),
    ),
  );
  peer = (await readPeers(driver))[0];
  assert.equal(
    peer?.cursor_in,
    5,
    "the cursor advanced for an apply that failed",
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM notes"), 1);

  // And a cursor never goes backwards: a stale delivery cannot rewind it.
  await driver.batch(applyStatements(UID_PEER_A, 3, []));
  peer = (await readPeers(driver))[0];
  assert.equal(peer?.cursor_in, 5);
});

test("acks prune a row only when every live peer has acknowledged it", async () => {
  const { db, driver } = openStore();
  await driver.batch(
    registerPeerStatements({ deviceId: UID_PEER_A, generation: 1 }),
  );
  await driver.batch(
    registerPeerStatements({ deviceId: UID_PEER_B, generation: 1 }),
  );
  await driver.batch(
    outboxStatements([{ table: "notes", uid: UID_NOTE, kind: "create" }]),
  );

  await driver.batch(ackStatements(UID_PEER_A, 1));
  const afterFirst = await readOutbox(driver);
  assert.equal(
    afterFirst.length,
    1,
    "peer B has not acked: the row is its only copy",
  );
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sync_outbox_delivery"),
    1,
    "the acknowledgement itself is recorded",
  );
  const peers = await readPeers(driver);
  assert.equal(peers.find((p) => p.device_id === UID_PEER_A)?.cursor_out, 1);

  await driver.batch(ackStatements(UID_PEER_B, 1));
  assert.equal(count(db, "SELECT count(*) AS n FROM sync_outbox"), 0);
  assert.equal(await pendingCount(driver), 0);

  // A revoked peer is no longer waited on (§11.3).
  await driver.batch(
    outboxStatements([{ table: "notes", uid: UID_NOTE, kind: "update" }]),
  );
  await driver.batch(revokePeerStatements(UID_PEER_A));
  await driver.batch(ackStatements(UID_PEER_B, 2));
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sync_outbox"),
    0,
    "the revoked peer's silence must not pin the outbox",
  );
});

test("tombstones are collected only when every live peer acked, and never with no peers", async () => {
  const { db, driver } = openStore();
  await driver.batch(
    deleteStatements([
      { table: "notes", uid: "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d" },
      { table: "notes", uid: "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e" },
    ]),
  );
  // No peer has ever paired, so collecting would forget a delete that a phone
  // pairing tomorrow still needs (§5.4).
  await driver.batch(collectTombstonesStatements());
  assert.equal(count(db, "SELECT count(*) AS n FROM sync_tombstones"), 2);

  await driver.batch(
    registerPeerStatements({ deviceId: UID_PEER_A, generation: 1 }),
  );
  await driver.batch(
    registerPeerStatements({ deviceId: UID_PEER_B, generation: 1 }),
  );
  await driver.batch(ackStatements(UID_PEER_A, 2));
  await driver.batch(collectTombstonesStatements());
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sync_tombstones"),
    2,
    "peer B has not acked yet",
  );

  await driver.batch(ackStatements(UID_PEER_B, 2));
  await driver.batch(collectTombstonesStatements());
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sync_tombstones"),
    0,
    "every live peer acked, so the tombstones go",
  );
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sync_tombstone_acks"),
    0,
    "acknowledgements cascade with their tombstone",
  );
});

test("the device identity is minted once per database and a fresh install mints a new one", async () => {
  const first = openStore();
  const a = await readState(first.driver);
  const b = await readState(first.driver);
  assert.match(
    a.deviceId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    "the device id must be a canonical UUID v4",
  );
  // "Survives a restart" for an in-memory database is the same row read again:
  // the id is stored, not derived from a clock or a path.
  assert.equal(b.deviceId, a.deviceId);
  assert.equal(a.dataGeneration, 1);
  assert.equal(a.rePairRequired, false);

  const second = openStore();
  assert.notEqual(
    (await readState(second.driver)).deviceId,
    a.deviceId,
    "a wiped install is a new device, never a reused identity (§1.2)",
  );
});

test("a restore bumps the generation, forces re-pair and drops the pre-restore outbox", async () => {
  const { db, driver } = openStore();
  await driver.batch(
    registerPeerStatements({ deviceId: UID_PEER_A, generation: 1 }),
  );
  await driver.batch(applyStatements(UID_PEER_A, 7, []));
  await driver.batch(
    outboxStatements([{ table: "notes", uid: UID_NOTE, kind: "create" }]),
  );
  await driver.batch(deleteStatements([{ table: "notes", uid: UID_NOTE }]));

  await driver.batch(restoreStatements());

  const state = await readState(driver);
  assert.equal(state.dataGeneration, 2);
  assert.equal(state.rePairRequired, true, "§10.2: the pairing is stale");
  assert.equal(
    state.deviceId.length,
    36,
    "the install keeps its own device id through a restore",
  );
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sync_outbox"),
    0,
    "the pre-restore outbox describes data that no longer exists",
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM sync_tombstones"), 0);
  const peer = (await readPeers(driver))[0];
  assert.equal(peer?.cursor_in, 0);
  assert.equal(peer?.cursor_out, 0);
  assert.equal(
    peer?.generation,
    1,
    "the peer keeps the generation it paired at — that mismatch is the evidence",
  );
});

test("nothing outside the 17-table allowlist can enter the outbox or a tombstone", () => {
  assert.throws(
    () =>
      outboxStatements([{ table: "contacts", uid: UID_NOTE, kind: "create" }]),
    /sync allowlist/,
  ); // `vault_items` IS syncable (desktop-to-mobile), so the refusal is pinned on
  // a desktop-only table instead: settings never reaches a peer.
  assert.throws(
    () => deleteStatements([{ table: "settings", uid: UID_NOTE }]),
    /sync allowlist/,
  );
});

test("field stamps travel with the operation, and the reminders marker stays unread", async () => {
  const { db, driver } = openStore();
  const stamp = { counter: 4, deviceId: UID_PEER_A, opId: "op-1" };
  await driver.batch(
    outboxStatements([
      {
        table: "reminders",
        uid: "44444444-4444-4444-8444-444444444444",
        kind: "update",
        fields: { title: "Renamed" },
        fieldStamps: { title: stamp },
        baseCounter: 3,
      },
    ]),
  );
  const row = (await readOutbox(driver))[0];
  assert.ok(row);
  assert.deepEqual(JSON.parse(row.field_stamps), { title: stamp });
  assert.deepEqual(JSON.parse(row.payload), { title: "Renamed" });
  assert.equal(row.base_counter, 3);
  assert.equal(
    row.counter,
    1,
    "the op carries this device's Lamport stamp, while field stamps keep the counters they arrived with",
  );

  // §13.1 is open: the column exists, is nullable, and nothing writes it yet.
  db.prepare(
    "INSERT INTO reminders (uid, title, remind_at, created_at) VALUES ('55555555-5555-4555-8555-555555555555', 'R', '2026-11-08T09:00', '2026-11-08')",
  ).run();
  assert.equal(
    count(
      db,
      "SELECT count(*) AS n FROM reminders WHERE created_by_device_id IS NULL",
    ),
    1,
  );
  const storeSource = readFileSync(
    new URL("./store.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    !storeSource.includes("created_by_device_id"),
    "the §13.1 marker must stay unwired until that decision is made",
  );
});
