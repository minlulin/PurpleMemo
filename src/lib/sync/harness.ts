// Failure-injection harness for sync protocol v1 — docs/ANDROID_SYNC_PROTOCOL.md
// (Phase C Session 1, task K.2).
//
// Two peers, no network, no database, no device: a simulated desktop and a
// simulated phone, a transport that can lose, repeat and interrupt batches, and
// oracles that judge an outcome against the spec instead of trusting a flag.
// Every later Phase C session is judged by this file.
//
// What this is NOT: a sync engine. It records what arrived and where the
// cursors stand; it does not decide merges, materialise records, or write an
// outbox. The peers' `records`/`tombstones` only ever hold what a test or
// Stage 1's engine put there, which is why the convergence tests are pending
// rather than passing: an empty model must never read as "synced".
//
// One rule is enforced by construction: **a verdict never consults a peer's
// own claim.** `claimedSynced` exists so a test can set it and show the oracles
// ignore it (§14.5).

import {
  compareStamps,
  type Hello,
  handshake,
  isSyncTable,
  nextCounter,
  type OpKind,
  opKey,
  PROTOCOL_VERSION,
  type VersionStamp,
} from "./protocol.ts";

/**
 * The seam Stage 1 plugs into (provisional).
 *
 * An engine owns the durable outbox and the apply path; the harness owns the
 * two replicas, the wire and the faults. Extending this interface later is a
 * harness change (allowed); changing what the oracles demand is a spec change
 * (§14.6).
 */
export interface SyncEngineUnderTest {
  /** Export what a peer's durable outbox still owes, in seq order (§6.2). */
  push(peer: "desktop" | "mobile", limit: number): readonly SimOp[];
  /** Apply one inbound batch: idempotent, atomic, resumable (§7). */
  apply(
    peer: "desktop" | "mobile",
    batch: readonly SimOp[],
  ): { acknowledgedThrough: number | null };
}

export interface SimOp {
  deviceId: string;
  seq: number;
  opId: string;
  table: string;
  uid: string;
  kind: OpKind;
  stamp: VersionStamp;
  fields?: Record<string, unknown>;
}

export interface SimRecord {
  table: string;
  uid: string;
  stamp: VersionStamp;
  fields: Record<string, unknown>;
}

export interface SimTombstone {
  table: string;
  uid: string;
  stamp: VersionStamp;
  /** Device ids that have acknowledged this tombstone (§5.4, §6.5). */
  ackedBy: string[];
}

export interface SimPeer {
  deviceId: string;
  generation: number;
  protocolVersion: number;
  dataSchemaVersion: number;
  /** Lamport counter: every local write and every applied batch advances it. */
  lamport: number;
  records: Map<string, SimRecord>;
  tombstones: Map<string, SimTombstone>;
  outbox: SimOp[];
  /** Everything that reached this peer, duplicates included (§6.3). */
  received: SimOp[];
  /** Last seq applied per peer device (§6.4). */
  cursors: Map<string, number>;
  /** Last seq acknowledged to each peer device (§6.5). */
  ackedThrough: Map<string, number>;
  /** Ops this peer has acknowledged to their origin (§6.5). */
  ackLog: SimOp[];
  /** Devices whose key this peer has revoked: they are refused (§11.3). */
  revoked: Set<string>;
  alive: boolean;
  clockSkewMs: number;
  /** A stub "I am synced" flag the oracles must never read (§14.5). */
  claimedSynced: boolean;
}

export interface PeerSeed {
  deviceId: string;
  generation?: number;
  protocolVersion?: number;
  dataSchemaVersion?: number;
}

export const DESKTOP_DEVICE = "desktop-7f3c";
export const MOBILE_DEVICE = "phone-91ab";
export const DATA_SCHEMA_VERSION = 7;

