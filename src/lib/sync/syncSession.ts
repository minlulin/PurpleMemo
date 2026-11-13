/**
 * One sync session — the phone's half driving `/pair/sync`
 * (`docs/ANDROID_SYNC_PROTOCOL.md` §6, §7).
 *
 * A session is a value with an order, not a promise in a comment:
 *
 * 1. this device's outbox rows past the desktop's acknowledgement are pushed,
 *    filtered to the eight Stage 1 tables (§12.1) — an operation for a table a
 *    later stage moves can exist here (a Trash restore records for any synced
 *    table) and it stays home, because the engine on the other side would only
 *    refuse it;
 * 2. the desktop's operations are pulled from this device's `cursor_in`, one
 *    wire batch at a time, and applied with `applyOps` in ONE batch per wire
 *    batch — foreign keys resolve inside the apply, so the sender's seq order
 *    is the order to apply in, never a re-sort;
 * 3. the highest applied seq is reported, so the desktop can record it (§6.5);
 * 4. the push's verdict is polled, and only a sealed `applied` records the
 *    desktop's acknowledgement of what was pushed.
 *
 * Nothing here is remembered between sessions: `cursor_in` moved inside each
 * apply batch (§6.4) and `cursor_out` moves with the acknowledgement, so an
 * interrupted session resumes from the cursors and never from memory.
 */
import type {
  BatchStatement,
  DataDriver,
  PairingDriver,
  SnapshotPullInput,
  SyncStatusResult,
} from "../../data/driver.ts";
import { MAX_PAIRING_SNAPSHOT_BYTES } from "./bootstrap.ts";
import { applyOps, type PeerOp, STAGE_ONE_TABLES } from "./engine.ts";
import { MAX_BATCH_OPS } from "./protocol.ts";
import { ackStatements, readOutbox, readPeers } from "./store.ts";

/** The driver surface one session uses — one method per Rust command. */
export interface SyncTransport {
  syncPush(
    input: SnapshotPullInput,
    batch: number,
    total: number,
    ops: readonly PeerOp[],
  ): Promise<void>;
  syncCommit(input: SnapshotPullInput): Promise<void>;
  syncPull(
    input: SnapshotPullInput,
    batch: number,
    afterSeq: number,
  ): Promise<{
    pairingId: string;
    batch: number;
    total: number;
    ops: unknown[];
  }>;
  syncApplied(input: SnapshotPullInput, throughSeq: number): Promise<void>;
  syncStatus(input: SnapshotPullInput): Promise<SyncStatusResult>;
  batch(statements: BatchStatement[]): Promise<void>;
}

/** How long the phone asks for the push verdict before it stops (§9.4's cadence). */
const STATUS_ATTEMPTS = 30;
const STATUS_WAIT_MS = 1_000;

export interface SyncRefusal {
  code: string;
  message: string;
}

/** What one session did — a value, so the order can be tested. */
export interface SyncOutcome {
  /** True only once the desktop's sealed verdict said `applied`. */
  confirmed: boolean;
  /** Operations this device sent (0 when it had nothing past the cursor). */
  pushed: number;
  /** Operations the desktop sent, across every batch. */
  pulled: number;
  /** The highest seq this device applied of the desktop's. */
  appliedThrough: number;
  /** The desktop's acknowledged position, once a verdict settled it. */
  ackThrough: number;
  /** `applied`, `failed`, `pending` (the poll gave up), or `refused`. */
  state: "applied" | "failed" | "pending" | "refused";
  refusal: SyncRefusal | null;
}

const refuse = (code: string, message: string, pushed = 0): SyncOutcome => ({
  confirmed: false,
  pushed,
  pulled: 0,
  appliedThrough: 0,
  ackThrough: 0,
  state: "refused",
  refusal: { code, message },
});

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The desktop's words carry the code (`upload-busy: …`); split it back off. */
function splitRefusal(message: string): SyncRefusal {
  const match = /^([a-z][a-z0-9-]*):\s+(.*)$/s.exec(message);
  return match
    ? { code: match[1] ?? "refused", message: match[2] ?? message }
    : { code: "refused", message };
}

/**
 * One outbox row as the wire's operation document (§6.2). The stored JSON is
 * passed through untouched: the receiver's engine parses it, and a payload it
 * cannot parse is that engine's refusal to make, not this sender's to repair.
 */
function wireOp(row: {
  device_id: string;
  seq: number;
  op_id: string;
  entity_table: string;
  entity_uid: string;
  op: string;
  base_counter: number;
  counter: number;
  field_stamps: string;
  payload: string;
}): PeerOp {
  return {
    device_id: row.device_id,
    seq: row.seq,
    op_id: row.op_id,
    entity_table: row.entity_table,
    entity_uid: row.entity_uid,
    op: row.op as PeerOp["op"],
    base_counter: row.base_counter,
    counter: row.counter,
    field_stamps: row.field_stamps,
    payload: row.payload,
  };
}

