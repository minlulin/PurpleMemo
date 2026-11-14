/**
 * Stage 1's apply half — a peer's operations, merged into this device
 * (`docs/ANDROID_SYNC_PROTOCOL.md` §4, §5, §7).
 *
 * House shape, like `store.ts`: this module composes `BatchStatement[]` and
 * never writes. The caller owns the transaction, which is what makes §7.4 hold
 * — every op in a batch commits or none do, and the cursor advance
 * (`applyStatements`) is the last statement of that same batch (§6.4).
 *
 * It DOES read local state, through the driver it is given: a per-field merge
 * cannot be written without asking what this device already holds and under
 * which stamp. The reads happen while the batch is composed, so a refused op
 * (§7.7) writes nothing at all.
 *
 * Order inside the batch:
 *
 * 1. the §13.2 conflict copies, PREPENDED — a copy is the losing value as this
 *    device still holds it, written in the winning apply's transaction (§5.5);
 * 2. the Lamport advance (§4.2), so the next local write outranks what was
 *    merged here;
 * 3. the effects, in the order the ops arrived (§7.6);
 * 4. the cursor, appended by `applyStatements` (§6.4).
 */
import type { BatchStatement, DataDriver } from "../../data/driver.ts";
import { CONFLICT_COPY_LABEL } from "./bootstrap.ts";
import {
  compareStamps,
  isSyncTable,
  type OpKind,
  type Origin,
  type SyncTable,
  updateFieldsAllowed,
  type VersionStamp,
  writeAllowed,
} from "./protocol.ts";
import {
  applyStatements,
  CONFLICT_TRASH_TYPES,
  conflictCopyStatements,
  FOREIGN_KEYS,
  foldStatements,
  type HeldConflictRow,
  LOCAL_FOREIGN_KEYS,
  NATURAL_KEYS,
  readVaultMetadata,
  splitVaultMetadata,
  vaultMetadataStatements,
  vaultWipeStatements,
} from "./store.ts";

/**
 * The tables sync moves: all seventeen of §2.1's core.
 *
 * This is the ONE place the set lives — the engine's stage gate below and the
 * session's sender filter both read it, so a table can never travel without
 * being applicable. Stage 3 added `vault_items`, the last one: it travels
 * desktop→mobile only, under its password generation (§12.3), and the
 * authority in `writeAllowed` is what keeps it one-way.
 */
export const UNLOCKED_TABLES = [
  "collections",
  "notes",
  "tasks",
  "reminders",
  "shopping_lists",
  "shopping_items",
  "habits",
  "habit_logs",
  "wallets",
  "income_categories",
  "expense_categories",
  "income_entries",
  "expense_entries",
  "shops",
  "jobs",
  "loans",
  "vault_items",
] as const satisfies readonly SyncTable[];

const OP_KINDS: readonly OpKind[] = ["create", "update", "toggle", "delete"];

/** A field name an op may carry: lowercase, unquoted, never SQL. */
const IDENTIFIER = /^[a-z][a-z0-9_]*$/;

/**
 * One operation as the sender's outbox row names it (§6.2) — the shape
 * `readOutbox` returns, which Session 3 ferries verbatim.
 *
 * `field_stamps` and `payload` are JSON text, exactly as stored: parsing them
 * is the engine's first act, because a malformed one is a §7.7 refusal and not
 * a value to guess at.
 */
export interface PeerOp {
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
}

export interface ApplyRequest {
  /** The peer whose cursor this batch advances (§6.4). */
  peerId: string;
  /**
   * Who SENT these ops (§2.3). Authority is checked against the sender, not
   * this device: a phone's op may not edit a note even though the desktop can.
   */
  origin: Origin;
  /** In `seq` order, as the sender's outbox hands them over (§7.6). */
  ops: readonly PeerOp[];
}

/** The row shape the stamp reads return, kept local so the merges read clean. */
interface StampRow {
  counter: number;
  device_id: string;
  op_id: string;
}

interface LocalRowStampRow extends StampRow {
  field_stamps: string;
}

function toStamp(row: StampRow): VersionStamp {
  return { counter: row.counter, deviceId: row.device_id, opId: row.op_id };
}

function opStamp(op: PeerOp): VersionStamp {
  return { counter: op.counter, deviceId: op.device_id, opId: op.op_id };
}

/** §4's comparison for a row that has no stamp at all: pre-history loses. */
function outranks(
  incoming: VersionStamp,
  held: VersionStamp | undefined,
): boolean {
  return held === undefined || compareStamps(incoming, held) > 0;
}

function highest(stamps: readonly VersionStamp[]): VersionStamp | undefined {
  let winner: VersionStamp | undefined;
  for (const stamp of stamps) {
    if (winner === undefined || compareStamps(stamp, winner) > 0) {
      winner = stamp;
    }
  }
  return winner;
}

