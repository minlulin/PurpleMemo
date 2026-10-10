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
