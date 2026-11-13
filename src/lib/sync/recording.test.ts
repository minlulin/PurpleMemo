/**
 * Stage 1's recording half — `docs/ANDROID_SYNC_PROTOCOL.md` §6.1: an op
 * commits in the same transaction as its mutation.
 *
 * One mutation without its op, or an op without its mutation, is the bug these
 * tests exist to catch, so every case here reads the domain row, the outbox and
 * the tombstone set out of the SAME real SQLite database, after the real
 * repository method ran. The fixtures are hand-trimmed copies of the app's DDL
 * (`src-tauri/src/schema.rs`) — the tables each repository actually touches —
 * and the sync tables are sliced from that file rather than retyped
 * (`./testSchema.ts`).
 *
 * Stage 1's eight tables and Stage 2's five Budget tables are the whole of
 * what records; a write to a §2.2 table — `expense_limits`,
 * `recurring_payments`, `payables` — records nothing, which the Budget
 * boundary case at the end pins.
 */
import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { DataDriver } from "../../data/driver.ts";
import { createBudgetRepo } from "../budget.ts";
import { createBusinessRepo } from "../business.ts";
import { createHabitsRepo } from "../habits.ts";
import { createLoansRepo } from "../loans.ts";
import { createNotesRepo } from "../notes.ts";
import { createShoppingRepo } from "../shopping.ts";
import { createTasksRepo } from "../tasks.ts";
import {
  readOutbox,
  readState,
  readTombstones,
  type SyncState,
} from "./store.ts";
import { openSyncStore, type SyncFixture as Store } from "./testSchema.ts";

/** The Stage 1 fixture and the app's batch contract live in `./testSchema.ts`,
 * so the engine's two-store tests exercise the same database this one does. */
const openStore = (): Store => openSyncStore();

function count(db: DatabaseSync, sql: string, params: unknown[] = []): number {
  const row = db.prepare(sql).get(...(params as never[])) as
    | { n: number }
    | undefined;
  return row?.n ?? 0;
}

/** One row of `sync_outbox`, as the assertions want to read it. */
interface RecordedOp {
  seq: number;
  entity_table: string;
  entity_uid: string;
  op: string;
  counter: number;
  payload: Record<string, unknown>;
}

async function opsFor(
  driver: DataDriver,
  table: string,
): Promise<RecordedOp[]> {
  return (await readOutbox(driver))
    .filter((row) => row.entity_table === table)
    .map((row) => ({
      seq: row.seq,
      entity_table: row.entity_table,
      entity_uid: row.entity_uid,
      op: row.op,
      counter: row.counter,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
    }));
}

/** The stamp `sync_row_stamps` holds for one record (§4.2/§8.4). */
function rowStamp(
  db: DatabaseSync,
  table: string,
  uid: string,
): { counter: number; device_id: string; op_id: string } | undefined {
  return db
    .prepare(
      "SELECT counter, device_id, op_id FROM sync_row_stamps WHERE entity_table = ? AND entity_uid = ?",
    )
    .get(table, uid) as
    | { counter: number; device_id: string; op_id: string }
    | undefined;
}

function uidOf(
  db: DatabaseSync,
  table: string,
  id: number,
): string | undefined {
  const row = db.prepare(`SELECT uid FROM "${table}" WHERE id = ?`).get(id) as
    | { uid: string | null }
    | undefined;
  return row?.uid ?? undefined;
}

/**
 * §6.1 on one record: the row exists, exactly one op names it, that op's stamp
 * is the row's stamp, and the sequence/lamport pair moved once.
 */
async function assertRecorded(
  store: Store,
  table: string,
  id: number,
  kind: string,
): Promise<{ op: RecordedOp; state: SyncState; uid: string }> {
  const { db, driver } = store;
  const uid = uidOf(db, table, id);
  assert.ok(uid, `${table} ${id} has no uid`);
  const ops = await opsFor(driver, table);
  const op = ops.at(-1);
  assert.ok(op, `no op recorded for ${table}`);
  assert.equal(op.entity_uid, uid, "the op names the row's uid");
  assert.equal(op.op, kind);
  const state = await readState(driver);
  assert.equal(op.counter, state.lamport, "the op carries this device's stamp");
  assert.equal(op.seq, state.lastSeq);
  const stamp = rowStamp(db, table, uid);
  assert.ok(stamp, `${table} ${uid} has no row stamp`);
  assert.equal(stamp.counter, op.counter, "the row's stamp is the op's stamp");
  assert.equal(stamp.device_id, state.deviceId);
  return { op, state, uid };
}

