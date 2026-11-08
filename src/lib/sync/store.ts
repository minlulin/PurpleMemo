/**
 * Sync storage for protocol v1 — the write path of
 * `docs/ANDROID_SYNC_PROTOCOL.md` §1.2, §5, §6 and §10 over schema v8
 * (`src-tauri/src/schema.rs`, `MIGRATION_7_8`).
 *
 * This module owns the SQL and nothing else: it opens no connection, keeps no
 * state, replicates nothing and decides no conflict. Every writer returns
 * `BatchStatement[]` so the CALLER can put it in the same `driver.batch` as the
 * domain mutation. That shape is the clause: §6.1 says an outbox row and its
 * mutation commit together, and a helper that wrote on its own would make that
 * promise impossible to keep.
 *
 * The device id, the Lamport counter and the operation sequence are read
 * *inside* those statements with SQL subselects, so a concurrent writer cannot
 * observe a stale counter and the transaction's own row is the only source of
 * truth.
 */
import type { BatchStatement, DataDriver } from "../../data/driver.ts";
import { isSyncTable, type OpKind, type SyncTable } from "./protocol.ts";

/** The single row of `sync_state` (`id INTEGER PRIMARY KEY CHECK (id = 1)`). */
export const SYNC_STATE_ID = 1;

export interface SyncState {
  deviceId: string;
  /** §10.2: bumped by a restore; a peer paired at an older value re-pairs. */
  dataGeneration: number;
  /** §4.2: the Lamport counter, the newest local stamp. */
  lamport: number;
  /** §1.3: the last operation sequence handed out, durable across pruning. */
  lastSeq: number;
  rePairRequired: boolean;
}

export interface PeerRow {
  device_id: string;
  pairing_id: string | null;
  display_name: string;
  public_key: string | null;
  generation: number;
  cursor_in: number;
  cursor_out: number;
  revoked_at: string | null;
  created_at: string;
}

export interface OutboxRow {
  id: number;
  device_id: string;
  seq: number;
  op_id: string;
  entity_table: string;
  entity_uid: string;
  op: OpKind;
  base_counter: number;
  counter: number;
  field_stamps: string;
  payload: string;
  created_at: string;
}

export interface TombstoneRow {
  id: number;
  entity_table: string;
  entity_uid: string;
  counter: number;
  device_id: string;
  op_id: string;
  deleted_at: string;
}

/** A field's stamp in the §4.3 sense, as stored in `sync_outbox.field_stamps`. */
export interface FieldStamp {
  counter: number;
  deviceId: string;
  opId: string;
}

export interface OutboxEntry {
  table: string;
  uid: string;
  kind: OpKind;
  /** The changed field values. Ignored for `delete`. */
  fields?: Record<string, unknown>;
  /** Per-field stamps; every field in `fields` should have one. */
  fieldStamps?: Record<string, FieldStamp>;
  /** The stamp the writer saw, for §4.5's diagnostics. */
  baseCounter?: number;
}

function nowIso(now: Date): string {
  return now.toISOString();
}

/**
 * Nothing outside the 17-table allowlist may enter the outbox or a tombstone.
 * §2.2 keeps credentials and the inbox out of sync entirely, and an op that
 * reaches the transport for an excluded table is a leak, not a bug report.
 */
function assertSyncTable(table: string): asserts table is SyncTable {
  if (!isSyncTable(table)) {
    throw new Error(
      `${table} is not on the sync allowlist (§2.2); it must never enter the outbox or a tombstone`,
    );
  }
}

/** The one-row bump every enqueued mutation uses (§4.2, §1.3). */
function bumpClock(now: string): BatchStatement {
  return {
    sql: "UPDATE sync_state SET lamport = lamport + 1, last_seq = last_seq + 1, updated_at = ? WHERE id = 1",
    params: [now],
  };
}

/**
 * §5.1/§5.2: a delete leaves a tombstone. The upsert matters for a row that is
 * deleted twice (or deleted, then re-created and deleted again): the newest
 * delete owns the record, and a second tombstone row would make the peers'
 * acknowledgement bookkeeping ambiguous.
 */
function tombstoneStatement(
  table: SyncTable,
  uid: string,
  opId: string,
  now: string,
): BatchStatement {
  return {
    sql: `INSERT INTO sync_tombstones (entity_table, entity_uid, counter, device_id, op_id, deleted_at)
          VALUES (?, ?, (SELECT lamport FROM sync_state WHERE id = 1), (SELECT device_id FROM sync_state WHERE id = 1), ?, ?)
          ON CONFLICT(entity_table, entity_uid) DO UPDATE SET
            counter = excluded.counter,
            device_id = excluded.device_id,
            op_id = excluded.op_id,
            deleted_at = excluded.deleted_at`,
    params: [table, uid, opId, now],
  };
}

/**
 * §6.1: the statements that make one mutation durable for sync. Batched with
 * the domain write, they commit or roll back as one unit.
 *
 * The `seq`/`counter`/`device_id` values come from `sync_state` inside the
 * transaction, so two mutations in one batch get two distinct sequences.
 */
