/**
 * Sync storage for protocol v1 — the write path of
 * `docs/ANDROID_SYNC_PROTOCOL.md` §1.2, §5, §6 and §10 over schema v9
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
import type {
  BatchStatement,
  DataDriver,
  Queryable,
} from "../../data/driver.ts";
import { todayLocal } from "../dates.ts";
import { SETTING_KEYS, settingsUpsertStatement } from "../settings.ts";
import {
  TRASH_CONFLICT_KIND,
  TRASH_SNAPSHOT_COLUMNS,
  TRASH_SNAPSHOT_VERSION,
  type TrashConflictCopy,
  type TrashEntityType,
} from "../trash.ts";
import { CONFLICT_COPY_LABEL, type ConflictLoser } from "./bootstrap.ts";
import {
  isSyncTable,
  type OpKind,
  SYNC_TABLES,
  type SyncTable,
} from "./protocol.ts";

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
export function assertSyncTable(table: string): asserts table is SyncTable {
  if (!isSyncTable(table)) {
    throw new Error(
      `${table} is not on the sync allowlist (§2.2); it must never enter the outbox or a tombstone`,
    );
  }
}

/**
 * §4.3's per-field stamps for a local write: every field the write touches is
 * stamped with the op's own stamp, and every OTHER field keeps the stamp it
 * already had.
 *
 * Merging rather than replacing is the whole point. A row stamp that dropped
 * the fields it did not touch would make the next merge read those fields as
 * "stamped by this device's latest write", so a peer's older edit of a
 * different field would lose a comparison it should win — two devices editing
 * two different fields would silently keep only one edit.
 *
 * Built in SQL because the stamp is the transaction's own counter
 * (`sync_state.lamport`), which this module never reads into TypeScript: a
 * value read before the batch would be exactly the stale counter the store's
 * subselects exist to avoid.
 */
