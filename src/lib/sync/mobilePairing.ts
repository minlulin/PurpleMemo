/**
 * The phone's half of pairing: the camera frame, the typed code, and the wire
 * step — protocol §11.1 and §11.6.1 (Phase C Session 6 Q.2; Session 7 T2).
 *
 * Both entries drive the same values `pairing.ts` already defines:
 *
 * - a camera frame goes through `qr.ts`'s decode (`jsqr`) and then
 *   `parseOffer`, so a scan is the same proof the desktop's rendered QR is
 *   tested against — pixels in, an offer with a named refusal out;
 * - a typed code goes through `redeemCode`, so the expired / used / locked /
 *   malformed / wrong-code answers and their attempt counting are the tested
 *   ones, never a second implementation written for the phone.
 *
 * The wire step is `pairWithDesktop`. The sealed request → ack → hello runs in
 * Rust behind `PairingPhoneTransport.pair`, because the long-term key lives in
 * the platform keystore and a webview that could seal with it could also read
 * it. That command resolves only after the desktop has opened the phone's
 * sealed hello, so the pin is written **after** possession is proven — never on
 * the ack alone (wave 1 N1, mirrored on this side).
 */
import type {
  BatchStatement,
  DataDriver,
  PairingDriver,
  PairingPhoneInput,
  PhonePairResult,
  SnapshotBatchResult,
  SnapshotPullInput,
} from "../../data/driver.ts";
import {
  type AdoptionCheckpoint,
  MAX_PAIRING_SNAPSHOT_BYTES,
} from "./bootstrap.ts";
import {
  type CodeVerdict,
  desktopPinStatements,
  normalizeCode,
  type PairingOffer,
  type PairingSession,
  redeemCode,
} from "./pairing.ts";
import { isSyncTable, MAX_BATCH_OPS } from "./protocol.ts";
import { type QrPixels, scanOffer } from "./qr.ts";
import {
  applyStatements,
  type PeerRow,
  readPeers,
  type SnapshotOp,
  type SnapshotStamp,
  type SnapshotTombstoneOp,
  snapshotStatements,
} from "./store.ts";

export type FrameOutcome =
  | { ok: true; offer: PairingOffer }
  | { ok: false; kind: "empty-frame" | "invalid-qr"; reason: string };

/**
 * One camera frame through the same decode path the rendered QR is proven
 * against: RGBA pixels → `jsqr` → `parseOffer`. The refusal carries its kind, so
 * the caller can keep scanning an empty frame but stop on a QR it refused.
 */
export function offerFromFrame(pixels: QrPixels): FrameOutcome {
  return scanOffer(pixels);
}

/**
 * The session a scan starts (§11.1, §4.1).
 *
 * The offer's timestamps are the *desktop's* clock, and the phone's is a
 * different clock that can be minutes or days off. Judging local expiry against
 * `expiresAt` with `Date.now()` (the bug, N6) made a fast phone reject a code it
 * had just scanned. Instead the code's lifetime is measured from the scan — the
 * one instant both sides agree is "now" — and the desktop stays authoritative
 * on whether the window itself is still open.
 */
export function scannedSession(
  offer: PairingOffer,
  now: number = Date.now(),
): PairingSession {
  const lifetime = Math.max(0, offer.expiresAt - offer.createdAt);
  return {
    offer: { ...offer, createdAt: now, expiresAt: now + lifetime },
    failedAttempts: [],
    usedAt: null,
  };
}

/** What the numeric entry knows: the scanned offer and its own attempts. */
export type TypedCodeSession = PairingSession;

/**
 * Type the six digits shown on the desktop. `wrong-code` costs an attempt,
 * `malformed` costs none, and the fifth wrong guess locks the code — all of it
 * decided by `redeemCode`.
 */
export function confirmTypedCode(
  session: TypedCodeSession,
  typed: string,
  now: number = Date.now(),
): { verdict: CodeVerdict; session: TypedCodeSession } {
  return redeemCode(session, typed, now);
}

/** True when the entry is worth offering: six digits, spaces and dashes allowed. */
export function isCompleteCode(typed: string): boolean {
  return normalizeCode(typed) !== null;
}