function parsePayload(op: PeerOp): Record<string, unknown> {
  const raw: unknown = JSON.parse(op.payload);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `op ${op.device_id}#${op.seq} (${op.entity_table} ${op.entity_uid}) carries a payload that is not an object (§3.4).`,
    );
  }
  return raw as Record<string, unknown>;
}

/**
 * The payload fields an op may write as columns.
 *
 * For every table but one this is the payload. A vault payload also carries
 * the §12.3 envelope (`vault_generation`, `vault_verifier`), which are not
 * columns: the engine strips them here and writes them into this device's own
 * settings instead — never into the row.
 */
function rowFieldsOf(op: PeerOp): Record<string, unknown> {
  const payload = parsePayload(op);
  return op.entity_table === "vault_items"
    ? splitVaultMetadata(payload).fields
    : payload;
}

/** The op's per-field stamps, each of which must itself be a stamp (§4.3). */
function parseFieldStamps(op: PeerOp): Record<string, VersionStamp> {
  const raw: unknown = JSON.parse(op.field_stamps);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(
      `op ${op.device_id}#${op.seq} (${op.entity_table} ${op.entity_uid}) carries field stamps that are not an object (§4.3).`,
    );
  }
  const stamps: Record<string, VersionStamp> = {};
  for (const [field, value] of Object.entries(raw as Record<string, unknown>)) {
    const stamp = value as Record<string, unknown> | null;
    if (
      typeof stamp !== "object" ||
      stamp === null ||
      typeof stamp.counter !== "number" ||
      typeof stamp.deviceId !== "string" ||
      typeof stamp.opId !== "string"
    ) {
      throw new Error(
        `op ${op.device_id}#${op.seq} names ${field} with a field stamp that is not a stamp (§4.3).`,
      );
    }
    stamps[field] = {
      counter: stamp.counter,
      deviceId: stamp.deviceId,
      opId: stamp.opId,
    };
  }
  return stamps;
}

/**
 * One payload field as the row column it writes, and — for a foreign key — the
 * parent table its value names by uid.
 *
 * A payload names a parent by UID (`collection_uid`), never by this device's
 * row number: `collection_id` means a different record on every device, so a
 * payload carrying one is refused rather than applied to whatever happens to
 * hold that number here (§3.4, §8.4).
 */
function destinationOf(
  table: SyncTable,
  field: string,
  op: PeerOp,
): { column: string; parent?: SyncTable } {
  const refuse = (why: string): never => {
    throw new Error(
      `op ${op.device_id}#${op.seq} sends ${table}.${field}, ${why} (§3.4).`,
    );
  };
  if (field === "uid" || field === "id") {
    refuse("which is identity, not a field — the uid is the record");
  }
  const parent = FOREIGN_KEYS[table]?.[field];
  if (parent !== undefined) {
    return { column: `${field.slice(0, -"_uid".length)}_id`, parent };
  }
  if (LOCAL_FOREIGN_KEYS[table]?.[field] !== undefined) {
    refuse(
      "a local row number that means nothing on this device; name the parent by uid",
    );
  }
  if (field.endsWith("_uid")) {
    refuse("which names no parent table this build syncs");
  }
  if (!IDENTIFIER.test(field)) {
    refuse("which is not a column name");
  }
  return { column: field };
}

/** `?` for a plain value, a uid subselect for a parent, `NULL` for no parent. */
function resolveValue(
  value: unknown,
  parent: SyncTable | undefined,
): { sql: string; params: unknown[] } {
  if (parent === undefined) return { sql: "?", params: [value] };
  if (value === null || value === undefined) return { sql: "NULL", params: [] };
  return { sql: `(SELECT id FROM "${parent}" WHERE uid = ?)`, params: [value] };
}

/**
 * A row-level stamp write (§4.2, §8.4). The field stamps travel with it
 * because the next merge compares per field, and a row stamp with no field
 * stamps behind it would make every field read as pre-history.
 */
function rowStampStatement(
  table: SyncTable,
  uid: string,
  stamp: VersionStamp,
  fieldStamps: Record<string, VersionStamp>,
  now: string,
): BatchStatement {
  return {
    sql: `INSERT INTO sync_row_stamps (entity_table, entity_uid, counter, device_id, op_id, field_stamps, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(entity_table, entity_uid) DO UPDATE SET
            counter = excluded.counter,
            device_id = excluded.device_id,
            op_id = excluded.op_id,
            field_stamps = excluded.field_stamps,
            updated_at = excluded.updated_at`,
    params: [
      table,
      uid,
      stamp.counter,
      stamp.deviceId,
      stamp.opId,
      JSON.stringify(fieldStamps),
      now,
    ],
  };
}

/**
 * §5.1's tombstone, written under the same total order the merge uses: a
 * re-delivered delete replaces nothing, and an older delete never displaces a
 * newer one — the comparison has to stay decidable for the next op.
 */