export function createPeer(seed: PeerSeed): SimPeer {
  return {
    deviceId: seed.deviceId,
    generation: seed.generation ?? 1,
    protocolVersion: seed.protocolVersion ?? PROTOCOL_VERSION,
    dataSchemaVersion: seed.dataSchemaVersion ?? DATA_SCHEMA_VERSION,
    lamport: 0,
    records: new Map(),
    tombstones: new Map(),
    outbox: [],
    received: [],
    cursors: new Map(),
    ackedThrough: new Map(),
    ackLog: [],
    revoked: new Set(),
    alive: true,
    clockSkewMs: 0,
    claimedSynced: false,
  };
}

export function recordKey(table: string, uid: string): string {
  return `${table}:${uid}`;
}

/** Materialise a record (test fixture or engine output). */
export function seedRecord(
  peer: SimPeer,
  record: {
    table: string;
    uid: string;
    fields: Record<string, unknown>;
    counter?: number;
  },
): SimRecord {
  peer.lamport = nextCounter([peer.lamport, record.counter ?? peer.lamport]);
  const stored: SimRecord = {
    table: record.table,
    uid: record.uid,
    stamp: {
      counter: record.counter ?? peer.lamport,
      deviceId: peer.deviceId,
      opId: `${peer.deviceId}#seed`,
    },
    fields: { ...record.fields },
  };
  peer.records.set(recordKey(record.table, record.uid), stored);
  return stored;
}

/** Materialise a tombstone (test fixture or engine output). */
export function seedTombstone(
  peer: SimPeer,
  tombstone: { table: string; uid: string; counter?: number },
): SimTombstone {
  const stored: SimTombstone = {
    table: tombstone.table,
    uid: tombstone.uid,
    stamp: {
      counter: tombstone.counter ?? peer.lamport + 1,
      deviceId: peer.deviceId,
      opId: `${peer.deviceId}#tombstone`,
    },
    ackedBy: [],
  };
  peer.tombstones.set(recordKey(tombstone.table, tombstone.uid), stored);
  peer.records.delete(recordKey(tombstone.table, tombstone.uid));
  return stored;
}

/** Queue a mutation in a peer's outbox exactly as a domain write would (§6.1). */
export function makeOp(
  peer: SimPeer,
  input: {
    table: string;
    uid: string;
    kind: OpKind;
    fields?: Record<string, unknown>;
    counter?: number;
  },
): SimOp {
  const seq = peer.outbox.length === 0 ? 1 : (peer.outbox.at(-1)?.seq ?? 0) + 1;
  peer.lamport = input.counter ?? peer.lamport + 1;
  const op: SimOp = {
    deviceId: peer.deviceId,
    seq,
    // Stand-in for the real op UUID; (deviceId, seq) is the identity that
    // matters (§1.3) and a deterministic id keeps tests readable.
    opId: `${peer.deviceId}#${seq}`,
    table: input.table,
    uid: input.uid,
    kind: input.kind,
    stamp: {
      counter: peer.lamport,
      deviceId: peer.deviceId,
      opId: `${peer.deviceId}#${seq}`,
    },
  };
  if (input.fields) op.fields = { ...input.fields };
  peer.outbox.push(op);
  return op;
}

export interface Faults {
  /** Apply this many ops of the batch, then die (§7.4, §7.5). */
  killAfterOps?: number;
  /** Re-send the whole batch this many extra times (§6.3). */
  duplicateDeliveries?: number;
  /** The batch disappears in flight and is re-sent from the outbox (§6.3). */
  dropBatch?: boolean;
}

export interface Delivery {
  from: string;
  to: string;
  ops: readonly SimOp[];
  /** How many times the batch crossed the wire. */
  attempts: number;
  /** Ops handed to the receiver before a kill; 0 when nothing was attempted. */
  attemptedOps: number;
  /** Ops that committed on the receiver. */
  committed: number;
  acknowledgedThrough: number | null;
  refusal: string | null;
  killed: boolean;
}

function helloOf(peer: SimPeer): Hello {
  return {
    deviceId: peer.deviceId,
    protocolVersion: peer.protocolVersion,
    dataSchemaVersion: peer.dataSchemaVersion,
    generation: peer.generation,
  };
}

