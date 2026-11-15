/**
 * The in-process ferry Stage 1's tests run over: two real SQLite stores and the
 * listener's rules, with no Rust and no socket in the loop.
 *
 * The wire is modelled where it is *decided*, not where it is encrypted: the
 * phone's `SyncTransport` implements `/pair/sync`'s staging rules (batches land
 * in order, a commit names the whole push, the pull is read once from the
 * sender's outbox after the receiver's cursor), and the desktop's half is the
 * panel's `applyStagedSync` — take once, apply with the real engine, report the
 * sealed verdict. The route's own Rust tests cover the transport itself.
 *
 * Lives outside `*.test.ts` because two suites drive it: the session's own
 * tests (`syncSession.test.ts`) and Stage 1's exit invariants
 * (`harness.test.ts`).
 */
import assert from "node:assert/strict";
import { applyOps, type PeerOp } from "./engine.ts";
import { applyStagedSync, type SyncApplyTransport } from "./pairingPanel.ts";
import {
  type PeerRow,
  readOutbox,
  readPeers,
  registerPeerStatements,
} from "./store.ts";
import { batchSyncOps, type SyncTransport } from "./syncSession.ts";
import { openSyncStore, type SyncFixture } from "./testSchema.ts";

export const PHONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const DESKTOP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
export const PAIRING = "pair-1";

/** What the phone dials: the desktop's device id, behind any address. */
export const SYNC_INPUT = {
  endpoint: "127.0.0.1:8788",
  desktopDeviceId: DESKTOP,
};

export interface Ferry {
  /** What the phone dials. */
  phone: SyncTransport;
  /** What the panel applies: take, apply, report. */
  apply: SyncApplyTransport;
  /** The listener's report, as `PairingListenerInfo` would project it. */
  syncState: string | null;
  syncApplied: number | null;
  /** Fail the pull batch with this index, once (an interrupted pull). */
  failPullAt: number | null;
  /** Serve the pull in two batches when there is more than one op. */
  splitPull: boolean;
  pushed: PeerOp[];
  /** A new session dials a NEW window: nothing staged is held across one. */
  newWindow(): void;
}

/**
 * A ferry between two stores, implementing the listener's rules on the phone's
 * side and the panel's on the desktop's.
 */