function tombstoneStatement(
  table: SyncTable,
  uid: string,
  stamp: VersionStamp,
  now: string,
): BatchStatement {
  return {
    sql: `INSERT INTO sync_tombstones (entity_table, entity_uid, counter, device_id, op_id, deleted_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(entity_table, entity_uid) DO UPDATE SET
            counter = excluded.counter,
            device_id = excluded.device_id,
            op_id = excluded.op_id,
            deleted_at = excluded.deleted_at
          WHERE excluded.counter > sync_tombstones.counter
             OR (excluded.counter = sync_tombstones.counter AND excluded.device_id > sync_tombstones.device_id)
             OR (excluded.counter = sync_tombstones.counter AND excluded.device_id = sync_tombstones.device_id AND excluded.op_id > sync_tombstones.op_id)`,
    params: [table, uid, stamp.counter, stamp.deviceId, stamp.opId, now],
  };
}

/** §7.1/§7.7: everything the batch must refuse before a single row is written. */
function validate(op: PeerOp, request: ApplyRequest): void {
  const name = `op ${op.device_id}#${op.seq}`;
  if (op.device_id !== request.peerId) {
    throw new Error(
      `${name} claims another device than the peer whose batch it arrived in (${request.peerId}) (§7.7).`,
    );
  }
  if (!isSyncTable(op.entity_table)) {
    throw new Error(
      `${name} names ${op.entity_table}, which is not on the sync allowlist (§2.2).`,
    );
  }
  const table = op.entity_table;
  if (!(UNLOCKED_TABLES as readonly string[]).includes(table)) {
    throw new Error(
      `${name} names ${table}, which Stage 2 does not move (§12.1, §12.2).`,
    );
  }
  if (!OP_KINDS.includes(op.op)) {
    throw new Error(
      `${name} carries an unknown operation (${String(op.op)}) (§7.7).`,
    );
  }
  if (typeof op.entity_uid !== "string" || op.entity_uid.length === 0) {
    throw new Error(`${name} names no record (§7.7).`);
  }
  if (op.op === "delete") {
    const verdict = writeAllowed(table, "delete", request.origin);
    if (!verdict.allowed) {
      throw new Error(`${name} was refused: ${verdict.reason}`);
    }
    return;
  }
  const fields = Object.keys(rowFieldsOf(op));
  const verdict =
    op.op === "update"
      ? updateFieldsAllowed(table, fields, request.origin)
      : writeAllowed(table, op.op, request.origin);
  if (!verdict.allowed)
    throw new Error(`${name} was refused: ${verdict.reason}`);
  for (const field of fields) destinationOf(table, field, op);
  if (table === "vault_items") {
    // §4.4: a vault row is aggregate-atomic. A write naming only part of the
    // sealed triple could not land a row anyone can decrypt, so it is refused
    // by name rather than half-applied.
    const missing = ["ciphertext", "salt", "iv"].filter(
      (column) => !fields.includes(column),
    );
    if (missing.length > 0) {
      throw new Error(
        `${name} sends a vault row without ${missing.join(", ")} (§4.4).`,
      );
    }
  }
}

/**
 * §7.2 / §8.4: what this device already holds for the create being applied.
 *
 * Three answers, and they are three different cases — conflating the second
 * with the first is what left a peer's uid unadopted:
 *
 * - `held`: a row wearing this uid IS this record, so the create is the same
 *   write delivered twice — nothing to do (§7.2).
 * - `fold`: the natural key (`NATURAL_KEYS`) is held under a DIFFERENT uid.
 *   §8.4 says a natural key folds, it never collides: the baseline seeds every
 *   wallet and category on each install under random uids, and either device
 *   may create `Food`, so the local row and the incoming record are one record
 *   spelled two ways. The local row is re-keyed onto the incoming uid and the
 *   create then lands through §4's merge.
 * - `new`: nothing here shares either spelling; the row is inserted.
 */
type Identity =
  | { kind: "held" }
  | { kind: "fold"; localUid: string }
  | { kind: "new" };

async function identityOf(
  driver: DataDriver,
  table: SyncTable,
  op: PeerOp,
  fields: Record<string, unknown>,
): Promise<Identity> {
  const [byUid] = await driver.query<{ one: number }>(
    `SELECT 1 AS one FROM "${table}" WHERE uid = ?`,
    [op.entity_uid],
  );
  if (byUid !== undefined) return { kind: "held" };

  const key = NATURAL_KEYS[table];
  if (key === undefined) return { kind: "new" };
  const value = fields[key];
  // A natural key is never null on these tables (`name TEXT NOT NULL UNIQUE`),
  // so a create that omitted one has nothing to collide with.
  if (typeof value !== "string" && typeof value !== "number") {
    return { kind: "new" };
  }
  const [byKey] = await driver.query<{ uid: string | null }>(
    `SELECT uid FROM "${table}" WHERE "${key}" = ? LIMIT 1`,
    [value],
  );
  if (byKey === undefined) return { kind: "new" };
  // A row with no uid is pre-v7 drift; it cannot be re-keyed onto one.
  if (typeof byKey.uid !== "string" || byKey.uid.length === 0) {
    return { kind: "new" };
  }
  return { kind: "fold", localUid: byKey.uid };
}

