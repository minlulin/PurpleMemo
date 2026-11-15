// Vault repository security: a cached key never bypasses password
// validation, changePassword is all-or-nothing, and (Stage 3) every desktop
// mutation records the operation that carries it — under its password
// generation — while the phone records nothing at all.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { BatchStatement } from "../data/driver.ts";
import type { MockDriver } from "../data/mock-driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import {
  bytesToB64,
  deriveVaultTag,
  PBKDF2_ITERATIONS,
  randomSaltB64,
  VAULT_TAG_ITERATIONS,
} from "./crypto.ts";
import type { Origin } from "./sync/protocol.ts";
import { readState } from "./sync/store.ts";
import { openSyncStore, type SyncFixture } from "./sync/testSchema.ts";
import type { VaultItemRow } from "./types.ts";
import {
  createVaultRepo,
  VAULT_GENERATION_KEY,
  VAULT_SETUP_KEY,
  VAULT_VERIFY_KEY,
  WrongPasswordError,
} from "./vault.ts";

/**
 * Every write the vault issued, as `[sql, params]` — from single `execute`
 * calls AND from statements inside a `batch`. The vault writes atomically, so
 * assertions have to look in both places or they silently stop checking
 * anything.
 */
function writesFrom(driver: MockDriver): [string, unknown[]][] {
  const out: [string, unknown[]][] = driver
    .callsTo("execute")
    .map((c) => [c.args[0] as string, (c.args[1] as unknown[]) ?? []]);
  for (const call of driver.callsTo("batch")) {
    for (const s of call.args[0] as BatchStatement[]) {
      out.push([s.sql, s.params ?? []]);
    }
  }
  return out;
}

/** The sealed verifier row the vault last wrote, or undefined. */
function verifierWritten(driver: MockDriver): string | undefined {
  return writesFrom(driver).find(([, p]) => p[0] === "vault_verify")?.[1][1] as
    | string
    | undefined;
}

/** The one `INSERT INTO vault_items` a write committed, or undefined. */
function itemInsert(driver: MockDriver): BatchStatement | undefined {
  return writesFrom(driver)
    .map(([sql, params]) => ({ sql, params }))
    .find((statement) => /INSERT INTO vault_items/.test(statement.sql));
}

/** A verifier-shaped value: the payload only ever forwards it, never parses it. */
const SEALED_VERIFIER = JSON.stringify({
  salt: "c2FsdA==",
  iv: "aXYtYnl0ZXMh",
  ciphertext: "Y2lwaGVydGV4dA==",
});

/** What `readVaultMetadata` reads: the two settings rows, as stored. */
function storedMetadata(generation = 1): { key: string; value: string }[] {
  return [
    { key: "vault_generation", value: JSON.stringify(generation) },
    { key: "vault_verify", value: SEALED_VERIFIER },
  ];
}

/**
 * The two queries an `addItem` makes before and after its batch: the vault
 * metadata every op carries (§12.3), then the row id it returns.
 */
function stageAdd(driver: MockDriver, id: number, generation = 1): void {
  driver.pushResults([storedMetadata(generation), [{ id }]]);
}

/** Rebuild the vault_items row from the addItem INSERT this driver committed. */
function rowFromInsert(driver: MockDriver): VaultItemRow {
  const insert = itemInsert(driver);
  assert.ok(insert, "the item's insert must be in a batch");
  const params = (insert.params ?? []) as unknown[];
  // [uid, title, ciphertext, salt, iv, created_at, updated_at]
  return {
    id: 1,
    uid: params[0] as string,
    title: params[1] as string,
    ciphertext: params[2] as string,
    salt: params[3] as string,
    iv: params[4] as string,
    created_at: params[5] as string,
    updated_at: params[6] as string,
  };
}

/** A store under test: the real schema, the driver, and the vault over them. */
async function vaultStore(origin: Origin = "desktop") {
  const fixture: SyncFixture = openSyncStore();
  return { ...fixture, vault: createVaultRepo(fixture.driver, origin) };
}