/**
 * Hand one batch from `from` to `to`.
 *
 * The batch is the transaction (§7.4): a peer that dies part-way commits
 * nothing and advances no cursor, and the sender's outbox still owes the ops,
 * so the next attempt re-sends them. That is the protocol's requirement; the
 * harness models it here and the pending engine tests are what prove Stage 1's
 * apply actually behaves that way.
 */
export function deliver(
  from: SimPeer,
  to: SimPeer,
  batch: readonly SimOp[],
  faults: Faults = {},
): Delivery {
  const base = {
    from: from.deviceId,
    to: to.deviceId,
    ops: batch,
    attempts: 0,
    attemptedOps: 0,
    committed: 0,
    acknowledgedThrough: null,
    refusal: null,
    killed: false,
  } satisfies Delivery;
  const refused = (refusal: string): Delivery => ({ ...base, refusal });

  if (!from.alive || !to.alive) return refused("peer is not running (§6.6)");
  if (faults.dropBatch) return refused("batch lost in flight (§6.3)");
  if (to.revoked.has(from.deviceId)) {
    return refused(`${from.deviceId} is revoked by ${to.deviceId} (§11.3)`);
  }
  const admitted = handshake(helloOf(to), helloOf(from));
  if (!admitted.ok) return refused(admitted.message);

  const attempts = 1 + Math.max(0, faults.duplicateDeliveries ?? 0);
  const killAt = faults.killAfterOps;
  if (killAt !== undefined && killAt < batch.length) {
    // Died mid-apply: nothing committed, the sender learns nothing.
    to.alive = false;
    return {
      ...base,
      attempts: 1,
      attemptedOps: killAt,
      refusal: "peer died mid-apply; the batch rolled back (§7.4)",
      killed: true,
    };
  }

  let committed = 0;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    committed = 0;
    for (const op of batch) {
      to.received.push(op);
      committed += 1;
    }
  }
  const highestSeq = batch.reduce(
    (max, op) => (op.seq > max ? op.seq : max),
    0,
  );
  to.cursors.set(from.deviceId, highestSeq);
  to.ackedThrough.set(from.deviceId, highestSeq);
  // Applying an op advances the receiver's Lamport counter past what it saw
  // (§4.2), which is why a later local write outranks the op it merged.
  to.lamport = nextCounter([
    to.lamport,
    ...batch.map((op) => op.stamp.counter),
  ]);

  return {
    ...base,
    attempts,
    attemptedOps: batch.length,
    committed,
    acknowledgedThrough: highestSeq,
  };
}

/** Prune the origin's outbox to the acknowledged point (§6.5). */
export function acknowledge(from: SimPeer, delivery: Delivery): void {
  const through = delivery.acknowledgedThrough;
  if (through === null) return;
  from.outbox = from.outbox.filter((op) => op.seq > through);
  from.ackLog.push(...delivery.ops);
}

export function killPeer(peer: SimPeer): void {
  peer.alive = false;
}

export function restartPeer(peer: SimPeer): void {
  peer.alive = true;
}

/** Move only the wall clock — never a version stamp (§4.2, §4.7). */
export function skewClock(peer: SimPeer, offsetMs: number): void {
  peer.clockSkewMs = offsetMs;
}

export function now(peer: SimPeer): number {
  return Date.now() + peer.clockSkewMs;
}

export function revokePeer(by: SimPeer, deviceId: string): void {
  by.revoked.add(deviceId);
}

/**
 * Model a desktop restore from an old backup (§10.1, §10.5).
 *
 * The restored data is older; the *generation* is newer, because it names the
 * data line and the line just changed. Everything the phone stored about the
 * previous line — cursors, acks — stops being evidence.
 */
export function restoreBackup(peer: SimPeer, generation: number): void {
  peer.generation = generation;
  peer.cursors.clear();
  peer.ackedThrough.clear();
}

function fingerprint(record: SimRecord): string {
  const fields = Object.keys(record.fields)
    .sort()
    .map((key) => `${key}=${JSON.stringify(record.fields[key])}`)
    .join(",");
  return `${fields}|${record.stamp.counter}|${record.stamp.deviceId}`;
}