/**
 * The row a create lands: every payload field, plus the uid. A create carries
 * the record's whole definition — the sender wrote them all in one op — so
 * there is nothing to merge when the row is new here.
 */
function insertStatements(
  op: PeerOp,
  fields: Record<string, unknown>,
  stamp: VersionStamp,
  fieldStamps: Record<string, VersionStamp>,
  now: string,
): { effects: BatchStatement[]; held: HeldRow } {
  const table = op.entity_table as SyncTable;
  const columns = ["uid"];
  const values = ["?"];
  const params: unknown[] = [op.entity_uid];
  const stamps: Record<string, VersionStamp> = {};
  const row: Record<string, unknown> = { uid: op.entity_uid };
  for (const [field, value] of Object.entries(fields)) {
    // §13.1: a reminder's creator is the operation's author, never a payload
    // claim — the column is stamped below, from `op.device_id` alone.
    if (table === "reminders" && field === "created_by_device_id") continue;
    const destination = destinationOf(table, field, op);
    const resolved = resolveValue(value, destination.parent);
    columns.push(destination.column);
    values.push(resolved.sql);
    params.push(...resolved.params);
    // Every field's stamp is the op's own unless the sender carried a
    // per-field one (§4.3) — either way the row records where each value came
    // from, which is what the next merge compares against.
    stamps[field] = fieldStamps[field] ?? stamp;
    // The in-batch view of the row. A uid valued field keeps the uid it named;
    // a local row number cannot be known before the insert commits, and a
    // pending row never earns a copy anyway, so it has none here.
    row[destination.column] =
      destination.parent === undefined ? (value ?? null) : null;
  }
  if (table === "reminders") {
    // §13.1's border stamp: a create op's author IS the reminder's creator, so
    // the receiving device can never hold a synced reminder with no creator.
    // A create op's payload carries no such field, and nothing rewrites this
    // column afterwards — the delivery filter depends on both halves.
    columns.push("created_by_device_id");
    values.push("?");
    params.push(op.device_id);
    row.created_by_device_id = op.device_id;
    stamps.created_by_device_id = fieldStamps.created_by_device_id ?? stamp;
  }
  return {
    effects: [
      {
        sql: `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(", ")})
              VALUES (${values.join(", ")})`,
        params,
      },
      rowStampStatement(table, op.entity_uid, stamp, stamps, now),
    ],
    held: { row, stamp, fieldStamps: stamps, pending: true },
  };
}

/** One row this device holds, and the stamp it holds it under (§4.2). */
interface HeldRow {
  row: Record<string, unknown>;
  stamp: VersionStamp | undefined;
  fieldStamps: Record<string, VersionStamp>;
  /**
   * True when this row is an INSERT earlier in the same batch, so it has no
   * local id yet. A value that arrived in this very batch is not "a value this
   * device held", so it never earns a §13.2 copy — and it could not be
   * archived by local id anyway.
   */
  pending?: boolean;
}

function stampsOf(raw: string): Record<string, VersionStamp> {
  const stamps: Record<string, VersionStamp> = {};
  for (const [field, value] of Object.entries(
    JSON.parse(raw) as Record<string, unknown>,
  )) {
    const candidate = value as VersionStamp | null;
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      typeof candidate.counter === "number" &&
      typeof candidate.deviceId === "string" &&
      typeof candidate.opId === "string"
    ) {
      stamps[field] = {
        counter: candidate.counter,
        deviceId: candidate.deviceId,
        opId: candidate.opId,
      };
    }
  }
  return stamps;
}

async function readHeld(
  driver: DataDriver,
  table: SyncTable,
  uid: string,
): Promise<HeldRow | undefined> {
  const [row] = await driver.query<Record<string, unknown>>(
    `SELECT * FROM "${table}" WHERE uid = ?`,
    [uid],
  );
  if (!row) return undefined;
  const [stampRow] = await driver.query<LocalRowStampRow>(
    "SELECT counter, device_id, op_id, field_stamps FROM sync_row_stamps WHERE entity_table = ? AND entity_uid = ?",
    [table, uid],
  );
  return {
    row,
    stamp: stampRow ? toStamp(stampRow) : undefined,
    fieldStamps: stampRow ? stampsOf(stampRow.field_stamps) : {},
  };
}

