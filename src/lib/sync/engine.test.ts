/**
 * Stage 1's apply half — `docs/ANDROID_SYNC_PROTOCOL.md` §4, §5, §7 and §13.2.
 *
 * Every test here runs TWO stores over the same real SQLite fixture: A records
 * with Session 1's repositories, B applies with the engine. "Converges" means
 * B ends up holding what A holds — same rows, same stamps — which is the only
 * claim worth making about a merge engine.
 *
 * The starting points are always produced by the real repositories (never
 * hand-written outbox rows) except where a test needs an operation no local
 * writer produces — a mobile edit of a habit log, an op for a Stage 2 table —
 * and those say so.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createBudgetRepo } from "../budget.ts";
import { createBusinessRepo } from "../business.ts";
import { createHabitsRepo } from "../habits.ts";
import { createLoansRepo } from "../loans.ts";
import { createNotesRepo } from "../notes.ts";
import { createTasksRepo } from "../tasks.ts";
import { createTrashRepo, TRASH_CONFLICT_KIND } from "../trash.ts";
import { applyOps, type PeerOp } from "./engine.ts";
import type { Origin, VersionStamp } from "./protocol.ts";
import {
  readOutbox,
  readState,
  readTombstones,
  registerPeerStatements,
} from "./store.ts";
import { openSyncStore, type SyncFixture } from "./testSchema.ts";

const DEVICE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DEVICE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

interface Pair {
  a: SyncFixture;
  b: SyncFixture;
}

/**
 * Two devices, each pinned to the other. The peer rows are not needed for the
 * merge — they are what the cursor advance writes into (§6.4), so having them
 * makes the cursor claims below mean something.
 */
async function openPair(): Promise<Pair> {
  const a = openSyncStore(DEVICE_A);
  const b = openSyncStore(DEVICE_B);
  await a.driver.batch([
    ...registerPeerStatements({ deviceId: DEVICE_B, generation: 1 }),
  ]);
  await b.driver.batch([
    ...registerPeerStatements({ deviceId: DEVICE_A, generation: 1 }),
  ]);
  return { a, b };
}

/** A's own device id, as the peer row on B names it. */
async function deviceOf(store: SyncFixture): Promise<string> {
  return (await readState(store.driver)).deviceId;
}

/** Every op this device has recorded, in `seq` order. */
async function opsOf(store: SyncFixture): Promise<PeerOp[]> {
  return readOutbox(store.driver);
}

/**
 * Apply `source`'s ops to `target`, in seq order, as one batch — the caller's
 * one transaction (§7.4). `ops` narrows what is sent, which is how a test says
 * "B's cursor was already past the earlier ones".
 */
async function applyFrom(
  target: SyncFixture,
  source: SyncFixture,
  options: { origin?: Origin; ops?: readonly PeerOp[] } = {},
): Promise<void> {
  const ops = options.ops ?? (await opsOf(source));
  const statements = await applyOps(target.driver, {
    peerId: await deviceOf(source),
    origin: options.origin ?? "desktop",
    ops,
  });
  await target.driver.batch(statements);
}

interface NoteRow {
  id: number;
  uid: string | null;
  title: string;
  content: string;
  collection_id: number | null;
}

async function notesIn(store: SyncFixture, uid?: string): Promise<NoteRow[]> {
  return uid === undefined
    ? store.driver.query<NoteRow>("SELECT * FROM notes ORDER BY id")
    : store.driver.query<NoteRow>("SELECT * FROM notes WHERE uid = ?", [uid]);
}

async function stampOf(
  store: SyncFixture,
  table: string,
  uid: string,
): Promise<VersionStamp | undefined> {
  const [row] = await store.driver.query<{
    counter: number;
    device_id: string;
    op_id: string;
  }>(
    "SELECT counter, device_id, op_id FROM sync_row_stamps WHERE entity_table = ? AND entity_uid = ?",
    [table, uid],
  );
  return row
    ? { counter: row.counter, deviceId: row.device_id, opId: row.op_id }
    : undefined;
}

async function count(
  store: SyncFixture,
  sql: string,
  params: unknown[] = [],
): Promise<number> {
  const [row] = await store.driver.query<{ n: number }>(sql, params);
  return row?.n ?? 0;
}

/**
 * An operation no local writer produces — a phone's edit of a habit log, or an
 * op for a table Stage 1 does not move. Both are wire documents, so they are
 * written the way the wire writes them (§6.2).
 */
function syntheticOp(
  deviceId: string,
  seq: number,
  table: string,
  uid: string,
  kind: PeerOp["op"],
  fields: Record<string, unknown>,
  counter: number,
): PeerOp {
  return {
    device_id: deviceId,
    seq,
    op_id: `${deviceId.slice(0, 8)}-op-${seq}`,
    entity_table: table,
    entity_uid: uid,
    op: kind,
    base_counter: counter - 1,
    counter,
    field_stamps: "{}",
    payload: JSON.stringify(fields),
  };
}

