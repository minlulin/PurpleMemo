/**
 * First-pair adoption and the initial snapshot — protocol v1 §8.3–§8.4, §9
 * (Phase C Session 3).
 *
 * Three promises, all of them counted rather than asserted:
 *
 * 1. **Adoption, never a wipe** (§9.1): the plan's `deletions` is always empty
 *    and every record on both sides survives — the caller gets the counts, so a
 *    test can compare them to the rows it started with.
 * 2. **Bounded, aggregate-safe batches** (§8.3): a snapshot is cut at 200 ops /
 *    256 KiB, and a caller-declared aggregate is never split across two — even
 *    when the snapshot is read table by table and its rows are far apart.
 * 3. **An interrupted snapshot leaves nothing half-applied** (§8.4, §9.4): the
 *    snapshot is one transaction, so a crash restarts it; what the phone had
 *    already adopted is skipped by UID, never re-inserted.
 */
import {
  compareStamps,
  MAX_BATCH_BYTES,
  MAX_BATCH_OPS,
  type SyncTable,
  type VersionStamp,
} from "./protocol.ts";

/**
 * The pairing frame's budget for one snapshot batch (§8.3).
 *
 * The pairing frame is 64 KiB, and `envelope::seal` **hex**-encodes its
 * ciphertext, so a batch is 30 KiB of plaintext — `MAX_SNAPSHOT_BATCH_BYTES` in
 * `src-tauri/src/pairing_snapshot.rs`. Deliberately not `MAX_BATCH_BYTES`
 * (256 KiB): that is the export's bound, not a sealed frame's, and using it
 * here would let the phone accept a batch the desktop can never send.
 */
export const MAX_PAIRING_SNAPSHOT_BYTES = 30 * 1024;

/** One synced record as a snapshot or an upload carries it (§3.1). */
export interface SyncedRow {
  table: SyncTable;
  uid: string;
  stamp: VersionStamp;
  fields: Record<string, unknown>;
}

export interface BootstrapCounts {
  /** Rows in the desktop snapshot. */
  snapshot: number;
  /** Phone rows the desktop does not hold: uploaded as new records (§9.2). */
  upload: number;
  /** Phone rows with a UID the desktop already holds: merged by §4 later. */
  alreadyKnown: number;
  /** Desktop rows the phone does not hold: they arrive in the snapshot. */
  desktopOnly: number;
  /** Phone rows that stay on the phone. Always `upload + alreadyKnown`. */
  phoneKept: number;
  /** Always 0. Present so a wiping implementation is visible in the counts. */
  deletions: 0;
}

export interface BootstrapPlan {
  snapshot: readonly SyncedRow[];
  upload: readonly SyncedRow[];
  alreadyKnown: readonly SyncedRow[];
  desktopOnly: readonly SyncedRow[];
  /** §9.1: never anything. The field exists so an implementation that wipes
   * cannot hide behind an omission. */
  deletions: readonly string[];
  counts: BootstrapCounts;
}

/**
 * §1.1/§14.2: a record's identity is `(table, uid)`.
 *
 * SQLite's unique indexes are per table (`schema.rs`), so the same UID in two
 * tables is two different records. Keyed by `uid` alone, the later table
 * silently overwrote the earlier one in the map, and a phone row was called
 * `alreadyKnown` — merged into a record it had never seen — on no evidence but
 * a coincidence of UIDs.
 */
function rowKey(row: SyncedRow): string {
  return `${row.table}\u0000${row.uid}`;
}

/**
 * What a first pairing moves, per §9.1–§9.2. Nothing on either side is
 * dropped: the desktop's rows are all in `snapshot`, and every phone row is in
 * `upload` or `alreadyKnown`.
 */
export function planBootstrap(
  desktop: readonly SyncedRow[],
  mobile: readonly SyncedRow[],
): BootstrapPlan {
  const desktopKeys = new Set(desktop.map(rowKey));
  const mobileKeys = new Set(mobile.map(rowKey));
  const upload = mobile.filter((row) => !desktopKeys.has(rowKey(row)));
  const alreadyKnown = mobile.filter((row) => desktopKeys.has(rowKey(row)));
  const desktopOnly = desktop.filter((row) => !mobileKeys.has(rowKey(row)));
  return {
    snapshot: desktop,
    upload,
    alreadyKnown,
    desktopOnly,
    deletions: [],
    counts: {
      snapshot: desktop.length,
      upload: upload.length,
      alreadyKnown: alreadyKnown.length,
      desktopOnly: desktopOnly.length,
      phoneKept: upload.length + alreadyKnown.length,
      deletions: 0,
    },
  };
}