/** Every recorded operation, oldest first. */
async function opsOf(store: SyncFixture): Promise<
  {
    seq: number;
    entity_uid: string;
    op: string;
    payload: Record<string, unknown>;
  }[]
> {
  const rows = await store.driver.query<{
    seq: number;
    entity_uid: string;
    op: string;
    payload: string;
  }>(
    "SELECT seq, entity_uid, op, payload FROM sync_outbox WHERE entity_table = 'vault_items' ORDER BY seq",
  );
  return rows.map((row) => ({
    seq: row.seq,
    entity_uid: row.entity_uid,
    op: row.op,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
  }));
}

async function settingOf(
  store: SyncFixture,
  key: string,
): Promise<string | undefined> {
  const [row] = await store.driver.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [key],
  );
  return row?.value;
}

test("getItem with a wrong password fails even when the key is cached", async () => {
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  stageAdd(driver, 1);
  const id = await vault.addItem("email", "s3cret", "correct-horse");
  const row = rowFromInsert(driver);

  // Correct password first: cache hit path, decrypts fine.
  driver.pushResults([[row]]);
  const got = await vault.getItem(id, "correct-horse");
  assert.equal(got?.plaintext, "s3cret");

  // Wrong password: cache miss (tag differs) -> fresh (wrong) key -> GCM auth
  // failure. The cached key never bypasses validation.
  driver.pushResults([[row], [{ salt: row.salt }]]);
  await assert.rejects(vault.getItem(id, "wrong-password"));
});

test("changePassword with a wrong old password writes nothing", async () => {
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  stageAdd(driver, 1);
  await vault.addItem("email", "s3cret", "correct-horse");
  const row = rowFromInsert(driver);
  // metadata, then the items, then the (wrong-password) key derivation's salt.
  driver.pushResults([storedMetadata(), [row], [{ salt: row.salt }]]);
  await assert.rejects(vault.changePassword("wrong-old", "new-pass"));
  assert.equal(
    driver.callsTo("batch").length,
    1,
    "only addItem's batch was written; the rotation wrote none",
  );
  assert.equal(
    writesFrom(driver).filter(([sql]) => /UPDATE vault_items/.test(sql)).length,
    0,
  );
});

