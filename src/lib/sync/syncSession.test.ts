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
import { ackStatements, readOutbox } from "./store.ts";
import { runSync } from "./syncSession.ts";
import {
  countRows as count,
  DESKTOP,
  ferry,
  SYNC_INPUT as input,
  PHONE,
  pairStores as pair,
  peerOf as peer,
} from "./testFerry.ts";

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
