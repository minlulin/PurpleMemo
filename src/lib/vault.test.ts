// Vault repository security (§5.3): a cached key never bypasses password
// validation, and changePassword is all-or-nothing.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { MockDriver } from "../data/mock-driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import type { VaultItemRow } from "./types.ts";
import { createVaultRepo } from "./vault.ts";

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
  assert.equal(statements.length, 1);
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

test("setupVault refuses a second setup — the marker is written once", async () => {
  const driver = createMockDriver({
    results: [[{ key: "vault_setup" }]], // isSetUp: marker already present
  });
  const vault = createVaultRepo(driver);
  await assert.rejects(vault.setupVault("any-pass"), /already set up/);
  assert.equal(driver.callsTo("execute").length, 0);
});

// Pre-release audit: with no items yet there was nothing to decrypt, so
// unlock() trusted any password. A user who set the vault up, added nothing,
// and then typed a different password was told "unlocked" — and their first
// secret became encrypted under a password they do not believe they used.
test("setupVault stores a password verifier so the password is proven immediately", async () => {
  const driver = createMockDriver({ results: [[]] }); // isSetUp: no marker
  const vault = createVaultRepo(driver);
  await vault.setupVault("correct-horse");
  const writes = driver
    .callsTo("execute")
    .map((c) => c.args as [string, unknown[]]);
  const verifier = writes.find(([, params]) => params[0] === "vault_verify");
  assert.ok(verifier, "a verifier must be written at setup");
  // Same shape as a vault item: salt + iv + ciphertext, never the password.
  const stored = JSON.parse(verifier[1][1] as string) as {
    salt: string;
    iv: string;
    ciphertext: string;
  };
  assert.ok(stored.salt && stored.iv && stored.ciphertext);
  assert.ok(!JSON.stringify(stored).includes("correct-horse"));
});

test("unlock with no items still verifies the stored verifier, rejecting a wrong password", async () => {
  // The verifier was written by a real setup run below, then replayed here.
  const driver = createMockDriver({ results: [[]] });
  const vault = createVaultRepo(driver);
  await vault.setupVault("correct-horse");
  const writes = driver
    .callsTo("execute")
    .map((c) => c.args as [string, unknown[]]);
  const verifierRaw = writes.find(
    ([, p]) => p[0] === "vault_verify",
  )?.[1][1] as string;
  assert.ok(verifierRaw.includes("ciphertext"), "verifier must be sealed");

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
    [{ key: "vault_setup" }], // settings: setup marker -> must throw
  ]);
  const badVault = createVaultRepo(badDriver);
  await assert.rejects(() => badVault.unlock("not-the-password"), /password/i);
});

test("listItems never selects ciphertext, salt or iv (§5.3)", async () => {
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
