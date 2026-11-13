/**
 * §13.1 Option A as built: one delivery predicate, and every border stamping a
 * reminder's creator so the predicate can be trusted
 * (`docs/ANDROID_SYNC_PROTOCOL.md`, decision A).
 *
 * Two devices, two real SQLite stores. The engine's apply is the border for a
 * synced op, `snapshotStatements` and `uploadStatements` are the borders for a
 * row-carrying transfer, and the desktop ticker's due-selection and the
 * Android pass are the two surfaces the predicate protects.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  deliveredOutcomes,
  missedOutcomes,
  reminderSyncRows,
} from "../android-reminders.ts";
import { createTasksRepo } from "../tasks.ts";
import { applyOps, type PeerOp } from "./engine.ts";
import { remindableHere, remindsHere } from "./reminderDelivery.ts";
import { readOutbox, snapshotStatements, uploadStatements } from "./store.ts";
import { openSyncStore, type SyncFixture } from "./testSchema.ts";

const PHONE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DESKTOP = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DUE = "2026-11-13T09:00";
const NOW = "2026-11-13T09:05";

/** The ops this device's outbox still owes, as the wire carries them (§6.2). */
async function wireOps(store: SyncFixture): Promise<PeerOp[]> {
  return (await readOutbox(store.driver)).map((row) => ({
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
  }));
}

/** Hand every pending op to the other device through the real engine (§7). */
async function applyAll(
  to: SyncFixture,
  from: SyncFixture,
  peerId: string,
  origin: "mobile" | "desktop",
): Promise<void> {
  const ops = await wireOps(from);
  assert.ok(ops.length > 0, "the sender recorded something to send");
  const statements = await applyOps(to.driver, { peerId, origin, ops });
  await to.driver.batch(statements);
}

/** What the desktop ticker actually sees: `dueReminders`, then §13.1's rule. */
async function desktopDue(store: SyncFixture, own: string) {
  return remindableHere(
    await createTasksRepo(store.driver).dueReminders(NOW),
    own,
  );
}

test("a phone-created reminder reaches the desktop and is never due or settled there", async () => {
  const phone = openSyncStore(PHONE);
  const desktop = openSyncStore(DESKTOP);
  await createTasksRepo(phone.driver).createReminder({
    title: "Call the plumber",
    remindAt: DUE,
    repeat: "none",
  });

  await applyAll(desktop, phone, PHONE, "mobile");

  const rows = await desktop.driver.query<{
    uid: string;
    fired: number;
    created_by_device_id: string | null;
  }>("SELECT uid, fired, created_by_device_id FROM reminders");
  assert.equal(rows.length, 1, "the definition is two-way");
  assert.equal(
    rows[0]?.created_by_device_id,
    PHONE,
    "the op's author is the creator (§13.1's border stamp)",
  );

  assert.deepEqual(
    await desktopDue(desktop, DESKTOP),
    [],
    "another device's reminder is never due on this one",
  );
  // Nothing due means nothing the ticker could settle, so `fired` stays put —
  // the phone's own settle is what converges it (§6's op, not a local guess).
  const [held] = await desktop.driver.query<{ fired: number }>(
    "SELECT fired FROM reminders WHERE uid = ?",
    [rows[0]?.uid],
  );
  assert.equal(held?.fired, 0);
});

test("a desktop-created reminder is visible on the phone and never armed or settled", async () => {
  const phone = openSyncStore(PHONE);
  const desktop = openSyncStore(DESKTOP);
  await createTasksRepo(desktop.driver).createReminder({
    title: "From the desktop",
    remindAt: DUE,
    repeat: "daily",
  });

  await applyAll(phone, desktop, DESKTOP, "desktop");

  const rows = await createTasksRepo(phone.driver).listReminders(false);
  assert.equal(rows.length, 1, "the phone shows the reminder");
  assert.equal(rows[0]?.created_by_device_id, DESKTOP);

  const own = remindableHere(rows, PHONE);
  assert.deepEqual(own, [], "but the phone does not deliver it");
  assert.deepEqual(reminderSyncRows(own, true), [], "no alarm is armed");
  assert.deepEqual(
    deliveredOutcomes(own, [rows[0]?.id ?? 0], NOW),
    [],
    "a delivery report cannot settle it either",
  );
  assert.deepEqual(
    missedOutcomes(own, [], NOW),
    [],
    "and a past-due row is not late-notified on this device",
  );
});