// ---------------------------------------------------------------------------
// Task 1 — notes, tasks, collections, reminders.
// ---------------------------------------------------------------------------

test("a note records create, update and delete, each with its op in the same commit", async () => {
  const store = openStore();
  const { db, driver } = store;
  const notes = createNotesRepo(driver);

  const id = await notes.createNote({
    title: "Trip plan",
    content: "pack",
    tags: ["travel"],
  });
  assert.equal(count(db, "SELECT count(*) AS n FROM notes"), 1);
  const created = await assertRecorded(store, "notes", id, "create");
  assert.equal(created.op.payload.title, "Trip plan");
  assert.equal(created.op.payload.tags, "travel", "tags travel comma-joined");
  assert.equal(created.op.counter, 1);
  assert.equal(created.op.seq, 1);

  await notes.updateNote(id, { title: "Trip plan v2" });
  const ops = await opsFor(driver, "notes");
  assert.equal(ops.length, 2, "the update appended a second op");
  const updated = ops[1];
  assert.ok(updated);
  assert.equal(updated.op, "update");
  assert.equal(updated.entity_uid, created.uid);
  assert.ok(
    updated.counter > created.op.counter,
    "the newer write outranks the one it replaced (§4.2)",
  );
  assert.equal(updated.payload.title, "Trip plan v2");
  assert.ok(
    updated.payload.updated_at !== undefined,
    "the op carries the row's updated_at, which the write changed",
  );

  await notes.deleteNote(id);
  assert.equal(count(db, "SELECT count(*) AS n FROM notes"), 0, "the row went");
  const afterDelete = await opsFor(driver, "notes");
  assert.equal(afterDelete.length, 3);
  assert.equal(afterDelete[2]?.op, "delete");
  assert.equal(afterDelete[2]?.entity_uid, created.uid);
  const tombstones = (await readTombstones(driver)).filter(
    (row) => row.entity_table === "notes",
  );
  assert.equal(tombstones.length, 1, "the delete left a tombstone (§5.1)");
  assert.equal(tombstones[0]?.entity_uid, created.uid);
  assert.equal(
    rowStamp(db, "notes", created.uid),
    undefined,
    "a deleted record keeps no row stamp — the tombstone carries the stamp",
  );
});

test("a task records create, update and delete, each with its op", async () => {
  const store = openStore();
  const { db, driver } = store;
  const tasks = createTasksRepo(driver);

  const id = await tasks.createTask({
    title: "Call shop",
    dueDate: "2026-11-20",
  });
  const created = await assertRecorded(store, "tasks", id, "create");
  assert.equal(created.op.payload.due_date, "2026-11-20");
  assert.equal(created.op.payload.done, 0);

  await tasks.updateTask(id, { dueDate: "2026-11-21" });
  const updated = (await opsFor(driver, "tasks"))[1];
  assert.ok(updated);
  assert.equal(updated.op, "update");
  assert.ok(updated.counter > created.op.counter);
  assert.deepEqual(updated.payload, { due_date: "2026-11-21" });

  await tasks.toggleTask(id, true);
  const toggled = (await opsFor(driver, "tasks"))[2];
  assert.ok(toggled);
  assert.equal(toggled.op, "toggle", "a done flag is a toggle (§2.3)");
  assert.deepEqual(toggled.payload, { done: 1 });

  await tasks.deleteTask(id);
  assert.equal(count(db, "SELECT count(*) AS n FROM tasks"), 0);
  const deleted = (await opsFor(driver, "tasks")).at(-1);
  assert.equal(deleted?.op, "delete");
  assert.equal(
    (await readTombstones(driver)).filter((row) => row.entity_table === "tasks")
      .length,
    1,
  );
});