function perFieldStamps(
  table: SyncTable,
  uid: string,
  opId: string,
  fields: Record<string, unknown>,
  provided?: Record<string, FieldStamp>,
): { sql: string; params: unknown[] } {
  // An explicit map (a caller merging on a peer's behalf) is patched over the
  // held stamps exactly as a writer's own fields are: the fields it does not
  // name keep the stamps they already had.
  const patch = provided
    ? { sql: "?", params: [JSON.stringify(provided)] }
    : {
        sql: `(SELECT json_group_object(
                 touched.key,
                 json_object(
                   'counter', (SELECT lamport FROM sync_state WHERE id = 1),
                   'deviceId', (SELECT device_id FROM sync_state WHERE id = 1),
                   'opId', ?))
               FROM json_each(?) AS touched)`,
        params: [opId, JSON.stringify(fields)],
      };
  return {
    sql: `json_patch(
            COALESCE((SELECT held.field_stamps FROM sync_row_stamps held
                       WHERE held.entity_table = ? AND held.entity_uid = ?), '{}'),
            COALESCE(${patch.sql}, '{}'))`,
    params: [table, uid, ...patch.params],
  };
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
    // §4.2/§8.4: the durable stamp of the value this row now holds. Written
    // with the mutation, in the same batch (§6.1), because `sync_outbox` is
    // pruned once every peer acks (§6.5) and the snapshot still has to be
    // able to say which write a row's value came from. A delete drops the
    // stamp: the tombstone carries the delete's own stamp (§5.1).
    statements.push(
      entry.kind === "delete"
        ? {
            sql: "DELETE FROM sync_row_stamps WHERE entity_table = ? AND entity_uid = ?",
            params: [entry.table, entry.uid],
          }
        : (() => {
            // An explicit per-field map (a caller merging on a peer's behalf)
            // is patched over the held one exactly as a writer's own fields
            // are — the fields it does not name keep their stamps.
            const stamps = perFieldStamps(
              entry.table,
              entry.uid,
              opId,
              entry.fields ?? {},
              entry.fieldStamps,
            );
            return {
              sql: `INSERT INTO sync_row_stamps (entity_table, entity_uid, counter, device_id, op_id, field_stamps, updated_at)
                    VALUES (?, ?, (SELECT lamport FROM sync_state WHERE id = 1),
                            (SELECT device_id FROM sync_state WHERE id = 1), ?, ${stamps.sql}, ?)
                    ON CONFLICT(entity_table, entity_uid) DO UPDATE SET
                      counter = excluded.counter,
                      device_id = excluded.device_id,
                      op_id = excluded.op_id,
                      field_stamps = excluded.field_stamps,
                      updated_at = excluded.updated_at`,
              params: [entry.table, entry.uid, opId, ...stamps.params, stamp],
            };
          })(),
    );
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
 * Record a newly paired peer. `generation` is the desktop's data generation at
 * pairing time — §10.2 compares it on every handshake, so a restored desktop
 * refuses the old pairing instead of merging.
 *
 * Pure `INSERT` (N10): a row that already exists is refused by the primary
 * key. The old `ON CONFLICT ... DO UPDATE` was wrong twice over — it replaced
 * the pin without zeroing `cursor_in`/`cursor_out` or dropping the previous
 * pairing's delivery acks, so the new pairing silently resumed another
 * pairing's history, and it made that look like success. Re-pairing is
 * `rePairStatements` (§11.4) and nothing else.
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
            VALUES (?, ?, ?, ?, ?, ?)`,
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

/**
 * §11.4: a re-pair is a NEW pairing, never a resumed one. The pin is replaced,
 * both cursors go back to 0, and a previous revocation is cleared (that is what
 * "re-pair" means). The row itself stays: its `created_at` is the history of
 * when this device was first paired.
 */
export function rePairStatements(
  peer: {
    deviceId: string;
    generation: number;
    pairingId: string;
    displayName?: string;
    publicKey?: string | null;
  },
  now: Date = new Date(),
): BatchStatement[] {
  return [
    {
      sql: `UPDATE sync_peers
            SET pairing_id = ?, display_name = ?, public_key = ?, generation = ?,
                cursor_in = 0, cursor_out = 0, revoked_at = NULL
            WHERE device_id = ?`,
      params: [
        peer.pairingId,
        peer.displayName ?? "",
        peer.publicKey ?? null,
        peer.generation,
        peer.deviceId,
      ],
    },
    // Acks describe the old pairing's outbox rows; the new pairing starts at
    // sequence 0 on both sides (§11.4), so they are not evidence any more.
    {
      sql: "DELETE FROM sync_outbox_delivery WHERE peer_id = ?",
      params: [peer.deviceId],
    },
    {
      sql: "DELETE FROM sync_tombstone_acks WHERE peer_id = ?",
      params: [peer.deviceId],
    },
    {
      sql: "UPDATE sync_state SET re_pair_required = 0, updated_at = ? WHERE id = 1",
      params: [now.toISOString()],
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

/**
 * The uid this device holds for a local row (§1.1's `(table, uid)`), or
 * `undefined` when the row is gone.
 *
 * A repository composes an op from the row it is about to write, so it needs
 * the uid before the batch: the mutation itself addresses the row by its local
 * `id`, while the op and its tombstone address it by uid. Reading it first is
 * what keeps "the mutation and its op travel in one batch" possible without
 * the op guessing an identity (§6.1).
 */
export async function readRowUid(
  driver: DataDriver,
  table: SyncTable,
  id: number,
): Promise<string | undefined> {
  assertSyncTable(table);
  const [row] = await driver.query<{ uid: string | null }>(
    `SELECT uid FROM "${table}" WHERE id = ?`,
    [id],
  );
  const uid = row?.uid;
  return typeof uid === "string" && uid.length > 0 ? uid : undefined;
}

/**
 * The local `id` of the row just inserted under `uid`.
 *
 * A create commits through `driver.batch` (it has to: the op rides in the same
 * transaction, §6.1) and a batch answers nothing, while the repositories return
 * the new row's id to their callers. The uid is minted here and is UNIQUE, so
 * reading it back after the commit names exactly the row the batch wrote.
 */
export async function readRowId(
  driver: DataDriver,
  table: SyncTable,
  uid: string,
): Promise<number> {
  assertSyncTable(table);
  const [row] = await driver.query<{ id: number }>(
    `SELECT id FROM "${table}" WHERE uid = ?`,
    [uid],
  );
  if (!row) {
    throw new Error(
      `the ${table} row committed under ${uid} is not there (§6.1) — the batch did not write it.`,
    );
  }
  return row.id;
}

// ---------------------------------------------------------------------------
// §12.3 — Vault: one password generation, carried with the rows.
// ---------------------------------------------------------------------------

/**
 * The two envelope keys every vault operation and every snapshot vault row
 * carries (Stage 3 decision 2).
 *
 * They ride ALONGSIDE the row's fields, never among them: `vault_items` has no
 * such columns, and the values are written into the RECEIVING device's own
 * `settings` — the settings table itself never crosses (§2.2).
 *
 * `vault_generation` is the vault's **password** generation: 1 at setup, +1 at
 * every password change, which re-seals every item. It is deliberately NOT the
 * §10 data generation — a different counter with a different lifecycle, and
 * mixing the two names is how a restore would silently re-key the vault.
 */
export const VAULT_GENERATION_FIELD = "vault_generation";
export const VAULT_VERIFIER_FIELD = "vault_verifier";

/** The vault metadata a payload carries, once its fields are separated out. */
export interface VaultMetadata {
  /** The password generation, or null when the payload carried none. */
  generation: number | null;
  /** The sealed verifier, exactly as `settings.vault_verify` stores it. */
  verifier: string | null;
}

/**
 * The vault metadata this device holds, read the way its own `settings` store
 * it. `generation` is null when no row exists (a vault set up before Stage 3,
 * or none at all) — the caller decides what that means, because only the
 * vault's own writer knows whether a vault exists here.
 */
export async function readVaultMetadata(reader: {
  query<T extends Queryable>(sql: string, params?: unknown[]): Promise<T[]>;
}): Promise<VaultMetadata> {
  const rows = await reader.query<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key IN (?, ?)",
    [SETTING_KEYS.vaultGeneration, SETTING_KEYS.vaultVerify],
  );
  let generation: number | null = null;
  let verifier: string | null = null;
  for (const row of rows) {
    if (row.key === SETTING_KEYS.vaultGeneration) {
      try {
        const value: unknown = JSON.parse(row.value);
        if (typeof value === "number" && Number.isSafeInteger(value)) {
          generation = value;
        }
      } catch {
        // A corrupt counter reads as "no row": the next op's generation is a
        // guess either way, and a thrown error here would block every local
        // vault write over one damaged setting.
      }
    } else if (row.key === SETTING_KEYS.vaultVerify) {
      verifier = row.value;
    }
  }
  return { generation, verifier };
}

/**
 * Split a vault payload into the row's own fields and the envelope (§12.3).
 *
 * A vault row's write may only use the fields half: `vault_generation` and
 * `vault_verifier` are not columns, and `vaultMetadataStatements` is where they
 * belong. Every other table's payload is its row, unchanged.
 */
export function splitVaultMetadata(fields: Record<string, unknown>): {
  fields: Record<string, unknown>;
  metadata: VaultMetadata;
} {
  if (
    !Object.hasOwn(fields, VAULT_GENERATION_FIELD) &&
    !Object.hasOwn(fields, VAULT_VERIFIER_FIELD)
  ) {
    return { fields, metadata: { generation: null, verifier: null } };
  }
  const row: Record<string, unknown> = { ...fields };
  const raw = row[VAULT_GENERATION_FIELD];
  const sealed = row[VAULT_VERIFIER_FIELD];
  delete row[VAULT_GENERATION_FIELD];
  delete row[VAULT_VERIFIER_FIELD];
  return {
    fields: row,
    metadata: {
      generation:
        typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0
          ? raw
          : null,
      verifier: typeof sealed === "string" && sealed.length > 0 ? sealed : null,
    },
  };
}

/**
 * The RECEIVING side's own settings write for vault metadata (decision 2), for
 * the same batch that applies the items.
 *
 * Three rows, because the phone's existing `vault.ts` reads three: the verifier
 * (`unlock`'s only proof while the vault holds no item), the generation (what
 * the next comparison reads), and the setup marker — which `isSetUp()` reads,
 * so without it the phone would keep telling the user no vault exists while the
 * items sit right there. None of them crossed as a settings row; each is
 * written here from the envelope (§2.2 stands).
 */
export function vaultMetadataStatements(
  metadata: VaultMetadata,
): BatchStatement[] {
  const statements: BatchStatement[] = [];
  if (metadata.verifier !== null) {
    statements.push(
      settingsUpsertStatement(
        SETTING_KEYS.vaultSetup,
        JSON.stringify({ version: 1 }),
      ),
      settingsUpsertStatement(SETTING_KEYS.vaultVerify, metadata.verifier),
    );
  }
  if (metadata.generation !== null) {
    statements.push(
      settingsUpsertStatement(
        SETTING_KEYS.vaultGeneration,
        JSON.stringify(metadata.generation),
      ),
    );
  }
  return statements;
}

/**
 * The wholesale wipe a new generation's first operation runs (decision 3):
 * every local item and its stamp, because the incoming generation is a
 * complete re-seal and mixing the two sets is the F3 failure.
 *
 * Tombstones stay: they are delete proofs (§5.1), not items, and dropping them
 * would let a re-delivered delete resurrect nothing but also forget it.
 */
export function vaultWipeStatements(): BatchStatement[] {
  return [
    { sql: "DELETE FROM vault_items" },
    {
      sql: "DELETE FROM sync_row_stamps WHERE entity_table = ?",
      params: ["vault_items"],
    },
  ];
}

// ---------------------------------------------------------------------------
// §8.4 — adopting the desktop's snapshot.
// ---------------------------------------------------------------------------

/**
 * The synced tables' foreign keys, as a snapshot names them.
 *
 * A foreign key is not portable: `notes.collection_id` is a local integer that
 * means nothing on another device, so the snapshot carries the parent's uid as
 * `collection_uid` and this map is what turns it back into a local `id`. Only
 * the referenced tables appear here; every other table's keys are its own.
 */
export const FOREIGN_KEYS: Partial<
  Record<SyncTable, Record<string, SyncTable>>
> = {
  notes: { collection_uid: "collections" },
  income_entries: { category_uid: "income_categories", wallet_uid: "wallets" },
  expense_entries: {
    category_uid: "expense_categories",
    wallet_uid: "wallets",
  },
  jobs: { shop_uid: "shops" },
  shopping_items: { list_uid: "shopping_lists" },
  habit_logs: { habit_uid: "habits" },
};

/**
 * The same foreign keys named by their LOCAL columns (`collection_id`, not
 * `collection_uid`) — what a reader of this device's own rows needs to turn
 * them into wire documents (§9.1's upload). Kept beside `FOREIGN_KEYS` so the
 * two maps are visibly one fact spelled two ways.
 */
export const LOCAL_FOREIGN_KEYS: Partial<
  Record<SyncTable, Record<string, SyncTable>>
> = {
  notes: { collection_id: "collections" },
  income_entries: { category_id: "income_categories", wallet_id: "wallets" },
  expense_entries: {
    category_id: "expense_categories",
    wallet_id: "wallets",
  },
  jobs: { shop_id: "shops" },
  shopping_items: { list_id: "shopping_lists" },
  habit_logs: { habit_id: "habits" },
};

/**
 * The synced tables whose `name` is the record's identity within a device.
 *
 * The schema says so itself: each of these declares `name TEXT NOT NULL
 * UNIQUE`, so two rows with the same name cannot coexist here — while the
 * baseline seeds every one of them on a fresh install under *random* uids
 * (§2.1's seed block). Two installs therefore hold the same `Cash` wallet as
 * two different records, and an incoming snapshot row whose name already
 * exists locally is that same record created twice, not a second one (§8.4).
 */
export const NATURAL_KEYS: Partial<Record<SyncTable, string>> = {
  collections: "name",
  wallets: "name",
  income_categories: "name",
  expense_categories: "name",
};

/** The one §4.2 stamp a snapshot row (or tombstone) carries. */
export interface SnapshotStamp {
  counter: number;
  deviceId: string;
  opId: string;
}

/** One record as the snapshot carries it (§8.4). */
export interface SnapshotOp {
  table: SyncTable;
  uid: string;
  stamp: SnapshotStamp;
  fields: Record<string, unknown>;
}

/** One deletion's proof as the snapshot carries it (§5.1). */
export interface SnapshotTombstoneOp {
  table: SyncTable;
  uid: string;
  stamp: SnapshotStamp;
}

/** A name a payload may name: lowercase, unquoted, and never SQL. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

function assertIdentifier(name: string, owner: string): void {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `${JSON.stringify(name)} is not a name ${owner} may receive (§8.4).`,
    );
  }
}

/**
 * §8.4's fold: the local row that already holds this natural key becomes the
 * incoming record.
 *
 * Shared by both borders that must obey the rule — the snapshot's row write
 * (`snapshotRowStatements`) and the Stage 1 op apply, which §8.4 says inherits
 * it (`composeOp`'s create branch). The caller passes the record it means to
 * write: the local row whose name matches is re-keyed onto that uid first.
 *
 * The two statements are a pair and always run before the row write:
 *
 * 1. the displaced row's stamp is removed, because the row write that follows
 *    records the record's stamp under its *new* uid — leaving the old one would
 *    orphan a stamp under a uid no row carries;
 * 2. the row is re-keyed in place. Its local `id` is untouched, so every child
 *    written against it (entries pointing at this wallet or category, notes
 *    pointing at this collection) stays attached, and the incoming fields then
 *    land through the ordinary upsert exactly as if the uid had matched.
 *
 * Both statements are guarded by `uid != ?`, so they match nothing in the two
 * ordinary cases — the incoming uid already exists here (a re-adoption), or no
 * local row carries the name (a genuinely new record) — and in those cases the
 * apply is byte-for-byte the pre-fold behaviour.
 */
export function foldStatements(
  op: Pick<SnapshotOp, "table" | "uid" | "fields">,
): BatchStatement[] {
  const key = NATURAL_KEYS[op.table];
  if (key === undefined) return [];
  const value = op.fields[key];
  // No usable natural key in the incoming fields: nothing to fold.
  if (typeof value !== "string") return [];
  return [
    {
      sql: `DELETE FROM sync_row_stamps
            WHERE entity_table = ?
              AND entity_uid IN (SELECT uid FROM "${op.table}" WHERE "${key}" = ? AND uid != ?)`,
      params: [op.table, value, op.uid],
    },
    {
      sql: `UPDATE "${op.table}" SET uid = ? WHERE "${key}" = ? AND uid != ?`,
      params: [op.uid, value, op.uid],
    },
  ];
}

/**
 * One row's columns, values and params, shared by every apply that writes a
 * synced record (§8.4, §9.1).
 *
 * A foreign key is resolved by subselect — `(SELECT id FROM "collections"
 * WHERE uid = ?)` — never by a read before the transaction. That is what makes
 * "parents first" a property of the batch instead of a race: the parent is
 * inserted earlier in the SAME transaction, so the subselect finds it.
 *
 * An absent parent resolves to NULL. The `NOT NULL` foreign keys
 * (`income_entries`, `expense_entries`, `shopping_items`, `habit_logs`) then
 * refuse, and the whole batch adopts nothing; the nullable two
 * (`notes.collection_id`, `jobs.shop_id`) would land that record unlinked.
 * That is unreachable from a well-formed payload — the reader walks all 17
 * tables in one transaction, parents first — and a row with no parent at all
 * arrives as an explicit `null` `_uid`, which is written as a literal NULL
 * rather than a subselect, so the two cases cannot be confused.
 */
function snapshotColumns(op: SnapshotOp): {
  columns: string[];
  values: string[];
  params: unknown[];
} {
  const foreignKeys = FOREIGN_KEYS[op.table] ?? {};
  const columns: string[] = ["uid"];
  const values: string[] = ["?"];
  const params: unknown[] = [op.uid];
  for (const [key, value] of Object.entries(op.fields)) {
    if (key === "uid") continue;
    if (key === "id") {
      throw new Error(
        `a snapshot must not carry ${op.table}'s local id; the uid is its identity (§8.4).`,
      );
    }
    const parent = foreignKeys[key];
    if (parent !== undefined) {
      assertIdentifier(parent, op.table);
      columns.push(`${key.slice(0, -"_uid".length)}_id`);
      if (value === null || value === undefined) {
        // An unlinked row: the sender's own `NULL` foreign key. Spelled as
        // NULL rather than a subselect, so it cannot be confused with a parent
        // this batch merely failed to find.
        values.push("NULL");
      } else {
        values.push(`(SELECT id FROM "${parent}" WHERE uid = ?)`);
        params.push(value);
      }
      continue;
    }
    if (key.endsWith("_uid")) {
      throw new Error(
        `the snapshot sent ${op.table}.${key}, which names no parent table this build keeps (§8.4).`,
      );
    }
    assertIdentifier(key, op.table);
    columns.push(key);
    values.push("?");
    params.push(value);
  }
  if (columns.length === 1) {
    throw new Error(
      `the snapshot sent ${op.table} ${op.uid} with no fields (§8.4).`,
    );
  }
  return { columns, values, params };
}