/**
 * The convergence oracle (§14.2): the same records with the same merged values,
 * and the same tombstones, on both peers.
 *
 * It reads the replicas, never `claimedSynced` — a peer that says "synced" and
 * holds different data is the exact failure this file exists to catch.
 */
export function checkConvergence(a: SimPeer, b: SimPeer): string[] {
  const problems: string[] = [];
  const keys = new Set([...a.records.keys(), ...b.records.keys()]);
  for (const key of [...keys].sort()) {
    const left = a.records.get(key);
    const right = b.records.get(key);
    if (!left || !right) {
      problems.push(
        `${key}: present on ${left ? a.deviceId : b.deviceId} only`,
      );
      continue;
    }
    if (fingerprint(left) !== fingerprint(right)) {
      problems.push(
        `${key}: fields differ (${fingerprint(left)} vs ${fingerprint(right)})`,
      );
    }
  }
  const tombstoneKeys = new Set([
    ...a.tombstones.keys(),
    ...b.tombstones.keys(),
  ]);
  for (const key of [...tombstoneKeys].sort()) {
    if (!a.tombstones.has(key) || !b.tombstones.has(key)) {
      problems.push(`${key}: tombstone on one peer only`);
    }
  }
  return problems;
}

/**
 * The no-loss oracle (§14.3): every acknowledged op is visible on every peer,
 * or superseded by a strictly newer stamp on the same record. An op that was
 * acknowledged and then vanished is data loss, whatever the replica looks like.
 */
export function checkNoAcknowledgedLoss(peers: readonly SimPeer[]): string[] {
  const problems = new Set<string>();
  const acked = new Map<string, SimOp>();
  for (const peer of peers) {
    for (const op of peer.ackLog) acked.set(opKey(op), op);
  }
  for (const op of acked.values()) {
    const key = recordKey(op.table, op.uid);
    for (const peer of peers) {
      const seen = peer.records.get(key) ?? peer.tombstones.get(key);
      if (!seen) {
        problems.add(
          `${key}: acknowledged ${op.kind} (${opKey(op)}) is missing on ${peer.deviceId}`,
        );
        continue;
      }
      if (compareStamps(seen.stamp, op.stamp) < 0) {
        problems.add(
          `${key}: ${peer.deviceId} holds an older stamp than acknowledged ${opKey(op)}`,
        );
      }
    }
  }
  return [...problems].sort();
}

export function checkTombstones(
  expected: readonly { table: string; uid: string }[],
  peers: readonly SimPeer[],
): string[] {
  const problems: string[] = [];
  for (const item of expected) {
    const key = recordKey(item.table, item.uid);
    for (const peer of peers) {
      if (!peer.tombstones.has(key)) {
        problems.push(`${key}: no tombstone on ${peer.deviceId}`);
      }
    }
  }
  return problems;
}

/** What this peer would put on the wire or has received (§2.2). */
export function wireRows(peer: SimPeer): { table: string; uid: string }[] {
  return [...peer.outbox, ...peer.received].map((op) => ({
    table: op.table,
    uid: op.uid,
  }));
}

/**
 * The leak oracle (§2.2): a table outside the allowlist must never appear in a
 * peer's records, tombstones or wire traffic.
 */
export function checkNoForbiddenRows(
  peer: SimPeer,
  allowed: (table: string) => boolean = isSyncTable,
): string[] {
  const problems: string[] = [];
  const rows = [
    ...[...peer.records.values()].map((r) => ({ table: r.table, uid: r.uid })),
    ...[...peer.tombstones.values()].map((t) => ({
      table: t.table,
      uid: t.uid,
    })),
    ...wireRows(peer),
  ];
  for (const row of rows) {
    if (!allowed(row.table)) {
      problems.push(`${row.table}:${row.uid} crossed the allowlist boundary`);
    }
  }
  return [...new Set(problems)].sort();
}