async function readTombstone(
  driver: DataDriver,
  table: SyncTable,
  uid: string,
): Promise<VersionStamp | undefined> {
  const [row] = await driver.query<StampRow>(
    "SELECT counter, device_id, op_id FROM sync_tombstones WHERE entity_table = ? AND entity_uid = ?",
    [table, uid],
  );
  return row ? toStamp(row) : undefined;
}

/**
 * What this batch has already decided about one record, before it commits.
 *
 * §7.6 applies ops "in the order given", and a batch can name the same record
 * twice — create then edit, delete then restore. Composing every op against
 * the COMMITTED state would make the second op blind to the first: a
 * delete-after-create in one batch would leave two rows, and a restore-after-
 * delete would resurrect nothing. This overlay is that ordering, held in
 * memory for the length of one composition.
 */
type BatchEntry = { held: HeldRow } | { gone: VersionStamp };

function batchKey(table: string, uid: string): string {
  return `${table}\u0000${uid}`;
}

/** What one op contributed: its effects, and the §13.2 copy it earned. */
interface OpOutcome {
  effects: BatchStatement[];
  /** The losing values, by payload field name — what the copy shows as `kept`. */
  lostFields: Record<string, unknown>;
  /** The winning values this apply wrote over them. */
  wonFields: Record<string, unknown>;
  /** The losing row as this device still holds it (empty when nothing lost). */
  held: readonly HeldConflictRow[];
  /** What the rest of this batch should now assume about the record. */
  next?: BatchEntry;
}

const EMPTY_OUTCOME: OpOutcome = {
  effects: [],
  lostFields: {},
  wonFields: {},
  held: [],
};

/**
 * §4's merge for one op on a row this device holds.
 *
 * Field by field: the incoming stamp for a field (its own if the op carried
 * one, else the op's stamp) is compared with the stamp this device holds for
 * that field, and the loser's value is simply not written. The row's stamp
 * entry becomes the merge's outcome — the highest stamp involved — so a third
 * peer recomputing the merge reaches the same answer (§4.5).
 *
 * A field whose local value is outranked is a §13.2 loser: the row as this
 * device held it is archived, on this device, in the same transaction. Two
 * kinds of table opt out — a check-in is not content, and an overwritten
 * reminder definition is not either — and `CONFLICT_TRASH_TYPES` is the list.
 */
function mergeOp(
  op: PeerOp,
  held: HeldRow,
  stamp: VersionStamp,
  fieldStamps: Record<string, VersionStamp>,
  now: string,
): OpOutcome {
  const table = op.entity_table as SyncTable;
  const fields = parsePayload(op);
  const mergedFields: Record<string, VersionStamp> = { ...held.fieldStamps };
  const assignments: string[] = [];
  const params: unknown[] = [];
  const lostFields: Record<string, unknown> = {};
  const wonFields: Record<string, unknown> = {};
  const won: Record<string, unknown> = {};
  const moved: VersionStamp[] = [];

  for (const [field, value] of Object.entries(fields)) {
    const destination = destinationOf(table, field, op);
    const incoming = fieldStamps[field] ?? stamp;
    const local = held.fieldStamps[field] ?? held.stamp;
    // This device's value stands, and the peer's value is the loser — which
    // the PEER archives, on its own device (§13.2). Nothing to copy here.
    if (!outranks(incoming, local)) continue;

    // The incoming value wins, so the value this device was holding is the
    // §13.2 loser and is archived here, in this same transaction — unless
    // the two sides agree, because a field both devices left alone is not a
    // conflict. A foreign key is compared by presence only: one side holds a
    // local row number and the other a uid, so the numbers are not comparable.
    const localValue = held.row[destination.column] ?? null;
    const disagrees =
      destination.parent === undefined
        ? localValue !== (value ?? null)
        : (localValue === null) !== (value === null || value === undefined);
    if (disagrees && !held.pending) {
      lostFields[field] = localValue;
      wonFields[field] = value ?? null;
    }
    const resolved = resolveValue(value, destination.parent);
    assignments.push(`"${destination.column}" = ${resolved.sql}`);
    params.push(...resolved.params);
    mergedFields[field] = incoming;
    moved.push(incoming);
    won[destination.column] = value ?? null;
  }

  if (assignments.length === 0) {
    // §7.2: a stale op — or this very op, delivered again — writes nothing.
    return { ...EMPTY_OUTCOME, lostFields, wonFields };
  }

  // The record's stamp is the highest stamp behind any value it now holds, so
  // the next comparison starts from the merge's outcome (§4.2).
  const outcome = highest([...(held.stamp ? [held.stamp] : []), ...moved]);
  return {
    effects: [
      {
        sql: `UPDATE "${table}" SET ${assignments.join(", ")} WHERE uid = ?`,
        params: [...params, op.entity_uid],
      },
      rowStampStatement(
        table,
        op.entity_uid,
        outcome ?? stamp,
        mergedFields,
        now,
      ),
    ],
    lostFields,
    wonFields,
    held:
      Object.keys(lostFields).length > 0 && CONFLICT_TRASH_TYPES[table]
        ? [{ table, uid: op.entity_uid, row: held.row }]
        : [],
    next: {
      held: {
        row: { ...held.row, ...won },
        stamp: outcome ?? stamp,
        fieldStamps: mergedFields,
        pending: held.pending,
      },
    },
  };
}