/**
 * §13.1's border stamp for the two row-carrying borders that are not the
 * engine: a reminder whose payload carries no creator is stamped with the
 * SENDER's device id — the row came from that device, so that device is where
 * it was created (or, for a legacy row, the best evidence there is).
 *
 * A payload that already names a creator keeps it: a real creator id is never
 * overwritten by a passing border.
 */
function withSenderCreator(
  op: SnapshotOp,
  senderDeviceId?: string,
): SnapshotOp {
  if (op.table !== "reminders") return op;
  if (op.fields.created_by_device_id != null) return op;
  if (senderDeviceId === undefined || senderDeviceId.length === 0) return op;
  return {
    ...op,
    fields: { ...op.fields, created_by_device_id: senderDeviceId },
  };
}

/**
 * §8.4's row write: the record and its stamp, as two statements.
 *
 * The stamp is written too (§4.2): the row's value came from that write, and
 * a merge that read it as pre-history would let any edit win over it.
 * `field_stamps` stays empty because the snapshot carries a row stamp; claiming
 * per-field stamps here would claim more than the desktop sent.
 */
export function snapshotRowStatements(
  op: SnapshotOp,
  now: Date = new Date(),
  senderDeviceId?: string,
): BatchStatement[] {
  assertSyncTable(op.table);
  const { columns, values, params } = snapshotColumns(
    withSenderCreator(op, senderDeviceId),
  );
  const updates = columns
    .filter((column) => column !== "uid")
    .map((column) => `"${column}" = excluded."${column}"`);
  // §8.4's fold comes first: a seed this device minted under its own uid has to
  // become the incoming record before the upsert can find it by uid.
  const statements = foldStatements(op);
  statements.push(
    {
      sql: `INSERT INTO "${op.table}" (${columns
        .map((column) => `"${column}"`)
        .join(", ")})
            VALUES (${values.join(", ")})
            ON CONFLICT(uid) DO UPDATE SET ${updates.join(", ")}`,
      params,
    },
    {
      sql: `INSERT INTO sync_row_stamps (entity_table, entity_uid, counter, device_id, op_id, field_stamps, updated_at)
            VALUES (?, ?, ?, ?, ?, '{}', ?)
            ON CONFLICT(entity_table, entity_uid) DO UPDATE SET
              counter = excluded.counter,
              device_id = excluded.device_id,
              op_id = excluded.op_id,
              field_stamps = excluded.field_stamps,
              updated_at = excluded.updated_at`,
      params: [
        op.table,
        op.uid,
        op.stamp.counter,
        op.stamp.deviceId,
        op.stamp.opId,
        nowIso(now),
      ],
    },
  );
  return statements;
}