/** A note created on A and applied to B: the shape every merge test starts at. */
async function sharedNote(pair: Pair): Promise<string> {
  const notes = createNotesRepo(pair.a.driver);
  const id = await notes.createNote({ title: "Shared", content: "body" });
  await applyFrom(pair.b, pair.a);
  const [row] = await notesIn(pair.a, undefined);
  assert.ok(row?.uid, "the shared note has a uid");
  assert.equal(id, row.id);
  return row.uid;
}

// ---------------------------------------------------------------------------
// Task 1 — §4 merge, §5 tombstones, §7 semantics.
// ---------------------------------------------------------------------------

test("a create and an update arrive intact, stamps and all", async () => {
  const pair = await openPair();
  const uid = await sharedNote(pair);
  const [onB] = await notesIn(pair.b, uid);
  assert.ok(onB, "the create landed on B");
  assert.equal(onB.title, "Shared");
  assert.equal(onB.content, "body");

  const notesA = createNotesRepo(pair.a.driver);
  const [rowA] = await notesIn(pair.a, uid);
  assert.ok(rowA);
  await notesA.updateNote(rowA.id, { content: "body, edited" });
  await applyFrom(pair.b, pair.a);

  const [updated] = await notesIn(pair.b, uid);
  assert.ok(updated);
  assert.equal(
    updated.content,
    "body, edited",
    "the update merged into the row B already held",
  );
  assert.equal(updated.title, "Shared");
  assert.equal(
    await count(pair.b, "SELECT count(*) AS n FROM notes"),
    1,
    "an update to a known uid is never a second row",
  );
  assert.deepEqual(
    await stampOf(pair.b, "notes", uid),
    await stampOf(pair.a, "notes", uid),
    "both devices hold the record under the same stamp",
  );
});

test("two devices edit DIFFERENT fields offline and both edits survive", async () => {
  const pair = await openPair();
  const uid = await sharedNote(pair);
  const [rowB] = await notesIn(pair.b, uid);
  assert.ok(rowB);

  // A changes the title, B the body, neither having seen the other (§4.3).
  const notesA = createNotesRepo(pair.a.driver);
  const [rowA] = await notesIn(pair.a, uid);
  assert.ok(rowA);
  await notesA.updateNote(rowA.id, { title: "A's title" });
  const notesB = createNotesRepo(pair.b.driver);
  await notesB.updateNote(rowB.id, { content: "B's body" });

  await applyFrom(pair.b, pair.a);
  await applyFrom(pair.a, pair.b);

  for (const [name, store] of [
    ["A", pair.a],
    ["B", pair.b],
  ] as const) {
    const [row] = await notesIn(store, uid);
    assert.ok(row, `${name} holds the note`);
    assert.equal(row.title, "A's title", `${name} kept A's title`);
    assert.equal(row.content, "B's body", `${name} kept B's body`);
  }
  assert.deepEqual(
    await stampOf(pair.a, "notes", uid),
    await stampOf(pair.b, "notes", uid),
    "the merged record carries the same stamp on both sides (§4.2)",
  );
});

test("the same field edited on both sides resolves by stamp, deterministically", async () => {
  const pair = await openPair();
  const uid = await sharedNote(pair);
  const [rowB] = await notesIn(pair.b, uid);
  const [rowA] = await notesIn(pair.a, uid);
  assert.ok(rowA && rowB);

  // Both writes take counter 2 (each device saw only the create), so the
  // device id decides — B's is lexicographically higher (§4.2).
  await createNotesRepo(pair.a.driver).updateNote(rowA.id, {
    title: "A wins?",
  });
  await createNotesRepo(pair.b.driver).updateNote(rowB.id, {
    title: "B wins?",
  });
  assert.equal(
    (await stampOf(pair.a, "notes", uid))?.counter,
    (await stampOf(pair.b, "notes", uid))?.counter,
    "precondition: the counters tie, so the tie-break is what decides",
  );

  await applyFrom(pair.b, pair.a);
  await applyFrom(pair.a, pair.b);

  for (const store of [pair.a, pair.b]) {
    const [row] = await notesIn(store, uid);
    assert.equal(
      row?.title,
      "B wins?",
      "the higher device id wins an equal counter",
    );
    assert.deepEqual(await stampOf(store, "notes", uid), {
      counter: 2,
      deviceId: DEVICE_B,
      opId: (await stampOf(pair.b, "notes", uid))?.opId,
    });
  }
});

test("a delete that outranks the local edit removes the row on both devices", async () => {
  const pair = await openPair();
  const uid = await sharedNote(pair);
  const [rowB] = await notesIn(pair.b, uid);
  const [rowA] = await notesIn(pair.a, uid);
  assert.ok(rowA && rowB);

  // B edits at counter 2. A edits (2) and then deletes (3), so the delete is
  // strictly newer than the value B holds.
  await createNotesRepo(pair.b.driver).updateNote(rowB.id, { content: "B" });
  await createNotesRepo(pair.a.driver).updateNote(rowA.id, { title: "A" });
  await createNotesRepo(pair.a.driver).deleteNote(rowA.id);

  await applyFrom(pair.b, pair.a);
  assert.equal(
    await count(pair.b, "SELECT count(*) AS n FROM notes"),
    0,
    "§5.3: the newer delete removes the row B was holding",
  );
  const [tombstone] = await readTombstones(pair.b.driver);
  assert.equal(tombstone?.entity_uid, uid);

  // And B's older edit, arriving at A, cannot resurrect what the tombstone
  // outranks: A keeps the record dead.
  await applyFrom(pair.a, pair.b, { ops: (await opsOf(pair.b)).slice(0, 1) });
  assert.equal(
    await count(pair.a, "SELECT count(*) AS n FROM notes"),
    0,
    "an op the tombstone outranks leaves the record dead",
  );
});