test("changePassword migrates every item in one atomic batch", async () => {
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  stageAdd(driver, 1);
  await vault.addItem("email", "s3cret", "old-pass");
  const row = rowFromInsert(driver);
  // metadata, then SELECT * FROM vault_items ORDER BY id.
  driver.pushResults([storedMetadata(), [row]]);
  await vault.changePassword("old-pass", "new-pass");

  const batches = driver.callsTo("batch");
  assert.equal(batches.length, 2, "addItem's batch, then the rotation's");
  const statements = batches[1]?.args[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.match(statements[0]?.sql ?? "", /UPDATE vault_items SET ciphertext/);

  // The re-encrypted row decrypts with the new password, not the old.
  const updateParams = statements[0]?.params as unknown[];
  const newRow: VaultItemRow = {
    ...row,
    ciphertext: updateParams[0] as string,
    salt: updateParams[1] as string,
    iv: updateParams[2] as string,
  };
  const driver2 = createMockDriver();
  const vault2 = createVaultRepo(driver2);
  driver2.pushResults([[newRow], [{ salt: newRow.salt }]]);
  const got = await vault2.getItem(newRow.id, "new-pass");
  assert.equal(got?.plaintext, "s3cret");
  driver2.pushResults([[newRow], [{ salt: newRow.salt }]]);
  await assert.rejects(vault2.getItem(newRow.id, "old-pass"));
});

// This is the bug that broke the feature entirely. The verifier
// was re-sealed with a plain INSERT into `settings`, whose `key` is the
// PRIMARY KEY, so every password change failed with a UNIQUE violation — and
// it failed AFTER the re-encrypted items had already committed. The UI showed
// "wrong current password, nothing was changed" and left the user with items
// only the new password could read.
test("changePassword re-seals the verifier by UPSERT, in the item batch", async () => {
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  stageAdd(driver, 1);
  await vault.addItem("email", "s3cret", "old-pass");
  const row = rowFromInsert(driver);
  driver.pushResults([storedMetadata(), [row]]);
  await vault.changePassword("old-pass", "new-pass");

  const statements = driver.callsTo("batch")[1]?.args[0] as {
    sql: string;
    params: unknown[];
  }[];
  const seal = statements.find((s) => (s.params ?? [])[0] === "vault_verify");
  assert.ok(seal, "the verifier must be re-sealed in the rotation's batch");
  assert.match(
    seal.sql,
    /ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value/,
    "a plain INSERT would violate the settings primary key",
  );
  // Same batch as the items: no window where the items have moved to the new
  // password but the verifier still expects the old one.
  assert.match(statements[0]?.sql ?? "", /UPDATE vault_items/);
});

test("changePassword leaves the verifier proving the new password", async () => {
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  stageAdd(driver, 1);
  await vault.addItem("email", "s3cret", "old-pass");
  const row = rowFromInsert(driver);
  driver.pushResults([storedMetadata(), [row]]);
  await vault.changePassword("old-pass", "new-pass");
  const sealed = verifierWritten(driver);
  assert.ok(sealed);

  // Empty vault + the verifier the change just wrote: the NEW password opens
  // it, the OLD one does not.
  const okDriver = createMockDriver();
  okDriver.pushResults([[], [{ value: sealed }]]);
  await createVaultRepo(okDriver).unlock("new-pass");

  const badDriver = createMockDriver();
  // `isSetUp`/the marker read now come from the settings repo, which selects
  // `value` (docs/AUDIT.md DUP-06) — the marker row is a value, not a key.
  badDriver.pushResults([[], [{ value: sealed }], [{ value: "{}" }]]);
  await assert.rejects(
    () => createVaultRepo(badDriver).unlock("old-pass"),
    /password/i,
  );
});

// A write failure must never masquerade as a wrong password. Since Stage 3 the
// rotation also records an op (§6.1), so a failing op inside the same batch
// must take the re-encrypted items down with it — the vault stays readable by
// the password it had.
test("changePassword writes nothing when its batch fails", async () => {
  const store = await vaultStore();
  await store.vault.setupVault("old-pass");
  const id = await store.vault.addItem("email", "s3cret", "old-pass");
  store.db.exec(
    "CREATE TRIGGER refuse_outbox BEFORE INSERT ON sync_outbox BEGIN SELECT RAISE(ABORT, 'outbox refused'); END",
  );

  const err = await store.vault
    .changePassword("old-pass", "new-pass")
    .then(() => null)
    .catch((e: unknown) => e);
  // The second half of the UI told the user "wrong current password" here,
  // which was false — the write failed, the password was fine.
  assert.ok(
    !(err instanceof WrongPasswordError),
    "a write failure must not masquerade as a wrong password",
  );
  assert.match(String((err as Error).message), /outbox refused/);

  // Rolled back whole: the old password still opens the item, the generation
  // never moved, and no rotation op was left behind.
  const reopened = createVaultRepo(store.driver);
  assert.equal((await reopened.getItem(id, "old-pass"))?.plaintext, "s3cret");
  await assert.rejects(() => reopened.getItem(id, "new-pass"));
  const [generation] = await store.driver.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [VAULT_GENERATION_KEY],
  );
  assert.equal(generation?.value, JSON.stringify(1));
  assert.equal(
    (await opsOf(store)).filter((op) => op.op === "update").length,
    0,
  );
});

test("a wrong password is reported as WrongPasswordError, not a bare Error", async () => {
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  stageAdd(driver, 1);
  await vault.addItem("email", "s3cret", "correct-horse");
  const row = rowFromInsert(driver);
  driver.pushResults([storedMetadata(), [row], [{ salt: row.salt }]]);
  await assert.rejects(
    () => vault.changePassword("wrong-old", "new-pass"),
    WrongPasswordError,
  );

  // And on the unlock path, so "wrong password" stays honest there too.
  driver.pushResults([[row], [{ salt: row.salt }]]);
  await assert.rejects(
    () => vault.getItem(row.id, "wrong-old"),
    WrongPasswordError,
  );
});