/**
 * §9.1's row write, the upload direction: a plain insert, never an upsert.
 *
 * The caller has already established that this device does not hold the uid
 * (that classification IS the upload plan), so the row lands as the new
 * record §9.2 promises, with the stamp the phone sent — the merge baseline
 * for everything Stage 1 later compares against it. There is deliberately
 * no §8.4 fold here: a natural-key collision on this side means a genuinely
 * distinct record was created under the same name on both devices while
 * unpaired, and silently overwriting either side's fields is not §9.1's to
 * decide — the insert refuses on the unique name, the whole apply rolls
 * back, and the failure is reported by name instead (§7.7).
 */
export function uploadRowStatements(
  op: SnapshotOp,
  now: Date = new Date(),
  senderDeviceId?: string,
): BatchStatement[] {
  assertSyncTable(op.table);
  const { columns, values, params } = snapshotColumns(
    withSenderCreator(op, senderDeviceId),
  );
  return [
    {
      sql: `INSERT INTO "${op.table}" (${columns
        .map((column) => `"${column}"`)
        .join(", ")})
            VALUES (${values.join(", ")})`,
      params,
    },
    {
      sql: `INSERT INTO sync_row_stamps (entity_table, entity_uid, counter, device_id, op_id, field_stamps, updated_at)
            VALUES (?, ?, ?, ?, ?, '{}', ?)`,
      params: [
        op.table,
        op.uid,
        op.stamp.counter,
        op.stamp.deviceId,
        op.stamp.opId,
        nowIso(now),
      ],
    },
  ];
}