test("a collection records its create and delete, and the notes it unlinked travel too", async () => {
  const store = openStore();
  const { db, driver } = store;
  const notes = createNotesRepo(driver);

  const collectionId = await notes.createCollection("Travel");
  const collection = await assertRecorded(
    store,
    "collections",
    collectionId,
    "create",
  );
  assert.equal(collection.op.payload.name, "Travel");

  const noteId = await notes.createNote({
    title: "Flight",
    content: "",
    collectionId,
  });
  const noteUid = uidOf(db, "notes", noteId);
  assert.ok(noteUid);
  const notesBefore = (await opsFor(driver, "notes")).length;

  await notes.deleteCollection(collectionId);
  assert.equal(count(db, "SELECT count(*) AS n FROM collections"), 0);
  const unlink = (await opsFor(driver, "notes")).at(-1);
  assert.ok(unlink);
  assert.equal(
    (await opsFor(driver, "notes")).length,
    notesBefore + 1,
    "clearing the link is a note mutation, so it records one op",
  );
  assert.equal(unlink.entity_uid, noteUid);
  assert.equal(unlink.op, "update");
  assert.deepEqual(
    unlink.payload,
    { collection_uid: null },
    "the op names the parent by uid, never by a local row number (§3.4)",
  );

  const collectionDelete = (await opsFor(driver, "collections")).at(-1);
  assert.equal(collectionDelete?.op, "delete");
  assert.equal(collectionDelete?.entity_uid, collection.uid);
  assert.equal(
    (await readTombstones(driver)).filter(
      (row) => row.entity_table === "collections",
    ).length,
    1,
    "the note was unlinked, not deleted, so only the collection is tombstoned",
  );
});

test("a reminder create carries this device's id, and its delete records", async () => {
  const store = openStore();
  const { db, driver } = store;
  const tasks = createTasksRepo(driver);
  const state = await readState(driver);

  const id = await tasks.createReminder({
    title: "Stand up",
    remindAt: "2026-11-20T09:00",
  });
  const created = await assertRecorded(store, "reminders", id, "create");
  const row = db
    .prepare("SELECT created_by_device_id FROM reminders WHERE id = ?")
    .get(id) as { created_by_device_id: string | null } | undefined;
  assert.equal(
    row?.created_by_device_id,
    state.deviceId,
    "§13.1 Option A: the creating device is stamped on the definition",
  );

  await tasks.deleteReminder(id);
  assert.equal(count(db, "SELECT count(*) AS n FROM reminders"), 0);
  assert.equal((await opsFor(driver, "reminders")).at(-1)?.op, "delete");
  assert.equal(
    (await readTombstones(driver)).filter(
      (row) => row.entity_table === "reminders",
    ).length,
    1,
  );
  assert.equal(created.op.payload.title, "Stand up");
});

// ---------------------------------------------------------------------------
// Task 3 (Stage 2) — Budget records on the five §2.1 tables, and only those.
// ---------------------------------------------------------------------------

test("a wallet and a category record their create, and a rename records an update", async () => {
  const store = openStore();
  const { driver } = store;
  const budget = createBudgetRepo(driver);

  const walletId = await budget.createWallet("Cash");
  const wallet = await assertRecorded(store, "wallets", walletId, "create");
  assert.equal(wallet.op.payload.name, "Cash");
  assert.match(
    String(wallet.op.payload.created_at),
    /^\d{4}-\d{2}-\d{2}$/,
    "the create carries the row's own created_at",
  );

  const expenseCategoryId = await budget.createExpenseCategory("Food");
  const expenseCategory = await assertRecorded(
    store,
    "expense_categories",
    expenseCategoryId,
    "create",
  );
  assert.equal(expenseCategory.op.payload.name, "Food");

  const incomeCategoryId = await budget.createIncomeCategory("Salary");
  const incomeCategory = await assertRecorded(
    store,
    "income_categories",
    incomeCategoryId,
    "create",
  );
  assert.equal(incomeCategory.op.payload.name, "Salary");

  // An income entry is a row on a second ledger table, so it must name its own
  // category table's row by uid — never the expense one (§3.4).
  const entryId = await budget.createIncomeEntry({
    amountCents: 5_000,
    categoryId: incomeCategoryId,
    walletId,
    entryDate: "2026-11-13",
  });
  const entry = await assertRecorded(
    store,
    "income_entries",
    entryId,
    "create",
  );
  assert.equal(entry.op.payload.category_uid, incomeCategory.uid);
  assert.equal(entry.op.payload.wallet_uid, wallet.uid);

  await budget.renameWallet(walletId, "Pocket");
  const renamed = (await opsFor(driver, "wallets")).at(-1);
  assert.equal(renamed?.op, "update");
  assert.deepEqual(renamed?.payload, { name: "Pocket" });
});