test("an edit newer than a remote delete keeps the row and records the losing tombstone", async () => {
  const pair = await openPair();
  const uid = await sharedNote(pair);
  const [rowA] = await notesIn(pair.a, uid);
  const [rowB] = await notesIn(pair.b, uid);
  assert.ok(rowA && rowB);

  // B deletes at counter 2; A edits at 2 and again at 3, so the value A holds
  // is strictly newer than the delete that arrives.
  await createNotesRepo(pair.b.driver).deleteNote(rowB.id);
  const notesA = createNotesRepo(pair.a.driver);
  await notesA.updateNote(rowA.id, { title: "edited" });
  await notesA.updateNote(rowA.id, { content: "edited too" });

  await applyFrom(pair.a, pair.b);
  const [survivor] = await notesIn(pair.a, uid);
  assert.equal(
    survivor?.title,
    "edited",
    "§5.3: the edit outranks the delete, so the record survives",
  );
  const tombstone = (await readTombstones(pair.a.driver)).find(
    (row) => row.entity_uid === uid,
  );
  assert.ok(
    tombstone,
    "the delete is still recorded, so the next comparison stays decidable",
  );
});

test("applying the same op list twice changes nothing the second time", async () => {
  const pair = await openPair();
  const uid = await sharedNote(pair);
  const [rowB] = await notesIn(pair.b, uid);
  assert.ok(rowB);
  await createNotesRepo(pair.b.driver).updateNote(rowB.id, { title: "B" });
  await createNotesRepo(pair.a.driver).updateNote(
    (await notesIn(pair.a, uid))[0]?.id ?? 0,
    { title: "A" },
  );

  const ops = await opsOf(pair.a);
  await applyFrom(pair.b, pair.a, { ops });
  const first = {
    rows: await notesIn(pair.b),
    stamp: await stampOf(pair.b, "notes", uid),
    lamport: (await readState(pair.b.driver)).lamport,
    cursor: (
      await pair.b.driver.query<{ cursor_in: number }>(
        "SELECT cursor_in FROM sync_peers WHERE device_id = ?",
        [DEVICE_A],
      )
    )[0]?.cursor_in,
  };

  await applyFrom(pair.b, pair.a, { ops });
  assert.deepEqual(
    {
      rows: await notesIn(pair.b),
      stamp: await stampOf(pair.b, "notes", uid),
      lamport: (await readState(pair.b.driver)).lamport,
      cursor: (
        await pair.b.driver.query<{ cursor_in: number }>(
          "SELECT cursor_in FROM sync_peers WHERE device_id = ?",
          [DEVICE_A],
        )
      )[0]?.cursor_in,
    },
    first,
    "§7.2: a re-delivered batch is not a data event",
  );
});

test("an op for a Stage 3 table refuses the whole batch and writes nothing", async () => {
  const pair = await openPair();
  const notes = createNotesRepo(pair.a.driver);
  await notes.createNote({ title: "Arrives", content: "" });
  const valid = await opsOf(pair.a);
  assert.equal(valid.length, 1);

  const vaultOp = syntheticOp(
    await deviceOf(pair.a),
    2,
    "vault_items",
    "9f9f9f9f-9f9f-4f9f-8f9f-9f9f9f9f9f9f",
    "create",
    { title: "ciphertext" },
    2,
  );

  await assert.rejects(
    applyOps(pair.b.driver, {
      peerId: await deviceOf(pair.a),
      origin: "desktop",
      ops: [...valid, vaultOp],
    }),
    /Stage 2 does not move/,
  );
  assert.equal(
    await count(pair.b, "SELECT count(*) AS n FROM notes"),
    0,
    "§7.1: a refusal is a wall — the valid op in the same batch is not applied either",
  );
  assert.equal(
    await count(pair.b, "SELECT count(*) AS n FROM sync_row_stamps"),
    0,
  );
});

// ---------------------------------------------------------------------------
// Stage 2 — Budget's five tables move under §2.3's authority (§12.2).
// ---------------------------------------------------------------------------

/** A Budget row on a store, read whole: what the merge actually wrote. */
interface EntryRow {
  uid: string | null;
  amount_cents: number;
  category_id: number;
  wallet_id: number;
  entry_date: string;
  note: string;
}

async function entryOn(
  store: SyncFixture,
  table: "expense_entries" | "income_entries",
): Promise<EntryRow[]> {
  return store.driver.query<EntryRow>(`SELECT * FROM "${table}" ORDER BY id`);
}