/**
 * Split the operations into frames of at most `MAX_BATCH_OPS` and at most
 * `MAX_PAIRING_SNAPSHOT_BYTES`, in order — the same bound every other wire
 * batch obeys (§8.3). A single operation too large for a frame is sent alone:
 * the receiver's frame cap is the one that decides whether it is admissible.
 */
export function batchSyncOps(ops: readonly PeerOp[]): PeerOp[][] {
  const batches: PeerOp[][] = [];
  let current: PeerOp[] = [];
  let bytes = 0;
  for (const op of ops) {
    const size = new TextEncoder().encode(JSON.stringify(op)).length;
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_OPS ||
        bytes + size > MAX_PAIRING_SNAPSHOT_BYTES)
    ) {
      batches.push(current);
      current = [];
      bytes = 0;
    }
    current.push(op);
    bytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Narrow wire documents to operations before the engine sees them, so a
 * malformed batch is refused by name rather than half-applied. The engine
 * validates the semantics (§7.7); this is the shape.
 */
export function readSyncOps(
  raw: unknown[],
): { ok: true; ops: PeerOp[] } | { ok: false; reason: string } {
  const bad = (reason: string) => ({ ok: false as const, reason });
  if (!Array.isArray(raw))
    return bad("a sync batch carries its operations as a list.");
  if (raw.length > MAX_BATCH_OPS) {
    return bad(`a batch carries at most ${MAX_BATCH_OPS} operations (§8.3).`);
  }
  const ops: PeerOp[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return bad("an operation is not a document.");
    }
    const doc = entry as Record<string, unknown>;
    const text = [
      "device_id",
      "op_id",
      "entity_table",
      "entity_uid",
      "field_stamps",
      "payload",
      "op",
    ];
    if (text.some((key) => typeof doc[key] !== "string")) {
      return bad("an operation does not carry the fields §6.2 names.");
    }
    const numbers = ["seq", "base_counter", "counter"];
    if (
      numbers.some(
        (key) =>
          typeof doc[key] !== "number" || !Number.isSafeInteger(doc[key]),
      )
    ) {
      return bad("an operation does not carry its sequence and stamps.");
    }
    ops.push(doc as unknown as PeerOp);
  }
  return { ok: true, ops };
}

/** Narrow one pulled batch's documents to operations before the engine sees them. */
export function readSyncBatch(
  raw: {
    pairingId: string;
    batch: number;
    total: number;
    ops: unknown[];
  },
  expected: { pairingId: string; batch: number },
):
  | { ok: true; ops: PeerOp[]; total: number }
  | { ok: false; refusal: SyncRefusal } {
  const bad = (message: string, code = "malformed") => ({
    ok: false as const,
    refusal: { code, message },
  });
  if (raw.pairingId !== expected.pairingId) {
    return bad(
      "that batch belongs to a different pairing.",
      "pairing-mismatch",
    );
  }
  if (raw.batch !== expected.batch) {
    return bad(
      "the desktop answered with a different batch than the one asked for.",
    );
  }
  if (
    typeof raw.total !== "number" ||
    !Number.isSafeInteger(raw.total) ||
    raw.total < 1 ||
    expected.batch >= raw.total
  ) {
    return bad("the desktop's batch names no usable batch count.");
  }
  const read = readSyncOps(raw.ops);
  if (!read.ok) return bad(read.reason);
  return { ok: true, ops: read.ops, total: raw.total };
}

/**
 * Run one session (§6). The phone drives every step; the desktop only answers.
 *
 * Refusals come back as a value with the desktop's own words — a sync that
 * could not finish says so rather than reporting success, and nothing is
 * marked delivered on the strength of having sent it.
 */