/**
 * The complete-row write a vault op lands (§12.3, §4.4).
 *
 * An upsert by uid rather than an UPDATE: after a rotation the incoming set is
 * written into a table this batch has just emptied, and even without one the
 * payload is the whole sealed row, so an insert and an update are the same
 * write. Every column present in the payload lands, and nothing else is
 * touched — the row is aggregate-atomic, not field-merged.
 */
function vaultUpsertStatement(
  op: PeerOp,
  fields: Record<string, unknown>,
): BatchStatement {
  const columns: string[] = ["uid"];
  const values: string[] = ["?"];
  const params: unknown[] = [op.entity_uid];
  for (const [field, value] of Object.entries(fields)) {
    const destination = destinationOf("vault_items", field, op);
    columns.push(`"${destination.column}"`);
    values.push("?");
    params.push(value ?? null);
  }
  const updates = columns
    .filter((column) => column !== "uid")
    .map((column) => `${column} = excluded.${column}`);
  return {
    sql: `INSERT INTO vault_items (${columns.join(", ")})
          VALUES (${values.join(", ")})
          ON CONFLICT(uid) DO UPDATE SET ${updates.join(", ")}`,
    params,
  };
}

/**
 * §12.3's vault path — the ONE table-specific branch the spec orders.
 *
 * Two things differ from §4's field merge, and both are the clause:
 *
 *  - **aggregate-atomic (§4.4).** A vault row is a sealed triple, so the op is
 *    compared as a WHOLE row: the winner's ciphertext/salt/iv land together or
 *    none of them does. There is no per-field winner and no §13.2 copy — a
 *    losing vault value is not content, so Vault stays out of
 *    `CONFLICT_TRASH_TYPES`.
 *  - **generation-aware (§12.3).** A rotation re-seals every item and sends it
 *    as an `update`, so after the wipe an op for a record this device does not
 *    hold still writes it (`adopt`). §5.3's "an edit for a missing record
 *    writes nothing" exists because an ordinary edit names only its fields;
 *    a vault payload always carries the whole row.
 */
async function composeVaultOp(
  driver: DataDriver,
  op: PeerOp,
  now: string,
  overlay: Map<string, BatchEntry>,
  adopt: boolean,
): Promise<OpOutcome> {
  const table = "vault_items" as const;
  const stamp = opStamp(op);
  const key = batchKey(table, op.entity_uid);
  const prior = overlay.get(key);
  // After a wipe nothing this device holds is part of the new generation, and
  // nothing this batch composed before it survived it either.
  const held = adopt
    ? undefined
    : prior !== undefined
      ? "held" in prior
        ? prior.held
        : undefined
      : await readHeld(driver, table, op.entity_uid);
  const tombstone = adopt
    ? undefined
    : prior !== undefined
      ? "gone" in prior
        ? prior.gone
        : undefined
      : await readTombstone(driver, table, op.entity_uid);

  if (op.op === "delete") {
    if (tombstone !== undefined && tombstone.opId === op.op_id) {
      return EMPTY_OUTCOME; // §7.2: already applied.
    }
    const effects: BatchStatement[] = [];
    const removed = held !== undefined && outranks(stamp, held.stamp);
    if (removed) {
      effects.push({
        sql: 'DELETE FROM "vault_items" WHERE uid = ?',
        params: [op.entity_uid],
      });
      effects.push({
        sql: "DELETE FROM sync_row_stamps WHERE entity_table = ? AND entity_uid = ?",
        params: [table, op.entity_uid],
      });
    }
    effects.push(tombstoneStatement(table, op.entity_uid, stamp, now));
    return {
      ...EMPTY_OUTCOME,
      effects,
      next: removed || held === undefined ? { gone: stamp } : undefined,
    };
  }

  if (!adopt) {
    // §5.3: a record a tombstone still outranks stays dead.
    if (
      held === undefined &&
      tombstone !== undefined &&
      outranks(tombstone, stamp)
    ) {
      return EMPTY_OUTCOME;
    }
    // §4.4: the row's stamp decides the whole row, so an op that does not
    // outrank what this device holds writes none of its three fields.
    if (held !== undefined && !outranks(stamp, held.stamp)) {
      return EMPTY_OUTCOME;
    }
  }

  const { fields } = splitVaultMetadata(parsePayload(op));
  const stamps: Record<string, VersionStamp> = {};
  const row: Record<string, unknown> = { uid: op.entity_uid };
  for (const [field, value] of Object.entries(fields)) {
    stamps[field] = stamp;
    row[field] = value ?? null;
  }
  return {
    ...EMPTY_OUTCOME,
    effects: [
      vaultUpsertStatement(op, fields),
      rowStampStatement(table, op.entity_uid, stamp, stamps, now),
    ],
    next: { held: { row, stamp, fieldStamps: stamps } },
  };
}