/**
 * §9.1's apply, whole: every uploaded row as ONE statement list, parents
 * first (the same `SYNC_TABLES` order the snapshot apply sorts by), for the
 * caller's one transaction. An uploaded child whose parent is itself in the
 * upload resolves by the same subselect; a parent this device already holds
 * resolves the same way.
 */
export function uploadStatements(
  ops: readonly SnapshotOp[],
  now: Date = new Date(),
  senderDeviceId?: string,
): BatchStatement[] {
  const order = new Map(
    (Object.keys(SYNC_TABLES) as SyncTable[]).map((table, index) => [
      table,
      index,
    ]),
  );
  const sorted = [...ops].sort(
    (left, right) =>
      (order.get(left.table) ?? 0) - (order.get(right.table) ?? 0),
  );
  const statements: BatchStatement[] = [];
  for (const op of sorted)
    statements.push(...uploadRowStatements(op, now, senderDeviceId));
  return statements;
}

// ---------------------------------------------------------------------------
// §13.2 — the losing side of a conflict, archived on the device that held it.
// ---------------------------------------------------------------------------

/**
 * The §13.2 sync tables whose losers archive, and the Trash type each lands
 * under.
 *
 * Deliberately not every synced table: habit check-ins are not content (§9.5),
 * Budget's append-only rows have no losing edit to keep, Vault is read-only
 * desktop-to-mobile, and an overwritten reminder definition is not content
 * either (§13.2). A table absent from this map produces no statements — the
 * loser is simply decided and dropped.
 */
