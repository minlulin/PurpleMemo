/**
 * The pairing IPC contract, pinned from the outside.
 *
 * One invoke site per command (so the driver stays the only place that names a
 * command), each command registered, and the local facts read in Rust rather
 * than accepted from the webview.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const driver = readFileSync(new URL("./driver.ts", import.meta.url), "utf8");
const commands = readFileSync(
  new URL("../../src-tauri/src/commands.rs", import.meta.url),
  "utf8",
);
const lib = readFileSync(
  new URL("../../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);

test("each pairing command is one invoke site with the documented argument", () => {
  assert.match(driver, /pairingLocal: \(\) => invoke\("pairing_local"\)/);
  assert.match(
    driver,
    /pairingOpen: \(input\) => invoke\("pairing_open", \{ input \}\)/,
  );
  assert.match(driver, /pairingClose: \(\) => invoke\("pairing_close"\)/);
  assert.match(driver, /pairingStatus: \(\) => invoke\("pairing_status"\)/);
  assert.match(
    driver,
    /pairingIdentityStatus: \(\) => invoke\("pairing_identity_status"\)/,
  );
  assert.match(
    driver,
    /pairingIdentityReplace: \(confirm\) =>\s*invoke\("pairing_identity_replace", \{ confirm \}\)/,
  );
});

/**
 * The phone's wire step is the same contract: one invoke site, registered in
 * Rust, and the two wire paths belong to the client rather than the webview.
 */
test("the phone's wire step is one invoke site and is registered", () => {
  assert.match(
    driver,
    /pairingPhonePair: \(input\) => invoke\("pairing_phone_pair", \{ input \}\)/,
  );
  assert.match(lib, /commands::pairing_phone_pair,/);
  assert.ok(
    !driver.includes("/pair/request"),
    "the webview must not name a wire path; the client is in Rust",
  );
});

/**
 * §8.4's pull is the same contract: one invoke site per message, registered in
 * Rust, and the pin — not the webview — supplies the key and the data line.
 */
test("the snapshot pull is three invoke sites and each is registered", () => {
  assert.match(
    driver,
    /pairingSnapshotRequest: \(input, batch\) =>\s*invoke\("pairing_snapshot_request", \{ input, batch \}\)/,
  );
  assert.match(
    driver,
    /pairingSnapshotApplied: \(input, batch\) =>\s*invoke\("pairing_snapshot_applied", \{ input, batch \}\)/,
  );
  assert.match(
    driver,
    /pairingSnapshotAdopted: \(input, rows, tombstones\) =>\s*invoke\("pairing_snapshot_adopted", \{ input, rows, tombstones \}\)/,
  );
  for (const name of [
    "pairing_snapshot_request",
    "pairing_snapshot_applied",
    "pairing_snapshot_adopted",
  ]) {
    assert.ok(lib.includes(`commands::${name}`), `${name} must be registered`);
  }
  // The caller names an address and a pinned device; it never names a key. The
  // key and the data line are read from `sync_peers` in Rust (§11.2).
  assert.match(
    driver,
    /export interface SnapshotPullInput \{\s*endpoint: string;\s*desktopDeviceId: string;\s*\}/,
  );
  assert.match(
    commands,
    /fn pinned_pull\(db_state: &AppState, device_id: &str\)/,
  );
  assert.match(
    commands,
    /SELECT pairing_id, public_key, generation FROM sync_peers/,
  );
  assert.ok(
    !driver.includes("/pair/snapshot"),
    "the webview must not name the snapshot path; the client is in Rust",
  );
});

/**
 * §11.2 (N2): a pairing identity that is gone must never be minted behind the
 * person's back. The replacement is a separate command, it refuses without an
 * explicit confirmation, and it deletes only the pairing slot.
 */
test("a replacement pairing identity needs an explicit confirmation", () => {
  assert.match(
    commands,
    /pub fn pairing_identity_replace\(\s*app: tauri::AppHandle,\s*confirm: bool,\s*\)/,
  );
  assert.match(commands, /if !confirm \{/);
  assert.match(commands, /pairing_key::replace_after_confirmation\(\)/);
  assert.match(
    commands,
    /pairing_key::load_or_mint\(history\)/,
    "the fail-closed load takes the pairing history",
  );
  const backing = readFileSync(
    new URL("../../src-tauri/src/pairing_key.rs", import.meta.url),
    "utf8",
  );
  assert.match(backing, /pub fn replace_after_confirmation\(\)/);
  assert.match(
    backing,
    /key_store::delete\(Slot::PairingIdentity\)/,
    "only the pairing slot is deleted — the database key stays",
  );
  assert.match(
    backing,
    /PairingHistory::Paired => \{\s*Err\(PairingKeyError::MissingWithPeers\(\s*missing_identity_message\(\)/,
  );
});

test("the pairing commands are registered and the window binds the LAN", () => {
  for (const name of [
    "pairing_local",
    "pairing_open",
    "pairing_close",
    "pairing_status",
    "pairing_identity_status",
    "pairing_identity_replace",
  ]) {
    assert.ok(lib.includes(`commands::${name}`), `${name} must be registered`);
  }
  assert.match(
    commands,
    /pub fn pairing_open\(\s*app: tauri::AppHandle,\s*input: PairingOpenInput,\s*\)/,
  );
  assert.match(commands, /listener\.start\("0\.0\.0\.0"/);
  // The device id, generation and schema come from the store, not the caller.
  assert.match(commands, /fn local_sync_facts\(/);
  assert.match(commands, /SELECT device_id, data_generation FROM sync_state/);
});

/**
 * §9.1's upload is the same contract: one invoke site per message, each
 * registered in Rust, the wire path named only by the Rust client, and the
 * desktop's take/outcome pair carrying no key material — the staged ops were
 * already opened by the listener.
 */
test("the upload is five invoke sites and each is registered", () => {
  assert.match(
    driver,
    /pairingUploadBatch: \(input, batch, total, ops\) =>\s*invoke\("pairing_upload_batch", \{ input, batch, total, ops \}\)/,
  );
  assert.match(
    driver,
    /pairingUploadCommit: \(input\) => invoke\("pairing_upload_commit", \{ input \}\)/,
  );
  assert.match(
    driver,
    /pairingUploadStatus: \(input\) => invoke\("pairing_upload_status", \{ input \}\)/,
  );
  assert.match(
    driver,
    /pairingUploadTake: \(\) => invoke\("pairing_upload_take"\)/,
  );
  assert.match(
    driver,
    /pairingUploadOutcome: \(input\) =>\s*invoke\("pairing_upload_outcome", \{ input \}\)/,
  );
  for (const name of [
    "pairing_upload_batch",
    "pairing_upload_commit",
    "pairing_upload_status",
    "pairing_upload_take",
    "pairing_upload_outcome",
  ]) {
    assert.ok(lib.includes(`commands::${name}`), `${name} must be registered`);
  }
  assert.ok(
    !driver.includes("/pair/upload"),
    "the webview must not name the upload path; the client is in Rust",
  );
});