/**
 * One op, applied (§7). Reads what this device holds, decides by §4's order,
 * and returns the statements plus any losing value a §13.2 copy must keep.
 *
 * `adopt` is §12.3's one exception: after a generation change has wiped the
 * local vault, the incoming set is written whole rather than compared.
 */
async function composeOp(
  driver: DataDriver,
  op: PeerOp,
  now: string,
  overlay: Map<string, BatchEntry>,
  adopt = false,
): Promise<OpOutcome> {
  const table = op.entity_table as SyncTable;
  if (table === "vault_items") {
    return composeVaultOp(driver, op, now, overlay, adopt);
  }
  const stamp = opStamp(op);
  const delivered = parseFieldStamps(op);
  const key = batchKey(table, op.entity_uid);
  const prior = overlay.get(key);

  // §7.6: what THIS batch already did to the record outranks what the last
  // commit left behind — an op after a create in the same batch must see the
  // row the create is about to write, not the absence it is replacing.
  const held =
    prior !== undefined
      ? "held" in prior
        ? prior.held
        : undefined
      : await readHeld(driver, table, op.entity_uid);
  const tombstone =
    prior !== undefined
      ? "gone" in prior
        ? prior.gone
        : undefined
      : await readTombstone(driver, table, op.entity_uid);

  if (op.op === "delete") {
    if (tombstone !== undefined && tombstone.opId === op.op_id) {
      return EMPTY_OUTCOME; // §7.2: already applied.
    }
    const effects: BatchStatement[] = [];
    const removed = held !== undefined && outranks(stamp, held.stamp);
    if (removed) {
      effects.push({
        sql: `DELETE FROM "${table}" WHERE uid = ?`,
        params: [op.entity_uid],
      });
      effects.push({
        sql: "DELETE FROM sync_row_stamps WHERE entity_table = ? AND entity_uid = ?",
        params: [table, op.entity_uid],
      });
    }
    // §5.3: a row that outranks the delete survives it — and the tombstone is
    // still written, with its own stamp, so the next op has something to
    // compare against. The guard keeps an older delete from displacing a newer.
    effects.push(tombstoneStatement(table, op.entity_uid, stamp, now));
    return {
      ...EMPTY_OUTCOME,
      effects,
      // The row is gone either way as far as later ops are concerned: either
      // this delete removed it, or it was never here to remove.
      next: removed || held === undefined ? { gone: stamp } : undefined,
    };
  }

  if (held === undefined) {
    // §5.3: a record the tombstone still outranks stays dead, and re-delivery
    // of an op the tombstone already answered changes nothing.
    if (tombstone !== undefined && outranks(tombstone, stamp)) {
      return EMPTY_OUTCOME;
    }
    // Resurrection needs the whole record, and only a create op carries it. A
    // field-level edit that outranks a tombstone cannot rebuild the row it
    // edits here: inserting the fields it names would either break the table's
    // constraints (wedging every later batch on the same op) or converge the
    // two devices on a half-row. So an edit for a record this device does not
    // hold writes nothing — which is why the Trash restore records a
    // create-kind op under the same uid (§5.3).
    if (op.op !== "create") {
      return EMPTY_OUTCOME;
    }
    const fields = parsePayload(op);
    const identity = await identityOf(driver, table, op, fields);
    // §7.2: a create for a record this device already holds BY UID writes
    // nothing — that delivery is the same write arriving twice.
    if (identity.kind === "held") return EMPTY_OUTCOME;
    if (identity.kind === "fold") {
      // §8.4: the row holding this name under another uid IS this record. Its
      // `id` never changes, so every child already written against it stays
      // attached — and a child op that names the incoming uid now resolves,
      // because that uid is the row's from here on.
      const held = await readHeld(driver, table, identity.localUid);
      if (held !== undefined) {
        const rekeyed: HeldRow = {
          ...held,
          row: { ...held.row, uid: op.entity_uid },
        };
        const merged = mergeOp(op, rekeyed, stamp, delivered, now);
        const fold = foldStatements({ table, uid: op.entity_uid, fields });
        const outcome: OpOutcome =
          merged.effects.length > 0
            ? { ...merged, effects: [...fold, ...merged.effects] }
            : {
                ...merged,
                // Nothing of the create outranked what the row already holds,
                // but the identity still folded: carry the row's own stamp
                // across to its new key, so §4.2 still sees the write its
                // values came from.
                effects: [
                  ...fold,
                  ...(held.stamp
                    ? [
                        rowStampStatement(
                          table,
                          op.entity_uid,
                          held.stamp,
                          held.fieldStamps,
                          now,
                        ),
                      ]
                    : []),
                ],
              };
        if (outcome.next === undefined) outcome.next = { held: rekeyed };
        return outcome;
      }
    }
    const inserted = insertStatements(op, fields, stamp, delivered, now);
    return {
      ...EMPTY_OUTCOME,
      effects: inserted.effects,
      next: { held: inserted.held },
    };
  }

  return mergeOp(op, held, stamp, delivered, now);
}