export const CONFLICT_TRASH_TYPES: Partial<Record<SyncTable, TrashEntityType>> =
  {
    notes: "note",
    tasks: "task",
    shopping_lists: "shopping_list",
    shopping_items: "shopping_item",
  };

/** The key a loser's locally held row is looked up by, §1.1's `(table, uid)`. */
export function conflictRowKey(table: SyncTable, uid: string): string {
  return `${table}\u0000${uid}`;
}

/**
 * One losing record as this device holds it: the local id and the full field
 * set, read by the caller BEFORE the winning apply overwrites the row.
 */
export interface HeldConflictRow {
  table: SyncTable;
  uid: string;
  row: Record<string, unknown>;
}

/**
 * §13.2's conflict copies, as statements to PREPEND to the winning apply's
 * `driver.batch`.
 *
 * Same transaction, copy first: §5.5 says the copy lands on the device that
 * held the losing value, in the same commit as the winning apply. Either both
 * are written or neither is — a batch that fails after the copy has been
 * prepared leaves no Trash row behind, because nothing here runs outside the
 * caller's transaction.
 *
 * Each statement is one `trash_items` INSERT whose snapshot is the ordinary
 * snapshot shape (empty child arrays — a conflict loser's children are not
 * archived) plus the §13.2 marker: the label, the losing uid, and the winning
 * field values, so the Trash page can show the copy beside what won. `won` is
 * carried verbatim from `conflictLosers()`; the UI derives the comparable text
 * from it.
 *
 * A loser whose table is not in `CONFLICT_TRASH_TYPES` produces nothing. A
 * loser whose locally held row was not supplied is a caller bug — the copy
 * cannot be built from the loser alone — so it throws instead of archiving a
 * half-record.
 */