/** A refusal must be a wall, not a warning: nothing committed, nothing acked. */
export function checkNothingFlowed(delivery: Delivery): string[] {
  const problems: string[] = [];
  if (delivery.refusal === null) {
    problems.push("the delivery was not refused at all");
  }
  if (delivery.committed !== 0) {
    problems.push(`${delivery.committed} op(s) committed through a refusal`);
  }
  if (delivery.acknowledgedThrough !== null) {
    problems.push(
      `the refused batch was acknowledged through ${delivery.acknowledgedThrough}`,
    );
  }
  return problems;
}

export interface Simulator {
  desktop: SimPeer;
  mobile: SimPeer;
  deliveries: Delivery[];
  send(
    from: SimPeer,
    to: SimPeer,
    batch?: readonly SimOp[],
    faults?: Faults,
  ): Delivery;
}

export function createSimulator(
  seed: { desktop?: Partial<PeerSeed>; mobile?: Partial<PeerSeed> } = {},
): Simulator {
  const desktop = createPeer({
    deviceId: DESKTOP_DEVICE,
    ...seed.desktop,
  });
  const mobile = createPeer({ deviceId: MOBILE_DEVICE, ...seed.mobile });
  const deliveries: Delivery[] = [];
  return {
    desktop,
    mobile,
    deliveries,
    send(from, to, batch = from.outbox, faults = {}) {
      const delivery = deliver(from, to, batch, faults);
      acknowledge(from, delivery);
      deliveries.push(delivery);
      return delivery;
    },
  };
}

export type InjectionId =
  | "mid-apply-kill"
  | "duplicate-delivery"
  | "clock-skew"
  | "conflicting-offline-edits"
  | "delete-vs-edit"
  | "cascaded-child-delete"
  | "revoked-peer"
  | "old-backup-restore"
  | "desktop-only-leak";

