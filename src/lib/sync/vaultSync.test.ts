/**
 * §12.3 (Stage 3): the Vault, one-way and generation-aware.
 *
 * Every test runs the REAL `vault.ts` on both sides over two real SQLite
 * stores, so "the phone unlocks what it received" is proven by decrypting it,
 * and "no generation was mixed" is proven by comparing the stored ciphertext
 * bytes rather than a claim about them.
 *
 * The phone is always built with its own origin (`createVaultRepo(driver,
 * "mobile")`), exactly as `data/app.ts` builds it: the vault is one-way, and a
 * phone that recorded an op would have the desktop refuse the whole batch.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVaultRepo } from "../vault.ts";
import { applyOps, type PeerOp } from "./engine.ts";
import {
  readOutbox,
  readVaultMetadata,
  type SnapshotOp,
  snapshotApplyStatements,
  snapshotStatements,
  type VaultMetaWire,
} from "./store.ts";
import { runSync } from "./syncSession.ts";
import {
  countRows as count,
  DESKTOP,
  ferry,
  SYNC_INPUT as input,
  PHONE,
  pairStores as pair,
} from "./testFerry.ts";
import { openSyncStore } from "./testSchema.ts";

/** The stored columns a vault row is compared by — ciphertext as bytes. */
interface StoredItem {
  uid: string | null;
  ciphertext: string;
  salt: string;
  iv: string;
}

/** One stored vault row, exactly as both devices keep it. */
async function storedItems(
  store: Awaited<ReturnType<typeof pair>>["phone"],
): Promise<StoredItem[]> {
  return store.driver.query<StoredItem>(
    "SELECT uid, ciphertext, salt, iv FROM vault_items ORDER BY uid",
  );
}

async function generationOf(
  store: Awaited<ReturnType<typeof pair>>["phone"],
): Promise<string | undefined> {
  const [row] = await store.driver.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = 'vault_generation'",
  );
  return row?.value;
}

test("a desktop vault item syncs to the phone, which unlocks it", async () => {
  const { phone, desktop } = await pair();
  const desktopVault = createVaultRepo(desktop.driver);
  await desktopVault.setupVault("desk-pass");
  await desktopVault.addItem("email", "s3cret", "desk-pass");

  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(outcome.confirmed, true);
  assert.equal(
    outcome.pulled,
    1,
    "the item, and only the item: no settings row crosses",
  );

  // The phone's own vault.ts, unchanged: what it received is a vault it can
  // unlock with the desktop's password.
  const phoneVault = createVaultRepo(phone.driver, "mobile");
  assert.equal(
    await phoneVault.isSetUp(),
    true,
    "the metadata write is what makes the phone hold a vault",
  );
  const items = await phoneVault.listItems();
  assert.equal(items.length, 1);
  const first = items[0];
  assert.ok(first);
  assert.equal(first.title, "email");
  assert.equal(
    (await phoneVault.getItem(first.id, "desk-pass"))?.plaintext,
    "s3cret",
  );
  await assert.rejects(() => phoneVault.getItem(first.id, "not-the-password"));
  // §2.2: the settings table itself never crossed, and the envelope never
  // became a column.
  const [row] = await phone.driver.query<Record<string, unknown>>(
    "SELECT * FROM vault_items",
  );
  assert.equal(Object.hasOwn(row ?? {}, "vault_generation"), false);
  assert.equal(Object.hasOwn(row ?? {}, "vault_verifier"), false);
});

