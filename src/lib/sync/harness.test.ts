// Failure-injection harness tests (Phase C Session 1, task K.2).
//
// Two kinds of test live here, and the difference is the point:
//
// 1. **Green — the harness's teeth.** Every injection must really fire, and
//    every oracle must really refuse a wrong outcome. If these passed
//    vacuously, the invariants below would be judged by a harness that cannot
//    tell a converged pair from a divergent one, which is worse than no
//    harness at all.
// 2. **Stage 1's obligations — now running.** The convergence, idempotency,
//    interrupted-apply, tombstone, revocation and leak invariants were
//    registered skipped while no engine existed. Each one now runs over the
//    real stack (`testFerry.ts`: two SQLite stores, the repositories'
//    recording, the engine, the session's cursors) and none is skipped.
//
// A third group keeps the documents honest: the spec's injection table, its
// clause numbers and the open decisions it carries are checked against the
// code and the todo.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { first } from "../../test-utils.ts";
import { createNotesRepo } from "../notes.ts";
import { createShoppingRepo } from "../shopping.ts";
import { createTasksRepo } from "../tasks.ts";
import { applyOps } from "./engine.ts";
import {
  checkConvergence,
  checkNoAcknowledgedLoss,
  checkNoForbiddenRows,
  checkNothingFlowed,
  checkTombstones,
  createSimulator,
  type Delivery,
  INJECTIONS,
  type Injection,
  type InjectionId,
  makeOp,
  now,
  recordKey,
  revokePeer,
  type Simulator,
  seedRecord,
} from "./harness.ts";
import {
  compareStamps,
  handshake,
  isSyncTable,
  OPEN_DECISIONS,
  PROTOCOL_VERSION,
  planAdoption,
  tombstoneGcEligible,
  writeAllowed,
} from "./protocol.ts";
import { readOutbox } from "./store.ts";
import { runSync } from "./syncSession.ts";
import {
  countRows,
  DESKTOP,
  type Ferry,
  ferry,
  PHONE,
  pairStores,
  peerOf,
  SYNC_INPUT,
} from "./testFerry.ts";
import type { SyncFixture } from "./testSchema.ts";

const SPEC = readFileSync(
  new URL("../../../docs/ANDROID_SYNC_PROTOCOL.md", import.meta.url),
  "utf8",
);
const TODO = readFileSync(
  new URL("../../../docs/ANDROID_BUILD_TODO.md", import.meta.url),
  "utf8",
);