export function ferry(phone: SyncFixture, desktop: SyncFixture): Ferry {
  let staged: PeerOp[][] = [];
  let total: number | null = null;
  let committed = false;
  let taken = false;
  let verdict: { throughSeq: number } | { error: string } | null = null;
  let pulledFrom: number | null = null;
  let pullBatches: PeerOp[][] = [];

  const state: Ferry = {
    phone: null as unknown as SyncTransport,
    apply: null as unknown as SyncApplyTransport,
    syncState: null,
    syncApplied: null,
    failPullAt: null,
    splitPull: false,
    pushed: [],
    newWindow() {
      staged = [];
      total = null;
      committed = false;
      taken = false;
      verdict = null;
      pulledFrom = null;
      pullBatches = [];
      state.syncState = null;
      state.syncApplied = null;
      state.pushed = [];
    },
  };

  state.phone = {
    async syncPush(_input, batch, declared, ops) {
      if (committed)
        throw new Error("sync-busy: this window's push was already committed.");
      if (total === null) total = declared;
      else if (total !== declared) {
        throw new Error(
          `this push declared ${total} batch(es), not ${declared}.`,
        );
      }
      if (batch < staged.length) {
        const held = staged[batch] ?? [];
        if (JSON.stringify(held) !== JSON.stringify(ops)) {
          throw new Error(
            "sync-busy: a different batch already holds this index.",
          );
        }
        return;
      }
      if (batch > staged.length) {
        throw new Error("sync-busy: sync batches land in order.");
      }
      staged.push([...ops]);
      state.pushed.push(...ops);
      state.syncState = "receiving";
    },
    async syncCommit() {
      if (committed)
        throw new Error("replayed: this push was already committed.");
      if (total === null)
        throw new Error("no sync batch has arrived in this window.");
      if (staged.length !== total) {
        throw new Error(`${staged.length} of ${total} batch(es) were staged.`);
      }
      committed = true;
      state.syncState = "staged";
    },
    async syncPull(_input, batch, afterSeq) {
      if (state.failPullAt === batch && state.failPullAt !== null) {
        state.failPullAt = null;
        throw new Error("unreachable: the desktop stopped answering mid-pull.");
      }
      if (pulledFrom === null) {
        pulledFrom = afterSeq;
        const rows = (await readOutbox(desktop.driver)).filter(
          (row) => row.seq > afterSeq,
        );
        const ops: PeerOp[] = rows.map((row) => ({
          device_id: row.device_id,
          seq: row.seq,
          op_id: row.op_id,
          entity_table: row.entity_table,
          entity_uid: row.entity_uid,
          op: row.op,
          base_counter: row.base_counter,
          counter: row.counter,
          field_stamps: row.field_stamps,
          payload: row.payload,
        }));
        pullBatches =
          state.splitPull && ops.length > 1
            ? [ops.slice(0, 1), ops.slice(1)]
            : batchSyncOps(ops);
        if (pullBatches.length === 0) pullBatches = [[]];
      }
      if (pulledFrom !== afterSeq) {
        throw new Error(
          "sync-mismatch: this window served a pull from another position.",
        );
      }
      if (batch >= pullBatches.length) {
        throw new Error(`this pull has ${pullBatches.length} batch(es).`);
      }
      return {
        pairingId: PAIRING,
        batch,
        total: pullBatches.length,
        ops: pullBatches[batch] ?? [],
      };
    },
    async syncApplied(_input, throughSeq) {
      state.syncApplied =
        state.syncApplied === null
          ? throughSeq
          : Math.max(state.syncApplied, throughSeq);
    },
    async syncStatus() {
      // The panel's settle tick runs while the phone polls: that is the whole
      // hand-off — nothing is applied by the phone's request.
      await settle();
      if (verdict === null)
        return { state: "pending", throughSeq: 0, message: null };
      return "error" in verdict
        ? { state: "failed", throughSeq: 0, message: verdict.error }
        : { state: "applied", throughSeq: verdict.throughSeq, message: null };
    },
    batch: (statements) => phone.driver.batch(statements),
  };

  state.apply = {
    async take() {
      if (!committed || taken || verdict !== null) return null;
      taken = true;
      state.syncState = "applying";
      return { ops: staged.flat() as unknown[] };
    },
    async report(input) {
      if (input.appliedThrough !== null)
        verdict = { throughSeq: input.appliedThrough };
      else if (input.error !== null) verdict = { error: input.error };
      state.syncState = "error" in (verdict ?? {}) ? "failed" : "applied";
    },
    async apply(peerId, ops) {
      const statements = await applyOps(desktop.driver, {
        peerId,
        origin: "mobile",
        ops,
      });
      await desktop.driver.batch(statements);
      return ops.reduce((highest, op) => Math.max(highest, op.seq), 0);
    },
  };

  /** The panel's tick: apply a staged push if there is one. */
  async function settle(): Promise<void> {
    if (state.syncState === "staged") {
      await applyStagedSync(state.apply, PHONE);
      state.syncState = "applied";
    }
  }

  return state;
}

/** Two devices, each pinned to the other, over the real fixture. */
export async function pairStores(): Promise<{
  phone: SyncFixture;
  desktop: SyncFixture;
}> {
  const phone = openSyncStore(PHONE);
  const desktop = openSyncStore(DESKTOP);
  await phone.driver.batch([
    ...registerPeerStatements({
      deviceId: DESKTOP,
      generation: 1,
      pairingId: PAIRING,
    }),
  ]);
  await desktop.driver.batch([
    ...registerPeerStatements({
      deviceId: PHONE,
      generation: 1,
      pairingId: PAIRING,
    }),
  ]);
  return { phone, desktop };
}

/** This device's pin on another, asserted to exist. */
export async function peerOf(store: SyncFixture, id: string): Promise<PeerRow> {
  const row = (await readPeers(store.driver)).find(
    (entry) => entry.device_id === id,
  );
  assert.ok(row, `the ${id} pin exists`);
  return row;
}

/** A `SELECT count(*) AS n` helper. */
export async function countRows(
  store: SyncFixture,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const [row] = await store.driver.query<{ n: number }>(sql, params);
  return row?.n ?? 0;
}