test("a phone's expense entry lands on the desktop with both parents resolved by uid", async () => {
  const pair = await openPair();
  const onA = createBudgetRepo(pair.a.driver);
  const walletId = await onA.createWallet("Cash");
  const categoryId = await onA.createExpenseCategory("Food");
  // Wallet and category are desktop-owned: they reach the phone first (§2.3).
  await applyFrom(pair.b, pair.a);

  const phoneWallet = await pair.b.driver.query<{ id: number }>(
    "SELECT id FROM wallets WHERE name = 'Cash'",
  );
  const phoneCategory = await pair.b.driver.query<{ id: number }>(
    "SELECT id FROM expense_categories WHERE name = 'Food'",
  );
  assert.ok(phoneWallet[0] && phoneCategory[0], "the phone holds both parents");

  const onB = createBudgetRepo(pair.b.driver);
  await onB.createExpenseEntry({
    amountCents: 1_250,
    categoryId: phoneCategory[0].id,
    walletId: phoneWallet[0].id,
    entryDate: "2026-11-13",
    note: "lunch",
  });
  await applyFrom(pair.a, pair.b, { origin: "mobile" });

  const entries = await entryOn(pair.a, "expense_entries");
  const entry = entries[0];
  assert.ok(entry, "the entry landed on the desktop");
  assert.equal(entries.length, 1);
  assert.equal(entry.amount_cents, 1_250);
  assert.equal(entry.note, "lunch");
  assert.equal(entry.entry_date, "2026-11-13");
  assert.equal(
    entry.wallet_id,
    walletId,
    "the wallet uid resolved to the desktop's own row",
  );
  assert.equal(
    entry.category_id,
    categoryId,
    "and the category uid to its own category row",
  );
  assert.deepEqual(
    await stampOf(pair.a, "expense_entries", entry.uid ?? ""),
    await stampOf(pair.b, "expense_entries", entry.uid ?? ""),
    "both devices hold the entry under one stamp",
  );
});

test("a desktop-created wallet and category arrive on the phone", async () => {
  const pair = await openPair();
  const onA = createBudgetRepo(pair.a.driver);
  await onA.createWallet("Bank");
  await onA.createIncomeCategory("Salary");
  await onA.createExpenseCategory("Food");
  await applyFrom(pair.b, pair.a);

  for (const [table, name] of [
    ["wallets", "Bank"],
    ["income_categories", "Salary"],
    ["expense_categories", "Food"],
  ] as const) {
    assert.equal(
      await count(
        pair.b,
        `SELECT count(*) AS n FROM "${table}" WHERE name = ?`,
        [name],
      ),
      1,
      `${table} arrived exactly once, under its own uid`,
    );
  }

  // The rows the phone received are usable rows, not mirrored labels: they are
  // what its own entry form reads (decision 4's create path).
  const [wallet] = await pair.b.driver.query<{ id: number }>(
    "SELECT id FROM wallets WHERE name = 'Bank'",
  );
  const [category] = await pair.b.driver.query<{ id: number }>(
    "SELECT id FROM expense_categories WHERE name = 'Food'",
  );
  assert.ok(wallet && category);
  const entryId = await createBudgetRepo(pair.b.driver).createExpenseEntry({
    amountCents: 400,
    categoryId: category.id,
    walletId: wallet.id,
    entryDate: "2026-11-13",
  });
  assert.equal(entryId > 0, true);
});

test("a mobile-origin wallet create is refused and writes nothing", async () => {
  const pair = await openPair();
  const phoneId = await deviceOf(pair.b);
  const op = syntheticOp(
    phoneId,
    1,
    "wallets",
    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "create",
    { name: "Phone wallet", created_at: "2026-11-13" },
    1,
  );

  await assert.rejects(
    () =>
      applyOps(pair.a.driver, {
        peerId: phoneId,
        origin: "mobile",
        ops: [op],
      }),
    /desktop-owned/,
  );
  assert.equal(
    await count(pair.a, "SELECT count(*) AS n FROM wallets"),
    0,
    "§2.3: the phone never writes a wallet, so the desktop never holds one",
  );
  assert.equal(
    await count(pair.a, "SELECT count(*) AS n FROM sync_row_stamps"),
    0,
  );
});

test("a mobile-origin entry edit is refused, and the same edit from the desktop applies", async () => {
  const pair = await openPair();
  const onA = createBudgetRepo(pair.a.driver);
  const walletId = await onA.createWallet("Cash");
  const categoryId = await onA.createExpenseCategory("Food");
  const entryId = await onA.createExpenseEntry({
    amountCents: 1_000,
    categoryId,
    walletId,
    entryDate: "2026-11-13",
  });
  const [row] = await entryOn(pair.a, "expense_entries");
  assert.ok(row?.uid);
  assert.equal(entryId > 0, true);

  // A correction an append-only table does not take from the phone (§2.3). The
  // op is written the way the wire writes one, because no phone writer makes it.
  const phoneId = await deviceOf(pair.b);
  const edit = syntheticOp(
    phoneId,
    9,
    "expense_entries",
    row.uid,
    "update",
    { amount_cents: 900 },
    10,
  );
  await assert.rejects(
    () =>
      applyOps(pair.a.driver, {
        peerId: phoneId,
        origin: "mobile",
        ops: [edit],
      }),
    /never edits or deletes expense_entries/,
  );
  assert.equal(
    (await entryOn(pair.a, "expense_entries"))[0]?.amount_cents,
    1_000,
    "the refused edit wrote nothing",
  );

  await applyOps(pair.a.driver, {
    peerId: phoneId,
    origin: "desktop",
    ops: [edit],
  }).then((statements) => pair.a.driver.batch(statements));
  assert.equal(
    (await entryOn(pair.a, "expense_entries"))[0]?.amount_cents,
    900,
    "§2.3: the desktop is the authority for every synced table, so a correction flows",
  );
});