test("corrupt stored ciphertext is NOT reported as a wrong password", async () => {
  // A GCM tag mismatch is an OperationError and does mean "wrong password".
  // An undecodable field is corruption of the stored row — telling the user
  // they mistyped their password would send them looking in the wrong place.
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  stageAdd(driver, 1);
  await vault.addItem("email", "s3cret", "correct-horse");
  const row = rowFromInsert(driver);
  driver.pushResults([
    [{ ...row, ciphertext: "!!!not base64!!!" }],
    [{ salt: row.salt }],
  ]);
  const err = await vault
    .getItem(row.id, "correct-horse")
    .then(() => null)
    .catch((e: unknown) => e);
  assert.ok(err, "it must still fail");
  assert.ok(
    !(err instanceof WrongPasswordError),
    "corruption must not masquerade as a mistyped password",
  );
});

test("a structurally broken row reads as corruption, never a wrong password (H5)", async () => {
  // The tag check is the ONLY thing allowed to say "wrong password": it is
  // the one failure that means "this key did not open this ciphertext". An IV
  // that is not 12 bytes, or a ciphertext cut below its own 16-byte tag, can
  // never verify either — but the reason is a damaged row, and telling the
  // user they mistyped the password would send them hunting for a typo that
  // was never there. `crypto.ts` refuses both before WebCrypto can fold them
  // into an OperationError, and the message names the corruption.
  const damage: [string, (row: VaultItemRow) => VaultItemRow][] = [
    ["empty IV", (row) => ({ ...row, iv: "" })],
    ["9-byte IV", (row) => ({ ...row, iv: bytesToB64(new Uint8Array(9)) })],
    [
      "3-byte ciphertext",
      (row) => ({ ...row, ciphertext: bytesToB64(new Uint8Array(3)) }),
    ],
  ];
  for (const [name, breakRow] of damage) {
    const driver = createMockDriver();
    const vault = createVaultRepo(driver);
    stageAdd(driver, 1);
    await vault.addItem("email", "s3cret", "correct-horse");
    const row = rowFromInsert(driver);
    driver.pushResults([[breakRow(row)], [{ salt: row.salt }]]);
    const err = await vault
      .getItem(row.id, "correct-horse")
      .then(() => null)
      .catch((e: unknown) => e);
    assert.ok(err instanceof Error, `${name}: it must still fail`);
    assert.ok(
      !(err instanceof WrongPasswordError),
      `${name}: corruption must not masquerade as a mistyped password`,
    );
    assert.match(
      err.message,
      /corrupt/i,
      `${name}: the refusal must name the corruption`,
    );
  }
});

test("setupVault refuses a second setup — the marker is written once", async () => {
  const driver = createMockDriver({
    // isSetUp: marker already present (the repo reads `value`, DUP-06).
    results: [[{ value: "{}" }]],
  });
  const vault = createVaultRepo(driver);
  await assert.rejects(vault.setupVault("any-pass"), /already set up/);
  assert.equal(driver.callsTo("execute").length, 0);
  assert.equal(driver.callsTo("batch").length, 0);
});

// Pre-release audit: with no items yet there was nothing to decrypt, so
// unlock() trusted any password. A user who set the vault up, added nothing,
// and then typed a different password was told "unlocked" — and their first
// secret became encrypted under a password they do not believe they used.
test("setupVault stores a password verifier so the password is proven immediately", async () => {
  const driver = createMockDriver({ results: [[]] }); // isSetUp: no marker
  const vault = createVaultRepo(driver);
  await vault.setupVault("correct-horse");
  const verifier = verifierWritten(driver);
  assert.ok(verifier, "a verifier must be written at setup");
  // Same shape as a vault item: salt + iv + ciphertext, never the password.
  const stored = JSON.parse(verifier) as {
    salt: string;
    iv: string;
    ciphertext: string;
  };
  assert.ok(stored.salt && stored.iv && stored.ciphertext);
  assert.ok(!JSON.stringify(stored).includes("correct-horse"));
});