test("an expense entry records create, update and delete, parents named by uid", async () => {
  const store = openStore();
  const { db, driver } = store;
  const budget = createBudgetRepo(driver);
  const walletId = await budget.createWallet("Cash");
  const categoryId = await budget.createExpenseCategory("Food");
  const walletUid = uidOf(db, "wallets", walletId);
  const categoryUid = uidOf(db, "expense_categories", categoryId);
  assert.ok(walletUid && categoryUid);

  const entryId = await budget.createExpenseEntry({
    amountCents: 1250,
    categoryId,
    walletId,
    entryDate: "2026-11-13",
    note: "lunch",
  });
  const created = await assertRecorded(
    store,
    "expense_entries",
    entryId,
    "create",
  );
  assert.equal(created.op.payload.amount_cents, 1250);
  assert.equal(created.op.payload.entry_date, "2026-11-13");
  assert.equal(created.op.payload.note, "lunch");
  assert.equal(
    created.op.payload.category_uid,
    categoryUid,
    "the category travels as a uid (§3.4), not as a local row number",
  );
  assert.equal(created.op.payload.wallet_uid, walletUid);
  assert.equal(
    (await opsFor(driver, "expense_entries")).length,
    1,
    "exactly one op records the create",
  );

  await budget.updateExpenseEntry(entryId, { amountCents: 1500 });
  const updated = (await opsFor(driver, "expense_entries")).at(-1);
  assert.equal(updated?.op, "update");
  assert.deepEqual(
    updated?.payload,
    { amount_cents: 1500 },
    "the update names exactly the field it wrote",
  );

  await budget.deleteExpenseEntry(entryId);
  assert.equal(count(db, "SELECT count(*) AS n FROM expense_entries"), 0);
  const deleted = (await opsFor(driver, "expense_entries")).at(-1);
  assert.equal(deleted?.op, "delete");
  assert.equal(deleted?.entity_uid, created.uid);
  assert.equal(
    (await readTombstones(driver)).filter(
      (row) => row.entity_table === "expense_entries",
    ).length,
    1,
    "the delete leaves a tombstone (§5.1)",
  );
});

// ---------------------------------------------------------------------------
// Stage 2 Session 2 — Business and Loans record; payables never do.
// ---------------------------------------------------------------------------

test("a job create names its shop by uid, and a shop's delete unlinks its jobs", async () => {
  const store = openStore();
  const { db, driver } = store;
  const business = createBusinessRepo(driver);

  const shopId = await business.createShop({ name: "Alpha", phone: "09" });
  const shop = await assertRecorded(store, "shops", shopId, "create");
  assert.equal(shop.op.payload.name, "Alpha");
  assert.equal(shop.op.payload.phone, "09");

  await business.updateShop(shopId, { notes: "weekly" });
  assert.deepEqual((await opsFor(driver, "shops")).at(-1)?.payload, {
    notes: "weekly",
  });

  const jobId = await business.createJob({
    title: "Fix roof",
    shopId,
    totalCents: 100_000,
    jobDate: "2026-11-13",
  });
  const job = await assertRecorded(store, "jobs", jobId, "create");
  assert.equal(
    job.op.payload.shop_uid,
    shop.uid,
    "the job names its shop by uid (§3.4), never a local row number",
  );
  assert.equal(job.op.payload.total_cents, 100_000);
  assert.equal(job.op.payload.paid_cents, 0);
  assert.equal(job.op.payload.status, "open");

  await business.deleteShop(shopId);
  assert.equal(count(db, "SELECT count(*) AS n FROM shops"), 0);
  const jobLink = (await opsFor(driver, "jobs")).at(-1);
  assert.equal(
    jobLink?.op,
    "update",
    "the unlinked job is its own mutation, recorded in the same batch (§6.1)",
  );
  assert.equal(jobLink?.entity_uid, job.uid);
  assert.deepEqual(jobLink?.payload, { shop_uid: null });
  const shopDelete = (await opsFor(driver, "shops")).at(-1);
  assert.equal(shopDelete?.op, "delete");
  assert.equal(
    (await readTombstones(driver)).filter((row) => row.entity_table === "shops")
      .length,
    1,
    "only the shop is tombstoned — the job was unlinked, not deleted",
  );
});