/** The phone's pin of the desktop (§11.2) — the key the QR carried. */
export function desktopPin(offer: PairingOffer): {
  deviceId: string;
  publicKey: string;
  generation: number;
  pairingId: string;
} {
  return {
    deviceId: offer.deviceId,
    publicKey: offer.publicKey,
    generation: offer.generation,
    pairingId: offer.pairingId,
  };
}

/**
 * The wire step and the two local reads a pairing needs. Narrow on purpose:
 * the orchestration below cannot open a socket, cannot read the key, and cannot
 * write anything except the pin statements it was handed.
 */
export interface PairingPhoneTransport {
  /** The sealed request → ack → hello, in Rust; resolves only after the hello. */
  pair(input: PairingPhoneInput): Promise<PhonePairResult>;
  /** Every pin this phone holds, from `sync_peers`. */
  peers(): Promise<PeerRow[]>;
  /** One transaction of pin writes. */
  batch(statements: BatchStatement[]): Promise<void>;
}

/** What one pairing attempt did — a value, so the order can be tested. */
export interface PairingOutcome {
  /** The session after the attempt; a used code stays used. */
  session: PairingSession;
  /** The code verdict, exactly as `redeemCode` words it. */
  verdict: CodeVerdict;
  /** True only once the desktop acknowledged the sealed hello. */
  paired: boolean;
  /** The desktop's facts, once it acknowledged. */
  desktop: PhonePairResult | null;
  /** What this attempt wrote to `sync_peers`; empty unless `paired`. */
  statements: BatchStatement[];
  /**
   * Why nothing was paired, when the code was right but the wire was not: the
   * desktop's own reason code (`wrong-code`, `unpaired`, `unauthenticated`, …)
   * or `pin-failed`, which means the desktop accepted the phone but the pin
   * could not be stored.
   */
  refusal: { code: string; message: string } | null;
}

/**
 * The Rust command's error text is `"{code}: {message}"` (§11.6.1 — the wire's
 * reason, then its words). Split it so the UI can show the protocol's message
 * and still keep the code for branching.
 */
