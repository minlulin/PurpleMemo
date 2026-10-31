// Settings repository. This module had no test file, which
// mattered: `getJSON` collapses "no row" and "unparseable JSON" into a single
// null, and the lock shell's fail-closed rule depends on telling those apart.
// `getRaw` is the seam that preserves the difference, so both
// behaviours are pinned here.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createMockDriver } from "../data/mock-driver.ts";
import { createSettingsRepo, SETTING_KEYS } from "./settings.ts";

test("getRaw: undefined when the row does not exist", async () => {
  const driver = createMockDriver({ results: [[]] });
  const settings = createSettingsRepo(driver);
  assert.equal(await settings.getRaw(SETTING_KEYS.pinHash), undefined);
});

test("getRaw: the unparsed value when the row does exist", async () => {
  const driver = createMockDriver({ results: [[{ value: '{"a":1}' }]] });
  const settings = createSettingsRepo(driver);
  assert.equal(await settings.getRaw(SETTING_KEYS.pinHash), '{"a":1}');
});

test("getRaw: a corrupt value comes back intact rather than as null", async () => {
  // The whole point: `classifyPin` must be able to see that SOMETHING is
  // stored here, even though it cannot be parsed.
  const driver = createMockDriver({ results: [[{ value: "not json" }]] });
  const settings = createSettingsRepo(driver);
  const raw = await settings.getRaw(SETTING_KEYS.pinHash);
  assert.equal(raw, "not json");
});

test("getJSON: no row and unparseable JSON both read as null", async () => {
  // Documented, unchanged behaviour — and exactly why the lock shell must NOT
  // use getJSON for the PIN. Pinned so the difference cannot be "tidied away".
  const absent = createMockDriver({ results: [[]] });
  assert.equal(
    await createSettingsRepo(absent).getJSON(SETTING_KEYS.pinHash),
    null,
  );
  const corrupt = createMockDriver({ results: [[{ value: "not json" }]] });
  assert.equal(
    await createSettingsRepo(corrupt).getJSON(SETTING_KEYS.pinHash),
    null,
  );
});

test("setJSON upserts on the settings primary key", async () => {
  const driver = createMockDriver();
  await createSettingsRepo(driver).setJSON(SETTING_KEYS.theme, "light");
  const call = driver.lastCall();
  assert.ok(call, "setJSON must record an execute call");
  const [sql] = call.args as [string, unknown[]];
  // A plain INSERT would fail on the second write to the same key.
  assert.match(sql, /ON CONFLICT\(key\) DO UPDATE SET value = excluded\.value/);
});

test("setManyJSON writes every entry as one batch of upserts", async () => {
  const driver = createMockDriver();
  await createSettingsRepo(driver).setManyJSON([
    { key: SETTING_KEYS.pinHash, value: { salt: "s" } },
    { key: SETTING_KEYS.securityQuestion, value: "First pet?" },
  ]);
  const batches = driver.callsTo("batch");
  assert.equal(batches.length, 1);
  const statements = batches[0]?.args[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(statements.length, 2);
  for (const s of statements) {
    assert.match(s.sql, /ON CONFLICT\(key\) DO UPDATE/);
  }
});

test("the key export hands over a path and gets nothing back", async () => {
  // the repository used to *return* the plaintext key, which put
  // it in React state and let it onto the system clipboard. The save must be a
  // one-way trip — path in, nothing out.
  const driver = createMockDriver();
  const settings = createSettingsRepo(driver);
  const result = await settings.saveDatabaseKeyFile("/tmp/purple-memo-key.txt");
  assert.equal(result, undefined, "no key, and nothing else, comes back");
  const calls = driver.callsTo("saveDbKeyFile");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, ["/tmp/purple-memo-key.txt"]);
});

test("a failed key export surfaces the error and never a partial key", async () => {
  const driver = createMockDriver({
    error: new Error("no DB encryption key stored"),
  });
  await assert.rejects(
    () => createSettingsRepo(driver).saveDatabaseKeyFile("/tmp/k.txt"),
    /no DB encryption key stored/,
  );
});

// -- Notification previews --------------------------------

test("notification preview is OFF unless it was explicitly turned on", async () => {
  // A missing row is every install that predates the key: they must all land
  // on the safe default without a migration. Only a JSON `true` opts in —
  // not the string "true", not truthy junk in a corrupt row.
  const previewOf = async (rows: { value?: unknown }[]) => {
    const driver = createMockDriver({ results: [rows] });
    return createSettingsRepo(driver).getNotificationPreview();
  };
  assert.equal(await previewOf([]), false, "a missing row is the default");
  assert.equal(
    await previewOf([{ value: "not json" }]),
    false,
    "corrupt stays private",
  );
  assert.equal(await previewOf([{ value: "false" }]), false);
  assert.equal(await previewOf([{ value: "true" }]), true, "explicitly on");
  assert.equal(
    await previewOf([{ value: '"true"' }]),
    false,
    "only JSON true counts",
  );
});