/**
 * Apply a peer's operations: ONE batch, the caller's one transaction.
 *
 * Every op is validated first (§7.1), so a refused op refuses the batch with
 * zero effects (§7.7) — nothing here is half-applied, nothing silently skipped.
 * The statements are wrapped by `applyStatements`, so the cursor moves only if
 * the whole batch commits (§6.4).
 */
export async function applyOps(
  driver: DataDriver,
  request: ApplyRequest,
): Promise<BatchStatement[]> {
  const { peerId, ops, origin } = request;
  if (ops.length === 0) return [];
  for (const op of ops) validate(op, request);

  const now = new Date().toISOString();
  const copies: BatchStatement[] = [];
  const effects: BatchStatement[] = [];
  let highestSeq = 0;
  let highestCounter = 0;

  const overlay = new Map<string, BatchEntry>();
  /**
   * The password generation this device holds (§12.3 decision 1), read at most
   * once per batch — only a batch carrying vault ops needs it.
   */
  let vaultGeneration: number | null = null;
  /** The §12.3 metadata is written once per batch, with the items it names. */
  let vaultMetadataWritten = false;

  for (const op of ops) {
    // §6.4: the cursor advances past every op the batch carries, including one
    // this device decided to write nothing for — otherwise it is re-delivered
    // for ever.
    if (op.seq > highestSeq) highestSeq = op.seq;
    if (op.counter > highestCounter) highestCounter = op.counter;

    let adopt = false;
    if (op.entity_table === "vault_items") {
      const name = `op ${op.device_id}#${op.seq}`;
      const { metadata } = splitVaultMetadata(parsePayload(op));
      if (metadata.generation === null) {
        // Without a generation this device cannot tell whether the op may be
        // mixed with what it holds, and guessing is the F3 failure itself.
        throw new Error(`${name} carries no vault generation (§12.3).`);
      }
      vaultGeneration ??= (await readVaultMetadata(driver)).generation ?? 0;
      // A generation this device has already left behind is a re-delivered op
      // from before a rotation: it writes nothing, and none of its metadata.
      // Applying it would put an item sealed under the old password back into
      // a vault whose verifier proves the new one (F3).
      if (metadata.generation < vaultGeneration) continue;
      if (metadata.generation > vaultGeneration) {
        // Decision 3: a new generation REPLACES the local set. The wipe is a
        // statement of this batch, so the incoming generation lands in the
        // same transaction — never beside the outgoing one.
        effects.push(...vaultWipeStatements());
        for (const key of [...overlay.keys()]) {
          if (key.startsWith("vault_items\u0000")) overlay.delete(key);
        }
        vaultGeneration = metadata.generation;
        adopt = true;
      }
      if (!vaultMetadataWritten) {
        // Decision 2: this device's own settings, inside the batch that
        // applies the items — the phone's `vault.ts` reads exactly these.
        effects.push(...vaultMetadataStatements(metadata));
        vaultMetadataWritten = true;
      }
    }

    const outcome = await composeOp(driver, op, now, overlay, adopt);
    if (outcome.next)
      overlay.set(batchKey(op.entity_table, op.entity_uid), outcome.next);
    if (outcome.held.length > 0) {
      // §5.5: the copy is written by the device that held the losing value,
      // in the winning apply's own transaction.
      copies.push(
        ...conflictCopyStatements(
          [
            {
              table: op.entity_table as SyncTable,
              uid: op.entity_uid,
              // This device holds the loser, so it writes the copy; the sender
              // is the other side of the pairing.
              loser: origin === "mobile" ? "desktop" : "mobile",
              label: CONFLICT_COPY_LABEL,
              kept: outcome.lostFields,
              won: outcome.wonFields,
            },
          ],
          outcome.held,
        ),
      );
    }
    effects.push(...outcome.effects);
  }

  // §4.2: the next local write outranks everything just merged. One statement
  // for the batch, because the clock only ever moves forward.
  const clock: BatchStatement = {
    sql: "UPDATE sync_state SET lamport = max(lamport, ?), updated_at = ? WHERE id = 1",
    params: [highestCounter, now],
  };

  return applyStatements(peerId, highestSeq, [...copies, clock, ...effects]);
}