test("a desktop category whose name the phone already holds is a no-op, not a failed batch", async () => {
  const pair = await openPair();
  const phoneUid = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  await pair.b.driver.execute(
    "INSERT INTO expense_categories (uid, name, created_at) VALUES (?, 'Food', '2026-11-01')",
    [phoneUid],
  );
  const onA = createBudgetRepo(pair.a.driver);
  await onA.createExpenseCategory("Food");
  const [desktopRow] = await pair.a.driver.query<{ uid: string }>(
    "SELECT uid FROM expense_categories",
  );
  assert.ok(desktopRow);

  // The desktop's create collides on `UNIQUE (name)` but never on identity: it
  // is a second record with the same name (§8.4's fold already answered this
  // for a snapshot), so the apply is a no-op instead of a constraint failure
  // that would wedge every later batch on the same op.
  await applyFrom(pair.b, pair.a);

  const rows = await pair.b.driver.query<{ uid: string; name: string }>(
    "SELECT uid, name FROM expense_categories",
  );
  assert.equal(rows.length, 1, "the phone keeps its one Food");
  assert.equal(rows[0]?.uid, phoneUid, "and it is the phone's own record");
  assert.notEqual(rows[0]?.uid, desktopRow.uid);
  assert.equal(
    await count(
      pair.b,
      "SELECT count(*) AS n FROM sync_row_stamps WHERE entity_uid = ?",
      [desktopRow.uid],
    ),
    0,
    "a no-op writes no stamp for a record this device does not hold",
  );
  assert.equal(
    (await readState(pair.b.driver)).lamport,
    1,
    "but the batch still moved its clock, as a delivered batch does (§4.2)",
  );
});

// ---------------------------------------------------------------------------
// Stage 2 Session 2 — Business/Loans: desktop-owned shops, create-only jobs
// and loans (§12.2).
// ---------------------------------------------------------------------------

test("a phone's job arrives on the desktop with its shop resolved by uid", async () => {
  const pair = await openPair();
  const shopId = await createBusinessRepo(pair.a.driver).createShop({
    name: "Alpha",
  });
  // A shop is desktop-owned, so it reaches the phone before a job can name it.
  await applyFrom(pair.b, pair.a);
  const [phoneShop] = await pair.b.driver.query<{ id: number }>(
    "SELECT id FROM shops WHERE name = 'Alpha'",
  );
  assert.ok(phoneShop);

  const jobId = await createBusinessRepo(pair.b.driver).createJob({
    title: "Fix roof",
    shopId: phoneShop.id,
    totalCents: 50_000,
    jobDate: "2026-11-13",
  });
  assert.equal(jobId > 0, true);
  await applyFrom(pair.a, pair.b, { origin: "mobile" });

  const jobs = await pair.a.driver.query<{
    uid: string | null;
    title: string;
    shop_id: number | null;
    total_cents: number;
    paid_cents: number;
    status: string;
  }>("SELECT * FROM jobs");
  const job = jobs[0];
  assert.ok(job, "the job landed on the desktop");
  assert.equal(jobs.length, 1);
  assert.equal(job.title, "Fix roof");
  assert.equal(
    job.shop_id,
    shopId,
    "the shop uid resolved to the desktop's own shop row",
  );
  assert.equal(job.total_cents, 50_000);
  assert.equal(job.paid_cents, 0);
  assert.equal(job.status, "open");
  assert.deepEqual(
    await stampOf(pair.a, "jobs", job.uid ?? ""),
    await stampOf(pair.b, "jobs", job.uid ?? ""),
  );
});

