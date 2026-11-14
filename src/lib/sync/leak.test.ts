/**
 * §2.2's leak sweep: every way a row can leave this desktop, asked the same
 * question with the same poison.
 *
 * §2.2 says the database holds modules a peer must never see — `expense_limits`,
 * `recurring_payments`, `payables`, `settings`, `links`, `trash_items`, `photos`,
 * `photo_refs`, `notes_fts`, and the excluded contacts/journal/memories modules.
 * They are in the same database as the synced tables, so a leak is always one
 * careless loop away; a test that only checks the happy path would pass while
 * the loop was wrong.
 *
 * So: one poison row in EVERY table §2.2 names, plus this device's app PIN
 * (§10.3), planted in the real baseline schema. Each row names itself and its
 * side, so "the desktop's poison reached the phone" is a substring, and a row
 * that crossed cannot be mistaken for the receiving side's own plant.
 *
 * Every assertion here has a positive control — a row that must travel, or the
 * vault envelope that must be present — because a carrier that sent nothing at
 * all would otherwise pass a test about leaks perfectly.
 *
 * The served snapshot is read in Rust (`pairing_snapshot::read_snapshot`), so
 * its half of the sweep lives there: `no_desktop_only_row_reaches_a_batch`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createBackupRepo, parseBackupZip } from "../backup.ts";
import { readLocalRows } from "./mobilePairing.ts";
import {
  DESKTOP_ONLY_TABLES,
  EXCLUDED_MODULE_TABLES,
  SYNC_TABLES,
} from "./protocol.ts";
import {
  outboxStatements,
  readState,
  registerPeerStatements,
} from "./store.ts";
import { runSync } from "./syncSession.ts";
import { countRows, ferry, PAIRING, PHONE } from "./testFerry.ts";
import { openBaselineStore, type SyncFixture } from "./testSchema.ts";

/** §2.2, both lists, as one sweep. */
const NEVER_TRAVELS: readonly string[] = [
  ...DESKTOP_ONLY_TABLES,
  ...EXCLUDED_MODULE_TABLES,
];

const NOTE_UID = "11111111-aaaa-4aaa-8aaa-111111111111";
const VAULT_UID = "22222222-aaaa-4aaa-8aaa-222222222222";
const PUSH_NOTE_UID = "33333333-aaaa-4aaa-8aaa-333333333333";
const PULL_TASK_UID = "44444444-aaaa-4aaa-8aaa-444444444444";

/**
 * One poison row in every table §2.2 names, plus the app PIN, plus the rows a
 * carrier must actually move: a note (any synced table) and a vault row with
 * its envelope.
 *
 * `side` is in every marker so two stores' plants stay distinguishable: a row
 * that crossed the wire carries the OTHER side's marker, and the receiving
 * side's own plant cannot hide it.
 *
 * `expense_limits`, `links` and `photo_refs` have no free-text column at all —
 * CHECK constraints pin every one of them to an enum or a number — so those
 * three are detected structurally instead: an op naming the table on the wire,
 * or a row on the other side.
 */