/** Every clause heading the spec defines (`#### §4.2 …`). */
const CLAUSES = new Set(
  [...SPEC.matchAll(/^#### (§\d+\.\d+)/gm)].map((match) => match[1] ?? ""),
);

function injection(id: InjectionId): Injection {
  const found = INJECTIONS.find((item) => item.id === id);
  assert.ok(found, `the harness has no ${id} injection`);
  return found;
}

function lastDelivery(sim: Simulator): Delivery {
  const delivery = sim.deliveries.at(-1);
  assert.ok(delivery, "the scenario delivered nothing");
  return delivery;
}

// ---------------------------------------------------------------------------
// The documents and the harness must not drift apart.
// ---------------------------------------------------------------------------

test("the spec's obligation table and the harness list exactly the same injections", () => {
  const start = SPEC.indexOf("<!-- harness-obligations:start -->");
  const end = SPEC.indexOf("<!-- harness-obligations:end -->");
  assert.ok(
    start >= 0 && end > start,
    "the spec lost its harness-obligations table (§14.4)",
  );
  const documented = [
    ...SPEC.slice(start, end).matchAll(/^\| `([a-z-]+)` \| ([^|]+)\|/gm),
  ].map((row) => ({
    id: row[1] ?? "",
    clauses: (row[2] ?? "").match(/§\d+\.\d+/g) ?? [],
  }));

  assert.deepEqual(
    documented.map((row) => row.id).sort(),
    INJECTIONS.map((item) => item.id).sort(),
    "an injection exists on one side only",
  );
  for (const row of documented) {
    const item = injection(row.id as InjectionId);
    assert.deepEqual(
      [...row.clauses].sort(),
      [...item.clauses].sort(),
      `${row.id} cites different clauses in the spec and the code`,
    );
    assert.ok(
      item.description.length > 40,
      `${row.id} needs a description a reviewer can read`,
    );
  }
  assert.ok(INJECTIONS.length >= 8, "the spec requires at least eight faults");
});

test("every clause the code cites is one the spec defines", () => {
  const cited = new Set<string>();
  for (const item of INJECTIONS) {
    for (const clause of item.clauses) cited.add(clause);
  }
  for (const decision of OPEN_DECISIONS) cited.add(decision.clause);
  assert.ok(cited.size > 0);
  for (const clause of cited) {
    assert.ok(CLAUSES.has(clause), `${clause} is cited but not defined`);
  }
});

test("the spec supersedes ANDROID_DESIGN.md §5 and ends on the oracle", () => {
  assert.match(SPEC, /supersedes/i, "the spec must say what it replaces");
  assert.match(
    SPEC,
    /both devices converge without losing acknowledged operations/i,
  );
});

test("open decisions are recorded in the spec, the code and the todo", () => {
  assert.ok(OPEN_DECISIONS.length >= 1, "a silent decision is the bug");
  for (const decision of OPEN_DECISIONS) {
    assert.ok(CLAUSES.has(decision.clause), `${decision.id}: unknown clause`);
    assert.ok(
      SPEC.includes(decision.id),
      `${decision.id} is not written down in the spec`,
    );
    assert.ok(
      TODO.includes(decision.id),
      `${decision.id} is not carried into the todo`,
    );
    assert.ok(
      decision.options.length >= 2,
      `${decision.id} must offer the reviewer real options`,
    );
  }
});

// ---------------------------------------------------------------------------
// The harness's teeth: every injection fires, and is observable.
// ---------------------------------------------------------------------------

test("no injection is a no-op", () => {
  for (const item of INJECTIONS) {
    const sim = createSimulator();
    item.apply(sim);
    assert.ok(sim.deliveries.length > 0, `${item.id} delivered nothing`);
    const observable = sim.deliveries.some(
      (delivery) =>
        delivery.refusal !== null || delivery.committed > 0 || delivery.killed,
    );
    assert.ok(observable, `${item.id} had no observable effect`);
  }
});

test("mid-apply-kill: nothing commits, then the retry delivers all four", () => {
  const sim = createSimulator();
  injection("mid-apply-kill").apply(sim);
  const killed = sim.deliveries[0];
  const retried = sim.deliveries[1];
  assert.ok(killed && retried, "the scenario needs a kill and a retry");
  assert.equal(killed.killed, true);
  assert.equal(killed.attemptedOps, 2, "the kill lands after two ops");
  assert.equal(killed.committed, 0, "a dead transaction commits nothing");
  assert.equal(killed.acknowledgedThrough, null);
  assert.equal(retried.committed, 4);
  assert.equal(retried.acknowledgedThrough, 4);
  assert.equal(sim.desktop.received.length, 4);
  assert.equal(sim.mobile.outbox.length, 0, "acked work leaves the outbox");
});

test("duplicate-delivery: the batch crosses three times and stays three deliveries", () => {
  const sim = createSimulator();
  injection("duplicate-delivery").apply(sim);
  const delivery = lastDelivery(sim);
  assert.equal(delivery.attempts, 3);
  assert.equal(sim.desktop.received.length, 6);
  const unique = new Set(
    sim.desktop.received.map((op) => `${op.deviceId}#${op.seq}`),
  );
  assert.equal(
    unique.size,
    2,
    "the harness must not dedup on the engine's behalf",
  );
  assert.equal(delivery.acknowledgedThrough, 2);
});

test("clock-skew: three days of skew move no version stamp", () => {
  const sim = createSimulator();
  injection("clock-skew").apply(sim);
  assert.ok(now(sim.mobile) - now(sim.desktop) > 0, "the clock really is off");
  const op = sim.mobile.ackLog[0];
  assert.ok(op, "the skewed write must travel");
  assert.deepEqual(
    Object.keys(op.stamp).sort(),
    ["counter", "deviceId", "opId"],
    "a stamp must carry no time at all (§4.2)",
  );
  const earlier = { counter: 4, deviceId: "desktop-7f3c", opId: "a" };
  const later = { counter: 4, deviceId: "phone-91ab", opId: "b" };
  assert.equal(compareStamps(earlier, later), -1);
  assert.equal(compareStamps(later, earlier), 1);
});

test("conflicting-offline-edits: unmerged peers never read as converged", () => {
  const sim = createSimulator();
  injection("conflicting-offline-edits").apply(sim);
  assert.equal(sim.deliveries.length, 2);
  for (const delivery of sim.deliveries) {
    assert.equal(delivery.committed, 1, "each edit reaches the other peer");
  }
  const problems = checkConvergence(sim.desktop, sim.mobile);
  assert.ok(problems.length >= 1, "nothing merged, so the oracle must say so");
  assert.match(first(problems, "problem"), /note-shared/);
});

test("delete-vs-edit: both directions travel, the decision stays with the engine", () => {
  const sim = createSimulator();
  injection("delete-vs-edit").apply(sim);
  const [tombstone, toggle] = sim.deliveries;
  assert.ok(tombstone && toggle);
  assert.equal(tombstone.ops[0]?.kind, "delete");
  assert.equal(toggle.ops[0]?.kind, "toggle");
  assert.equal(toggle.committed, 1);
  assert.equal(tombstone.committed, 1);
  // §5.3 is a merge rule: the harness cannot satisfy it by itself.
  assert.equal(
    checkTombstones([{ table: "shopping_items", uid: "item-1" }], [sim.mobile])
      .length,
    1,
  );
});

test("cascaded-child-delete: the child tombstone is in the same batch", () => {
  const sim = createSimulator();
  injection("cascaded-child-delete").apply(sim);
  const delivery = lastDelivery(sim);
  assert.deepEqual(
    delivery.ops.map((op) => `${op.table}:${op.uid}`),
    ["collections:collection-1", "notes:note-in-collection"],
  );
  assert.equal(delivery.committed, 2);
  assert.equal(
    checkTombstones(
      [
        { table: "collections", uid: "collection-1" },
        { table: "notes", uid: "note-in-collection" },
      ],
      [sim.mobile],
    ).length,
    2,
  );
});

test("revoked-peer: the refusal is a wall, and the write stays owed", () => {
  const sim = createSimulator();
  injection("revoked-peer").apply(sim);
  const delivery = lastDelivery(sim);
  assert.deepEqual(checkNothingFlowed(delivery), []);
  assert.match(String(delivery.refusal), /revoked/);
  assert.equal(sim.desktop.received.length, 0);
  assert.equal(
    sim.mobile.outbox.length,
    1,
    "a refused write is still the phone's to retry after re-pairing",
  );
});

test("old-backup-restore: the generation bump refuses until the phone re-pairs", () => {
  const sim = createSimulator();
  injection("old-backup-restore").apply(sim);
  const delivery = lastDelivery(sim);
  assert.deepEqual(checkNothingFlowed(delivery), []);
  assert.match(String(delivery.refusal), /re-pair/);
  assert.equal(sim.desktop.generation, 2);
  assert.equal(sim.mobile.generation, 1);
});

test("desktop-only-leak: an excluded row on the wire is named, not tolerated", () => {
  const sim = createSimulator();
  injection("desktop-only-leak").apply(sim);
  const problems = checkNoForbiddenRows(sim.desktop);
  assert.equal(problems.length, 1);
  assert.match(first(problems, "leak"), /contacts:contact-should-never-sync/);
  assert.deepEqual(checkNoForbiddenRows(sim.mobile), []);
  assert.equal(writeAllowed("contacts", "create", "mobile").allowed, false);
});

// ---------------------------------------------------------------------------
// The oracles: they fail when they should. A harness that cannot say "no" is
// not a verdict.
// ---------------------------------------------------------------------------

test("the convergence oracle passes an identical pair and fails a divergent one", () => {
  const sim = createSimulator();
  seedRecord(sim.desktop, {
    table: "notes",
    uid: "note-1",
    fields: { title: "at home" },
    counter: 3,
  });
  const stored = sim.desktop.records.get(recordKey("notes", "note-1"));
  assert.ok(stored, "the seed must materialise");
  sim.mobile.records.set(recordKey("notes", "note-1"), {
    ...stored,
    fields: { ...stored.fields },
  });
  assert.deepEqual(checkConvergence(sim.desktop, sim.mobile), []);

  sim.desktop.claimedSynced = true;
  sim.mobile.claimedSynced = true;
  sim.mobile.records.delete(recordKey("notes", "note-1"));
  const problems = checkConvergence(sim.desktop, sim.mobile);
  assert.equal(problems.length, 1);
  assert.match(first(problems, "problem"), /note-1/);
});

test("the no-loss oracle catches an acknowledged write that vanished", () => {
  const sim = createSimulator();
  const op = makeOp(sim.mobile, {
    table: "notes",
    uid: "note-lost",
    kind: "create",
  });
  sim.mobile.ackLog.push(op); // acknowledged to the origin...
  const problems = checkNoAcknowledgedLoss([sim.mobile, sim.desktop]);
  // ...and absent on both peers is loss, reported once per peer.
  assert.equal(problems.length, 2);
  for (const problem of problems) assert.match(problem, /note-lost/);
});

test("the leak oracle sees an excluded module's record", () => {
  const sim = createSimulator();
  seedRecord(sim.desktop, {
    table: "journal_entries",
    uid: "journal-1",
    fields: { content: "private" },
  });
  const problems = checkNoForbiddenRows(sim.desktop);
  assert.equal(problems.length, 1);
  assert.match(first(problems, "leak"), /journal_entries/);
});

test("a refusal is only a refusal when nothing flows", () => {
  const sim = createSimulator();
  revokePeer(sim.desktop, sim.mobile.deviceId);
  const delivered = sim.send(sim.mobile, sim.desktop, [
    makeOp(sim.mobile, { table: "notes", uid: "n-1", kind: "create" }),
  ]);
  assert.deepEqual(checkNothingFlowed(delivered), []);
  sim.desktop.revoked.clear();
  const admitted = sim.send(sim.mobile, sim.desktop, [
    makeOp(sim.mobile, { table: "notes", uid: "n-1", kind: "create" }),
  ]);
  assert.equal(admitted.committed, 1);
  const flowed = checkNothingFlowed(admitted);
  // Not refused, one op committed, and it was acknowledged: three problems.
  assert.equal(flowed.length, 3, "a flow is not a refusal");
  assert.match(first(flowed, "flow problem"), /not refused/);
});

test("the handshake refuses a peer that cannot share the same line of data", () => {
  const local = {
    deviceId: "phone-91ab",
    protocolVersion: PROTOCOL_VERSION,
    dataSchemaVersion: 7,
    generation: 1,
  };
  const desktop = { ...local, deviceId: "desktop-7f3c" };
  assert.equal(handshake(local, desktop).ok, true);

  const sameDevice = handshake(local, local);
  assert.equal(sameDevice.ok, false);

  const staleGeneration = handshake(local, { ...desktop, generation: 2 });
  assert.equal(staleGeneration.ok, false);
  assert.equal(
    staleGeneration.ok ? null : staleGeneration.code,
    "generation-mismatch",
  );

  const oldBuild = handshake(local, {
    ...desktop,
    protocolVersion: PROTOCOL_VERSION + 1,
  });
  assert.equal(oldBuild.ok, false);
  assert.equal(oldBuild.ok ? null : oldBuild.code, "protocol-unsupported");
});

test("first pairing never plans a deletion", () => {
  const plan = planAdoption(["shared", "desktop-only"], ["shared", "new"]);
  assert.deepEqual([...plan.upload], ["new"]);
  assert.deepEqual([...plan.alreadyKnown], ["shared"]);
  assert.deepEqual([...plan.deletions], [], "adoption never wipes (§9.1)");
});

test("a tombstone is collectable only when every known peer has it", () => {
  assert.equal(tombstoneGcEligible([], []), false, "no peers, no proof");
  assert.equal(tombstoneGcEligible(["phone"], ["phone"]), true);
  assert.equal(tombstoneGcEligible(["phone"], ["phone", "laptop"]), false);
  assert.equal(tombstoneGcEligible([], ["phone"]), false);
});

test("the phone cannot write what the allowlist does not grant it", () => {
  assert.equal(
    writeAllowed("expense_entries", "create", "mobile").allowed,
    true,
  );
  assert.equal(
    writeAllowed("expense_entries", "update", "mobile").allowed,
    false,
  );
  assert.equal(writeAllowed("jobs", "delete", "mobile").allowed, false);
  assert.equal(writeAllowed("wallets", "create", "mobile").allowed, false);
  assert.equal(writeAllowed("vault_items", "create", "mobile").allowed, false);
  assert.equal(writeAllowed("tasks", "toggle", "mobile").allowed, true);
  assert.equal(writeAllowed("wallets", "update", "desktop").allowed, true);
  assert.equal(writeAllowed("trash_items", "create", "desktop").allowed, false);
});

// ---------------------------------------------------------------------------
// Stage 1's obligations — the exit evidence (§14.5). Each invariant runs over
// the REAL stack: two SQLite stores, the repositories' recording, the engine's
// apply, and the session's cursor and acknowledgement bookkeeping, ferried in
// process (`testFerry.ts`). Nothing here is judged by the harness's own
// bookkeeping, and none of them is skipped.
// ---------------------------------------------------------------------------

interface Invariant {
  name: string;
  clauses: readonly string[];
  body: () => Promise<void>;
}

/** One session, run the way the app runs it. */
function syncOnce(phone: SyncFixture, wire: Ferry) {
  return runSync(phone.driver, wire.phone, SYNC_INPUT, {
    sleep: async () => undefined,
  });
}

/** Every row stamp this store holds, for an idempotency comparison. */
function stamps(store: SyncFixture) {
  return store.driver.query<{
    entity_table: string;
    entity_uid: string;
    counter: number;
    device_id: string;
    op_id: string;
  }>(
    "SELECT entity_table, entity_uid, counter, device_id, op_id FROM sync_row_stamps ORDER BY entity_uid",
  );
}

/** The values one column holds, in row order. */
async function column(store: SyncFixture, sql: string): Promise<string[]> {
  const rows = await store.driver.query<{ value: string }>(sql);
  return rows.map((row) => row.value);
}

const STAGE_ONE_INVARIANTS: readonly Invariant[] = [
  {
    name: "two populated peers converge without losing acknowledged ops",
    clauses: ["§9.1", "§14.2", "§14.3"],
    body: async () => {
      const { phone, desktop } = await pairStores();
      // One write on each side, made apart: the case a session exists for.
      await createNotesRepo(phone.driver).createNote({
        title: "Made on the phone",
        content: "",
      });
      await createTasksRepo(desktop.driver).createTask({
        title: "Made on the desktop",
      });

      const wire = ferry(phone, desktop);
      const outcome = await syncOnce(phone, wire);
      assert.equal(outcome.confirmed, true);
      assert.equal(outcome.pushed, 1);
      assert.equal(outcome.pulled, 1);

      // §14.2: the same records, with the same values, on both devices.
      for (const [name, store] of [
        ["phone", phone],
        ["desktop", desktop],
      ] as const) {
        assert.deepEqual(
          await column(store, "SELECT title AS value FROM notes"),
          ["Made on the phone"],
          `${name} holds the phone's note`,
        );
        assert.deepEqual(
          await column(store, "SELECT title AS value FROM tasks"),
          ["Made on the desktop"],
          `${name} holds the desktop's task`,
        );
      }

      // §14.3: the phone's acknowledged write left the outbox only because
      // the desktop's sealed verdict said applied — and what it carried is
      // here on both devices.
      assert.deepEqual(await readOutbox(phone.driver), []);
      assert.equal((await peerOf(phone, DESKTOP)).cursor_out, 1);
      assert.equal((await peerOf(desktop, PHONE)).cursor_in, 1);
    },
  },
  {
    name: "a retried batch is idempotent",
    clauses: ["§6.3", "§7.2"],
    body: async () => {
      const { phone, desktop } = await pairStores();
      await createNotesRepo(phone.driver).createNote({
        title: "Sent once",
        content: "",
      });
      const wire = ferry(phone, desktop);
      await syncOnce(phone, wire);
      const before = await stamps(desktop);

      // §6.3's lost acknowledgement: the very same batch arrives again — same
      // device, same seq, same op id — and must be a no-op (§7.2).
      await desktop.driver.batch(
        await applyOps(desktop.driver, {
          peerId: PHONE,
          origin: "mobile",
          ops: wire.pushed,
        }),
      );

      assert.equal(
        await countRows(desktop, "SELECT count(*) AS n FROM notes"),
        1,
        "one record, not two",
      );
      assert.deepEqual(await stamps(desktop), before, "and the same stamp");

      // A second session sends nothing at all: nothing is past the cursor.
      wire.newWindow();
      const second = await syncOnce(phone, wire);
      assert.equal(second.pushed, 0);
      assert.equal(second.pulled, 0);
    },
  },
  {
    name: "an interrupted apply loses no acknowledged write and keeps the cursor honest",
    clauses: ["§6.4", "§7.4", "§7.5"],
    body: async () => {
      const { phone, desktop } = await pairStores();
      const tasks = createTasksRepo(desktop.driver);
      await tasks.createTask({ title: "One" });
      await tasks.createTask({ title: "Two" });

      const wire = ferry(phone, desktop);
      wire.splitPull = true;
      wire.failPullAt = 1;
      const interrupted = await syncOnce(phone, wire);
      assert.equal(interrupted.confirmed, false);
      assert.equal(
        await countRows(phone, "SELECT count(*) AS n FROM tasks"),
        1,
        "batch 0 committed; the pull stopped there",
      );
      assert.equal(
        (await peerOf(phone, DESKTOP)).cursor_in,
        1,
        "the cursor moved inside that apply, not in memory (§6.4)",
      );

      // The next window resumes from the cursor: batch 0 is not offered again.
      wire.newWindow();
      wire.splitPull = false;
      const resumed = await syncOnce(phone, wire);
      assert.equal(resumed.confirmed, true);
      assert.deepEqual(
        await column(phone, "SELECT title AS value FROM tasks ORDER BY id"),
        ["One", "Two"],
        "§14.3: both acknowledged writes arrived, each once",
      );
      const [highest] = await desktop.driver.query<{ seq: number | null }>(
        "SELECT max(seq) AS seq FROM sync_outbox",
      );
      assert.equal(
        (await peerOf(phone, DESKTOP)).cursor_in,
        highest?.seq ?? 0,
        "the cursor is exactly the last applied seq, never past it",
      );
    },
  },
  {
    name: "tombstones propagate, cascaded children included",
    clauses: ["§5.2", "§5.3"],
    body: async () => {
      const { phone, desktop } = await pairStores();
      const shopping = createShoppingRepo(desktop.driver);
      const list = await shopping.createList("Weekly shop");
      await shopping.addItem(list, "Milk");

      // The rows travel first, so the delete has something to cascade over on
      // the other device.
      const wire = ferry(phone, desktop);
      await syncOnce(phone, wire);
      assert.equal(
        await countRows(phone, "SELECT count(*) AS n FROM shopping_items"),
        1,
      );

      wire.newWindow();
      await shopping.deleteList(list);
      await syncOnce(phone, wire);

      assert.equal(
        await countRows(phone, "SELECT count(*) AS n FROM shopping_lists"),
        0,
      );
      assert.equal(
        await countRows(phone, "SELECT count(*) AS n FROM shopping_items"),
        0,
        "the cascade removes the child row too",
      );
      assert.deepEqual(
        await column(
          phone,
          "SELECT entity_table AS value FROM sync_tombstones ORDER BY entity_table",
        ),
        ["shopping_items", "shopping_lists"],
        "§5.2: the child's tombstone travels, not only the parent's",
      );
    },
  },
  {
    name: "a revoked peer is rejected before any effect",
    clauses: ["§11.3"],
    body: async () => {
      const { phone, desktop } = await pairStores();
      // §11.3: the pin is revoked on this device, so the phone may not send.
      await phone.driver.execute(
        "UPDATE sync_peers SET revoked_at = ? WHERE device_id = ?",
        ["2026-11-13T09:00:00.000Z", DESKTOP],
      );
      await createNotesRepo(phone.driver).createNote({
        title: "Written after a revoke",
        content: "",
      });

      const wire = ferry(phone, desktop);
      const refused = await syncOnce(phone, wire);
      assert.equal(refused.state, "refused");
      assert.equal(refused.refusal?.code, "unpaired");
      assert.equal(wire.pushed.length, 0, "not one operation reached the wire");
      assert.equal(
        await countRows(desktop, "SELECT count(*) AS n FROM notes"),
        0,
      );
      assert.equal(
        await countRows(desktop, "SELECT count(*) AS n FROM sync_row_stamps"),
        0,
        "and nothing on the desktop changed at all",
      );
      assert.equal(
        await countRows(phone, "SELECT count(*) AS n FROM sync_outbox"),
        1,
        "the write stays the phone's to retry after re-pairing",
      );
    },
  },
  {
    name: "desktop-only rows never appear on the peer",
    clauses: ["§2.2"],
    body: async () => {
      const { phone, desktop } = await pairStores();
      // A row no stage ever moves — the Trash page's own record, written where
      // the Trash page writes it — beside a real record that must travel.
      await desktop.driver.execute(
        `INSERT INTO trash_items (entity_type, entity_id, snapshot, deleted_at, created_at)
         VALUES ('note', 1, '{}', '2026-11-13', '2026-11-13')`,
      );
      await createNotesRepo(desktop.driver).createNote({
        title: "A real record",
        content: "",
      });

      const wire = ferry(phone, desktop);
      await syncOnce(phone, wire);

      assert.equal(
        await countRows(phone, "SELECT count(*) AS n FROM trash_items"),
        0,
        "§2.2: an excluded table never crosses, not even as a stray row",
      );
      assert.equal(
        await countRows(phone, "SELECT count(*) AS n FROM notes"),
        1,
        "while the record beside it did cross",
      );
      const onWire = new Set([
        ...(await readOutbox(desktop.driver)).map((row) => row.entity_table),
        ...wire.pushed.map((op) => op.entity_table),
      ]);
      for (const table of onWire) {
        assert.ok(
          isSyncTable(table),
          `${table} crossed the allowlist boundary`,
        );
      }
    },
  },
];

test("the invariants are the coverage the spec requires", () => {
  assert.ok(
    STAGE_ONE_INVARIANTS.length >= 6,
    "the spec requires six invariants before Stage 1 can be judged",
  );
  for (const invariant of STAGE_ONE_INVARIANTS) {
    assert.ok(
      invariant.clauses.length >= 1,
      `${invariant.name} must cite the clause it enforces`,
    );
    for (const clause of invariant.clauses) {
      assert.ok(
        CLAUSES.has(clause),
        `${invariant.name} cites ${clause}, which the spec does not define`,
      );
    }
  }
});

for (const invariant of STAGE_ONE_INVARIANTS) {
  test(invariant.name, () => invariant.body());
}