test("a desktop job payment reaches the phone, paid amount and income included", async () => {
  const pair = await openPair();
  const budgetA = createBudgetRepo(pair.a.driver);
  await budgetA.createIncomeCategory("Business");
  const walletId = await budgetA.createWallet("Cash");
  const businessA = createBusinessRepo(pair.a.driver);
  const jobId = await businessA.createJob({
    title: "Fix roof",
    totalCents: 100_000,
    jobDate: "2026-11-13",
  });
  await applyFrom(pair.b, pair.a);
  const delivered = (await opsOf(pair.a)).length;

  await businessA.recordJobPayment({
    jobId,
    amountCents: 40_000,
    walletId,
    date: "2026-11-13",
  });
  await applyFrom(pair.b, pair.a, {
    ops: (await opsOf(pair.a)).slice(delivered),
  });

  const [onPhone] = await pair.b.driver.query<{
    paid_cents: number;
    status: string;
  }>("SELECT * FROM jobs");
  assert.ok(onPhone);
  assert.equal(onPhone.paid_cents, 40_000, "the payment merged into the copy");
  assert.equal(onPhone.status, "open", "a partial payment keeps the job open");

  const entries = await pair.b.driver.query<{
    amount_cents: number;
    category_id: number;
    wallet_id: number;
    note: string;
  }>("SELECT * FROM income_entries");
  const entry = entries[0];
  assert.ok(entry, "the receipt travelled with the payment (§6.1)");
  assert.equal(entry.amount_cents, 40_000);
  assert.equal(entry.note, "Job: Fix roof");
  const [phoneWallet] = await pair.b.driver.query<{ id: number }>(
    "SELECT id FROM wallets WHERE name = 'Cash'",
  );
  const [phoneCategory] = await pair.b.driver.query<{ id: number }>(
    "SELECT id FROM income_categories WHERE name = 'Business'",
  );
  assert.equal(entry.wallet_id, phoneWallet?.id);
  assert.equal(entry.category_id, phoneCategory?.id);
});

test("a mobile-origin job edit is refused and writes nothing", async () => {
  const pair = await openPair();
  const jobId = await createBusinessRepo(pair.a.driver).createJob({
    title: "Fix roof",
    totalCents: 10_000,
    jobDate: "2026-11-13",
  });
  const [job] = await pair.a.driver.query<{ uid: string | null }>(
    "SELECT uid FROM jobs WHERE id = ?",
    [jobId],
  );
  assert.ok(job?.uid);

  const phoneId = await deviceOf(pair.b);
  const edit = syntheticOp(
    phoneId,
    3,
    "jobs",
    job.uid,
    "update",
    { paid_cents: 1_000 },
    10,
  );
  await assert.rejects(
    () =>
      applyOps(pair.a.driver, {
        peerId: phoneId,
        origin: "mobile",
        ops: [edit],
      }),
    /never updates or deletes jobs/,
  );
  const [held] = await pair.a.driver.query<{ paid_cents: number }>(
    "SELECT paid_cents FROM jobs",
  );
  assert.equal(held?.paid_cents, 0, "§2.3: payment fields are desktop-only");
});

test("a phone's loan arrives on the desktop", async () => {
  const pair = await openPair();
  const loanId = await createLoansRepo(pair.b.driver).createLoan({
    counterparty: "Daw Mya",
    direction: "borrowed",
    amountCents: 30_000,
    dueDate: "2026-12-01",
  });
  assert.equal(loanId > 0, true);
  await applyFrom(pair.a, pair.b, { origin: "mobile" });

  const loans = await pair.a.driver.query<{
    uid: string | null;
    counterparty: string;
    direction: string;
    amount_cents: number;
    repaid_cents: number;
    due_date: string | null;
  }>("SELECT * FROM loans");
  const loan = loans[0];
  assert.ok(loan, "the loan landed on the desktop");
  assert.equal(loans.length, 1);
  assert.equal(loan.counterparty, "Daw Mya");
  assert.equal(loan.direction, "borrowed");
  assert.equal(loan.amount_cents, 30_000);
  assert.equal(loan.repaid_cents, 0);
  assert.equal(loan.due_date, "2026-12-01");
});

test("a desktop shop reaches the phone while a mobile-origin shop op is refused", async () => {
  const pair = await openPair();
  await createBusinessRepo(pair.a.driver).createShop({ name: "Alpha" });
  await applyFrom(pair.b, pair.a);
  assert.equal(
    await count(pair.b, "SELECT count(*) AS n FROM shops WHERE name = 'Alpha'"),
    1,
    "the desktop-owned shop flowed down",
  );

  const phoneId = await deviceOf(pair.b);
  const create = syntheticOp(
    phoneId,
    2,
    "shops",
    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
    "create",
    { name: "Phone shop", created_at: "2026-11-13" },
    5,
  );
  await assert.rejects(
    () =>
      applyOps(pair.a.driver, {
        peerId: phoneId,
        origin: "mobile",
        ops: [create],
      }),
    /desktop-owned/,
  );
  assert.equal(
    await count(pair.a, "SELECT count(*) AS n FROM shops"),
    1,
    "only the desktop's own shop exists there",
  );
});

// ---------------------------------------------------------------------------
// Task 2 — §13.2 conflict copies.
// ---------------------------------------------------------------------------

/**
 * B holds a note whose title it edited locally, and A's newer edit of the same
 * field arrives — so B is the device holding the losing value.
 *
 * A's title writes come after a second note's create, which is what gives them
 * a counter above B's: counters are Lamport, so a device's second op is 3 only
 * because something took 2.
 */