test("a NULL creator is a legacy-local row and still fires on its home device", async () => {
  const desktop = openSyncStore(DESKTOP);
  await desktop.driver.execute(
    `INSERT INTO reminders (uid, title, remind_at, repeat, note, fired, created_at)
     VALUES (?, 'From before the column', ?, 'none', '', 0, '2026-11-01')`,
    ["legacy-reminder", DUE],
  );

  const due = await desktopDue(desktop, DESKTOP);
  assert.equal(due.length, 1, "NULL means this device created it");
  assert.equal(due[0]?.title, "From before the column");
  // A NULL row is delivered by whichever device holds it — no border can put
  // one here now (the sync apply, the snapshot and the upload all stamp the
  // creator), so a NULL row can only be this device's own pre-column write.
});

test("the engine stamps the op's author, not the payload's claim", async () => {
  const desktop = openSyncStore(DESKTOP);
  const claimed: PeerOp = {
    device_id: PHONE,
    seq: 1,
    op_id: "op-claim",
    entity_table: "reminders",
    entity_uid: "reminder-claimed",
    op: "create",
    base_counter: 0,
    counter: 4,
    field_stamps: "{}",
    payload: JSON.stringify({
      title: "Says someone else made it",
      remind_at: DUE,
      repeat: "none",
      note: "",
      fired: 0,
      created_at: "2026-11-13",
      created_by_device_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    }),
  };

  await desktop.driver.batch(
    await applyOps(desktop.driver, {
      peerId: PHONE,
      origin: "mobile",
      ops: [claimed],
    }),
  );

  const [row] = await desktop.driver.query<{ created_by_device_id: string }>(
    "SELECT created_by_device_id FROM reminders WHERE uid = ?",
    ["reminder-claimed"],
  );
  assert.equal(row?.created_by_device_id, PHONE);
  assert.equal(remindsHere(row ?? {}, DESKTOP), false, "inert on the receiver");
});

test("a snapshot row and an upload row with no creator land stamped with the sender", async () => {
  const phone = openSyncStore(PHONE);
  const stamp = { counter: 3, deviceId: DESKTOP, opId: "desktop#3" };
  const rowWithoutCreator = {
    table: "reminders" as const,
    uid: "reminder-adopted",
    stamp,
    fields: {
      title: "Adopted",
      remind_at: DUE,
      repeat: "none",
      note: "",
      fired: 0,
      created_at: "2026-11-13",
      created_by_device_id: null as string | null,
    },
  };

  await phone.driver.batch(
    snapshotStatements([rowWithoutCreator], [], new Date(), DESKTOP),
  );
  const [adopted] = await phone.driver.query<{ created_by_device_id: string }>(
    "SELECT created_by_device_id FROM reminders WHERE uid = ?",
    ["reminder-adopted"],
  );
  assert.equal(adopted?.created_by_device_id, DESKTOP);

  const uploaded = { ...rowWithoutCreator, uid: "reminder-uploaded" };
  await phone.driver.batch(uploadStatements([uploaded], new Date(), PHONE));
  const [received] = await phone.driver.query<{ created_by_device_id: string }>(
    "SELECT created_by_device_id FROM reminders WHERE uid = ?",
    ["reminder-uploaded"],
  );
  assert.equal(received?.created_by_device_id, PHONE);

  // A real creator is never overwritten by a passing border.
  await phone.driver.batch(
    uploadStatements(
      [
        {
          ...rowWithoutCreator,
          uid: "reminder-owned",
          fields: { ...rowWithoutCreator.fields, created_by_device_id: PHONE },
        },
      ],
      new Date(),
      DESKTOP,
    ),
  );
  const [kept] = await phone.driver.query<{ created_by_device_id: string }>(
    "SELECT created_by_device_id FROM reminders WHERE uid = ?",
    ["reminder-owned"],
  );
  assert.equal(kept?.created_by_device_id, PHONE);
});