export function outboxStatements(
  entries: readonly OutboxEntry[],
  now: Date = new Date(),
): BatchStatement[] {
  const stamp = nowIso(now);
  const statements: BatchStatement[] = [];
  for (const entry of entries) {
    assertSyncTable(entry.table);
    const opId = crypto.randomUUID();
    statements.push(bumpClock(stamp));
    statements.push({
      sql: `INSERT INTO sync_outbox (device_id, seq, op_id, entity_table, entity_uid, op, base_counter, counter, field_stamps, payload, created_at)
            VALUES ((SELECT device_id FROM sync_state WHERE id = 1),
                    (SELECT last_seq FROM sync_state WHERE id = 1),
                    ?, ?, ?, ?, ?, (SELECT lamport FROM sync_state WHERE id = 1), ?, ?, ?)`,
      params: [
        opId,
        entry.table,
        entry.uid,
        entry.kind,
        entry.baseCounter ?? 0,
        JSON.stringify(entry.fieldStamps ?? {}),
        JSON.stringify(entry.fields ?? {}),
        stamp,
      ],
    });
    // §5.2: a deleted child gets its own tombstone even when the database's
    // FK cascade is what removed the row. The caller passes every cascaded
    // child explicitly; nothing here can infer the children.
    if (entry.kind === "delete") {
      statements.push(tombstoneStatement(entry.table, entry.uid, opId, stamp));
    }
  }
  return statements;
}

/** `outboxStatements` for deletes only, so call sites read as they mean. */
export function deleteStatements(
  deletions: readonly Omit<OutboxEntry, "kind" | "fields">[],
  now: Date = new Date(),
): BatchStatement[] {
  return outboxStatements(
    deletions.map((entry) => ({ ...entry, kind: "delete" as const })),
    now,
  );
}

/**
 * §6.4: applying a peer's operations and moving the cursor are one
 * transaction. `effects` are the local writes the apply loop derived; the
 * cursor is the last statement, so a mid-apply failure leaves it where it was
 * and the batch is re-delivered rather than skipped.
 */
export function applyStatements(
  peerId: string,
  throughSeq: number,
  effects: readonly BatchStatement[],
): BatchStatement[] {
  return [
    ...effects,
    {
      sql: "UPDATE sync_peers SET cursor_in = max(cursor_in, ?) WHERE device_id = ?",
      params: [throughSeq, peerId],
    },
  ];
}

/**
 * §6.5: a peer acknowledged everything through `throughSeq`.
 *
 * The acknowledgement is recorded per row (`sync_outbox_delivery`) rather than
 * inferred from a cursor, because a peer's cursor is its own; and the prune
 * only removes rows every live peer has acked. With no live peer nothing is
 * pruned at all: an outbox row that was never delivered is the only copy of
 * that mutation.
 */
export function ackStatements(
  peerId: string,
  throughSeq: number,
  now: Date = new Date(),
): BatchStatement[] {
  const stamp = nowIso(now);
  return [
    {
      sql: `INSERT OR IGNORE INTO sync_outbox_delivery (outbox_id, peer_id, acked_at)
            SELECT id, ?, ? FROM sync_outbox WHERE seq <= ?`,
      params: [peerId, stamp, throughSeq],
    },
    {
      sql: `INSERT OR IGNORE INTO sync_tombstone_acks (tombstone_id, peer_id, acked_at)
            SELECT t.id, ?, ?
            FROM sync_tombstones t
            JOIN sync_outbox o ON o.entity_table = t.entity_table
                               AND o.entity_uid = t.entity_uid
                               AND o.op = 'delete'
            WHERE o.seq <= ?`,
      params: [peerId, stamp, throughSeq],
    },
    {
      sql: "UPDATE sync_peers SET cursor_out = max(cursor_out, ?) WHERE device_id = ?",
      params: [throughSeq, peerId],
    },
    {
      sql: `DELETE FROM sync_outbox
            WHERE seq <= ?
              AND EXISTS (SELECT 1 FROM sync_peers WHERE revoked_at IS NULL)
              AND NOT EXISTS (
                SELECT 1 FROM sync_peers p
                WHERE p.revoked_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM sync_outbox_delivery d
                    WHERE d.outbox_id = sync_outbox.id AND d.peer_id = p.device_id
                  )
              )`,
      params: [throughSeq],
    },
  ];
}

/**
 * §5.4: collect tombstones every live peer has acknowledged. Two guards:
 * the peer list must not be empty (a phone that pairs later would otherwise
 * resurrect the row), and a revoked peer is not asked again (§11.3).
 */