// the setup marker and the verifier used to commit separately, so
// a seal that failed after the marker left isSetUp() true with nothing to
// unlock against — setup unreachable and unlock impossible, permanently.
test("setupVault writes the marker, the verifier and generation 1 in one batch", async () => {
  const driver = createMockDriver({ results: [[]] });
  const vault = createVaultRepo(driver);
  await vault.setupVault("correct-horse");

  const batches = driver.callsTo("batch");
  assert.equal(batches.length, 1, "one atomic batch, not two writes");
  const statements = batches[0]?.args[0] as BatchStatement[];
  const keys = statements.map((s) => (s.params ?? [])[0]);
  assert.deepEqual(
    keys,
    [VAULT_SETUP_KEY, VAULT_VERIFY_KEY, VAULT_GENERATION_KEY],
    "the marker, the verifier, and the generation they both belong to",
  );
  assert.equal(
    statements[2]?.params?.[1],
    JSON.stringify(1),
    "a vault starts at password generation 1 (§12.3)",
  );
});

test("setupVault leaves no marker behind when the batch fails", async () => {
  const driver = createMockDriver({
    results: [[]], // isSetUp: no marker
    batchError: new Error("disk full"),
  });
  const vault = createVaultRepo(driver);
  await assert.rejects(() => vault.setupVault("correct-horse"), /disk full/);
  // The marker rode in the same batch, so the rollback took it with it.
  assert.equal(driver.callsTo("execute").length, 0);
});

test("unlock with no items still verifies the stored verifier, rejecting a wrong password", async () => {
  // The verifier was written by a real setup run below, then replayed here.
  const driver = createMockDriver({ results: [[]] });
  const vault = createVaultRepo(driver);
  await vault.setupVault("correct-horse");
  const verifierRaw = verifierWritten(driver);
  assert.ok(verifierRaw?.includes("ciphertext"), "verifier must be sealed");

  // No items, correct password: the verifier decrypts, unlock succeeds.
  const okDriver = createMockDriver();
  okDriver.pushResults([
    [], // vault_items: none
    [{ value: verifierRaw }], // settings: the verifier
  ]);
  const okVault = createVaultRepo(okDriver);
  await okVault.unlock("correct-horse");

  // No items, WRONG password: must be rejected, not waved through. The setup
  // marker is present whenever a verifier is (both are written at setup).
  const badDriver = createMockDriver();
  badDriver.pushResults([
    [], // vault_items: none
    [{ value: verifierRaw }], // settings: the verifier
    [{ value: "{}" }], // settings: setup marker -> must throw
  ]);
  const badVault = createVaultRepo(badDriver);
  await assert.rejects(() => badVault.unlock("not-the-password"), /password/i);
});

test("listItems never selects ciphertext, salt or iv", async () => {
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  await vault.listItems();
  const call = driver.lastCall();
  assert.ok(call);
  const [sql] = call.args as [string];
  assert.match(
    sql,
    /SELECT id, title, created_at, updated_at FROM vault_items/,
  );
  assert.ok(!/ciphertext|salt|\biv\b/.test(sql));
});

// ---------------------------------------------------------------------------
// §12.3 (Stage 3) — the generation, and the ops that carry the vault.
// ---------------------------------------------------------------------------

test("setupVault writes generation 1 and the verifier it belongs to", async () => {
  const store = await vaultStore();
  await store.vault.setupVault("correct-horse");

  assert.equal(await store.vault.isSetUp(), true);
  assert.equal(await settingOf(store, VAULT_GENERATION_KEY), JSON.stringify(1));
  const sealed = await settingOf(store, VAULT_VERIFY_KEY);
  assert.ok(sealed, "the verifier is stored beside the generation");
  const parsed = JSON.parse(sealed ?? "{}") as Record<string, unknown>;
  assert.ok(parsed.salt && parsed.iv && parsed.ciphertext);
  assert.ok(
    !sealed?.includes("correct-horse"),
    "no plaintext password is ever stored",
  );
});