function plantPoison(store: SyncFixture, side: string): void {
  const marker = (table: string) => `LEAK-${side}-${table}`;
  const run = (sql: string, params: unknown[] = []) => {
    store.db.prepare(sql).run(...(params as never[]));
  };

  // --- what MUST travel (the positive controls) ---
  run(
    `INSERT INTO notes (uid, title, content, tags, created_at, updated_at)
     VALUES (?, ?, '', '', '2026-01-01', '2026-01-01')`,
    [NOTE_UID, `TRAVELS-${side}-notes`],
  );
  run(
    `INSERT INTO vault_items (uid, title, ciphertext, salt, iv, created_at, updated_at)
     VALUES (?, 'vault row', 'ct', 'salt', 'iv', '2026-01-01', '2026-01-01')`,
    [VAULT_UID],
  );
  run(
    "INSERT INTO settings (key, value) VALUES ('vault_setup', '{\"version\":1}')",
  );
  run("INSERT INTO settings (key, value) VALUES ('vault_generation', '2')");
  run("INSERT INTO settings (key, value) VALUES ('vault_verify', ?)", [
    JSON.stringify({
      salt: `TRAVELS-${side}-vault`,
      iv: "iv",
      ciphertext: "c",
    }),
  ]);

  // --- what never travels ---
  run(`INSERT INTO settings (key, value) VALUES ('pin_hash', ?)`, [
    marker("pin_hash"),
  ]);
  run("INSERT INTO settings (key, value) VALUES (?, ?)", [
    marker("settings"),
    marker("settings"),
  ]);
  // Budget's two (§2.2): a category of its own, so the plant does not depend on
  // the baseline's seeds.
  run(
    `INSERT INTO expense_categories (name, created_at)
     VALUES (?, '2026-01-01')`,
    [marker("expense_categories")],
  );
  run(
    `INSERT INTO expense_limits (category_id, limit_cents)
     VALUES ((SELECT id FROM expense_categories WHERE name = ?), 4242)`,
    [marker("expense_categories")],
  );
  run(
    `INSERT INTO recurring_payments (title, amount_cents, frequency, next_due_date, created_at)
     VALUES (?, 4242, 'monthly', '2026-01-01', '2026-01-01')`,
    [marker("recurring_payments")],
  );
  run(
    `INSERT INTO payables (title, amount_cents, created_at)
     VALUES (?, 4242, '2026-01-01')`,
    [marker("payables")],
  );
  run(
    `INSERT INTO links (type_a, id_a, type_b, id_b, created_at)
     VALUES ('note', 4242, 'task', 4243, '2026-01-01')`,
  );
  run(
    `INSERT INTO trash_items (entity_type, entity_id, snapshot, deleted_at, created_at)
     VALUES ('note', 4242, ?, '2026-01-01', '2026-01-01')`,
    [JSON.stringify({ [marker("trash_items")]: true })],
  );
  run(
    `INSERT INTO photos (rel_path, sha256, ext, size_bytes, created_at)
     VALUES (?, ?, 'jpg', 3, '2026-01-01')`,
    [`${marker("photos")}.jpg`, marker("photos")],
  );
  run(
    `INSERT INTO photo_refs (photo_id, entity_type, entity_id)
     VALUES ((SELECT id FROM photos WHERE rel_path = ?), 'note', 4242)`,
    [`${marker("photos")}.jpg`],
  );
  // An explicit rowid, high above any note: the baseline's `notes_fts_ai`
  // trigger keeps the index in step with `notes`, and a poison row that took a
  // rowid a note will claim would fail the next note insert.
  run(
    "INSERT INTO notes_fts (rowid, title, content, tags, folder) VALUES (999999, ?, '', '', '')",
    [marker("notes_fts")],
  );
  // The excluded modules (§2.2).
  run("INSERT INTO contacts (name, created_at) VALUES (?, '2026-01-01')", [
    marker("contacts"),
  ]);
  run(
    `INSERT INTO contact_channels (contact_id, kind, value)
     VALUES ((SELECT id FROM contacts WHERE name = ?), 'phone', ?)`,
    [marker("contacts"), marker("contact_channels")],
  );
  run(
    `INSERT INTO contact_tags (contact_id, tag)
     VALUES ((SELECT id FROM contacts WHERE name = ?), ?)`,
    [marker("contacts"), marker("contact_tags")],
  );
  run(
    `INSERT INTO journal_entries (entry_date, content, created_at, updated_at)
     VALUES ('2026-02-02', ?, '2026-01-01', '2026-01-01')`,
    [marker("journal_entries")],
  );
  run(
    `INSERT INTO memories (title, memory_date, created_at)
     VALUES (?, '2026-01-01', '2026-01-01')`,
    [marker("memories")],
  );
}

/** Every row of every §2.2 table, as text: what the other side must not hold. */
function dumpNeverTravels(store: SyncFixture): string {
  return NEVER_TRAVELS.map((table) =>
    JSON.stringify(store.db.prepare(`SELECT * FROM "${table}"`).all()),
  ).join("\n");
}

/** The markers of one side that appear in a serialized carrier. */
function leakedFrom(text: string, side: string): string[] {
  return [...NEVER_TRAVELS, "pin_hash", "settings"].filter((name) =>
    text.includes(`LEAK-${side}-${name}`),
  );
}

