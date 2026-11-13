/**
 * One sync session, end to end over two real stores
 * (`docs/ANDROID_SYNC_PROTOCOL.md` §6, §7).
 *
 * The wire is ferried in process: the phone's `SyncTransport` drives the same
 * staging rules the listener implements — batches land in order, a commit
 * names the whole push, the pull is read once from the sender's outbox after
 * the receiver's cursor — and the desktop's half is the panel's
 * `applyStagedSync`. No Rust is in the loop; the route's own tests cover that.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotesRepo } from "../notes.ts";
import { createTasksRepo } from "../tasks.ts";
import { applyOps, type PeerOp } from "./engine.ts";
import { applyStagedSync, type SyncApplyTransport } from "./pairingPanel.ts";
import {
  ackStatements,
  type PeerRow,
  readOutbox,
  readPeers,
  registerPeerStatements,
} from "./store.ts";
import { batchSyncOps, runSync, type SyncTransport } from "./syncSession.ts";
import { openSyncStore, type SyncFixture } from "./testSchema.ts";

const PHONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DESKTOP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const PAIRING = "pair-1";

interface Ferry {
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
function ferry(phone: SyncFixture, desktop: SyncFixture): Ferry {
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
async function pair(): Promise<{ phone: SyncFixture; desktop: SyncFixture }> {
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

const input = { endpoint: "127.0.0.1:8788", desktopDeviceId: DESKTOP };

async function peer(store: SyncFixture, id: string): Promise<PeerRow> {
  const row = (await readPeers(store.driver)).find(
    (entry) => entry.device_id === id,
  );
  assert.ok(row, `the ${id} pin exists`);
  return row;
}

async function count(
  store: SyncFixture,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const [row] = await store.driver.query<{ n: number }>(sql, params);
  return row?.n ?? 0;
}

test("a phone note and a desktop task cross in one session and both stores converge", async () => {
  const { phone, desktop } = await pair();
  await createNotesRepo(phone.driver).createNote({
    title: "From the phone",
    content: "",
  });
  await createTasksRepo(desktop.driver).createTask({
    title: "From the desktop",
  });

  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });

  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.state, "applied");
  assert.equal(outcome.pushed, 1, "the phone's note was pushed");
  assert.equal(outcome.pulled, 1, "the desktop's task was pulled");

  for (const [name, store] of [
    ["phone", phone],
    ["desktop", desktop],
  ] as const) {
    assert.equal(
      await count(store, "SELECT count(*) AS n FROM notes"),
      1,
      `${name} holds the phone's note`,
    );
    assert.equal(
      await count(store, "SELECT count(*) AS n FROM tasks"),
      1,
      `${name} holds the desktop's task`,
    );
  }
  // And the cursors each side moved by the exchange (§6.4, §6.5).
  assert.equal(
    (await peer(phone, DESKTOP)).cursor_in,
    1,
    "the phone applied through seq 1",
  );
  assert.equal(
    (await peer(desktop, PHONE)).cursor_in,
    1,
    "the desktop applied through seq 1",
  );
  assert.equal(
    (await peer(phone, DESKTOP)).cursor_out,
    1,
    "the desktop acked the phone's push",
  );
});

test("a second session with no new writes moves no operations and no cursors", async () => {
  const { phone, desktop } = await pair();
  await createNotesRepo(phone.driver).createNote({
    title: "Once",
    content: "",
  });
  const wire = ferry(phone, desktop);
  await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });

  const before = {
    phoneOut: (await peer(phone, DESKTOP)).cursor_out,
    phoneIn: (await peer(phone, DESKTOP)).cursor_in,
    desktopIn: (await peer(desktop, PHONE)).cursor_in,
    pushed: wire.pushed.length,
  };

  wire.pushed = [];
  const again = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(again.confirmed, true);
  assert.equal(again.pushed, 0, "nothing past the cursor, so nothing is sent");
  assert.equal(
    again.pulled,
    0,
    "the desktop's outbox is empty after its own ack",
  );
  assert.equal(wire.pushed.length, 0);
  assert.equal((await peer(phone, DESKTOP)).cursor_out, before.phoneOut);
  assert.equal((await peer(phone, DESKTOP)).cursor_in, before.phoneIn);
  assert.equal((await peer(desktop, PHONE)).cursor_in, before.desktopIn);
  assert.equal(await count(phone, "SELECT count(*) AS n FROM notes"), 1);
});

test("an interrupted pull resumes from cursor_in and converges without duplicating", async () => {
  const { phone, desktop } = await pair();
  // Two desktop writes: enough for two batches when the ferry splits them.
  const tasks = createTasksRepo(desktop.driver);
  await tasks.createTask({ title: "One" });
  await tasks.createTask({ title: "Two" });

  const wire = ferry(phone, desktop);
  wire.splitPull = true;
  wire.failPullAt = 1;
  const interrupted = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(interrupted.confirmed, false);
  assert.equal(
    interrupted.refusal?.code,
    "unreachable",
    "the desktop's own code, not a rewritten one",
  );
  assert.equal(
    await count(phone, "SELECT count(*) AS n FROM tasks"),
    1,
    "batch 0 committed; the pull stopped there",
  );
  assert.equal(
    (await peer(phone, DESKTOP)).cursor_in,
    1,
    "the cursor moved inside that apply, not in memory (§6.4)",
  );

  // The next session opens a new window and resumes from the cursor: batch 0
  // is not offered again.
  wire.newWindow();
  wire.splitPull = false;
  const resumed = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(resumed.confirmed, true);
  assert.equal(resumed.pulled, 1, "only the operation after the cursor");
  assert.equal(
    await count(phone, "SELECT count(*) AS n FROM tasks"),
    2,
    "both tasks, each once",
  );
  assert.equal((await peer(phone, DESKTOP)).cursor_in, 2);
});

test("an operation for a Stage 2 table stays home", async () => {
  const { phone, desktop } = await pair();
  // No desktop writer records for a Stage 2 table yet, so the row is written
  // the way one would be: the shape §6.1 commits with its mutation.
  await phone.driver.execute(
    `INSERT INTO sync_outbox (device_id, seq, op_id, entity_table, entity_uid, op, base_counter, counter, field_stamps, payload, created_at)
     VALUES (?, 1, 'op-budget', 'expense_entries', '99999999-9999-4999-8999-999999999999', 'create', 0, 1, '{}', '{"amount_cents": 500}', '2026-11-13T00:00:00.000Z')`,
    [PHONE],
  );
  await phone.driver.execute(
    "UPDATE sync_state SET last_seq = 1, lamport = 1 WHERE id = 1",
  );

  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.pushed, 0, "nothing Stage 1 was pending");
  assert.equal(wire.pushed.length, 0, "not one Stage 2 op reached the wire");
  assert.equal(
    await count(phone, "SELECT count(*) AS n FROM sync_outbox"),
    1,
    "it is still in the outbox for the stage that moves it",
  );
  assert.equal(
    await count(
      desktop,
      "SELECT count(*) AS n FROM sync_row_stamps WHERE entity_table = ?",
      ["expense_entries"],
    ),
    0,
  );
});

test("an applied verdict records the ack, so the pushed rows are prunable", async () => {
  const { phone, desktop } = await pair();
  await createNotesRepo(phone.driver).createNote({
    title: "Send me",
    content: "",
  });
  await createNotesRepo(phone.driver).createNote({
    title: "And me",
    content: "",
  });

  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.pushed, 2);
  assert.equal(outcome.ackThrough, 2);

  const own = await readOutbox(phone.driver);
  assert.equal(
    own.length,
    0,
    "§6.5: every live peer acked, so the rows are pruned",
  );
  assert.equal((await peer(phone, DESKTOP)).cursor_out, 2);
  // The desktop keeps its own copy of the records and its own cursor.
  assert.equal(await count(desktop, "SELECT count(*) AS n FROM notes"), 2);
  assert.equal((await peer(desktop, PHONE)).cursor_in, 2);

  // The desktop's acknowledgement is idempotent: asking again changes nothing.
  await phone.driver.batch(ackStatements(DESKTOP, 2));
  assert.equal((await peer(phone, DESKTOP)).cursor_out, 2);
});