export interface BatchLimits {
  maxOps?: number;
  maxBytes?: number;
  /**
   * The §8.3 aggregate rule: every row that answers the same non-null value
   * here lands in the same batch, adjacent in the input or not. Defaults to no
   * grouping — each row is its own aggregate.
   */
  aggregateOf?: (row: SyncedRow) => string | null;
}

/**
 * The bytes an op costs on the wire, measured the way the wire measures.
 *
 * `String.length` counts UTF-16 code units, so a Burmese letter measures 1
 * here and costs 3 bytes on the wire: a Burmese note measured a third of its
 * real size, and a batch that said it fitted could overflow the frame it was
 * sealed into. `TextEncoder` is the same measurement Rust's `String::len`
 * makes (§8.3).
 */
function rowBytes(row: SyncedRow): number {
  return (
    new TextEncoder().encode(
      JSON.stringify({
        table: row.table,
        uid: row.uid,
        stamp: row.stamp,
        fields: row.fields,
      }),
    ).length + 64
  );
}

/** The rows that must move together (§8.3), and what they cost. */
interface BatchUnit {
  readonly rows: SyncedRow[];
  bytes: number;
}

/**
 * Cut a snapshot into batches (§8.3). A batch is a transaction, so this is
 * also the unit an interruption loses: never more than the limits allow, and
 * never a split aggregate.
 *
 * Aggregates are collected *before* the cut, so a snapshot read table by table
 * (`shopping_lists` → 200 `notes` → `shopping_items`) still carries a list and
 * its items in one batch: grouping rows as they arrive let the parent flush in
 * batch 1 and its children land in batch 2, which splits a transaction that
 * §8.3 and foreign keys both require to be whole.
 *
 * D4: the bound is applied to whole aggregates, never to single rows. A batch
 * is flushed before an aggregate would cross it — 199 notes then a 3-row list
 * is a 199-op batch and a 3-op batch, not 202 ops — so a batch only exceeds
 * 200 ops / 256 KiB when one aggregate alone is larger than a whole batch, and
 * that aggregate travels whole in a batch of its own (§3.2, §8.3).
 */
export function batchSnapshot(
  rows: readonly SyncedRow[],
  limits: BatchLimits = {},
): SyncedRow[][] {
  const maxOps = limits.maxOps ?? MAX_BATCH_OPS;
  const maxBytes = limits.maxBytes ?? MAX_BATCH_BYTES;
  const aggregateOf = limits.aggregateOf ?? (() => null);

  // One unit per aggregate, keeping the order its first row appeared in.
  const units: BatchUnit[] = [];
  const byAggregate = new Map<string, BatchUnit>();
  for (const row of rows) {
    const bytes = rowBytes(row);
    const aggregate = aggregateOf(row);
    if (aggregate === null) {
      units.push({ rows: [row], bytes });
      continue;
    }
    const existing = byAggregate.get(aggregate);
    if (existing) {
      existing.rows.push(row);
      existing.bytes += bytes;
      continue;
    }
    const unit: BatchUnit = { rows: [row], bytes };
    byAggregate.set(aggregate, unit);
    units.push(unit);
  }

  const batches: SyncedRow[][] = [];
  let current: SyncedRow[] = [];
  let currentBytes = 0;
  const flush = (): void => {
    if (current.length > 0) batches.push(current);
    current = [];
    currentBytes = 0;
  };

  for (const unit of units) {
    const wouldOverflow =
      current.length + unit.rows.length > maxOps ||
      currentBytes + unit.bytes > maxBytes;
    // An aggregate that is over the bound on its own still travels: a record
    // that cannot be sent is worse than a batch that cannot be split.
    if (current.length > 0 && wouldOverflow) flush();
    for (const row of unit.rows) current.push(row);
    currentBytes += unit.bytes;
  }
  flush();
  return batches;
}

