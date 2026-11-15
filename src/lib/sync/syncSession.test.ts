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
import { createBudgetRepo } from "../budget.ts";
import { createBusinessRepo } from "../business.ts";
import { createNotesRepo } from "../notes.ts";
import { createTasksRepo } from "../tasks.ts";
import { createVaultRepo } from "../vault.ts";
import { planBootstrap } from "./bootstrap.ts";
import { readLocalRows } from "./mobilePairing.ts";
import {
  ackStatements,
  readOutbox,
  readState,
  snapshotStatements,
} from "./store.ts";
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

test("a phone records no vault op, so nothing of the Vault reaches the wire", async () => {
  const { phone, desktop } = await pair();
  // §2.3/§12.3: the vault is one-way desktop→mobile, and the phone's
  // repository is built with its own origin — so a mobile vault write stays on
  // this device and records nothing, rather than recording an op the desktop
  // would refuse as a whole batch.
  const vault = createVaultRepo(phone.driver, "mobile");
  await vault.setupVault("phone-pass");
  await vault.addItem("email", "s3cret", "phone-pass");

  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.pushed, 0, "nothing the peer may receive is pending");
  assert.equal(wire.pushed.length, 0, "not one vault op reached the wire");
  assert.equal(
    await count(phone, "SELECT count(*) AS n FROM sync_outbox"),
    0,
    "and nothing was recorded to send later either (§2.3)",
  );
  assert.equal(
    await count(phone, "SELECT count(*) AS n FROM vault_items"),
    1,
    "the item itself is still on the phone",
  );
  assert.equal(
    await count(
      desktop,
      "SELECT count(*) AS n FROM sync_row_stamps WHERE entity_table = ?",
      ["vault_items"],
    ),
    0,
  );
});

test("a phone's expense entry syncs with both parents resolved by uid", async () => {
  const { phone, desktop } = await pair();
  // Budget's parents are desktop-owned, so they arrive before the entry can.
  const onDesktop = createBudgetRepo(desktop.driver);
  await onDesktop.createWallet("Cash");
  await onDesktop.createExpenseCategory("Food");
  const opening = ferry(phone, desktop);
  const opened = await runSync(phone.driver, opening.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(opened.confirmed, true);

  const [wallet] = await phone.driver.query<{ id: number }>(
    "SELECT id FROM wallets WHERE name = 'Cash'",
  );
  const [category] = await phone.driver.query<{ id: number }>(
    "SELECT id FROM expense_categories WHERE name = 'Food'",
  );
  assert.ok(wallet && category, "the phone holds the wallet and category");
  await createBudgetRepo(phone.driver).createExpenseEntry({
    amountCents: 2_500,
    categoryId: category.id,
    walletId: wallet.id,
    entryDate: "2026-11-13",
    note: "taxi",
  });

  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.pushed, 1, "the entry travels");
  assert.deepEqual(
    wire.pushed.map((op) => op.entity_table),
    ["expense_entries"],
  );

  const [entry] = await desktop.driver.query<{
    amount_cents: number;
    note: string;
    wallet_id: number;
  }>("SELECT * FROM expense_entries");
  assert.ok(entry, "the desktop holds the phone's entry");
  assert.equal(entry.amount_cents, 2_500);
  assert.equal(entry.note, "taxi");
  assert.equal(
    await count(desktop, "SELECT count(*) AS n FROM wallets"),
    1,
    "and it resolved the parent it already held, not a second one",
  );
  assert.deepEqual(
    (await readOutbox(phone.driver)).map((row) => row.entity_table),
    [],
    "the acknowledged entry was pruned (§6.5)",
  );
});