export interface Injection {
  id: InjectionId;
  /** Spec clauses this injection exercises (§14.4). */
  clauses: readonly string[];
  description: string;
  apply: (sim: Simulator) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every fault the spec requires the harness to be able to inject (§14.4). The
 * spec's table and this list are compared by a test, so an injection cannot be
 * dropped from one side without the other noticing.
 */
export const INJECTIONS: readonly Injection[] = [
  {
    id: "mid-apply-kill",
    clauses: ["§6.4", "§7.4", "§7.5"],
    description:
      "the receiver dies after two of four ops; nothing commits or advances, then the origin retries from its outbox",
    apply: (sim) => {
      const ops = ["note-a", "note-b", "note-c", "note-d"].map((uid) =>
        makeOp(sim.mobile, {
          table: "notes",
          uid,
          kind: "create",
          fields: { title: uid },
        }),
      );
      sim.send(sim.mobile, sim.desktop, ops, { killAfterOps: 2 });
      restartPeer(sim.desktop);
      sim.send(sim.mobile, sim.desktop, ops);
    },
  },
  {
    id: "duplicate-delivery",
    clauses: ["§6.3", "§7.2"],
    description:
      "one batch is re-sent three times; apply must be idempotent per op identity",
    apply: (sim) => {
      const ops = [
        makeOp(sim.mobile, { table: "tasks", uid: "task-1", kind: "create" }),
        makeOp(sim.mobile, { table: "tasks", uid: "task-2", kind: "create" }),
      ];
      sim.send(sim.mobile, sim.desktop, ops, { duplicateDeliveries: 2 });
    },
  },
  {
    id: "clock-skew",
    clauses: ["§4.2", "§4.7"],
    description:
      "the phone's wall clock is three days ahead of the desktop's; version stamps must not move",
    apply: (sim) => {
      skewClock(sim.mobile, 3 * DAY_MS);
      sim.send(sim.mobile, sim.desktop, [
        makeOp(sim.mobile, {
          table: "notes",
          uid: "note-skew",
          kind: "create",
          fields: { title: "written on a phone three days ahead" },
        }),
      ]);
    },
  },
  {
    id: "conflicting-offline-edits",
    clauses: ["§4.2", "§4.3"],
    description:
      "both peers edit the same note while apart — different fields, then the same field",
    apply: (sim) => {
      seedRecord(sim.mobile, {
        table: "notes",
        uid: "note-shared",
        fields: { title: "Trip plan", body: "old body" },
        counter: 4,
      });
      seedRecord(sim.desktop, {
        table: "notes",
        uid: "note-shared",
        fields: { title: "Trip plan", body: "old body" },
        counter: 4,
      });
      const phoneEdit = makeOp(sim.mobile, {
        table: "notes",
        uid: "note-shared",
        kind: "update",
        fields: { title: "Trip plan (phone)" },
      });
      const desktopEdit = makeOp(sim.desktop, {
        table: "notes",
        uid: "note-shared",
        kind: "update",
        fields: { body: "new body from the desktop" },
      });
      sim.send(sim.mobile, sim.desktop, [phoneEdit]);
      sim.send(sim.desktop, sim.mobile, [desktopEdit]);
    },
  },
  {
    id: "delete-vs-edit",
    clauses: ["§5.3"],
    description:
      "the desktop deletes a shopping item while the phone marks it bought",
    apply: (sim) => {
      seedRecord(sim.mobile, {
        table: "shopping_items",
        uid: "item-1",
        fields: { title: "Milk", done: false },
        counter: 6,
      });
      seedRecord(sim.desktop, {
        table: "shopping_items",
        uid: "item-1",
        fields: { title: "Milk", done: false },
        counter: 6,
      });
      const deletion = makeOp(sim.desktop, {
        table: "shopping_items",
        uid: "item-1",
        kind: "delete",
      });
      const toggle = makeOp(sim.mobile, {
        table: "shopping_items",
        uid: "item-1",
        kind: "toggle",
        fields: { done: true },
      });
      sim.send(sim.desktop, sim.mobile, [deletion]);
      sim.send(sim.mobile, sim.desktop, [toggle]);
    },
  },
  {
    id: "cascaded-child-delete",
    clauses: ["§5.2"],
    description:
      "deleting a collection cascades to its notes; both tombstones must travel",
    apply: (sim) => {
      seedRecord(sim.desktop, {
        table: "notes",
        uid: "note-in-collection",
        fields: { title: "Inside", collection: "collection-1" },
        counter: 2,
      });
      const tombstones = [
        makeOp(sim.desktop, {
          table: "collections",
          uid: "collection-1",
          kind: "delete",
        }),
        makeOp(sim.desktop, {
          table: "notes",
          uid: "note-in-collection",
          kind: "delete",
        }),
      ];
      sim.send(sim.desktop, sim.mobile, tombstones);
    },
  },
  {
    id: "revoked-peer",
    clauses: ["§11.3"],
    description:
      "the desktop revoked the phone's key; the phone tries to push anyway",
    apply: (sim) => {
      revokePeer(sim.desktop, sim.mobile.deviceId);
      sim.send(sim.mobile, sim.desktop, [
        makeOp(sim.mobile, {
          table: "notes",
          uid: "note-after-revoke",
          kind: "create",
        }),
      ]);
    },
  },
  {
    id: "old-backup-restore",
    clauses: ["§10.2", "§10.5"],
    description:
      "the desktop restores an old backup and bumps its generation; the phone still holds the old one",
    apply: (sim) => {
      restoreBackup(sim.desktop, sim.desktop.generation + 1);
      sim.send(sim.mobile, sim.desktop, [
        makeOp(sim.mobile, {
          table: "tasks",
          uid: "task-after-restore",
          kind: "create",
        }),
      ]);
    },
  },
  {
    id: "desktop-only-leak",
    clauses: ["§2.2"],
    description:
      "a contacts row is put on the wire on purpose; the leak oracle must name it",
    apply: (sim) => {
      sim.send(sim.mobile, sim.desktop, [
        makeOp(sim.mobile, {
          table: "contacts",
          uid: "contact-should-never-sync",
          kind: "create",
          fields: { name: "Leaked" },
        }),
      ]);
    },
  },
];