test("a desktop password change rotates the phone's copy, old set gone", async () => {
  const { phone, desktop } = await pair();
  const desktopVault = createVaultRepo(desktop.driver);
  await desktopVault.setupVault("old-pass");
  await desktopVault.addItem("email", "s3cret", "old-pass");
  await desktopVault.addItem("bank", "0000", "old-pass");

  const opening = ferry(phone, desktop);
  await runSync(phone.driver, opening.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(await count(phone, "SELECT count(*) AS n FROM vault_items"), 2);

  await desktopVault.changePassword("old-pass", "new-pass");

  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(outcome.confirmed, true);
  assert.equal(
    outcome.pulled,
    2,
    "a rotation re-sends every item it re-sealed",
  );

  const phoneVault = createVaultRepo(phone.driver, "mobile");
  const items = await phoneVault.listItems();
  assert.deepEqual(
    items.map((item) => item.title),
    ["email", "bank"],
    "the new generation replaced the set; nothing was duplicated or merged",
  );
  const [email, bank] = items;
  assert.ok(email && bank);
  assert.equal(
    (await phoneVault.getItem(email.id, "new-pass"))?.plaintext,
    "s3cret",
  );
  assert.equal(
    (await phoneVault.getItem(bank.id, "new-pass"))?.plaintext,
    "0000",
  );
  // The old password opens nothing any more — not the rows, not the verifier.
  await assert.rejects(() => phoneVault.getItem(email.id, "old-pass"));
  assert.equal(await generationOf(phone), JSON.stringify(2));
});

test("an old-generation op replayed after a rotation resurrects nothing (F3)", async () => {
  const { phone, desktop } = await pair();
  const desktopVault = createVaultRepo(desktop.driver);
  await desktopVault.setupVault("old-pass");
  const id = await desktopVault.addItem("email", "s3cret", "old-pass");

  // The pre-rotation document, kept as the wire would re-deliver it.
  const stale: PeerOp[] = await readOutbox(desktop.driver);
  assert.equal(stale.length, 1);

  const opening = ferry(phone, desktop);
  await runSync(phone.driver, opening.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal((await storedItems(phone)).length, 1);

  await desktopVault.changePassword("old-pass", "new-pass");
  const wire = ferry(phone, desktop);
  await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });

  const [rotated] = await storedItems(phone);
  const [onDesktop] = await desktop.driver.query<StoredItem>(
    "SELECT uid, ciphertext, salt, iv FROM vault_items WHERE id = ?",
    [id],
  );
  assert.ok(rotated && onDesktop);
  assert.deepEqual(
    rotated,
    onDesktop,
    "the phone holds the rotated row, byte for byte",
  );

  // The same op, delivered again after the rotation: same generation as the
  // items it would resurrect, so it writes nothing — and writes no metadata
  // either, which is what would let it reconfigure the phone's verifier.
  await phone.driver.batch(
    await applyOps(phone.driver, {
      peerId: DESKTOP,
      origin: "desktop",
      ops: stale,
    }),
  );

  const after = await storedItems(phone);
  assert.deepEqual(after, [rotated], "no resurrection and no mixing");
  assert.equal(
    await generationOf(phone),
    JSON.stringify(2),
    "a stale op cannot move the generation back",
  );
  const phoneVault = createVaultRepo(phone.driver, "mobile");
  const [item] = await phoneVault.listItems();
  assert.ok(item);
  assert.equal(
    (await phoneVault.getItem(item.id, "new-pass"))?.plaintext,
    "s3cret",
    "and the vault still opens with the password it was rotated to",
  );
});

test("a mobile-origin vault op is refused (§2.3)", async () => {
  const { phone, desktop } = await pair();
  const desktopVault = createVaultRepo(desktop.driver);
  await desktopVault.setupVault("desk-pass");
  await desktopVault.addItem("email", "s3cret", "desk-pass");
  const ops = await readOutbox(desktop.driver);
  assert.equal(ops.length, 1);

  await assert.rejects(
    () =>
      applyOps(phone.driver, {
        peerId: DESKTOP,
        origin: "mobile",
        ops,
      }),
    /one-way desktop-to-mobile/,
  );
  assert.equal(
    await count(phone, "SELECT count(*) AS n FROM vault_items"),
    0,
    "§7.1: the refusal is a wall — nothing of the batch was written",
  );
});

test("an adopted snapshot leaves a working vault of the snapshot's generation", async () => {
  const phone = openSyncStore(PHONE);
  const desktop = openSyncStore(DESKTOP);
  const desktopVault = createVaultRepo(desktop.driver);
  await desktopVault.setupVault("desk-pass");
  await desktopVault.addItem("email", "s3cret", "desk-pass");

  // The phone already had a vault of its own: adoption REPLACES it (decision
  // 5), because the phone's vault is a copy of the desktop's.
  const phoneVault = createVaultRepo(phone.driver, "mobile");
  await phoneVault.setupVault("phone-pass");
  await phoneVault.addItem("local", "phone secret", "phone-pass");

  // The vault section exactly as `pairing_snapshot.rs` emits it: the row's
  // stored fields plus the two envelope keys, beside them.
  const rows = await desktop.driver.query<
    StoredItem & { title: string; created_at: string; updated_at: string }
  >("SELECT * FROM vault_items");
  const metadata = await readVaultMetadata(desktop.driver);
  const ops: SnapshotOp[] = rows.map((row) => ({
    table: "vault_items",
    uid: row.uid ?? "",
    stamp: { counter: 1, deviceId: DESKTOP, opId: "snapshot-op" },
    fields: {
      title: row.title,
      ciphertext: row.ciphertext,
      salt: row.salt,
      iv: row.iv,
      created_at: row.created_at,
      updated_at: row.updated_at,
      vault_generation: metadata.generation,
      vault_verifier: metadata.verifier,
    },
  }));
  await phone.driver.batch(snapshotStatements(ops));

  const adopted = createVaultRepo(phone.driver, "mobile");
  assert.equal(await adopted.isSetUp(), true);
  const items = await adopted.listItems();
  assert.deepEqual(
    items.map((item) => item.title),
    ["email"],
    "the phone's own vault was replaced, not merged",
  );
  const first = items[0];
  assert.ok(first);
  assert.equal(
    (await adopted.getItem(first.id, "desk-pass"))?.plaintext,
    "s3cret",
  );
  await assert.rejects(() => adopted.getItem(first.id, "phone-pass"));
  assert.equal(
    await generationOf(phone),
    JSON.stringify(metadata.generation),
    "the phone holds the snapshot's generation, not one of its own",
  );
  // The envelope stayed an envelope.
  const [row] = await phone.driver.query<Record<string, unknown>>(
    "SELECT * FROM vault_items",
  );
  assert.equal(Object.hasOwn(row ?? {}, "vault_generation"), false);
  assert.equal(Object.hasOwn(row ?? {}, "vault_verifier"), false);
});