test("a job update and delete record, and the delete tombstones the uid", async () => {
  const store = openStore();
  const { db, driver } = store;
  const business = createBusinessRepo(driver);
  const jobId = await business.createJob({
    title: "Fix roof",
    totalCents: 100_000,
    jobDate: "2026-11-13",
  });
  const created = await assertRecorded(store, "jobs", jobId, "create");

  await business.updateJob(jobId, { title: "Fix roof, again" });
  assert.deepEqual((await opsFor(driver, "jobs")).at(-1)?.payload, {
    title: "Fix roof, again",
  });

  await business.deleteJob(jobId);
  assert.equal(count(db, "SELECT count(*) AS n FROM jobs"), 0);
  const deleted = (await opsFor(driver, "jobs")).at(-1);
  assert.equal(deleted?.op, "delete");
  assert.equal(deleted?.entity_uid, created.uid);
  assert.equal(
    (await readTombstones(driver)).filter((row) => row.entity_table === "jobs")
      .length,
    1,
  );
});

test("a job payment records exactly the payment's fields, and books its income", async () => {
  const store = openStore();
  const { driver } = store;
  const budget = createBudgetRepo(driver);
  const business = createBusinessRepo(driver);
  const categoryId = await budget.createIncomeCategory("Business");
  const walletId = await budget.createWallet("Cash");
  const jobId = await business.createJob({
    title: "Fix roof",
    totalCents: 100_000,
    jobDate: "2026-11-13",
  });

  const result = await business.recordJobPayment({
    jobId,
    amountCents: 40_000,
    walletId,
    date: "2026-11-13",
  });
  assert.deepEqual(result, { fullyPaid: false, appliedCents: 40_000 });

  const payment = (await opsFor(driver, "jobs")).at(-1);
  assert.equal(payment?.op, "update");
  assert.deepEqual(
    payment?.payload,
    { paid_cents: 40_000, status: "open" },
    "only the fields the payment wrote (§6.1)",
  );

  const entries = await opsFor(driver, "income_entries");
  assert.equal(entries.length, 1, "the receipt is a synced row, so it records");
  assert.equal(entries[0]?.op, "create");
  assert.equal(entries[0]?.payload.amount_cents, 40_000);
  assert.equal(entries[0]?.payload.note, "Job: Fix roof");
  assert.equal(
    entries[0]?.payload.category_uid,
    uidOf(store.db, "income_categories", categoryId),
  );
  assert.equal(
    entries[0]?.payload.wallet_uid,
    uidOf(store.db, "wallets", walletId),
  );
});

test("a loan create, edit, repayment and delete each record one op", async () => {
  const store = openStore();
  const { db, driver } = store;
  const loans = createLoansRepo(driver);

  const loanId = await loans.createLoan({
    counterparty: "U Kyaw",
    direction: "lent",
    amountCents: 100_000,
    dueDate: "2026-12-01",
  });
  const created = await assertRecorded(store, "loans", loanId, "create");
  assert.equal(created.op.payload.counterparty, "U Kyaw");
  assert.equal(created.op.payload.repaid_cents, 0);

  await loans.updateLoan(loanId, { note: "called" });
  assert.deepEqual((await opsFor(driver, "loans")).at(-1)?.payload, {
    note: "called",
  });

  assert.equal(await loans.recordRepayment(loanId, 25_000), 25_000);
  const repaid = (await opsFor(driver, "loans")).at(-1);
  assert.equal(repaid?.op, "update");
  assert.deepEqual(
    repaid?.payload,
    { repaid_cents: 25_000 },
    "a repayment is exactly the counter it wrote (§6.1)",
  );

  await loans.deleteLoan(loanId);
  assert.equal(count(db, "SELECT count(*) AS n FROM loans"), 0);
  const deleted = (await opsFor(driver, "loans")).at(-1);
  assert.equal(deleted?.op, "delete");
  assert.equal(deleted?.entity_uid, created.uid);
  assert.equal(
    (await readTombstones(driver)).filter((row) => row.entity_table === "loans")
      .length,
    1,
  );
});

