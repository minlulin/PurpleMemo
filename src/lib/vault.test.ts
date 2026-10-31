// Vault repository security: a cached key never bypasses password
// validation, and changePassword is all-or-nothing.

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
import type { VaultItemRow } from "./types.ts";
import { createVaultRepo, WrongPasswordError } from "./vault.ts";

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

/** Rebuild the vault_items row from the addItem INSERT this driver recorded. */
function rowFromInsert(driver: MockDriver, id: number): VaultItemRow {
  const insert = driver.callsTo("execute")[0]?.args as [string, unknown[]];
  const params = insert[1] as unknown[];
  return {
    id,
    title: "email",
    ciphertext: params[1] as string,
    salt: params[2] as string,
    iv: params[3] as string,
    created_at: "2026-10-10",
    updated_at: "2026-10-10",
  };
}

test("getItem with a wrong password fails even when the key is cached", async () => {
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  const id = await vault.addItem("email", "s3cret", "correct-horse");
  const row = rowFromInsert(driver, id);

  // Correct password first: cache hit path, decrypts fine.
  driver.pushResults([[row]]);
  const got = await vault.getItem(id, "correct-horse");
  assert.equal(got?.plaintext, "s3cret");

  // Wrong password: cache miss (pwdHash differs) -> fresh (wrong) key ->
  // GCM auth failure. The cached key never bypasses validation.
  driver.pushResults([[row], [{ salt: row.salt }]]);
  await assert.rejects(vault.getItem(id, "wrong-password"));
});

test("changePassword with a wrong old password writes nothing", async () => {
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  const id = await vault.addItem("email", "s3cret", "correct-horse");
  const row = rowFromInsert(driver, id);
  driver.pushResults([[row], [{ salt: row.salt }]]);
  await assert.rejects(vault.changePassword("wrong-old", "new-pass"));
  assert.equal(driver.callsTo("batch").length, 0);
  assert.equal(
    driver
      .callsTo("execute")
      .filter((c) => /UPDATE vault_items/.test(c.args[0] as string)).length,
    0,
  );
});

test("changePassword migrates every item in one atomic batch", async () => {
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  const id = await vault.addItem("email", "s3cret", "old-pass");
  const row = rowFromInsert(driver, id);
  driver.pushResults([[row]]); // SELECT * FROM vault_items ORDER BY id
  await vault.changePassword("old-pass", "new-pass");

  const batches = driver.callsTo("batch");
  assert.equal(batches.length, 1);
  const statements = batches[0]?.args[0] as {
    sql: string;
    params: unknown[];
  }[];
  // One statement per item, plus the re-sealed verifier.
  assert.equal(statements.length, 2);
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
  const id = await vault.addItem("email", "s3cret", "old-pass");
  const row = rowFromInsert(driver, id);
  driver.pushResults([[row]]);
  await vault.changePassword("old-pass", "new-pass");

  const statements = driver.callsTo("batch")[0]?.args[0] as {
    sql: string;
    params: unknown[];
  }[];
  const seal = statements.at(-1);
  assert.ok(seal, "the verifier must be re-sealed");
  assert.equal((seal.params ?? [])[0], "vault_verify");
  assert.match(
    seal.sql,
    /ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value/,
    "a plain INSERT would violate the settings primary key",
  );
  // Same batch as the items: no window where the items have moved to the new
  // password but the verifier still expects the old one.
  assert.equal(statements.length, 2);
  assert.match(statements[0]?.sql ?? "", /UPDATE vault_items/);
});

test("changePassword leaves the verifier proving the new password", async () => {
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  const id = await vault.addItem("email", "s3cret", "old-pass");
  const row = rowFromInsert(driver, id);
  driver.pushResults([[row]]);
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

test("changePassword writes nothing when the batch fails", async () => {
  // `batchError` only fires on batch, so addItem (an execute) still works.
  const driver = createMockDriver({
    batchError: new Error("database is locked"),
  });
  const vault = createVaultRepo(driver);
  const id = await vault.addItem("email", "s3cret", "old-pass");
  const row = rowFromInsert(driver, id);
  driver.pushResults([[row]]);
  const err = await vault
    .changePassword("old-pass", "new-pass")
    .then(() => null)
    .catch((e: unknown) => e);
  // The second half of the UI told the user "wrong current password"
  // here, which was false — the write failed, the password was fine.
  assert.ok(
    !(err instanceof WrongPasswordError),
    "a write failure must not masquerade as a wrong password",
  );
  assert.match(String((err as Error).message), /database is locked/);
  assert.equal(driver.callsTo("execute").length, 1);
});

test("a wrong password is reported as WrongPasswordError, not a bare Error", async () => {
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  const id = await vault.addItem("email", "s3cret", "correct-horse");
  const row = rowFromInsert(driver, id);
  driver.pushResults([[row], [{ salt: row.salt }]]);
  await assert.rejects(
    () => vault.changePassword("wrong-old", "new-pass"),
    WrongPasswordError,
  );

  // And on the unlock path, so "wrong password" stays honest there too.
  driver.pushResults([[row], [{ salt: row.salt }]]);
  await assert.rejects(
    () => vault.getItem(id, "wrong-old"),
    WrongPasswordError,
  );
});

test("corrupt stored ciphertext is NOT reported as a wrong password", async () => {
  // A GCM tag mismatch is an OperationError and does mean "wrong password".
  // An undecodable field is corruption of the stored row — telling the user
  // they mistyped their password would send them looking in the wrong place.
  const driver = createMockDriver();
  const vault = createVaultRepo(driver);
  const id = await vault.addItem("email", "s3cret", "correct-horse");
  const row = rowFromInsert(driver, id);
  driver.pushResults([
    [{ ...row, ciphertext: "!!!not base64!!!" }],
    [{ salt: row.salt }],
  ]);
  const err = await vault
    .getItem(id, "correct-horse")
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
    const id = await vault.addItem("email", "s3cret", "correct-horse");
    const row = rowFromInsert(driver, id);
    driver.pushResults([[breakRow(row)], [{ salt: row.salt }]]);
    const err = await vault
      .getItem(id, "correct-horse")
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
test("setupVault writes the marker and the verifier in one batch", async () => {
  const driver = createMockDriver({ results: [[]] });
  const vault = createVaultRepo(driver);
  await vault.setupVault("correct-horse");

  const batches = driver.callsTo("batch");
  assert.equal(batches.length, 1, "one atomic batch, not two writes");
  const statements = batches[0]?.args[0] as BatchStatement[];
  const keys = statements.map((s) => (s.params ?? [])[0]);
  assert.deepEqual(keys, ["vault_setup", "vault_verify"]);
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