test("the sweep plants a row in every table §2.2 names", () => {
  const store = openBaselineStore();
  plantPoison(store, "sweep");
  const missing = NEVER_TRAVELS.filter(
    (table) =>
      (
        store.db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as {
          n: number;
        }
      ).n === 0,
  );
  assert.deepEqual(
    missing,
    [],
    "a §2.2 table with no poison row is a table the sweep checks blind",
  );
});

test("this device's upload carries its 17 tables, the vault envelope, and no §2.2 row", async () => {
  const store = openBaselineStore();
  plantPoison(store, "phone");

  const rows = await readLocalRows(store.driver);
  const json = JSON.stringify(rows);

  // Positive controls: the read is not silent, and the vault's own line is
  // carried (§12.3) — the envelope keys are the sanctioned exception, and this
  // is what keeps the sweep from flagging them.
  assert.ok(
    json.includes("TRAVELS-phone-notes"),
    "a synced note must be in the upload",
  );
  const vault = rows.find((row) => row.table === "vault_items");
  assert.ok(vault, "the vault row travels");
  assert.ok(
    Object.hasOwn(vault.fields, "vault_generation") &&
      Object.hasOwn(vault.fields, "vault_verifier"),
    "a vault row carries its generation and verifier",
  );
  assert.ok(json.includes("TRAVELS-phone-vault"));

  assert.deepEqual(
    [...new Set(rows.map((row) => row.table))].filter(
      (table) => !Object.hasOwn(SYNC_TABLES, table),
    ),
    [],
    "§2.2: an upload names only the 17 synced tables",
  );
  assert.deepEqual(leakedFrom(json, "phone"), []);
});