test("a phone's job crosses and its shop is created by uid", async () => {
  const { phone, desktop } = await pair();
  await createBusinessRepo(phone.driver).createJob({
    title: "Phone job",
    totalCents: 20_000,
    jobDate: "2026-11-13",
  });

  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.pushed, 1, "the job travels");
  assert.deepEqual(
    wire.pushed.map((op) => op.entity_table),
    ["jobs"],
  );

  const jobs = await desktop.driver.query<{
    title: string;
    total_cents: number;
  }>("SELECT * FROM jobs");
  assert.equal(jobs.length, 1, "the desktop holds the phone's job");
  assert.equal(jobs[0]?.title, "Phone job");
  assert.equal(jobs[0]?.total_cents, 20_000);
  assert.deepEqual(
    (await readOutbox(phone.driver)).map((row) => row.entity_table),
    [],
    "the acknowledged job was pruned (§6.5)",
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

/**
 * The exit gate's one proof that was not written yet: **counters reconcile over
 * a full cycle**.
 *
 * Both sides are populated before the session, so the counters start apart — a
 * cycle that only ever ran from zero would prove nothing about reconciling them.
 * The cycle carries one of each kind of payload: the phone's ordinary rows, the
 * desktop's ordinary rows, and the Vault's rotation (the one op family that also
 * carries a generation, §12.3).
 *
 * The desktop's own acknowledgement is the half the ferry leaves to the
 * listener: the phone's applied report reaches it on `/pair/applied`, which
 * records it with `ackStatements` (§6.5). The phone's ack of the desktop's
 * outbox is `runSync`'s own last step, so it is not written here.
 */
test("counters reconcile over a full cycle both ways, a Vault rotation included", async () => {
  const { phone, desktop } = await pair();
  const phoneNotes = createNotesRepo(phone.driver);
  await phoneNotes.createNote({ title: "Phone one", content: "" });
  await phoneNotes.createNote({ title: "Phone two", content: "" });
  const desktopTasks = createTasksRepo(desktop.driver);
  await desktopTasks.createTask({ title: "Desktop one" });
  await desktopTasks.createTask({ title: "Desktop two" });
  const vault = createVaultRepo(desktop.driver, "desktop");
  await vault.setupVault("pass-one");
  await vault.addItem("email", "s3cret@example", "pass-one");
  await vault.changePassword("pass-one", "pass-two");

  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(outcome.confirmed, true, "the cycle went through whole");
  assert.equal(outcome.state, "applied");

  const desktopAck = wire.syncApplied;
  assert.ok(desktopAck !== null, "the phone reported what it applied");
  await desktop.driver.batch(ackStatements(PHONE, desktopAck));

  const phoneSeq = (await readState(phone.driver)).lastSeq;
  const desktopSeq = (await readState(desktop.driver)).lastSeq;
  assert.equal(phoneSeq, 2, "the phone's own outbox is two records");
  assert.ok(
    desktopSeq > 2,
    "the desktop's is two tasks plus the Vault rotation",
  );

  // §6.4: a cursor is the seq this device applied through, and nothing infers
  // the other side's position. Reaching the end on both sides IS the
  // reconciliation.
  assert.equal(
    (await peer(desktop, PHONE)).cursor_in,
    phoneSeq,
    "the desktop applied the phone's outbox to its end",
  );
  assert.equal(
    (await peer(phone, DESKTOP)).cursor_in,
    desktopSeq,
    "the phone applied the desktop's outbox to its end",
  );
  // §6.5: `cursor_out` is the acked position, not the peer's outbox end — so
  // each side records the OTHER's acknowledgement of its own rows.
  assert.equal(
    (await peer(phone, DESKTOP)).cursor_out,
    phoneSeq,
    "the desktop acked the phone's outbox to its end",
  );
  assert.equal(
    (await peer(desktop, PHONE)).cursor_out,
    desktopSeq,
    "the phone acked the desktop's outbox to its end",
  );

  // §6.5: every row was delivered and acknowledged, so nothing is left to
  // prune and no acknowledgement outlives the row it named.
  assert.deepEqual(
    await readOutbox(phone.driver),
    [],
    "the phone's outbox is prunable and pruned",
  );
  assert.deepEqual(
    await readOutbox(desktop.driver),
    [],
    "the desktop's outbox is prunable and pruned",
  );
  for (const [name, store] of [
    ["phone", phone],
    ["desktop", desktop],
  ] as const) {
    assert.equal(
      await count(store, "SELECT count(*) AS n FROM sync_outbox_delivery"),
      0,
      `${name} keeps no delivery row for a row that is gone`,
    );
  }

  // And the counters are a means: the two stores hold the same records.
  for (const [name, store] of [
    ["phone", phone],
    ["desktop", desktop],
  ] as const) {
    assert.equal(
      await count(store, "SELECT count(*) AS n FROM notes"),
      2,
      `${name} holds both notes`,
    );
    assert.equal(
      await count(store, "SELECT count(*) AS n FROM tasks"),
      2,
      `${name} holds both tasks`,
    );
  }
  assert.equal(
    await count(phone, "SELECT count(*) AS n FROM vault_items"),
    1,
    "the phone holds the rotated item",
  );
  const [generation] = await phone.driver.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    ["vault_generation"],
  );
  assert.equal(
    generation?.value,
    "2",
    "and only in the rotation's generation, not the one it replaced",
  );
  // The generation is not just a number on a row: the phone's vault must OPEN
  // with the rotation's password and refuse the one it replaced. That is the
  // whole of §12.3 in one assertion pair — the batch carried both generations,
  // so a verifier taken from the first would fail both.
  const phoneVault = createVaultRepo(phone.driver, "mobile");
  await assert.rejects(
    phoneVault.unlock("pass-one"),
    "the phone must not answer to the password the rotation replaced",
  );
  await phoneVault.unlock("pass-two");
  const items = await phoneVault.listItems();
  assert.equal(items.length, 1, "one item, not one per generation");
  assert.equal(items[0]?.title, "email");
});

test("a fat outbox crosses as several in-budget push batches and prunes", async () => {
  const { phone, desktop } = await pair();
  const notes = createNotesRepo(phone.driver);
  // 3 KiB of body each: a 30 KiB frame holds only a handful of these, so a
  // 60-note backlog cannot cross in one batch. Before SW-04's discipline this
  // was the ordinary volume at which a pull could not be framed at all.
  const body = "x".repeat(3 * 1024);
  for (let index = 0; index < 60; index += 1) {
    await notes.createNote({ title: `Bulk ${index}`, content: body });
  }

  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });

  assert.equal(outcome.state, "applied");
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.pushed, 60, "every queued op crossed");
  assert.equal(
    await count(desktop, "SELECT count(*) AS n FROM notes"),
    60,
    "the desktop holds the whole backlog",
  );
  assert.deepEqual(
    await readOutbox(phone.driver),
    [],
    "nothing acked is left unpruned",
  );
  assert.equal(
    (await peer(phone, DESKTOP)).cursor_out,
    60,
    "the sealed verdict moved the cursor past all 60",
  );
});