export function splitRefusal(text: string): { code: string; message: string } {
  const at = text.indexOf(": ");
  return at === -1
    ? { code: "refused", message: text }
    : { code: text.slice(0, at), message: text.slice(at + 2) };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pair with the desktop in the scanned offer (§11.1, §11.6.1).
 *
 * The order is the point, and it is the same rule the desktop's panel enforces:
 *
 * 1. the code is redeemed first — attempts, single use and every refusal come
 *    from `redeemCode`, so a wrong code never reaches the network;
 * 2. the wire step runs in Rust and resolves only after the desktop opened the
 *    phone's sealed hello, which is the proof of key possession;
 * 3. only then is the pin written, through the desktop's own pin/re-pair path
 *    (`desktopPinStatements`).
 *
 * A refused code, a refused rendezvous or a desktop that goes away mid-call
 * writes nothing at all.
 */
export async function pairWithDesktop(
  transport: PairingPhoneTransport,
  session: PairingSession,
  typed: string,
  now: number = Date.now(),
): Promise<PairingOutcome> {
  const { verdict, session: redeemed } = redeemCode(session, typed, now);
  const code = normalizeCode(typed);
  if (!verdict.ok || code === null) {
    return {
      session: redeemed,
      verdict,
      paired: false,
      desktop: null,
      statements: [],
      refusal: null,
    };
  }

  let desktop: PhonePairResult;
  try {
    desktop = await transport.pair({
      endpoint: session.offer.endpoint,
      pairingId: session.offer.pairingId,
      publicKey: session.offer.publicKey,
      code,
    });
  } catch (error) {
    return {
      session: redeemed,
      verdict,
      paired: false,
      desktop: null,
      statements: [],
      refusal: splitRefusal(errorText(error)),
    };
  }

  try {
    const peers = await transport.peers();
    const existing =
      peers.find((row) => row.device_id === desktop.desktopDeviceId) ?? null;
    const statements = desktopPinStatements(
      desktop,
      session.offer,
      existing,
      new Date(now),
    );
    await transport.batch(statements);
    return {
      session: redeemed,
      verdict,
      paired: true,
      desktop,
      statements,
      refusal: null,
    };
  } catch (error) {
    return {
      session: redeemed,
      verdict,
      paired: false,
      desktop,
      statements: [],
      refusal: {
        code: "pin-failed",
        message: `the desktop accepted this phone, but the pin could not be stored: ${errorText(error)}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// §8.4 — the pull: request every batch, stage them all, apply once, adopt.
// ---------------------------------------------------------------------------

/**
 * What the pull does, in the words the card shows before it starts.
 *
 * It states the two promises a person cannot see for themselves: the snapshot
 * is all-or-nothing, and nothing on either device is deleted (§9.1). The last
 * sentence is the honest half of a partial feature: there is no upload yet, so
 * what this phone created is not sent anywhere.
 */
export const SNAPSHOT_PULL_DISCLOSURE =
  "This copies the desktop's records to this phone in one step: either the whole snapshot arrives or none of it does. Nothing is deleted on either device.";

/** §9.1's other half, which is not built yet — never left unsaid. */
export const SNAPSHOT_PULL_MISSING =
  "Records you created on this phone stay here, and they are not sent to the desktop yet — that direction is not built.";

/** The pull's narrow surface: three sealed messages and one transaction. */
export interface SnapshotPullTransport {
  /** One sealed `snapshot-request`, answered with the batch it names. */
  request(
    input: SnapshotPullInput,
    batch: number,
  ): Promise<SnapshotBatchResult>;
  /** One sealed `applied`; bookkeeping on the desktop, nothing written here. */
  applied(input: SnapshotPullInput, batch: number): Promise<void>;
  /** One sealed `adopted`, with the counts the summary reports. */
  adopted(
    input: SnapshotPullInput,
    rows: number,
    tombstones: number,
  ): Promise<void>;
  /** ONE transaction: the whole snapshot or nothing (§8.4). */
  batch(statements: BatchStatement[]): Promise<void>;
  /** This phone's pins, so the adoption names the peer it came from. */
  peers(): Promise<PeerRow[]>;
}

export interface SnapshotRefusal {
  code: string;
  message: string;
}

/** One batch, checked and measured, before anything is staged. */
export interface StagedBatch {
  batch: number;
  total: number;
  ops: SnapshotOp[];
  tombstones: SnapshotTombstoneOp[];
  /** The document's own cost in UTF-8 bytes — what the frame carries. */
  bytes: number;
}

/** A uid the snapshot may carry: canonical lowercase UUID, any version. */
const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readStamp(raw: unknown): SnapshotStamp | null {
  if (!isRecord(raw)) return null;
  const { counter, deviceId, opId } = raw;
  if (
    typeof counter !== "number" ||
    !Number.isSafeInteger(counter) ||
    counter < 0
  ) {
    return null;
  }
  if (typeof deviceId !== "string" || !UID.test(deviceId)) return null;
  if (typeof opId !== "string" || opId.length === 0) return null;
  return { counter, deviceId, opId };
}

type RowRead =
  | { ok: true; op: SnapshotOp }
  | { ok: true; tombstone: SnapshotTombstoneOp }
  | { ok: false; reason: string };

/**
 * One op, narrowed from the desktop's document.
 *
 * The table must be on the allowlist (§2.2), the uid must be the canonical
 * form the schema mints, and the stamp must be complete (§4.2) — a row without
 * one could not be merged later, so accepting it would store a record this
 * build can never reconcile. Nothing here invents a value: a field that is
 * missing stays missing, and the column's own NOT NULL constraint decides.
 */
function readRow(raw: unknown, tombstone: boolean): RowRead {
  if (!isRecord(raw)) {
    return { ok: false, reason: "a snapshot entry is not an object." };
  }
  const { table, uid, stamp } = raw;
  if (typeof table !== "string" || !isSyncTable(table)) {
    return {
      ok: false,
      reason: `${JSON.stringify(table)} is not on the sync allowlist (§2.2).`,
    };
  }
  if (typeof uid !== "string" || !UID.test(uid)) {
    return { ok: false, reason: `a ${table} entry carries no usable uid.` };
  }
  const read = readStamp(stamp);
  if (read === null) {
    return {
      ok: false,
      reason: `a ${table} entry carries no usable stamp (§4.2).`,
    };
  }
  if (tombstone) return { ok: true, tombstone: { table, uid, stamp: read } };
  const { fields } = raw;
  if (!isRecord(fields)) {
    return { ok: false, reason: `a ${table} row carries no fields.` };
  }
  return { ok: true, op: { table, uid, stamp: read, fields } };
}

/**
 * Check one batch before it is staged (§8.4).
 *
 * Every refusal happens here, before a statement is built, so a batch that
 * names an excluded table, a malformed uid or an impossible index writes
 * nothing at all — the pull has not touched the database at that point.
 */
export function readSnapshotBatch(
  raw: unknown,
  expected: { batch: number; pairingId: string },
): { ok: true; batch: StagedBatch } | { ok: false; refusal: SnapshotRefusal } {
  const refuse = (message: string, code = "malformed") => ({
    ok: false as const,
    refusal: { code, message },
  });
  if (!isRecord(raw)) return refuse("the desktop's batch is not a document.");
  if (raw.pairingId !== expected.pairingId) {
    return refuse(
      "that batch belongs to a different pairing.",
      "pairing-mismatch",
    );
  }
  if (raw.batch !== expected.batch) {
    return refuse(
      "the desktop answered with a different batch than the one requested.",
    );
  }
  const total = raw.total;
  if (
    typeof total !== "number" ||
    !Number.isSafeInteger(total) ||
    total < 1 ||
    expected.batch >= total
  ) {
    return refuse("the desktop's snapshot names no usable batch count.");
  }
  const ops = raw.ops;
  const tombstones = raw.tombstones;
  if (!Array.isArray(ops) || !Array.isArray(tombstones)) {
    return refuse("a snapshot batch carries its ops and tombstones as lists.");
  }
  if (ops.length + tombstones.length > MAX_BATCH_OPS) {
    return refuse(`a batch carries at most ${MAX_BATCH_OPS} ops (§8.3).`);
  }
  // Measured in UTF-8 bytes, the way the frame and the seal measure it. A
  // Burmese name is 3 bytes a letter, and `.length` would say 1.
  const bytes = new TextEncoder().encode(JSON.stringify(raw)).length;
  if (bytes > MAX_PAIRING_SNAPSHOT_BYTES) {
    return refuse(
      `a sealed batch is limited to ${MAX_PAIRING_SNAPSHOT_BYTES} bytes (§8.3).`,
    );
  }
  const staged: SnapshotOp[] = [];
  for (const entry of ops) {
    const read = readRow(entry, false);
    if (!read.ok) return refuse(read.reason);
    if ("op" in read) staged.push(read.op);
  }
  const deleted: SnapshotTombstoneOp[] = [];
  for (const entry of tombstones) {
    const read = readRow(entry, true);
    if (!read.ok) return refuse(read.reason);
    if ("tombstone" in read) deleted.push(read.tombstone);
  }
  return {
    ok: true,
    batch: {
      batch: expected.batch,
      total,
      ops: staged,
      tombstones: deleted,
      bytes,
    },
  };
}

/** One batch's progress, for the card's "batch 2 of 4". */
export interface PullProgress {
  batch: number;
  total: number;
}

/** What one pull did — a value, so the order can be tested. */
export interface SnapshotPullOutcome {
  /** True only once the whole snapshot committed in one transaction. */
  applied: boolean;
  /** Batches committed. 0 unless `applied`. */
  batches: number;
  rows: number;
  tombstones: number;
  /** §8.4: a pull that stopped applies nothing, so this records 0 or all. */
  checkpoint: AdoptionCheckpoint | null;
  refusal: SnapshotRefusal | null;
  /** The §9.3 sentences, empty when nothing was applied. */
  summary: string[];
}

/** The §9.3 summary for a snapshot-only adoption. */
export function snapshotSummary(rows: number, tombstones: number): string[] {
  return [
    `${rows} record(s) arrived from the desktop.`,
    `${tombstones} deletion(s) came with them, so those records stay deleted here.`,
    "Nothing was deleted on either device.",
    SNAPSHOT_PULL_MISSING,
  ];
}

/**
 * Pull the desktop's snapshot (§8.4).
 *
 * The order is the clause, and it is why this is a loop rather than a request:
 *
 * 1. every batch is requested in index order and staged in memory — nothing
 *    touches the database while this runs, so a pull that fails half way has
 *    left no trace;
 * 2. each staged batch is acknowledged, which is the desktop's bookkeeping and
 *    not this phone's;
 * 3. the ENTIRE snapshot is written in one `transport.batch`, so an error or a
 *    crash leaves either all of it or none of it — never half;
 * 4. only then is it adopted, with the counts the summary reports.
 *
 * A refusal at any step returns `applied: false` and a checkpoint that says the
 * pull stopped at 0, so `resumeAdoption` restarts it instead of resuming from
 * the middle (§8.4).
 */
export async function pullSnapshot(
  transport: SnapshotPullTransport,
  input: SnapshotPullInput,
  options: {
    pairingId: string;
    onProgress?: (progress: PullProgress) => void;
  },
): Promise<SnapshotPullOutcome> {
  const stalled = (refusal: SnapshotRefusal, total: number) => ({
    applied: false,
    batches: 0,
    rows: 0,
    tombstones: 0,
    checkpoint:
      total > 0
        ? {
            pairingId: options.pairingId,
            appliedBatches: 0,
            totalBatches: total,
          }
        : null,
    refusal,
    summary: [],
  });

  const staged: SnapshotOp[] = [];
  const deleted: SnapshotTombstoneOp[] = [];
  let total = 0;
  let batch = 0;
  for (;;) {
    let raw: SnapshotBatchResult;
    try {
      raw = await transport.request(input, batch);
    } catch (error) {
      return stalled(splitRefusal(errorText(error)), total);
    }
    const read = readSnapshotBatch(raw, {
      batch,
      pairingId: options.pairingId,
    });
    if (!read.ok) return stalled(read.refusal, total);
    total = read.batch.total;
    staged.push(...read.batch.ops);
    deleted.push(...read.batch.tombstones);
    options.onProgress?.({ batch: batch + 1, total });
    try {
      await transport.applied(input, batch);
    } catch (error) {
      return stalled(splitRefusal(errorText(error)), total);
    }
    batch += 1;
    if (batch >= total) break;
  }

  // ONE transaction for the whole snapshot. `applyStatements` with seq 0 is
  // the same shape every apply uses; a snapshot has no sequence of its own, so
  // the cursor it would move is left exactly where it was.
  let statements: BatchStatement[];
  try {
    statements = applyStatements(
      input.desktopDeviceId,
      0,
      snapshotStatements(staged, deleted),
    );
  } catch (error) {
    return stalled(splitRefusal(errorText(error)), total);
  }
  try {
    await transport.batch(statements);
  } catch (error) {
    // The batch is one transaction, so a failure here left nothing adopted.
    return stalled(splitRefusal(errorText(error)), total);
  }

  const rows = staged.length;
  const tombstones = deleted.length;
  const checkpoint = {
    pairingId: options.pairingId,
    appliedBatches: total,
    totalBatches: total,
  };
  try {
    await transport.adopted(input, rows, tombstones);
  } catch (error) {
    // The rows ARE committed — reporting a refusal as if nothing arrived would
    // be a lie. The refusal is still returned, so the card can say that the
    // desktop was not told.
    return {
      applied: true,
      batches: total,
      rows,
      tombstones,
      checkpoint,
      refusal: splitRefusal(errorText(error)),
      summary: snapshotSummary(rows, tombstones),
    };
  }
  return {
    applied: true,
    batches: total,
    rows,
    tombstones,
    checkpoint,
    refusal: null,
    summary: snapshotSummary(rows, tombstones),
  };
}

/** Bind the phone's pairing to the one production driver (`data/app.ts`). */
export function createMobilePairingRepo(driver: DataDriver & PairingDriver) {
  const transport: PairingPhoneTransport & SnapshotPullTransport = {
    pair: (input) => driver.pairingPhonePair(input),
    peers: () => readPeers(driver),
    batch: async (statements) => {
      await driver.batch(statements);
    },
    request: (input, batch) => driver.pairingSnapshotRequest(input, batch),
    applied: (input, batch) => driver.pairingSnapshotApplied(input, batch),
    adopted: (input, rows, tombstones) =>
      driver.pairingSnapshotAdopted(input, rows, tombstones),
  };
  return {
    pairWithDesktop: (
      session: PairingSession,
      typed: string,
      now?: number,
    ): Promise<PairingOutcome> =>
      pairWithDesktop(transport, session, typed, now),
    pullSnapshot: (
      input: SnapshotPullInput,
      pairingId: string,
      onProgress?: (progress: PullProgress) => void,
    ): Promise<SnapshotPullOutcome> =>
      pullSnapshot(transport, input, { pairingId, onProgress }),
  };
}