export function conflictCopyStatements(
  losers: readonly ConflictLoser[],
  held: readonly HeldConflictRow[],
  today: string = todayLocal(),
): BatchStatement[] {
  const byKey = new Map(
    held.map((entry) => [conflictRowKey(entry.table, entry.uid), entry]),
  );
  const statements: BatchStatement[] = [];
  for (const loser of losers) {
    const type = CONFLICT_TRASH_TYPES[loser.table];
    if (type === undefined) continue;
    const entry = byKey.get(conflictRowKey(loser.table, loser.uid));
    if (entry === undefined) {
      throw new Error(
        `a ${loser.table} conflict copy needs the losing row as this device holds it; ${loser.uid} was not supplied (§13.2).`,
      );
    }
    const id = entry.row.id;
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error(
        `the losing ${loser.table} row ${loser.uid} has no local id, so it cannot be archived (§13.2).`,
      );
    }
    const entity: Record<string, unknown> = {};
    for (const column of TRASH_SNAPSHOT_COLUMNS[type]) {
      entity[column] = entry.row[column] ?? null;
    }
    const conflict: TrashConflictCopy = {
      kind: TRASH_CONFLICT_KIND,
      label: loser.label || CONFLICT_COPY_LABEL,
      table: loser.table,
      uid: loser.uid,
      won: loser.won,
    };
    const snapshot = {
      version: TRASH_SNAPSHOT_VERSION,
      snapshotId: crypto.randomUUID(),
      entity,
      channels: [],
      tags: [],
      photoRefs: [],
      links: [],
      inboxRefs: [],
      conflict,
    };
    statements.push({
      sql: "INSERT INTO trash_items (entity_type, entity_id, snapshot, deleted_at, created_at) VALUES (?, ?, ?, ?, ?)",
      params: [type, id, JSON.stringify(snapshot), today, today],
    });
  }
  return statements;
}