test("an item add records one op: the stored triple, under generation 1", async () => {
  const store = await vaultStore();
  await store.vault.setupVault("correct-horse");
  const id = await store.vault.addItem("email", "s3cret", "correct-horse");

  const [stored] = await store.driver.query<VaultItemRow>(
    "SELECT * FROM vault_items WHERE id = ?",
    [id],
  );
  assert.ok(stored?.uid, "a created item mints its cross-device identity");

  const ops = await opsOf(store);
  assert.equal(ops.length, 1, "one mutation, one op");
  const [op] = ops;
  assert.ok(op);
  assert.equal(op.op, "create");
  assert.equal(op.entity_uid, stored.uid);
  // §12.3: ciphertext, salt and IV exactly as stored — compared as bytes
  // (base64 text), never by decrypting anything here.
  assert.equal(op.payload.ciphertext, stored.ciphertext);
  assert.equal(op.payload.salt, stored.salt);
  assert.equal(op.payload.iv, stored.iv);
  assert.equal(op.payload.title, "email");
  // The envelope rides beside the row's fields, never among them.
  assert.equal(op.payload.vault_generation, 1);
  assert.equal(
    op.payload.vault_verifier,
    await settingOf(store, VAULT_VERIFY_KEY),
  );
  assert.ok(
    !JSON.stringify(op).includes("s3cret"),
    "no op ever carries a plaintext secret",
  );
});

test("an edit and a delete record the whole row and its tombstone", async () => {
  const store = await vaultStore();
  await store.vault.setupVault("correct-horse");
  const id = await store.vault.addItem("email", "s3cret", "correct-horse");
  await store.vault.updateItem(
    id,
    { plaintext: "new secret" },
    "correct-horse",
  );
  const [stored] = await store.driver.query<VaultItemRow>(
    "SELECT * FROM vault_items WHERE id = ?",
    [id],
  );
  await store.vault.deleteItem(id);

  const ops = await opsOf(store);
  assert.deepEqual(
    ops.map((op) => op.op),
    ["create", "update", "delete"],
  );
  // §4.4: a vault row is aggregate-atomic, so an edit carries the complete row
  // rather than the fields it changed.
  const update = ops[1];
  assert.equal(update?.payload.ciphertext, stored?.ciphertext);
  assert.equal(update?.payload.salt, stored?.salt);
  assert.equal(update?.payload.iv, stored?.iv);
  assert.equal(update?.payload.vault_generation, 1);
  // §5.1: the delete leaves a tombstone under the same uid.
  const tombstones = await store.driver.query<{ entity_uid: string }>(
    "SELECT entity_uid FROM sync_tombstones WHERE entity_table = 'vault_items'",
  );
  assert.deepEqual(
    tombstones.map((row) => row.entity_uid),
    [stored?.uid],
  );
});

test("a password change bumps the generation once and re-op its every item", async () => {
  const store = await vaultStore();
  await store.vault.setupVault("old-pass");
  const first = await store.vault.addItem("email", "s3cret", "old-pass");
  const second = await store.vault.addItem("bank", "0000", "old-pass");

  await store.vault.changePassword("old-pass", "new-pass");

  assert.equal(
    await settingOf(store, VAULT_GENERATION_KEY),
    JSON.stringify(2),
    "one change, one bump — not one per item",
  );
  const ops = await opsOf(store);
  const rotation = ops.filter((op) => op.payload.vault_generation === 2);
  assert.equal(rotation.length, 2, "every re-sealed item is in the op set");
  assert.deepEqual(
    rotation.map((op) => op.op),
    ["update", "update"],
    "a rotation rewrites rows; it does not re-create them",
  );
  const uids = await store.driver.query<{ uid: string }>(
    "SELECT uid FROM vault_items ORDER BY id",
  );
  assert.deepEqual(
    rotation.map((op) => op.entity_uid),
    uids.map((row) => row.uid),
    "each op names a row that is really there",
  );
  const newVerifier = await settingOf(store, VAULT_VERIFY_KEY);
  for (const op of rotation) {
    assert.equal(
      op.payload.vault_verifier,
      newVerifier,
      "every op carries the NEW verifier: the old one cannot prove this password",
    );
  }
  // And the rotation really re-sealed the rows: the new password opens them.
  const reopened = createVaultRepo(store.driver);
  assert.equal(
    (await reopened.getItem(first, "new-pass"))?.plaintext,
    "s3cret",
  );
  assert.equal((await reopened.getItem(second, "new-pass"))?.plaintext, "0000");
});

