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
});

test("the pairing commands are registered and the window binds the LAN", () => {
  for (const name of [
    "pairing_local",
    "pairing_open",
    "pairing_close",
    "pairing_status",
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