/**
 * §8.4's apply, whole: every staged row and tombstone as ONE statement list.
 *
 * The caller gives this to one `driver.batch`, which is the snapshot's single
 * transaction — a failure leaves no adopted row behind, and an interruption is
 * re-taken from the start rather than resumed.
 *
 * Rows are ordered parents-first (`UID_TABLES`'s own order) no matter what
 * order the batches arrived in, because a child's subselect only finds a parent
 * that was written earlier in the same batch.
 *
 * A tombstone is only ever written forward: `excluded.counter >` the stored one
 * makes a re-delivered delete a no-op instead of a second, older record.
 */
export function snapshotStatements(
  ops: readonly SnapshotOp[],
  tombstones: readonly SnapshotTombstoneOp[] = [],
  now: Date = new Date(),
  senderDeviceId?: string,
): BatchStatement[] {
  // `SYNC_TABLES` is declared in `UID_TABLES`'s order — parents before children
  // — and `store.test.ts` pins the two against each other, so this sort cannot
  // quietly stop being parents-first.
  const order = new Map(
    (Object.keys(SYNC_TABLES) as SyncTable[]).map((table, index) => [
      table,
      index,
    ]),
  );
  const sorted = [...ops].sort(
    (left, right) =>
      (order.get(left.table) ?? 0) - (order.get(right.table) ?? 0),
  );
  const statements: BatchStatement[] = [];
  for (const op of sorted)
    statements.push(...snapshotRowStatements(op, now, senderDeviceId));
  for (const tombstone of tombstones) {
    assertSyncTable(tombstone.table);
    const outranks = tombstoneOutranksRow(
      tombstone.table,
      tombstone.uid,
      tombstone.stamp,
    );
    statements.push({
      // `INSERT … SELECT … WHERE` rather than `VALUES`, because the tombstone
      // itself is guarded: one the live row outranks is not recorded at all.
      // §4 gives the newer write the win, and a tombstone row here would claim
      // the opposite. The conflict clause keeps an older tombstone from
      // replacing a newer one.
      sql: `INSERT INTO sync_tombstones (entity_table, entity_uid, counter, device_id, op_id, deleted_at)
            SELECT ?, ?, ?, ?, ?, ?
            WHERE ${outranks.sql}
            ON CONFLICT(entity_table, entity_uid) DO UPDATE SET
              counter = excluded.counter,
              device_id = excluded.device_id,
              op_id = excluded.op_id,
              deleted_at = excluded.deleted_at
            WHERE excluded.counter > sync_tombstones.counter`,
      params: [
        tombstone.table,
        tombstone.uid,
        tombstone.stamp.counter,
        tombstone.stamp.deviceId,
        tombstone.stamp.opId,
        nowIso(now),
        ...outranks.params,
      ],
    });
    statements.push({
      // §5: a tombstone means the row is **deleted**, not merely recorded. On a
      // first adoption this finds nothing — the phone's uids are its own — but
      // on a re-adopted snapshot (§9.4) it is the difference between a record
      // the desktop has deleted and one still on screen. The same §4 guard
      // decides: a row the tombstone does not outrank stays.
      sql: `DELETE FROM "${tombstone.table}" WHERE uid = ? AND ${outranks.sql}`,
      params: [tombstone.uid, ...outranks.params],
    });
  }
  return statements;
}

/**
 * §4's comparison as SQL: does `stamp` outrank the stamp recorded for
 * `table`/`uid`?
 *
 * `compareStamps`'s order exactly — counter, then device id, then op id — read
 * here by subselect inside the transaction, so it sees the row the same
 * statement list has just written rather than a snapshot taken before it. A
 * row with no stamp row is pre-history (counter 0), so any tombstone outranks
 * it: that is the first-adoption case, and the one a row that predates v9
 * stamps falls into.
 */
function tombstoneOutranksRow(
  table: string,
  uid: string,
  stamp: SnapshotStamp,
): { sql: string; params: unknown[] } {
  return {
    sql: `(
      SELECT CASE
               WHEN s.counter IS NULL THEN 1
               WHEN s.counter < ? THEN 1
               WHEN s.counter = ? AND s.device_id < ? THEN 1
               WHEN s.counter = ? AND s.device_id = ? AND s.op_id < ? THEN 1
               ELSE 0
             END
        FROM (SELECT 1) AS one
        LEFT JOIN sync_row_stamps s
          ON s.entity_table = ? AND s.entity_uid = ?
    ) = 1`,
    params: [
      stamp.counter,
      stamp.counter,
      stamp.deviceId,
      stamp.counter,
      stamp.deviceId,
      stamp.opId,
      table,
      uid,
    ],
  };
}