test("a sync session carries the two-way rows in both directions and no §2.2 row", async () => {
  const phone = openBaselineStore();
  const desktop = openBaselineStore();
  // The ferry names the phone `PHONE` when it hands a staged push to the panel,
  // so the phone's own identity is that one — the ops it pushes must carry it.
  phone.db.prepare("UPDATE sync_state SET device_id = ?").run(PHONE);
  plantPoison(phone, "phone");
  plantPoison(desktop, "desktop");

  const phoneId = (await readState(phone.driver)).deviceId;
  const desktopId = (await readState(desktop.driver)).deviceId;
  for (const [store, peer] of [
    [phone, desktopId],
    [desktop, phoneId],
  ] as const) {
    await store.driver.batch(
      registerPeerStatements({
        deviceId: peer,
        generation: 1,
        pairingId: PAIRING,
      }),
    );
  }

  // One legal write on each side, so neither direction can pass by sending
  // nothing: the phone pushes a note, the desktop's outbox already holds a task.
  phone.db
    .prepare(
      `INSERT INTO notes (uid, title, content, tags, created_at, updated_at)
       VALUES (?, 'TRAVELS-phone-push', '', '', '2026-01-01', '2026-01-01')`,
    )
    .run(PUSH_NOTE_UID);
  await phone.driver.batch(
    outboxStatements([
      {
        table: "notes",
        uid: PUSH_NOTE_UID,
        kind: "create",
        fields: {
          title: "TRAVELS-phone-push",
          content: "",
          tags: "",
          created_at: "2026-01-01",
          updated_at: "2026-01-01",
        },
      },
    ]),
  );
  desktop.db
    .prepare(
      `INSERT INTO tasks (uid, title, due_date, done, repeat, note, created_at)
       VALUES (?, 'TRAVELS-desktop-tasks', NULL, 0, 'none', '', '2026-01-01')`,
    )
    .run(PULL_TASK_UID);
  await desktop.driver.batch(
    outboxStatements([
      {
        table: "tasks",
        uid: PULL_TASK_UID,
        kind: "create",
        fields: {
          title: "TRAVELS-desktop-tasks",
          done: 0,
          repeat: "none",
          note: "",
          created_at: "2026-01-01",
        },
      },
    ]),
  );

  const state = ferry(phone, desktop);
  // The wire, as the session actually put bytes on it: every pushed op and
  // every pulled op, in order.
  const wire: unknown[] = [];
  const transport = {
    ...state.phone,
    syncPush: async (
      ...args: Parameters<typeof state.phone.syncPush>
    ): Promise<void> => {
      wire.push(...args[3]);
      return state.phone.syncPush(...args);
    },
    syncPull: async (
      ...args: Parameters<typeof state.phone.syncPull>
    ): ReturnType<typeof state.phone.syncPull> => {
      const pulled = await state.phone.syncPull(...args);
      wire.push(...pulled.ops);
      return pulled;
    },
  };

  const outcome = await runSync(
    phone.driver,
    transport,
    { endpoint: "127.0.0.1:8788", desktopDeviceId: desktopId },
    { sleep: async () => undefined },
  );
  assert.equal(outcome.state, "applied", outcome.refusal?.message ?? "");
  assert.ok(outcome.pushed >= 1 && outcome.pulled >= 1);

  // Positive controls first: both directions really ran.
  const wireJson = JSON.stringify(wire);
  assert.ok(wireJson.includes("TRAVELS-phone-push"), "the push travelled");
  assert.ok(wireJson.includes("TRAVELS-desktop-tasks"), "the pull travelled");
  assert.equal(
    await countRows(desktop, "SELECT count(*) AS n FROM notes WHERE uid = ?", [
      PUSH_NOTE_UID,
    ]),
    1,
    "the desktop applied the phone's note",
  );
  assert.equal(
    await countRows(phone, "SELECT count(*) AS n FROM tasks WHERE uid = ?", [
      PULL_TASK_UID,
    ]),
    1,
    "the phone applied the desktop's task",
  );

  // And neither direction carried anything §2.2 names.
  assert.deepEqual(leakedFrom(wireJson, "phone"), [], "the push leaked");
  assert.deepEqual(leakedFrom(wireJson, "desktop"), [], "the pull leaked");
  assert.deepEqual(
    NEVER_TRAVELS.filter((table) => wireJson.includes(`"${table}"`)),
    [],
    "§2.2: an op names a synced table",
  );
  assert.deepEqual(
    leakedFrom(dumpNeverTravels(desktop), "phone"),
    [],
    "the phone's §2.2 rows stayed home",
  );
  assert.deepEqual(
    leakedFrom(dumpNeverTravels(phone), "desktop"),
    [],
    "the desktop's §2.2 rows stayed home",
  );
  // The plant that records no op is the point of §6.1: a row with no outbox
  // entry cannot be pushed at all.
  assert.ok(
    !dumpNeverTravels(desktop).includes("TRAVELS-phone-notes"),
    "an unrecorded note is not on the wire",
  );
});

test("a backup payload carries no sync storage and no app PIN", async () => {
  const store = openBaselineStore();
  plantPoison(store, "backup");
  // Four poison rows cannot survive the import-side validators, and this leg is
  // about §10.3 rather than about them: photos are read through IPC (which this
  // store's driver does not answer), `links` must point at rows the archive
  // holds, and a Trash snapshot must be a real one.
  for (const table of ["photo_refs", "photos", "links", "trash_items"]) {
    store.db.exec(`DELETE FROM ${table}`);
  }

  const { bytes } = await createBackupRepo(store.driver).exportBackup();
  const { payload } = parseBackupZip(bytes);
  const tables = Object.keys(payload.data);
  const json = JSON.stringify(payload);

  assert.deepEqual(
    tables.filter((table) => table.startsWith("sync_")),
    [],
    "§10.3: no sync table may enter a payload",
  );
  assert.deepEqual(
    leakedFrom(json, "backup").filter((name) => name === "pin_hash"),
    [],
    "§10.3: the app PIN is device-local",
  );
  // …while an ordinary settings row is user data and does travel: §10.3 names
  // the PIN and replication state, not `settings` as a table.
  assert.ok(json.includes("LEAK-backup-settings"));
  // A backup is the user's own data on their own disk: §10.3 excludes pairing
  // and replication state, not the desktop-only modules, so those DO travel.
  assert.ok(json.includes("LEAK-backup-payables"));
  assert.ok(json.includes("TRAVELS-backup-notes"));
});