test("setNotificationPreview writes the documented key", async () => {
  const driver = createMockDriver();
  await createSettingsRepo(driver).setNotificationPreview(true);
  const call = driver.lastCall();
  assert.ok(call);
  const [sql, params] = call.args as [string, unknown[]];
  assert.match(sql, /INSERT INTO settings \(key, value\)/);
  assert.deepEqual(params, [SETTING_KEYS.notificationPreview, "true"]);
});

// -- Close to tray ---------------------------------------------------------------

test("close-to-tray is ON unless it was explicitly turned off", async () => {
  // Inverted from the preview default: this flag guards "close keeps the
  // reminder poll running", so a missing row (every pre-toggle install), a
  // corrupt row and an unreadable row must all land on ON — a privacy-adjacent
  // default that needs a migration is not a default.
  const trayOf = async (rows: { value?: unknown }[]) => {
    const driver = createMockDriver({ results: [rows] });
    return createSettingsRepo(driver).getCloseToTray();
  };
  assert.equal(await trayOf([]), true, "a missing row is the default ON");
  assert.equal(await trayOf([{ value: "true" }]), true);
  assert.equal(await trayOf([{ value: "false" }]), false, "explicitly off");
  assert.equal(
    await trayOf([{ value: "not json" }]),
    true,
    "a corrupt row never makes close silently quit",
  );
  assert.equal(
    await trayOf([{ value: '"false"' }]),
    true,
    "only JSON false counts",
  );
});

test("setCloseToTray writes the documented key", async () => {
  const driver = createMockDriver();
  await createSettingsRepo(driver).setCloseToTray(false);
  const call = driver.lastCall();
  assert.ok(call);
  const [sql, params] = call.args as [string, unknown[]];
  assert.match(sql, /INSERT INTO settings \(key, value\)/);
  assert.deepEqual(params, [SETTING_KEYS.closeToTray, "false"]);
});

// -- Notes view preferences ---------------------------------------------------

test("the notes view mode defaults to split and is persisted by key", async () => {
  // Missing row (every pre-view-mode install) and corrupt row both land on
  // split — today's behaviour — without an error reaching the writer.
  const modeOf = async (rows: { value?: unknown }[]) => {
    const driver = createMockDriver({ results: [rows] });
    return createSettingsRepo(driver).getNotesViewMode();
  };
  assert.equal(await modeOf([]), "split", "a missing row is the default");
  assert.equal(await modeOf([{ value: "not json" }]), "split");
  assert.equal(await modeOf([{ value: '"read"' }]), "read");

  const driver = createMockDriver();
  await createSettingsRepo(driver).setNotesViewMode("read");
  const call = driver.lastCall();
  assert.ok(call);
  assert.deepEqual((call.args as [string, unknown[]])[1], [
    SETTING_KEYS.notesViewMode,
    '"read"',
  ]);
});

test("collections stay expanded unless collapse was stored explicitly", async () => {
  // Same shape as notification preview: only a JSON `true` collapses.
  const collapsedOf = async (rows: { value?: unknown }[]) => {
    const driver = createMockDriver({ results: [rows] });
    return createSettingsRepo(driver).getNotesCollectionsCollapsed();
  };
  assert.equal(await collapsedOf([]), false);
  assert.equal(await collapsedOf([{ value: "not json" }]), false);
  assert.equal(await collapsedOf([{ value: '"true"' }]), false);
  assert.equal(await collapsedOf([{ value: "true" }]), true);

  const driver = createMockDriver();
  await createSettingsRepo(driver).setNotesCollectionsCollapsed(true);
  const call = driver.lastCall();
  assert.ok(call);
  assert.deepEqual((call.args as [string, unknown[]])[1], [
    SETTING_KEYS.notesCollectionsCollapsed,
    "true",
  ]);
});

// -- Appearance / theme -------------------------------------------------------

test("getTheme: only dark and light pass through; every other JSON value is null", async () => {
  // `getJSON` happily parses `{}`, `true` and `"blue"`, and the shell's
  // fallback is nullish — so a parseable non-theme row used to reach
  // SettingsPage and get rendered as a React child, unmounting the app
  // root, while an unknown string bypassed the "dark" default. Validation
  // is the fix: absent, unreadable and non-theme values all normalise to
  // null, which is what the caller's `theme ?? "dark"` already expects.
  const themeOf = async (value: string | undefined) => {
    const rows = value === undefined ? [] : [{ value }];
    const driver = createMockDriver({ results: [rows] });
    return createSettingsRepo(driver).getTheme();
  };

  assert.equal(await themeOf('"dark"'), "dark", "dark passes through");
  assert.equal(await themeOf('"light"'), "light", "light passes through");
  assert.equal(await themeOf(undefined), null, "a missing row stays null");
  assert.equal(await themeOf("not json"), null, "unparseable stays null");
  assert.equal(await themeOf("{}"), null, "an object never reaches React");
  assert.equal(await themeOf("[]"), null, "an array never reaches React");
  assert.equal(await themeOf("true"), null, "a boolean never reaches React");
  assert.equal(await themeOf("false"), null, "…and neither does false");
  assert.equal(await themeOf('"blue"'), null, "an unknown string falls back");
  assert.equal(await themeOf('"DARK"'), null, "no case-insensitive leniency");
  assert.equal(await themeOf("42"), null, "a number falls back too");
});
