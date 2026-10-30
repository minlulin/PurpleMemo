// The IPC boundary is a two-file contract: `driver.ts` names the commands and
// headers, `src-tauri/src/commands.rs` + `lib.rs` implement and register them.
// TypeScript cannot check across that line, so a typo would only ever surface
// as a runtime error on a user's machine — these tests read both sides and pin
// them together (the same trick `contrast.test.ts` uses on the stylesheets).

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MAX_BACKUP_PHOTO_BYTES } from "../lib/backup.ts";
import {
  BACKUP_PATH_HEADER,
  createTauriDriver,
  EXPORT_PATH_HEADER,
  encodeHeaderPath,
  PHOTO_EXT_HEADER,
  PHOTO_LEASE_HEADER,
  PHOTO_SOURCE_HEADER,
} from "./driver.ts";

const driverSrc = readFileSync(new URL("./driver.ts", import.meta.url), "utf8");
const commandsSrc = readFileSync(
  new URL("../../src-tauri/src/commands.rs", import.meta.url),
  "utf8",
);
const libSrc = readFileSync(
  new URL("../../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);
const fileWriteSrc = readFileSync(
  new URL("../../src-tauri/src/file_write.rs", import.meta.url),
  "utf8",
);
const capabilitySrc = readFileSync(
  new URL("../../src-tauri/capabilities/default.json", import.meta.url),
  "utf8",
);

function invokedCommands(): string[] {
  return [...driverSrc.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)].map(
    (match) => match[1] ?? "",
  );
}

test("every command the driver invokes is registered in Rust", () => {
  const commands = invokedCommands();
  // The exact surface: 23 commands, plus `factory_reset` and
  // `app_restart`, plus the import-lease pair (`backup_import_begin` /
  // `backup_import_end`, E5) — 25. Bump deliberately, with the
  // change that adds the command — the count is what catches a command
  // dropped from BOTH sides at once.
  assert.equal(
    commands.length,
    25,
    `expected the full 25-command surface, got ${commands.length}`,
  );
  for (const command of commands) {
    assert.ok(
      libSrc.includes(`commands::${command},`),
      `${command} is invoked by the driver but never registered in lib.rs`,
    );
  }
  // And the reverse: nothing registered is unreachable from the driver, so the
  // surface cannot quietly grow past what the app actually calls.
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
  for (const header of [
    PHOTO_EXT_HEADER,
    PHOTO_SOURCE_HEADER,
    PHOTO_LEASE_HEADER,
  ]) {
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
  assert.ok(
    commandsSrc.includes(`const LEASE_HEADER: &str = "${PHOTO_LEASE_HEADER}"`),
    "LEASE_HEADER must stay in sync with driver.ts (E5)",
  );
});

test("photo header values are validated before Headers can coerce them (J2)", () => {
  // These two headers are the ones Rust reads RAW (`header_str`, no
  // percent-decoding), so unlike a path they cannot be percent-encoded — the
  // value must already be exactly what Rust should see. Fetch's `Headers`
  // would otherwise act first: it stringifies non-strings and strips
  // leading/trailing whitespace, which for Rust is a silently different
  // extension or a "missing header" error. The driver must validate and never
  // hand these headers a raw caller-supplied value.
  assert.match(
    driverSrc,
    /\[PHOTO_EXT_HEADER\]: extHeader/,
    "savePhoto must send the validated ext, not the raw argument",
  );
  assert.match(
    driverSrc,
    /\[PHOTO_SOURCE_HEADER\]: sourceHeader/,
    "savePhotoThumb must send the validated path, not the raw argument",
  );
  assert.doesNotMatch(
    driverSrc,
    /\[PHOTO_EXT_HEADER\]: ext,/,
    "the raw ext must never reach a header",
  );
  assert.doesNotMatch(
    driverSrc,
    /\[PHOTO_SOURCE_HEADER\]: sourceRelPath,/,
    "the raw source path must never reach a header",
  );

  // Parity with the Rust side, which is what makes the validation safe to
  // apply here: Rust must accept everything this accepts (it lowercases and
  // checks the same 1..=8 alphanumeric rule) and nothing that it would refuse.
  const photosSrc = readFileSync(
    new URL("../../src-tauri/src/photos.rs", import.meta.url),
    "utf8",
  );
  assert.match(
    photosSrc,
    /\(1\.\.=8\)\.contains\(&ext\.len\(\)\) && ext\.bytes\(\)\.all\(\|b\| b\.is_ascii_alphanumeric\(\)\)/,
    "Rust's is_valid_ext must keep the shape driver.ts mirrors",
  );
  assert.match(
    driverSrc,
    /\/\^\[A-Za-z0-9\]\{1,8\}\$\/\.test\(ext\)/,
    "the TS ext check must stay the mirror of Rust's is_valid_ext",
  );
  assert.match(
    driverSrc,
    /return ext\.toLowerCase\(\)/,
    "the ext must be lowercased here, like Rust's save_photo does",
  );

  // Behavioural: validation throws before any IPC, so this rejects without a
  // Tauri runtime — which is exactly the point. `Headers` would have trimmed
  // "jpg " to "jpg" and the write would have "succeeded" under the wrong name.
  const driver = createTauriDriver();
  assert.equal(typeof driver.savePhoto, "function");
  assert.rejects(
    () => driver.savePhoto(new Uint8Array([1]), "jpg "),
    /invalid photo extension/,
    "a whitespace-padded ext must be refused, not trimmed",
  );
  assert.rejects(
    () => driver.savePhoto(new Uint8Array([1]), "jpeg.webp"),
    /invalid photo extension/,
    "a multi-dot ext must be refused",
  );
  assert.rejects(
    () => driver.savePhoto(new Uint8Array([1]), 42 as unknown as string),
    /invalid photo extension/,
    "a non-string ext must be refused, not stringified",
  );
  // Leading/trailing whitespace in the SOURCE path is the exact case `Headers`
  // would strip silently; Rust would then fail its path grammar with a generic
  // error far from the caller's mistake.
  assert.rejects(
    () => driver.savePhotoThumb(" photos/2026/10/a.jpg", new Uint8Array([1])),
    /invalid photo source path/,
    "a whitespace-padded source path must be refused, not trimmed",
  );
  assert.rejects(
    () => driver.savePhotoThumb("photos/2026/10/a.jpg ", new Uint8Array([1])),
    /invalid photo source path/,
    "trailing whitespace must be refused too",
  );
});

test("the save-time photo limit is the importer's per-photo limit (E6)", () => {
  // A photo accepted by `photo_save` must be one `parseBackupZip` accepts on
  // restore — two constants in two languages are exactly how the app ends up
  // writing backups it refuses to read back.
  const rust = /MAX_SAVED_PHOTO_BYTES: u64 = (\d+) \* 1024 \* 1024/.exec(
    commandsSrc,
  );
  assert.ok(rust, "commands.rs must declare MAX_SAVED_PHOTO_BYTES (E6)");
  assert.equal(
    Number(rust[1]) * 1024 * 1024,
    MAX_BACKUP_PHOTO_BYTES,
    "the Rust save-time limit must equal the importer's per-photo limit",
  );
  assert.ok(
    commandsSrc.includes("bytes.len() as u64 > MAX_SAVED_PHOTO_BYTES"),
    "photo_save must actually enforce the limit before writing",
  );
});

test("the gallery picker refuses an oversized file before reading it (I2)", () => {
  // E6's refusal lives in Rust, *after* the request body has been read out of
  // the file and copied through IPC — so the renderer used to materialise an
  // arbitrarily large pick in full just to be told no. The `File` knows its
  // own size, so the same ceiling must be applied before `arrayBuffer()`.
  const galleryPageSrc = readFileSync(
    new URL("../pages/GalleryPage.tsx", import.meta.url),
    "utf8",
  );
  const start = galleryPageSrc.indexOf("const pickFiles = ");
  assert.notEqual(start, -1, "pickFiles not found — renamed or removed?");
  const body = galleryPageSrc.slice(start);
  const preflight = body.indexOf("assertPickablePhotoSize(file.size)");
  const read = body.indexOf("file.arrayBuffer()");
  assert.ok(preflight > -1, "pickFiles must check the file's own size first");
  assert.ok(read > -1, "pickFiles still reads the file afterwards");
  assert.ok(
    preflight < read,
    "the size must be checked before the file is read (I2)",
  );

  // And the ceiling it applies is the imported constant, not a second copy of
  // the number that could drift away from Rust's.
  const gallerySrc = readFileSync(
    new URL("../lib/gallery.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    gallerySrc,
    /import \{ MAX_BACKUP_PHOTO_BYTES \} from "\.\/backup\.ts"/,
    "gallery.ts must import the shared limit (E6's parity constant)",
  );
  assert.doesNotMatch(
    gallerySrc,
    /25 \* 1024 \* 1024/,
    "gallery.ts must not restate the 25 MiB figure",
  );
});

test("photo reads answer with raw bytes rather than a JSON byte array", () => {
  // The byte contract: `Vec<u8>` would serialize as a JSON number array; a
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
  // These commands are `async` + `spawn_blocking`, so the
  // pin allows the async form; the `request: Request` parameter is what
  // makes the raw-body contract hold either way.
  for (const command of [
    "photo_save",
    "photo_save_thumb",
    "backup_save_file",
    "export_save_file",
  ]) {
    assert.match(
      commandsSrc,
      new RegExp(
        `pub (async )?fn ${command}\\([\\s\\S]{0,240}request: Request`,
      ),
      `${command} must take a raw request body`,
    );
  }
});

test("the webview is granted no filesystem permission", () => {
  // The backup export used `writeFile` from
  // `@tauri-apps/plugin-fs`, which needed `fs:write-files` — a permission set
  // covering every write command on every path, with no accessible-path scope
  // configured anywhere, so every call failed AND the webview could have
  // written anywhere the process could. Rust does the write now; nothing needs
  // the permission, so it must not be re-granted.
  const permissions: unknown = JSON.parse(capabilitySrc).permissions;
  assert.ok(
    Array.isArray(permissions),
    "capability permissions must be a list",
  );
  for (const permission of permissions) {
    assert.ok(
      typeof permission !== "string" || !permission.startsWith("fs:"),
      `the webview must not hold ${permission} — Rust performs the backup write`,
    );
  }
  assert.ok(
    !libSrc.includes("tauri_plugin_fs::init"),
    "the fs plugin must not be registered",
  );
  assert.ok(
    !driverSrc.includes("@tauri-apps/plugin-fs"),
    "the driver must not use the fs plugin",
  );
  assert.ok(
    !/tauri-plugin-fs/.test(
      readFileSync(
        new URL("../../src-tauri/Cargo.toml", import.meta.url),
        "utf8",
      ),
    ),
    "the fs plugin crate must not be a dependency",
  );
});

test("the backup destination travels as one ASCII header on both sides", () => {
  // The backup body is raw, so the path has no argument channel and rides in a
  // header — which must be ASCII, while a user-chosen path need not be. The
  // encoder lives here and the decoder in Rust, so both halves are pinned:
  // Rust's test module carries the same encoder as a reference for the paths
  // that occur, and `header_paths_round_trip` decodes what this produces.
  assert.match(
    commandsSrc,
    /header_str\(&request, file_write::BACKUP_PATH_HEADER\)/,
    "backup_save_file must read the destination from the shared header name",
  );
  assert.ok(
    fileWriteSrc.includes(
      `pub const BACKUP_PATH_HEADER: &str = "${BACKUP_PATH_HEADER}"`,
    ),
    "BACKUP_PATH_HEADER must match driver.ts",
  );
  assert.match(
    fileWriteSrc,
    /pub fn decode_header_path\(encoded: &str\) -> Result<String, String>/,
    "the percent decoder must exist",
  );
  assert.match(
    driverSrc,
    /saveBackupFile: \(path, bytes\) =>\s*invoke\("backup_save_file", bytes, \{\s*headers: \{ \[BACKUP_PATH_HEADER\]: encodeHeaderPath\(path\) \}/,
    "the driver must send the encoded path with the raw bytes",
  );
});

test("exports use their own raw command and destination header", () => {
  assert.match(
    commandsSrc,
    /header_str\(&request, file_write::EXPORT_PATH_HEADER\)/,
    "export_save_file must read the destination from its own header",
  );
  assert.ok(
    fileWriteSrc.includes(
      `pub const EXPORT_PATH_HEADER: &str = "${EXPORT_PATH_HEADER}"`,
    ),
    "EXPORT_PATH_HEADER must match driver.ts",
  );
  assert.match(
    driverSrc,
    /saveExportFile: \(path, bytes\) =>\s*invoke\("export_save_file", bytes, \{\s*headers: \{ \[EXPORT_PATH_HEADER\]: encodeHeaderPath\(path\) \}/,
    "the driver must send the encoded path with the raw export bytes",
  );
  assert.match(
    fileWriteSrc,
    /pub fn save_export_file\(path: &Path, bytes: &\[u8\]\)/,
    "the export write must use the shared atomic file writer",
  );
});

test("encoded header paths are ASCII and reversible", () => {
  // The property Rust's `header_paths_round_trip` depends on: anything the
  // encoder emits survives a header, and nothing but an escape changes.
  for (const path of [
    "C:\\Users\\purple\\backups\\backup.zip",
    "C:\\Program Files\\Purple Memo\\a b.zip",
    "/home/purple/backups/backup.zip",
    "C:\\Users\\小明\\备份\\purple-memo-backup.zip",
    "C:\\Users\\p\\100%-done.zip",
    "C:\\emoji-🙂\\backup.zip",
    // Spaces at the value's ends (J2): `Headers` strips leading/trailing
    // whitespace from a value, so only an escaped space arrives intact.
    "C:\\Users\\p\\ leading.zip",
    "C:\\Users\\p\\trailing .zip",
    " ",
  ]) {
    const encoded = encodeHeaderPath(path);
    // Rust's decoder relies on every input being byte-per-character.
    assert.equal(
      encoded.length,
      new TextEncoder().encode(encoded).length,
      `must be ASCII: ${encoded}`,
    );
    assert.doesNotMatch(encoded, /%(?![0-9A-F]{2})/, `bad escape: ${encoded}`);
    assert.equal(
      decodeHeaderPath(encoded),
      path,
      "the path must survive the round trip",
    );
    // And through the actual transport: what a receiver observes is the value
    // AFTER `Headers` normalization. An encoded value must come back
    // byte-for-byte — a raw space at either end would NOT, which is why the
    // encoder escapes `0x20` rather than passing it through.
    const wire = new Headers({ [BACKUP_PATH_HEADER]: encoded }).get(
      BACKUP_PATH_HEADER,
    );
    assert.equal(
      wire,
      encoded,
      "Headers must not alter what the encoder emitted",
    );
    assert.equal(
      decodeHeaderPath(wire ?? ""),
      path,
      "the path must survive encode -> Headers -> decode",
    );
  }
});

/** The Rust decoder, re-implemented here from the same rules. */
function decodeHeaderPath(encoded: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    if (encoded[i] === "%") {
      bytes.push(Number.parseInt(encoded.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(encoded.charCodeAt(i));
    }
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    new Uint8Array(bytes),
  );
}

test("the single-instance plugin is registered first", () => {
  // The plugin claims the instance lock while the builder is assembled, so a
  // second launch must be turned away before `setup` — and therefore before
  // `boot` reaches `load_or_mint_db_key`. Two copies booting at once could
  // each mint a different DB key, and the loser would overwrite the only
  // credential-store slot with one that cannot open the database.
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
  // The command used to be `db_key_export() -> String`, handing the
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

test("the LAN share cannot be started without a consent token", () => {
  // `share_start` used to be one bare call that bound 0.0.0.0 and
  // put a read-only view of the user's notes and balances on the network. Rust
  // now refuses it without a one-shot token from `share_arm`, and the token has
  // to travel as `consentToken` — camelCase, via the command's `rename_all`.
  assert.match(
    commandsSrc,
    /pub fn share_arm\(state: State<'_, ShareState>\) -> CmdResult<String>/,
    "share_arm must exist and issue a token",
  );
  assert.match(
    commandsSrc,
    /#\[tauri::command\(rename_all = "camelCase"\)\]\s*pub fn share_start\(state: State<'_, ShareState>, consent_token: String\)/,
    "share_start must take a snake_case arg exposed as consentToken",
  );
  assert.match(
    driverSrc,
    /shareArm: \(\) => invoke\("share_arm"\)/,
    "the driver must arm consent",
  );
  assert.match(
    driverSrc,
    /shareStart: \(consentToken\) =>\s*invoke\("share_start", \{ consentToken \}\)/,
    "share_start must receive the token",
  );
});

test("share_stop carries the lock flag, and only the lock path sets it (D2a)", () => {
  // The lock's stop is a different stop: it revokes an armed consent token
  // and supersedes one an in-flight `share_start` has already spent, so no
  // listener can bind behind the lock screen. An ordinary stop must NOT do
  // that — a Rust test pins that a token survives it — so the distinction has
  // to survive the IPC boundary intact, in both directions.
  assert.match(
    commandsSrc,
    /#\[tauri::command\(rename_all = "camelCase"\)\]\s*pub fn share_stop\(state: State<'_, ShareState>, for_lock: Option<bool>\)/,
    "share_stop must take for_lock and expose it camelCase",
  );
  assert.match(
    commandsSrc,
    /if for_lock\.unwrap_or\(false\)\s*\{\s*state\.stop_for_lock\(\)/,
    "the flag must reach ShareState::stop_for_lock, not be ignored",
  );
  assert.match(
    driverSrc,
    /shareStop: \(forLock\) => invoke\("share_stop", \{ forLock: forLock === true \}\)/,
    "the driver sends the flag the caller meant, through one invoke site",
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

test("tauri.conf.json CSP connect-src allows Tauri custom protocol IPC", () => {
  // `backup_save_file` and `photo_save` rely on raw body + custom header IPC,
  // which uses fetch() to Tauri's custom IPC protocol (http://ipc.localhost on
  // Windows, ipc:// on Linux/macOS). If connect-src blocks them, Tauri falls
  // back to window.ipc.postMessage which strips HTTP headers and breaks saves.
  const confSrc = readFileSync(
    new URL("../../src-tauri/tauri.conf.json", import.meta.url),
    "utf8",
  );
  assert.match(
    confSrc,
    /connect-src[^;]*\bipc:/,
    "connect-src must allow ipc: scheme for macOS/Linux custom protocol IPC",
  );
  assert.match(
    confSrc,
    /connect-src[^;]*\bhttp:\/\/ipc\.localhost/,
    "connect-src must allow http://ipc.localhost for Windows custom protocol IPC",
  );
});