test("a payable records nothing — but the expense it books does", async () => {
  const store = openStore();
  const { db, driver } = store;
  const budget = createBudgetRepo(driver);
  const business = createBusinessRepo(driver);
  const categoryId = await budget.createExpenseCategory("Supplies");
  const walletId = await budget.createWallet("Cash");
  const before = await readState(driver);

  const payableId = await business.createPayable({
    title: "Cement",
    amountCents: 7_000,
    dueDate: "2026-12-01",
  });
  await business.updatePayable(payableId, { note: "urgent" });
  assert.equal(count(db, "SELECT count(*) AS n FROM payables"), 1);
  const afterWrites = await readState(driver);
  assert.equal(
    afterWrites.lamport,
    before.lamport,
    "§2.2: a payable never records, so it never spends a Lamport step",
  );
  assert.equal(
    (await readOutbox(driver)).filter((row) => row.entity_table === "payables")
      .length,
    0,
  );

  await business.markPayablePaid({
    payableId,
    walletId,
    categoryId,
    date: "2026-11-13",
  });
  const entries = await opsFor(driver, "expense_entries");
  assert.equal(entries.length, 1, "the expense entry it books is a synced row");
  assert.equal(entries[0]?.payload.note, "Cement");
  assert.equal(
    (await readOutbox(driver)).filter((row) => row.entity_table === "payables")
      .length,
    0,
    "and the payable itself still records nothing",
  );
});