test("a pre-pairing edit naming a folded seed resolves to the winner and sync converges", async () => {
  const { phone, desktop } = await pair();
  const PHONE_CATEGORY = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const PHONE_WALLET = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

  // The phone's own baseline seeds: local rows, no ops — a seed is not an edit.
  await phone.driver.batch([
    {
      sql: "INSERT INTO wallets (name, uid, created_at) VALUES ('Cash', ?, '2026-11-01')",
      params: [PHONE_WALLET],
    },
    {
      sql: "INSERT INTO expense_categories (name, uid, created_at) VALUES ('Food', ?, '2026-11-01')",
      params: [PHONE_CATEGORY],
    },
  ]);
  const [phoneWallet] = await phone.driver.query<{ id: number }>(
    "SELECT id FROM wallets WHERE uid = ?",
    [PHONE_WALLET],
  );
  const [phoneCategory] = await phone.driver.query<{ id: number }>(
    "SELECT id FROM expense_categories WHERE uid = ?",
    [PHONE_CATEGORY],
  );
  assert.ok(phoneWallet && phoneCategory);
  // The pre-pairing edit: an append-only entry naming the phone's own seeds.
  const entryId = await createBudgetRepo(phone.driver).createExpenseEntry({
    amountCents: 1_500,
    categoryId: phoneCategory.id,
    walletId: phoneWallet.id,
    entryDate: "2026-11-14",
  });
  assert.ok(entryId > 0);

  // The desktop holds the same seeds under ITS uids.
  const desktopBudget = createBudgetRepo(desktop.driver);
  await desktopBudget.createWallet("Cash");
  const desktopCategoryId = await desktopBudget.createExpenseCategory("Food");
  const [desktopCategory] = await desktop.driver.query<{ uid: string }>(
    "SELECT uid FROM expense_categories WHERE id = ?",
    [desktopCategoryId],
  );
  assert.ok(desktopCategory?.uid);

  // Pairing: the snapshot arrives and its same-name seeds FOLD the phone's rows
  // onto the desktop's uids — recording the retired uids locally (D-6).
  const plan = planBootstrap(
    await readLocalRows(desktop.driver),
    await readLocalRows(phone.driver),
  );
  await phone.driver.batch(
    snapshotStatements(plan.snapshot, [], new Date(), DESKTOP),
  );
  const [folded] = await phone.driver.query<{ uid: string }>(
    "SELECT uid FROM expense_categories WHERE name = 'Food'",
  );
  assert.equal(
    folded?.uid,
    desktopCategory.uid,
    "the phone's seed now carries the desktop's uid",
  );
  const [alias] = await phone.driver.query<{ winner_uid: string }>(
    "SELECT winner_uid FROM sync_uid_aliases WHERE entity_table = 'expense_categories' AND loser_uid = ?",
    [PHONE_CATEGORY],
  );
  assert.equal(
    alias?.winner_uid,
    desktopCategory.uid,
    "the retired uid stays resolvable on the device that folded it",
  );

  // The upload half of the first pairing has not run (an interrupted pairing is
  // retryable, §9.4), so the queued edit is what carries the entry across.
  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(outcome.state, "applied", "nothing wedges");
  assert.equal(outcome.pushed, 1, "the queued edit crossed");

  // Send-time resolution: the op carries the winner's uid, not the uid it was
  // recorded under — which is what let the entry's NOT NULL parent resolve.
  const pushed = wire.pushed[0];
  assert.equal(pushed?.entity_table, "expense_entries");
  assert.equal(
    JSON.parse(pushed?.payload ?? "{}").category_uid,
    desktopCategory.uid,
  );
  const entries = await desktop.driver.query<{
    amount_cents: number;
    category_id: number;
  }>("SELECT * FROM expense_entries");
  assert.equal(entries.length, 1, "the entry landed on the desktop");
  assert.equal(entries[0]?.amount_cents, 1_500);
  assert.equal(entries[0]?.category_id, desktopCategoryId);
  // Aliases are this device's bookkeeping; they never travel.
  assert.equal(
    await count(desktop, "SELECT count(*) AS n FROM sync_uid_aliases"),
    0,
  );
});