export async function runSync(
  driver: DataDriver,
  transport: SyncTransport,
  input: SnapshotPullInput,
  options: {
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<SyncOutcome> {
  const peer = (await readPeers(driver)).find(
    (row) => row.device_id === input.desktopDeviceId,
  );
  if (peer === undefined || peer.revoked_at !== null) {
    return refuse(
      "unpaired",
      "this device has not pinned that desktop, or the pairing was revoked (§11.2).",
    );
  }
  const pairingId = peer.pairing_id ?? "";

  // 1. Push. Only the eight Stage 1 tables travel (§12.1, decision 3): an op
  // for a later stage can exist here and stays in the outbox for later.
  const stageOne = new Set<string>(STAGE_ONE_TABLES);
  const pending = (await readOutbox(driver)).filter(
    (row) => row.seq > peer.cursor_out && stageOne.has(row.entity_table),
  );
  const pushing = pending.map(wireOp);
  if (pushing.length > 0) {
    const batches = batchSyncOps(pushing);
    for (let batch = 0; batch < batches.length; batch += 1) {
      try {
        await transport.syncPush(
          input,
          batch,
          batches.length,
          batches[batch] ?? [],
        );
      } catch (error) {
        return {
          ...refuse("push-refused", errorText(error), pushing.length),
          refusal: splitRefusal(errorText(error)),
        };
      }
    }
    try {
      await transport.syncCommit(input);
    } catch (error) {
      return {
        ...refuse("push-refused", errorText(error), pushing.length),
        refusal: splitRefusal(errorText(error)),
      };
    }
  }

  // 2. Pull, from the cursor this device's last apply left (§6.4).
  const afterSeq = peer.cursor_in;
  let appliedThrough = afterSeq;
  let pulled = 0;
  let batch = 0;
  for (;;) {
    let raw: Awaited<ReturnType<SyncTransport["syncPull"]>>;
    try {
      raw = await transport.syncPull(input, batch, afterSeq);
    } catch (error) {
      return {
        ...refuse("pull-refused", errorText(error), pushing.length),
        pulled,
        appliedThrough,
        refusal: splitRefusal(errorText(error)),
      };
    }
    const read = readSyncBatch(raw, { pairingId, batch });
    if (!read.ok) {
      return {
        ...refuse(read.refusal.code, read.refusal.message, pushing.length),
        pulled,
        appliedThrough,
        refusal: read.refusal,
      };
    }
    pulled += read.ops.length;
    if (read.ops.length > 0) {
      let statements: BatchStatement[];
      try {
        // The engine reads this device's rows and stamps through the driver,
        // so it needs the store — not just the transport's batch.
        statements = await applyOps(driver, {
          peerId: input.desktopDeviceId,
          origin: "desktop",
          ops: read.ops,
        });
      } catch (error) {
        return {
          ...refuse("apply-refused", errorText(error), pushing.length),
          pulled,
          appliedThrough,
          refusal: splitRefusal(errorText(error)),
        };
      }
      try {
        await transport.batch(statements);
      } catch (error) {
        return {
          ...refuse("apply-refused", errorText(error), pushing.length),
          pulled,
          appliedThrough,
          refusal: splitRefusal(errorText(error)),
        };
      }
      for (const op of read.ops) {
        if (op.seq > appliedThrough) appliedThrough = op.seq;
      }
    }
    batch += 1;
    if (batch >= read.total) break;
  }

  // 3. Report the position. The desktop turns it into an acknowledgement on
  // its own tick; sending the unchanged cursor is a no-op there (§6.5).
  try {
    await transport.syncApplied(input, appliedThrough);
  } catch (error) {
    return {
      ...refuse("applied-refused", errorText(error), pushing.length),
      pulled,
      appliedThrough,
      refusal: splitRefusal(errorText(error)),
    };
  }

  // 4. The verdict. Nothing pushed is nothing to wait for: the pull stands on
  // its own, and the cursor is already where it should be.
  if (pushing.length === 0) {
    return {
      confirmed: true,
      pushed: 0,
      pulled,
      appliedThrough,
      ackThrough: peer.cursor_out,
      state: "applied",
      refusal: null,
    };
  }

  // Only the sealed `applied` moves `cursor_out`.
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < STATUS_ATTEMPTS; attempt += 1) {
    let status: SyncStatusResult;
    try {
      status = await transport.syncStatus(input);
    } catch (error) {
      return {
        ...refuse("status-refused", errorText(error), pushing.length),
        pulled,
        appliedThrough,
        refusal: splitRefusal(errorText(error)),
      };
    }
    if (status.state === "applied") {
      await transport.batch(
        ackStatements(input.desktopDeviceId, status.throughSeq),
      );
      return {
        confirmed: true,
        pushed: pushing.length,
        pulled,
        appliedThrough,
        ackThrough: status.throughSeq,
        state: "applied",
        refusal: null,
      };
    }
    if (status.state === "failed") {
      return {
        confirmed: false,
        pushed: pushing.length,
        pulled,
        appliedThrough,
        ackThrough: peer.cursor_out,
        state: "failed",
        refusal: {
          code: "sync-failed",
          message: status.message ?? "the desktop could not apply the push.",
        },
      };
    }
    await sleep(STATUS_WAIT_MS);
  }
  // Silence is not success: this device keeps everything it pushed, marks
  // nothing delivered, and says so — the next session re-sends the same ops.
  return {
    confirmed: false,
    pushed: pushing.length,
    pulled,
    appliedThrough,
    ackThrough: peer.cursor_out,
    state: "pending",
    refusal: {
      code: "sync-unconfirmed",
      message:
        "the desktop did not confirm the sync in time — your changes stay on this device, and running a sync again is safe.",
    },
  };
}

/** Bind the session to the one production driver (`data/app.ts`). */
export function createSyncRepo(driver: DataDriver & PairingDriver) {
  const transport: SyncTransport = {
    syncPush: (input, batch, total, ops) =>
      driver.pairingSyncPush(input, batch, total, [...ops]),
    syncCommit: (input) => driver.pairingSyncCommit(input),
    syncPull: (input, batch, afterSeq) =>
      driver.pairingSyncPull(input, batch, afterSeq),
    syncApplied: (input, throughSeq) =>
      driver.pairingSyncApplied(input, throughSeq),
    syncStatus: (input) => driver.pairingSyncStatus(input),
    batch: (statements) => driver.batch(statements),
  };
  return {
    run: (input: SnapshotPullInput) => runSync(driver, transport, input),
  };
}