test("a recurring payment and an expense limit record nothing and spend no Lamport step", async () => {
  const store = openStore();
  const { db, driver } = store;
  const budget = createBudgetRepo(driver);
  const categoryId = await budget.createExpenseCategory("Food");
  const walletId = await budget.createWallet("Cash");
  const before = await readState(driver);

  await budget.createRecurring({
    title: "Net",
    amountCents: 9_000,
    categoryId,
    walletId,
    frequency: "monthly",
    nextDueDate: "2026-12-01",
  });
  await budget.setLimit(categoryId, 100_000);

  assert.equal(
    count(db, "SELECT count(*) AS n FROM recurring_payments"),
    1,
    "the rule itself is written",
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM expense_limits"), 1);
  const after = await readState(driver);
  assert.equal(after.lamport, before.lamport, "no op, so no Lamport step");
  assert.equal(after.lastSeq, before.lastSeq, "and no sequence number either");
  assert.deepEqual(
    [
      ...new Set((await readOutbox(driver)).map((row) => row.entity_table)),
    ].sort(),
    ["expense_categories", "wallets"],
    "§2.2: the desktop-only Budget tables never record, even in budget.ts itself",
  );
});

// ---------------------------------------------------------------------------
// Task 2 — shopping's parent/child shapes and the habit toggle.
// ---------------------------------------------------------------------------

test("a shopping item records its own op, and a list delete tombstones every item it held", async () => {
  const store = openStore();
  const { db, driver } = store;
  const shopping = createShoppingRepo(driver);

  const listId = await shopping.createList("Groceries");
  const listOp = await assertRecorded(
    store,
    "shopping_lists",
    listId,
    "create",
  );

  const milk = await shopping.addItem(listId, "milk");
  const milkOp = await assertRecorded(store, "shopping_items", milk, "create");
  assert.equal(milkOp.op.payload.text, "milk");
  assert.equal(
    milkOp.op.payload.list_uid,
    listOp.uid,
    "the item names its list by uid (§3.4), not by this device's row number",
  );

  const bread = await shopping.addItem(listId, "bread");
  const breadUid = uidOf(db, "shopping_items", bread);
  const milkUid = uidOf(db, "shopping_items", milk);
  assert.ok(breadUid && milkUid);

  await shopping.toggleItem(milk, true);
  const toggled = (await opsFor(driver, "shopping_items")).at(-1);
  assert.equal(toggled?.op, "toggle");
  assert.deepEqual(toggled?.payload, { done: 1 });

  await shopping.deleteList(listId);
  assert.equal(count(db, "SELECT count(*) AS n FROM shopping_lists"), 0);
  assert.equal(
    count(db, "SELECT count(*) AS n FROM shopping_items"),
    0,
    "the FK cascade removed the items",
  );
  const tombstones = await readTombstones(driver);
  assert.deepEqual(
    tombstones.map((row) => row.entity_uid).sort(),
    [listOp.uid, milkUid, breadUid].sort(),
    "§5.2: the list AND every child it held are tombstoned — the cascade is not the record",
  );
  const deletes = (await readOutbox(driver)).filter(
    (row) => row.op === "delete",
  );
  assert.equal(
    deletes.length,
    3,
    "each tombstone travels as its own delete op",
  );
});

test("a habit check-in and its un-check each record exactly one op", async () => {
  const store = openStore();
  const { db, driver } = store;
  const habits = createHabitsRepo(driver);

  const habitId = await habits.createHabit("Run");
  const habit = await assertRecorded(store, "habits", habitId, "create");
  assert.equal(habit.op.payload.name, "Run");

  assert.equal(await habits.toggleLog(habitId, "2026-11-13"), true);
  assert.equal(count(db, "SELECT count(*) AS n FROM habit_logs"), 1);
  const logUid = uidOf(db, "habit_logs", 1);
  assert.ok(logUid);
  let logs = await opsFor(driver, "habit_logs");
  assert.equal(logs.length, 1, "a check-in is one create op");
  assert.equal(logs[0]?.op, "create");
  assert.equal(logs[0]?.entity_uid, logUid);

  assert.equal(await habits.toggleLog(habitId, "2026-11-13"), false);
  assert.equal(count(db, "SELECT count(*) AS n FROM habit_logs"), 0);
  logs = await opsFor(driver, "habit_logs");
  assert.equal(logs.length, 2, "and an un-check is one delete op");
  assert.equal(logs[1]?.op, "delete");
  assert.equal(logs[1]?.entity_uid, logUid);
  assert.equal(
    (await readTombstones(driver)).filter(
      (row) => row.entity_table === "habit_logs",
    ).length,
    1,
  );
});

test("deleting a habit tombstones the habit and every check-in it held", async () => {
  const store = openStore();
  const { db, driver } = store;
  const habits = createHabitsRepo(driver);

  const habitId = await habits.createHabit("Read");
  const habitOp = await assertRecorded(store, "habits", habitId, "create");
  await habits.toggleLog(habitId, "2026-11-11");
  await habits.toggleLog(habitId, "2026-11-12");
  const logUids = (await readOutbox(driver))
    .filter((row) => row.entity_table === "habit_logs")
    .map((row) => row.entity_uid);
  assert.equal(logUids.length, 2);

  await habits.deleteHabit(habitId);
  assert.equal(count(db, "SELECT count(*) AS n FROM habits"), 0);
  assert.equal(count(db, "SELECT count(*) AS n FROM habit_logs"), 0);
  const tombstoned = (await readTombstones(driver)).map(
    (row) => row.entity_uid,
  );
  assert.deepEqual(
    tombstoned.sort(),
    [habitOp.uid, ...logUids].sort(),
    "§5.2: the cascaded check-ins get their own tombstones",
  );
});

// ---------------------------------------------------------------------------
// Atomicity at the repository level.
// ---------------------------------------------------------------------------

test("a batch that fails midway leaves neither the mutation nor its op", async () => {
  const store = openStore();
  const { db, driver } = store;
  const notes = createNotesRepo(driver);
  const tasks = createTasksRepo(driver);

  // The mutation commits first in the batch and the op second, so an op that
  // cannot be written is exactly the crash-between-the-two §6.1 forbids.
  db.exec(
    "CREATE TRIGGER refuse_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT, 'outbox refused'); END",
  );

  await assert.rejects(
    notes.createNote({ title: "Never lands", content: "body" }),
    /outbox refused/,
  );
  assert.equal(
    count(db, "SELECT count(*) AS n FROM notes"),
    0,
    "the note must not survive its refused op",
  );
  assert.equal(
    (await readState(driver)).lamport,
    0,
    "nor may the clock have advanced",
  );

  await assert.rejects(
    tasks.createTask({ title: "Never lands" }),
    /outbox refused/,
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM tasks"), 0);

  // And the reverse direction: a refused delete leaves the row and no tombstone.
  db.exec("DROP TRIGGER refuse_outbox");
  const id = await notes.createNote({ title: "Stays", content: "" });
  db.exec(
    "CREATE TRIGGER refuse_outbox_delete BEFORE INSERT ON sync_outbox WHEN NEW.op = 'delete' BEGIN SELECT RAISE(ABORT, 'delete refused'); END",
  );
  await assert.rejects(notes.deleteNote(id), /delete refused/);
  assert.equal(
    count(db, "SELECT count(*) AS n FROM notes"),
    1,
    "a failed op rolled the trash batch back whole",
  );
  assert.equal(count(db, "SELECT count(*) AS n FROM sync_tombstones"), 0);
});