// ---------------------------------------------------------------------------
// F-2 — an item-less vault still crosses: the pair travels at batch level.
// ---------------------------------------------------------------------------

/** The desktop's batch-level carriage, exactly as the readers build it. */
async function carriageOf(
  store: Awaited<ReturnType<typeof pair>>["desktop"],
): Promise<VaultMetaWire> {
  const metadata = await readVaultMetadata(store.driver);
  assert.ok(metadata.verifier !== null, "the desktop has a vault set up");
  return { generation: metadata.generation ?? 1, verifier: metadata.verifier };
}

test("F-2: a setup-only desktop vault reaches the phone over sync", async () => {
  const { phone, desktop } = await pair();
  const desktopVault = createVaultRepo(desktop.driver);
  await desktopVault.setupVault("desk-pass");
  // No item is ever added: there is no op for the envelope to ride on.

  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(outcome.confirmed, true);
  assert.equal(outcome.pulled, 0, "no operation crossed — the carriage did");

  const phoneVault = createVaultRepo(phone.driver, "mobile");
  assert.equal(
    await phoneVault.isSetUp(),
    true,
    "the phone now holds a vault, where it reported none before",
  );
  assert.equal(await generationOf(phone), JSON.stringify(1));
  // The verifier is the only proof an empty vault has, and it works: the
  // desktop's password unlocks, any other is refused.
  await phoneVault.unlock("desk-pass");
  await assert.rejects(() => phoneVault.unlock("not-the-password"));
  assert.deepEqual(await storedItems(phone), [], "still no items anywhere");
});

test("F-2: a setup-only desktop vault reaches the phone over a snapshot", async () => {
  const phone = openSyncStore(PHONE);
  const desktop = openSyncStore(DESKTOP);
  const desktopVault = createVaultRepo(desktop.driver);
  await desktopVault.setupVault("desk-pass");

  const meta = await carriageOf(desktop);
  const applied = await snapshotApplyStatements(
    phone.driver,
    [],
    [],
    new Date(),
    DESKTOP,
    "merge",
    meta,
  );
  await phone.driver.batch(applied.statements);

  const phoneVault = createVaultRepo(phone.driver, "mobile");
  assert.equal(await phoneVault.isSetUp(), true);
  await phoneVault.unlock("desk-pass");
  await assert.rejects(() => phoneVault.unlock("not-the-password"));
});

test("F-2: a rotated empty vault replaces the phone's generation, items go", async () => {
  const { phone, desktop } = await pair();
  const desktopVault = createVaultRepo(desktop.driver);
  await desktopVault.setupVault("desk-pass");

  // The phone holds a first-generation copy WITH an item, adopted earlier.
  const wire = ferry(phone, desktop);
  await desktopVault.addItem("email", "s3cret", "desk-pass");
  const first = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(first.confirmed, true);
  assert.equal((await storedItems(phone)).length, 1);

  // The desktop rotates its password and deletes its only item: generation
  // 2 now holds nothing, so only the carriage can say so.
  const items = await desktopVault.listItems();
  for (const item of items) await desktopVault.deleteItem(item.id);
  await desktopVault.changePassword("desk-pass", "new-pass");
  assert.deepEqual(await storedItems(desktop), []);

  wire.newWindow();
  const second = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(second.confirmed, true);
  assert.deepEqual(
    await storedItems(phone),
    [],
    "the old generation's item did not survive the rotation",
  );
  assert.equal(await generationOf(phone), JSON.stringify(2));
  const phoneVault = createVaultRepo(phone.driver, "mobile");
  await phoneVault.unlock("new-pass");
  await assert.rejects(() => phoneVault.unlock("desk-pass"));
});

test("F-2: a desktop with no vault sends nothing — the phone's own vault is untouched", async () => {
  const { phone, desktop } = await pair();
  void desktop;
  const phoneVault = createVaultRepo(phone.driver, "mobile");
  await phoneVault.setupVault("phone-pass");
  await phoneVault.addItem("local", "phone secret", "phone-pass");

  const wire = ferry(phone, desktop);
  const outcome = await runSync(phone.driver, wire.phone, input, {
    sleep: async () => undefined,
  });
  assert.equal(outcome.confirmed, true);

  const after = createVaultRepo(phone.driver, "mobile");
  assert.equal(await after.isSetUp(), true);
  const items = await after.listItems();
  assert.equal(items.length, 1);
  const first = items[0];
  assert.ok(first);
  assert.equal(
    (await after.getItem(first.id, "phone-pass"))?.plaintext,
    "phone secret",
    "§9.1: no carriage arrived, so nothing here was the desktop's to change",
  );
});