async function losingNoteConflict(pair: Pair): Promise<string> {
  const uid = await sharedNote(pair);
  const notesB = createNotesRepo(pair.b.driver);
  const [rowB] = await notesIn(pair.b, uid);
  assert.ok(rowB);
  await notesB.updateNote(rowB.id, { title: "B's copy" });

  const notesA = createNotesRepo(pair.a.driver);
  await notesA.createNote({ title: "Filler", content: "" });
  const [rowA] = await notesIn(pair.a, uid);
  assert.ok(rowA);
  await notesA.updateNote(rowA.id, { title: "A's newer copy" });
  return uid;
}

test("a same-field note conflict applies the winner and leaves one conflict copy", async () => {
  const pair = await openPair();
  const uid = await losingNoteConflict(pair);
  // B's cursor is already past A's first two ops (the create it applied and
  // the filler note), so only the title write is delivered.
  const ops = (await opsOf(pair.a)).slice(2);
  assert.equal(ops.length, 1, "precondition: one title write is delivered");

  await applyFrom(pair.b, pair.a, { ops });

  const [row] = await notesIn(pair.b, uid);
  assert.equal(
    row?.title,
    "A's newer copy",
    "the winning value is applied on the losing device",
  );
  const copies = await pair.b.driver.query<{
    entity_type: string;
    snapshot: string;
  }>("SELECT entity_type, snapshot FROM trash_items");
  assert.equal(copies.length, 1, "exactly one conflict copy (§13.2)");
  const copy = copies[0];
  assert.ok(copy);
  assert.equal(copy.entity_type, "note");
  const snapshot = JSON.parse(copy.snapshot) as {
    entity: { title: string };
    conflict: {
      kind: string;
      label: string;
      table: string;
      uid: string;
      won: { title: string };
    };
  };
  assert.equal(snapshot.conflict.kind, TRASH_CONFLICT_KIND);
  assert.equal(
    snapshot.conflict.label,
    "Conflict copy — kept on this device only",
  );
  assert.equal(snapshot.conflict.table, "notes");
  assert.equal(snapshot.conflict.uid, uid);
  assert.equal(
    snapshot.entity.title,
    "B's copy",
    "the copy holds the value that lost, as this device had it",
  );
  assert.equal(
    snapshot.conflict.won.title,
    "A's newer copy",
    "and it carries the value that won, so the user can compare",
  );
  assert.equal(
    await count(pair.a, "SELECT count(*) AS n FROM trash_items"),
    0,
    "the other device never learns the copy existed",
  );
});

test("a losing habit-log value merges without archiving anything", async () => {
  const pair = await openPair();
  const habits = createHabitsRepo(pair.a.driver);
  const habitId = await habits.createHabit("Run");
  await habits.toggleLog(habitId, "2026-11-13");
  await applyFrom(pair.b, pair.a);
  const [log] = await pair.b.driver.query<{ uid: string; done: number }>(
    "SELECT uid, done FROM habit_logs",
  );
  assert.ok(log);
  assert.equal(log.done, 1);

  // No local writer edits a habit log, so the op is synthetic: the phone's
  // check-in flag arriving from A with a newer stamp.
  const op = syntheticOp(
    await deviceOf(pair.a),
    99,
    "habit_logs",
    log.uid,
    "update",
    { done: 0 },
    (await readState(pair.a.driver)).lamport + 5,
  );
  await applyFrom(pair.b, pair.a, { ops: [op] });

  const [merged] = await pair.b.driver.query<{ done: number }>(
    "SELECT done FROM habit_logs WHERE uid = ?",
    [log.uid],
  );
  assert.equal(merged?.done, 0, "the newer value merged in");
  assert.equal(
    await count(pair.b, "SELECT count(*) AS n FROM trash_items"),
    0,
    "§13.2: a check-in is not content, so no copy is archived",
  );
});

test("a conflict whose batch fails midway leaves neither the winner nor the copy", async () => {
  const pair = await openPair();
  const uid = await losingNoteConflict(pair);
  const ops = (await opsOf(pair.a)).slice(2);

  // A create that passes every check the engine can make and then fails in
  // SQL: `tasks.repeat` has a CHECK the payload cannot satisfy.
  const doomed = syntheticOp(
    await deviceOf(pair.a),
    98,
    "tasks",
    "8f8f8f8f-8f8f-4f8f-8f8f-8f8f8f8f8f8f",
    "create",
    { title: "Doomed", repeat: "hourly" },
    (await readState(pair.a.driver)).lamport + 1,
  );

  await assert.rejects(
    applyFrom(pair.b, pair.a, { ops: [...ops, doomed] }),
    /CHECK|constraint/i,
  );
  const [row] = await notesIn(pair.b, uid);
  assert.equal(
    row?.title,
    "B's copy",
    "the winner was not applied — the batch rolled back whole",
  );
  assert.equal(
    await count(pair.b, "SELECT count(*) AS n FROM trash_items"),
    0,
    "and the copy went with it (§5.5: same transaction)",
  );
});

// ---------------------------------------------------------------------------
// Task 3 — the local writers Session 1 parked.
// ---------------------------------------------------------------------------