/**
 * A value as text, with object keys sorted at every depth.
 *
 * `JSON.stringify` keeps insertion order, so two devices holding the very same
 * field values produced different text whenever they built the object in a
 * different order — and a comparison that said "different" archived a trash
 * copy for a conflict that never happened (§9.5, §13.2). Array order is data,
 * so it is kept; only key order is normalized.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`,
      );
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Two rows claiming the same UID with different values: the §4 merge decides. */
export interface SharedUid {
  table: SyncTable;
  uid: string;
  desktop: SyncedRow;
  mobile: SyncedRow;
}

/** The §13.2 list: only these mutable entities archive a losing copy. */
export const TRASHABLE_CONFLICT_TABLES: readonly SyncTable[] = [
  "notes",
  "tasks",
  "shopping_lists",
  "shopping_items",
];

export const CONFLICT_COPY_LABEL = "Conflict copy — kept on this device only";

export interface ConflictLoser {
  table: SyncTable;
  uid: string;
  /** Which side holds the losing value, and so writes the trash copy. */
  loser: "desktop" | "mobile";
  label: string;
  kept: Record<string, unknown>;
  won: Record<string, unknown>;
}

/**
 * §9.5/§13.2: a shared UID that both sides changed differently produces one
 * loser, on one device, archived locally. Habit check-ins and append-only rows
 * never archive anything — a check-in is not content, and the phone cannot
 * edit those tables at all.
 */
export function conflictLosers(shared: readonly SharedUid[]): ConflictLoser[] {
  const losers: ConflictLoser[] = [];
  for (const item of shared) {
    if (!TRASHABLE_CONFLICT_TABLES.includes(item.table)) continue;
    const order = compareStamps(item.desktop.stamp, item.mobile.stamp);
    if (order === 0) continue;
    const desktopWins = order > 0;
    if (canonical(item.desktop.fields) === canonical(item.mobile.fields)) {
      continue;
    }
    losers.push({
      table: item.table,
      uid: item.uid,
      loser: desktopWins ? "mobile" : "desktop",
      label: CONFLICT_COPY_LABEL,
      kept: desktopWins ? item.mobile.fields : item.desktop.fields,
      won: desktopWins ? item.desktop.fields : item.mobile.fields,
    });
  }
  return losers;
}

/**
 * The §9.3 summary, in the plain words the user reads on both screens. Counts
 * only — never a promise the caller has to remember to keep.
 */
export function adoptionSummary(plan: BootstrapPlan): string[] {
  return [
    `${plan.counts.snapshot} record(s) on the desktop are ready for this phone.`,
    `${plan.counts.upload} record(s) created on this phone will be added to the desktop.`,
    `${plan.counts.alreadyKnown} record(s) already exist on both sides and will be merged.`,
    "Nothing is deleted on either device.",
  ];
}

export interface AdoptionCheckpoint {
  pairingId: string;
  /** Batches committed so far. A snapshot is one transaction (§8.4), so the
   * only meaningful values are 0 and "all of them". */
  appliedBatches: number;
  totalBatches: number;
}

export type ResumeDecision =
  | { action: "start" }
  | { action: "complete" }
  | { action: "restart"; reason: string };

/**
 * §8.4/§9.4: a snapshot is all-or-nothing. A checkpoint that stopped part-way
 * is not resumed from the middle — it is restarted, because half a snapshot
 * was never applied in the first place. A checkpoint for a different pairing id
 * is discarded for the same reason.
 */
export function resumeAdoption(
  checkpoint: AdoptionCheckpoint | null,
  pairingId: string,
): ResumeDecision {
  if (!checkpoint) return { action: "start" };
  if (checkpoint.pairingId !== pairingId) {
    return {
      action: "restart",
      reason: "this snapshot belongs to an earlier pairing (§11.4).",
    };
  }
  if (checkpoint.appliedBatches >= checkpoint.totalBatches) {
    return { action: "complete" };
  }
  return {
    action: "restart",
    reason:
      "an interrupted snapshot applies nothing, so it is re-taken (§8.4).",
  };
}