export function collectTombstonesStatements(): BatchStatement[] {
  return [
    {
      sql: `DELETE FROM sync_tombstones
            WHERE EXISTS (SELECT 1 FROM sync_peers WHERE revoked_at IS NULL)
              AND NOT EXISTS (
                SELECT 1 FROM sync_peers p
                WHERE p.revoked_at IS NULL
                  AND NOT EXISTS (
                    SELECT 1 FROM sync_tombstone_acks a
                    WHERE a.tombstone_id = sync_tombstones.id AND a.peer_id = p.device_id
                  )
              )`,
    },
  ];
}

/**
 * Record (or refresh) a paired peer. `generation` is the desktop's data
 * generation at pairing time — §10.2 compares it on every handshake, so a
 * restored desktop refuses the old pairing instead of merging.
 */
export function registerPeerStatements(
  peer: {
    deviceId: string;
    generation: number;
    pairingId?: string | null;
    displayName?: string;
    publicKey?: string | null;
  },
  now: Date = new Date(),
): BatchStatement[] {
  return [
    {
      sql: `INSERT INTO sync_peers (device_id, pairing_id, display_name, public_key, generation, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO UPDATE SET
              pairing_id = excluded.pairing_id,
              display_name = excluded.display_name,
              public_key = excluded.public_key,
              generation = excluded.generation,
              -- Re-pairing a revoked phone is the user's decision, and §11.3
              -- allows exactly that: revocation is a mark, not a delete.
              revoked_at = NULL`,
      params: [
        peer.deviceId,
        peer.pairingId ?? null,
        peer.displayName ?? "",
        peer.publicKey ?? null,
        peer.generation,
        nowIso(now),
      ],
    },
  ];
}

/** §11.3: stop syncing with a peer, keeping the row for diagnostics. */
export function revokePeerStatements(
  deviceId: string,
  now: Date = new Date(),
): BatchStatement[] {
  return [
    {
      sql: "UPDATE sync_peers SET revoked_at = ? WHERE device_id = ?",
      params: [nowIso(now), deviceId],
    },
  ];
}

/**
 * §10.3/§10.4: the desktop's data line changed under the pairing (a restore,
 * or a deliberate reset), so:
 *
 *  * the generation is bumped and `re_pair_required` is set — §10.2 refuses a
 *    peer still holding the old generation;
 *  * both cursors are zeroed: the numbers meant rows in the old line;
 *  * the outbox and tombstones are dropped: they describe the line that is
 *    gone, and delivering them would push the pre-restore state back onto the
 *    phone. What the phone had not pushed yet is lost by design (§10.5).
 *
 * Deliberately NOT touched: `device_id` (the install is the same install) and
 * `sync_peers.generation` (that stale value is the evidence the handshake
 * refuses).
 */
export function restoreStatements(now: Date = new Date()): BatchStatement[] {
  return [
    {
      sql: "UPDATE sync_state SET data_generation = data_generation + 1, re_pair_required = 1, updated_at = ? WHERE id = 1",
      params: [nowIso(now)],
    },
    { sql: "UPDATE sync_peers SET cursor_in = 0, cursor_out = 0" },
    { sql: "DELETE FROM sync_outbox" },
    { sql: "DELETE FROM sync_tombstones" },
  ];
}

export async function readState(driver: DataDriver): Promise<SyncState> {
  const [row] = await driver.query<{
    device_id: string;
    data_generation: number;
    lamport: number;
    last_seq: number;
    re_pair_required: number;
  }>(
    "SELECT device_id, data_generation, lamport, last_seq, re_pair_required FROM sync_state WHERE id = 1",
  );
  if (!row) {
    throw new Error(
      "sync storage has no state row; the v8 migration did not run (§1.2)",
    );
  }
  return {
    deviceId: row.device_id,
    dataGeneration: row.data_generation,
    lamport: row.lamport,
    lastSeq: row.last_seq,
    rePairRequired: row.re_pair_required === 1,
  };
}

export async function readPeers(driver: DataDriver): Promise<PeerRow[]> {
  return driver.query<PeerRow>(
    "SELECT device_id, pairing_id, display_name, public_key, generation, cursor_in, cursor_out, revoked_at, created_at FROM sync_peers ORDER BY created_at, device_id",
  );
}

/** Pending operations in sequence order — what §6.2 would send next. */
export async function readOutbox(driver: DataDriver): Promise<OutboxRow[]> {
  return driver.query<OutboxRow>(
    "SELECT id, device_id, seq, op_id, entity_table, entity_uid, op, base_counter, counter, field_stamps, payload, created_at FROM sync_outbox ORDER BY seq",
  );
}

export async function readTombstones(
  driver: DataDriver,
): Promise<TombstoneRow[]> {
  return driver.query<TombstoneRow>(
    "SELECT id, entity_table, entity_uid, counter, device_id, op_id, deleted_at FROM sync_tombstones ORDER BY id",
  );
}

/** The "N changes to sync" count of §9.3 — undelivered operations. */
export async function pendingCount(driver: DataDriver): Promise<number> {
  const [row] = await driver.query<{ pending: number }>(
    "SELECT count(*) AS pending FROM sync_outbox",
  );
  return row?.pending ?? 0;
}