test("a settle records exactly the fields it changed", async () => {
  const store = openSyncStore(DEVICE_A);
  const tasks = createTasksRepo(store.driver);
  const id = await tasks.createReminder({
    title: "Stand up",
    remindAt: "2026-11-20T09:00",
  });

  await tasks.settleReminders([{ id, nextRemindAt: null }]);
  let ops = (await opsOf(store)).filter(
    (op) => op.entity_table === "reminders",
  );
  assert.deepEqual(
    JSON.parse(ops.at(-1)?.payload ?? "{}"),
    { fired: 1 },
    "a one-shot settle changes only the fired flag",
  );

  await tasks.settleReminders([{ id, nextRemindAt: "2026-11-21T09:00" }]);
  ops = (await opsOf(store)).filter((op) => op.entity_table === "reminders");
  assert.deepEqual(
    JSON.parse(ops.at(-1)?.payload ?? "{}"),
    { remind_at: "2026-11-21T09:00", fired: 0 },
    "a re-arm carries the new time and the cleared flag",
  );

  await tasks.markReminderFired(id);
  ops = (await opsOf(store)).filter((op) => op.entity_table === "reminders");
  assert.deepEqual(JSON.parse(ops.at(-1)?.payload ?? "{}"), { fired: 1 });

  await tasks.rescheduleReminder(id, "2026-11-22T09:00");
  ops = (await opsOf(store)).filter((op) => op.entity_table === "reminders");
  assert.deepEqual(JSON.parse(ops.at(-1)?.payload ?? "{}"), {
    remind_at: "2026-11-22T09:00",
    fired: 0,
  });
});

test("a record, delete and restore round trip reaches the other device", async () => {
  const pair = await openPair();
  const notes = createNotesRepo(pair.a.driver);
  const id = await notes.createNote({ title: "Keep me", content: "body" });
  const [before] = await notesIn(pair.a, undefined);
  assert.ok(before?.uid);
  await notes.deleteNote(id);
  const [item] = await pair.a.driver.query<{ id: number }>(
    "SELECT id FROM trash_items",
  );
  assert.ok(item);
  await createTrashRepo(pair.a.driver).restore(item.id);

  const restored = await notesIn(pair.a);
  assert.equal(restored.length, 1, "A holds the restored row");
  assert.equal(restored[0]?.uid, before.uid, "under the SAME uid");

  const ops = await opsOf(pair.a);
  assert.deepEqual(
    ops.map((op) => op.op),
    ["create", "delete", "create"],
    "the restore records a create-kind op of its own",
  );

  await applyFrom(pair.b, pair.a, { ops });
  const onB = await notesIn(pair.b, before.uid);
  assert.equal(
    onB.length,
    1,
    "§5.3: the restore op outranks the tombstone, so B resurrects the row",
  );
  assert.equal(onB[0]?.title, "Keep me");
});

test("an edit that outranks a remote delete does not resurrect a half-row", async () => {
  const pair = await openPair();
  const uid = await sharedNote(pair);
  const [rowA] = await notesIn(pair.a, uid);
  const [rowB] = await notesIn(pair.b, uid);
  assert.ok(rowA && rowB);

  // B deletes at counter 2. A, never having seen the delete, edits at 2 and
  // again at 3 — so its newest write outranks the tombstone B holds.
  await createNotesRepo(pair.b.driver).deleteNote(rowB.id);
  const notesA = createNotesRepo(pair.a.driver);
  await notesA.updateNote(rowA.id, { title: "edited" });
  await notesA.updateNote(rowA.id, { content: "edited too" });

  await applyFrom(pair.b, pair.a, { ops: (await opsOf(pair.a)).slice(1) });
  assert.equal(
    await count(pair.b, "SELECT count(*) AS n FROM notes"),
    0,
    "§5.3: a field-level edit cannot rebuild the row it edits, so the record stays dead",
  );
  assert.ok(
    (await readTombstones(pair.b.driver)).some((row) => row.entity_uid === uid),
    "and the tombstone still decides the next comparison",
  );
});

test("a conflict copy's restore mints a new uid and records that uid", async () => {
  const pair = await openPair();
  const uid = await losingNoteConflict(pair);
  await applyFrom(pair.b, pair.a, { ops: (await opsOf(pair.a)).slice(2) });

  const [copy] = await pair.b.driver.query<{ id: number }>(
    "SELECT id FROM trash_items",
  );
  assert.ok(copy);
  await createTrashRepo(pair.b.driver).restore(copy.id);

  const restored = await pair.b.driver.query<NoteRow>(
    "SELECT * FROM notes WHERE uid <> ?",
    [uid],
  );
  const newRow = restored[0];
  assert.ok(newRow?.uid, "the copy came back as a new record");
  assert.notEqual(
    newRow.uid,
    uid,
    "§13.2: a conflict copy never resurrects the loser's uid",
  );

  const ops = (await opsOf(pair.b)).filter((op) => op.entity_table === "notes");
  const recorded = ops.at(-1);
  assert.equal(recorded?.op, "create");
  assert.equal(
    recorded?.entity_uid,
    newRow.uid,
    "the op records the NEW uid, which is what the peer will see",
  );
  assert.equal(
    await count(pair.b, "SELECT count(*) AS n FROM trash_items"),
    0,
    "the copy left the Trash",
  );
});