test("a mobile-origin vault repository records nothing at all", async () => {
  // §2.3: the vault is one-way desktop→mobile. A phone that recorded an op
  // would have the desktop refuse the whole batch it arrived in, so the phone
  // records none — and spends no Lamport step doing it.
  const store = await vaultStore("mobile");
  await store.vault.setupVault("phone-pass");
  const id = await store.vault.addItem("email", "s3cret", "phone-pass");
  await store.vault.updateItem(id, { plaintext: "edited" }, "phone-pass");
  await store.vault.changePassword("phone-pass", "next-pass");
  await store.vault.deleteItem(id);

  assert.deepEqual(await opsOf(store), []);
  assert.equal(
    (
      await store.driver.query<{ n: number }>(
        "SELECT count(*) AS n FROM sync_row_stamps",
      )
    )[0]?.n,
    0,
  );
  assert.equal(
    (
      await store.driver.query<{ n: number }>(
        "SELECT count(*) AS n FROM sync_tombstones",
      )
    )[0]?.n,
    0,
  );
  assert.equal((await readState(store.driver)).lastSeq, 0, "no Lamport step");
});

test("the cache tag is a slow KDF, not a fast hash of the password (P3-19)", async () => {
  // The cache must bind a key to its password — that is what stops a wrong
  // password being answered out of it — but the binding must not be cheap to
  // attack. An unsalted SHA-256 of the master password in renderer memory threw
  // back exactly what PBKDF2 was bought to prevent, and made the
  // non-extractable CryptoKey beside it pointless.
  assert.ok(
    VAULT_TAG_ITERATIONS >= 100_000,
    `VAULT_TAG_ITERATIONS=${VAULT_TAG_ITERATIONS} is too low to count as slow`,
  );
  assert.ok(
    VAULT_TAG_ITERATIONS < PBKDF2_ITERATIONS,
    "the tag is matched on every cache hit; matching it to the key's cost " +
      "would double unlock time for no extra protection",
  );

  const salt = randomSaltB64();
  const tag = await deriveVaultTag("correct-horse", salt);
  assert.equal(
    await deriveVaultTag("correct-horse", salt),
    tag,
    "stable for the same password and salt, so a cache hit compares equal",
  );
  assert.notEqual(
    await deriveVaultTag("wrong-password", salt),
    tag,
    "a different password must not match",
  );
  assert.notEqual(
    await deriveVaultTag("correct-horse", randomSaltB64()),
    tag,
    "derived per item, so two items under one password share no tag",
  );
  assert.match(tag, /^[A-Za-z0-9+/]+=*$/, "base64, as the cache stores it");
});

test("no password hash is left anywhere in the vault module (P3-19)", () => {
  // The regression guard: a future edit that reintroduces a fast hash of the
  // password would not fail any behavioural test, because the cache still
  // works either way. Comments are stripped first — this module discusses the
  // old function by name on purpose, and prose about it is not a call to it.
  const src = readFileSync(new URL("./vault.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(
    src,
    /sha256HexText|sha256HexBytes/,
    "the vault must not hash the password with a fast hash again",
  );
  assert.match(
    src,
    /deriveVaultTag/,
    "and must bind the cache with the slow tag",
  );
});
