// The IPC boundary is a two-file contract: `driver.ts` names the commands and
// headers, `src-tauri/src/commands.rs` + `lib.rs` implement and register them.
// TypeScript cannot check across that line, so a typo would only ever surface
// as a runtime error on a user's machine — these tests read both sides and pin
// them together (the same trick `contrast.test.ts` uses on the stylesheets).

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PHOTO_EXT_HEADER, PHOTO_SOURCE_HEADER } from "./driver.ts";

const driverSrc = readFileSync(new URL("./driver.ts", import.meta.url), "utf8");
const commandsSrc = readFileSync(
  new URL("../../src-tauri/src/commands.rs", import.meta.url),
  "utf8",
);
const libSrc = readFileSync(
  new URL("../../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);

function invokedCommands(): string[] {
  return [...driverSrc.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)].map(
    (match) => match[1] ?? "",
  );
}

test("every command the driver invokes is registered in Rust", () => {
  const commands = invokedCommands();
  assert.ok(
    commands.length >= 14,
    `expected the full surface, got ${commands.length}`,
  );
  for (const command of commands) {
    assert.ok(
      libSrc.includes(`commands::${command},`),
      `${command} is invoked by the driver but never registered in lib.rs`,
    );
  }
  // And the reverse: nothing registered is unreachable from the driver, so the
  // surface cannot quietly grow past what the app actually calls (L-03).
  const registered = [...libSrc.matchAll(/commands::([a-z_]+),/g)].map(
    (match) => match[1] ?? "",
  );
  assert.deepEqual(
    [...new Set(registered)].sort(),
    [...new Set(commands)].sort(),
    "registered commands and driver commands must match exactly",
  );
});

test("the raw-photo headers are the same strings on both sides", () => {
  for (const header of [PHOTO_EXT_HEADER, PHOTO_SOURCE_HEADER]) {
    assert.ok(
      commandsSrc.includes(`"${header}"`),
      `commands.rs does not mention the ${header} header`,
    );
  }
  assert.ok(
    commandsSrc.includes(`const EXT_HEADER: &str = "${PHOTO_EXT_HEADER}"`),
    "EXT_HEADER must stay in sync with driver.ts",
  );
  assert.ok(
    commandsSrc.includes(
      `const SOURCE_HEADER: &str = "${PHOTO_SOURCE_HEADER}"`,
    ),
    "SOURCE_HEADER must stay in sync with driver.ts",
  );
});

test("photo reads answer with raw bytes rather than a JSON byte array", () => {
  // The M-02 contract: `Vec<u8>` would serialize as a JSON number array; a
  // `tauri::ipc::Response` arrives as an ArrayBuffer.
  for (const command of ["photo_read", "photo_read_thumb"]) {
    assert.match(
      commandsSrc,
      new RegExp(`pub fn ${command}\\([\\s\\S]{0,240}CmdResult<Response>`),
      `${command} must return tauri::ipc::Response`,
    );
  }
});

test("raw-payload commands take the bytes as the request body", () => {
  // A raw payload IS the whole request, so these commands must accept a
  // `tauri::ipc::Request` and read the metadata from headers instead.
  for (const command of ["photo_save", "photo_save_thumb"]) {
    assert.match(
      commandsSrc,
      new RegExp(`pub fn ${command}\\([\\s\\S]{0,240}request: Request`),
      `${command} must take a raw request body`,
    );
  }
});

test("the single-instance plugin is registered first", () => {
  // The plugin claims the instance lock while the builder is assembled, so a
  // second launch must be turned away before `setup` — and therefore before
  // `boot` reaches `load_or_mint_db_key`. Two copies booting at once could
  // each mint a different DB key, and the loser would overwrite the only
  // credential-store slot with one that cannot open the database (review C-4).
  const plugins = [...libSrc.matchAll(/\.plugin\(\s*([A-Za-z0-9_:]+)/g)].map(
    (match) => match[1] ?? "",
  );
  assert.ok(plugins.length > 0, "lib.rs must register plugins");
  assert.equal(
    plugins[0],
    "tauri_plugin_single_instance::init",
    "the single-instance plugin must be the FIRST one registered",
  );
});

test("the key export is one-way: a path goes out, nothing comes back", () => {
  // Review H-7. The command used to be `db_key_export() -> String`, handing the
  // plaintext master key to the renderer on every call; it lived in React state
  // and could be pushed onto the system clipboard, which outlives the app. Rust
  // now does the write, so the command takes a path and returns unit.
  assert.match(
    commandsSrc,
    /pub fn db_key_save\(path: String\) -> CmdResult<\(\)>/,
    "db_key_save must take a path and return nothing",
  );
  assert.ok(
    !commandsSrc.includes("db_key_export"),
    "db_key_export must be gone - it returned the plaintext key",
  );
  assert.ok(
    !/\bexportDbKey\s*[:(]/.test(driverSrc),
    "the driver must not have a way to read the key back",
  );
  // And the driver hands Rust a path, not a key it already holds.
  assert.match(
    driverSrc,
    /saveDbKeyFile: \(path\) => invoke\("db_key_save", \{ path \}\)/,
  );
});

test("the window label Rust focuses is the window Tauri actually creates", () => {
  // `focus_main_window` looks the window up by label. A rename in
  // tauri.conf.json would leave the second launch silently doing nothing —
  // exactly the kind of drift this file exists to catch.
  const confSrc = readFileSync(
    new URL("../../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  );
  const label = /"label"\s*:\s*"([^"]+)"/.exec(confSrc)?.[1];
  assert.ok(label, "tauri.conf.json must declare a main window label");
  assert.match(
    libSrc,
    new RegExp(`const MAIN_WINDOW_LABEL: &str = "${label}"`),
    `MAIN_WINDOW_LABEL must match tauri.conf.json ("${label}")`,
  );
});
