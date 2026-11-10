/**
 * Storage tests for the sync tables (`src/lib/sync/store.ts`) — v8's six plus
 * v9's `sync_row_stamps`.
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
import { MAX_PAIRING_SNAPSHOT_BYTES } from "./bootstrap.ts";
import { SYNC_TABLES } from "./protocol.ts";
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
  type SnapshotOp,
  snapshotStatements,
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

/**
 * The v9 row-stamp DDL, sliced out of `BASELINE_SQL` for the same reason as
 * the v8 block: retyping it here would let the test and the app disagree.
 */
function rowStampDdl(): string {
  const match =
    /-- v9: the stamp of the value[\s\S]*?CREATE INDEX idx_sync_row_stamps_uid ON sync_row_stamps\(entity_uid\);/.exec(
      SCHEMA_RS,
    );
  assert.ok(
    match?.[0],
    "sync_row_stamps DDL not found in src-tauri/src/schema.rs",
  );
  return match[0];
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
  db.exec(rowStampDdl());
  // The real schema gives every synced table a UNIQUE uid index (the v7
  // backfill); the fixture declares the columns, so the indexes are added here
  // for the same reason: `ON CONFLICT(uid)` is only meaningful with one.
  for (const table of Object.keys(SYNC_TABLES)) {
    try {
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_uid ON ${table}(uid)`,
      );
    } catch {
      // The fixture carries only the tables these tests touch.
    }
  }
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

test("registering a peer twice is refused instead of half-re-pinning it", async () => {
  const { driver } = openStore();
  await driver.batch(
    registerPeerStatements({
      deviceId: UID_PEER_A,
      generation: 1,
      pairingId: "pair-1",
      publicKey: "aa",
    }),
  );
  await driver.batch([
    {
      sql: "UPDATE sync_peers SET cursor_in = 4, cursor_out = 7, revoked_at = '2026-01-01T00:00:00Z' WHERE device_id = ?",
      params: [UID_PEER_A],
    },
  ]);

  // §11.4 (N10): a second pairing is `rePairStatements` — new pairing id, both
  // cursors zeroed, old acks dropped. A plain register must refuse rather than
  // replace the pin and leave another pairing's history attached to it.
  await assert.rejects(
    driver.batch(
      registerPeerStatements({
        deviceId: UID_PEER_A,
        generation: 2,
        pairingId: "pair-2",
        publicKey: "bb",
      }),
    ),
    /UNIQUE|constraint/i,
  );

  const peer = (await readPeers(driver))[0];
  assert.equal(peer?.pairing_id, "pair-1", "the old pin is not half-replaced");
  assert.equal(peer?.public_key, "aa");
  assert.equal(peer?.generation, 1);
  assert.equal(
    peer?.cursor_in,
    4,
    "the cursors still belong to the pairing that set them",
  );
  assert.equal(peer?.cursor_out, 7);
  assert.notEqual(
    peer?.revoked_at,
    null,
    "a refused register cannot quietly un-revoke a phone (§11.3)",
  );
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

// ---------------------------------------------------------------------------
// §8.4 — adopting the desktop's snapshot.
// ---------------------------------------------------------------------------

const UID_PARENT = "1f1f1f1f-1f1f-4f1f-8f1f-1f1f1f1f1f1f";
const UID_CHILD = "2f2f2f2f-2f2f-4f2f-8f2f-2f2f2f2f2f2f";
const DESKTOP_STAMP = { deviceId: UID_PEER_A, opId: "op-desktop" };

function snapshotOp(
  table: SnapshotOp["table"],
  uid: string,
  counter: number,
  fields: Record<string, unknown>,
): SnapshotOp {
  return { table, uid, stamp: { ...DESKTOP_STAMP, counter }, fields };
}

test("a snapshot's child row lands linked to its parent, in the same batch", async () => {
  const { db, driver } = openStore();
  // Child FIRST: the statements must reorder, because the subselect can only
  // find a parent that was written earlier in this transaction.
  await driver.batch(
    snapshotStatements([
      snapshotOp("notes", UID_CHILD, 9, {
        title: "Child",
        content: "",
        created_at: "2026-11-10",
        updated_at: "2026-11-10",
        collection_uid: UID_PARENT,
      }),
      snapshotOp("collections", UID_PARENT, 8, {
        name: "Pull cash",
        created_at: "2026-11-10",
      }),
    ]),
  );

  const parent = db
    .prepare("SELECT id, name FROM collections WHERE uid = ?")
    .get(UID_PARENT) as { id: number; name: string } | undefined;
  assert.ok(parent, "the parent arrived");
  assert.equal(parent.name, "Pull cash");
  const child = db
    .prepare("SELECT collection_id FROM notes WHERE uid = ?")
    .get(UID_CHILD) as { collection_id: number | null } | undefined;
  assert.equal(
    child?.collection_id,
    parent.id,
    "the child points at the parent's LOCAL id, resolved by uid",
  );

  // §4.2: the stamp came with the row, so a later merge compares against the
  // desktop's write instead of reading the value as pre-history.
  const stamp = db
    .prepare(
      "SELECT counter, device_id, op_id FROM sync_row_stamps WHERE entity_table = 'notes' AND entity_uid = ?",
    )
    .get(UID_CHILD) as
    | { counter: number; device_id: string; op_id: string }
    | undefined;
  assert.deepEqual(
    { ...stamp },
    { counter: 9, device_id: UID_PEER_A, op_id: "op-desktop" },
  );
});

test("a REQUIRED parent that was never sent adopts nothing at all", async () => {
  const { db, driver } = openStore();
  const statements = snapshotStatements([
    snapshotOp("shopping_lists", UID_PARENT, 1, {
      name: "Orphan list",
      created_at: "2026-11-10",
    }),
    snapshotOp("shopping_items", UID_CHILD, 2, {
      text: "orphan item",
      done: 0,
      sort_order: 0,
      // No such list in this snapshot, and `list_id` is NOT NULL.
      list_uid: "3f3f3f3f-3f3f-4f3f-8f3f-3f3f3f3f3f3f",
    }),
  ]);
  await assert.rejects(driver.batch(statements));
  assert.equal(
    count(db, "SELECT count(*) AS n FROM shopping_items"),
    0,
    "the failed batch left no adopted item",
  );
  assert.equal(
    count(db, "SELECT count(*) AS n FROM shopping_lists"),
    0,
    "nor the list the batch had already inserted",
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM sync_row_stamps"), 0);
});

/**
 * A row with no parent is a row with a NULL foreign key, which is what the
 * desktop sends — not a parent this side failed to find. Those are written as
 * a literal NULL, never as a subselect that could quietly resolve to one.
 */
test("an unlinked row is written unlinked, not silently dropped", async () => {
  const { db, driver } = openStore();
  await driver.batch(
    snapshotStatements([
      snapshotOp("notes", UID_CHILD, 3, {
        title: "Loose note",
        content: "",
        created_at: "2026-11-10",
        updated_at: "2026-11-10",
        collection_uid: null,
      }),
    ]),
  );
  const note = db
    .prepare("SELECT collection_id, title FROM notes WHERE uid = ?")
    .get(UID_CHILD) as
    | { collection_id: number | null; title: string }
    | undefined;
  assert.equal(note?.title, "Loose note");
  assert.equal(note.collection_id, null);
});

test("applying the same snapshot twice is a no-op, tombstone included", async () => {
  const { db, driver } = openStore();
  const ops = [
    snapshotOp("shopping_lists", UID_PARENT, 4, {
      name: "Pull walk",
      created_at: "2026-11-10",
    }),
  ];
  const tombstones = [
    {
      table: "notes" as const,
      uid: UID_CHILD,
      stamp: { ...DESKTOP_STAMP, counter: 7 },
    },
  ];
  await driver.batch(snapshotStatements(ops, tombstones));
  await driver.batch(snapshotStatements(ops, tombstones));

  assert.equal(count(db, "SELECT count(*) AS n FROM shopping_lists"), 1);
  assert.equal(count(db, "SELECT count(*) AS n FROM sync_tombstones"), 1);
  // An OLDER delete can never replace the newer one that is already recorded.
  const older = {
    table: "notes" as const,
    uid: UID_CHILD,
    stamp: { ...DESKTOP_STAMP, counter: 3 },
  };
  await driver.batch(snapshotStatements([], [older]));
  const kept = db
    .prepare("SELECT counter FROM sync_tombstones WHERE entity_uid = ?")
    .get(UID_CHILD) as { counter: number } | undefined;
  assert.equal(kept?.counter, 7, "the newer delete still owns the record");
});

test("the pull's order and budget are the Rust constants, not copies of them", () => {
  // Parents-first is `UID_TABLES`'s order in schema.rs. If SYNC_TABLES is ever
  // reordered, a child could be written before its parent and the subselect
  // would resolve to NULL — so the two lists are pinned together.
  const declared =
    /pub const UID_TABLES: \[&str; 17\] = \[([\s\S]*?)\];/.exec(
      SCHEMA_RS,
    )?.[1] ?? "";
  const rustTables = [...declared.matchAll(/"([a-z_]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    Object.keys(SYNC_TABLES),
    rustTables,
    "SYNC_TABLES must stay in UID_TABLES' parents-first order",
  );

  // And the byte budget is one number on both sides: 30 KiB, hex-sealed into
  // the 64 KiB pairing frame.
  const pairingSnapshot = readFileSync(
    new URL("../../../src-tauri/src/pairing_snapshot.rs", import.meta.url),
    "utf8",
  );
  const bytes =
    /pub const MAX_SNAPSHOT_BATCH_BYTES: usize = (\d+) \* 1024;/.exec(
      pairingSnapshot,
    );
  assert.ok(bytes?.[1], "MAX_SNAPSHOT_BATCH_BYTES not found in Rust");
  assert.equal(
    Number(bytes[1]) * 1024,
    MAX_PAIRING_SNAPSHOT_BYTES,
    "the phone's accepted batch budget must equal the desktop's served one",
  );
});

/** A live note plus the stamp of the write that produced it. */
async function seedStampedNote(
  driver: DataDriver,
  uid: string,
  counter: number,
): Promise<void> {
  await driver.batch([
    insertNote(uid),
    {
      sql: "INSERT INTO sync_row_stamps (entity_table, entity_uid, counter, device_id, op_id, field_stamps, updated_at) VALUES ('notes', ?, ?, ?, ?, '{}', '2026-11-09')",
      params: [uid, counter, UID_PEER_A, `op-${counter}`],
    },
  ]);
}

test("a re-adopted tombstone deletes the row it outranks", async () => {
  const { db, driver } = openStore();
  // §9.4: a second pairing re-takes the snapshot. The phone still holds a note
  // the desktop has since deleted, with an older stamp than that delete.
  await seedStampedNote(driver, UID_CHILD, 5);
  await driver.batch(
    snapshotStatements(
      [],
      [
        {
          table: "notes",
          uid: UID_CHILD,
          stamp: { counter: 9, deviceId: UID_PEER_A, opId: "op-9" },
        },
      ],
    ),
  );
  assert.equal(
    count(db, "SELECT count(*) AS n FROM notes"),
    0,
    "§5: a tombstone means the row is deleted, not merely recorded",
  );
  assert.equal(
    count(
      db,
      "SELECT count(*) AS n FROM sync_tombstones WHERE entity_uid = ?",
      [UID_CHILD],
    ),
    1,
    "and the delete itself is recorded",
  );
});

test("a tombstone the row outranks leaves the row and records nothing", async () => {
  const { db, driver } = openStore();
  await seedStampedNote(driver, UID_CHILD, 9);
  await driver.batch(
    snapshotStatements(
      [],
      [
        {
          table: "notes",
          uid: UID_CHILD,
          stamp: { counter: 5, deviceId: UID_PEER_A, opId: "op-5" },
        },
      ],
    ),
  );
  assert.equal(
    count(db, "SELECT count(*) AS n FROM notes"),
    1,
    "§4: the newer write wins, so the note stays",
  );
  assert.equal(
    count(db, "SELECT count(*) AS n FROM sync_tombstones"),
    0,
    "a delete the live row outranks must not be recorded as authoritative",
  );
});

/** The first-adoption shape: the desktop's tombstones name uids this phone's
 * own rows never had, so the delete finds nothing and nothing appears. */
test("a tombstone for a uid this phone never held is recorded and reveals no row", async () => {
  const { db, driver } = openStore();
  await driver.batch(
    snapshotStatements(
      [],
      [
        {
          table: "tasks",
          uid: UID_CHILD,
          stamp: { counter: 3, deviceId: UID_PEER_A, opId: "op-3" },
        },
      ],
    ),
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM tasks"), 0);
  assert.equal(count(db, "SELECT count(*) AS n FROM sync_tombstones"), 1);
});
