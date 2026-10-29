// Factory-reset policy gate.
//
// The engine in Rust is deliberately NOT gated — `factory_reset` runs for any
// caller. The acknowledgement gate lives entirely in this repository's
// frontend, so these source pins are the deliverable's proof, the same way
// `pages/import-guard.test.ts` pins the safety-copy ordering. Three rules:
//
//   1. `factoryReset()` is invoked from exactly one place — the guarded
//      Settings handler, behind BOTH the permanent-destruction checkbox and
//      the two-step ConfirmButton;
//   2. `appRestart()` appears only behind the complete-check: the success
//      screen, which renders solely when `shouldRestart` (complete: true) —
//      a blocked reset NEVER restarts (owner decision);
//   3. the shell holds the finished attempt in top-level state and the
//      terminal screen outranks every workspace stage while it does — with
//      the workspace's pollers, idle lock and shortcuts gated off behind it.
//      "Retry reset" deliberately drops the attempt and returns to Settings'
//      Danger zone (owner decision D1); it is not a second path to the
//      engine, and it is never a restart.
//
// `lib/reset.test.ts` pins the pure decisions; this file pins the wiring that
// `node --test` cannot mount.

import { strict as assert } from "node:assert";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

const SRC = new URL("./", import.meta.url);

function read(rel: string): string {
  return readFileSync(new URL(rel, SRC), "utf8");
}

const SETTINGS = read("pages/SettingsPage.tsx");
const SCREEN = read("components/ResetScreen.tsx");
const SHELL = read("App.tsx");

/**
 * Every `.ts`/`.tsx` file under `src/`, with comments stripped: the call-site
 * counts below must see code, not prose about the code — several files (this
 * one included) discuss `factoryReset()` in comments.
 *
 * Two exclusions, both on purpose:
 *   - `data/driver.ts` holds the definitions, whose declarations
 *     (`function factoryReset(): …`) also contain an empty-parens token;
 *   - `*.test.ts` files quote both names as strings and regexes, and are not
 *     UI code that could reach the engine.
 */
function sourceFiles(): { path: string; code: string }[] {
  const files = readdirSync(SRC, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".tsx"))
    .filter((f) => !f.endsWith(".test.ts"))
    .filter((f) => f.replaceAll("\\", "/") !== "data/driver.ts");
  return files.map((f) => {
    const raw = readFileSync(new URL(f, SRC), "utf8");
    const code = raw
      // Block comments first (balanced pairs), then line comments that are
      // preceded by code structure — never the `//` inside a URL string.
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(?<=^|[\s;{}])\/\/[^\n]*/gm, "");
    return { path: f.replaceAll("\\", "/"), code };
  });
}

/** The body of one handler, by brace matching (the import-guard approach). */
function handlerSource(src: string, name: string): string {
  const start = src.search(new RegExp(`const ${name} = (async )?\\(`));
  assert.notEqual(start, -1, `${name} not found — renamed or removed?`);
  const open = src.indexOf("{", start);
  assert.notEqual(open, -1, `${name} has no body`);
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`${name} body is not brace-balanced`);
}

test("factoryReset() is invoked from exactly one place in the app", () => {
  // The definition in the driver is `function factoryReset(): Promise<...>`
  // — no empty-parens call — so an empty-parens scan finds only CALLS.
  const callSites: string[] = [];
  for (const { path, code } of sourceFiles()) {
    if (/\bfactoryReset\(\)/.test(code)) callSites.push(path);
  }
  assert.deepEqual(
    callSites,
    ["pages/SettingsPage.tsx"],
    "the reset engine must be reachable only through the guarded Settings handler",
  );
});

test("the guarded handler checks the acknowledgement AND its busy ref", () => {
  const body = handlerSource(SETTINGS, "runFactoryReset");
  // Both gates, in order, before the engine is invoked:
  assert.match(body, /if \(resettingRef\.current\) return;/);
  assert.match(body, /if \(!resetAck\) return;/);
  const guard = body.indexOf("if (!resetAck) return;");
  const call = body.indexOf("await factoryReset()");
  assert.ok(
    guard !== -1 && guard < call,
    "the acknowledgement check must come before the engine runs",
  );
  // The double-submit guard is raised before the first await (the pinned
  // GUARDS shape lives in submit-guards.test.ts; the pairing is checked here
  // too, because a gate this important should not rely on one file).
  const raised = body.indexOf("setResetting(true)");
  assert.ok(
    raised !== -1 && raised < call,
    "busy state must be raised before the engine is invoked",
  );
  assert.match(
    body,
    /p\.onResetFinished\(resetAttemptFromOutcome\(await factoryReset\(\)\)\)/,
  );
});

test("a thrown reset is forwarded as an incomplete attempt, never swallowed", () => {
  const body = handlerSource(SETTINGS, "runFactoryReset");
  // The catch path hands a throw-shaped attempt to the shell — it must not
  // show success, and it must not rethrow into an unhandled rejection either.
  assert.match(
    body,
    /catch \(e\) \{[\s\S]*?p\.onResetFinished\(resetAttemptFromError\(errText\(e\)\)\);/,
  );
  assert.doesNotMatch(body, /throw\b/);
});

test("the engine is reached only through the two-step ConfirmButton", () => {
  // 1. The ConfirmButton renders it via onConfirm — the sanctioned entry...
  const button = SETTINGS.slice(
    SETTINGS.indexOf("<ConfirmButton"),
    SETTINGS.indexOf("</ConfirmButton>"),
  );
  assert.ok(button.length > 0, "the danger zone must render a ConfirmButton");
  assert.match(button, /onConfirm=\{runFactoryReset\}/);
  // 2. ...disabled until the acknowledgement is ticked, and while in flight.
  assert.match(
    button,
    /disabled=\{!resetAck \|\| resetting\}/,
    "the reset button must require the acknowledgement and disable while running",
  );
  // 3. No other wiring reaches the handler: a bare onClick would make the
  // two-step confirm cosmetic.
  assert.doesNotMatch(
    SETTINGS,
    /onClick=\{[^}]*runFactoryReset/,
    "runFactoryReset must not be reachable from a plain onClick",
  );
  // 4. The acknowledgement checkbox exists, unchecked by default in code
  // (state starts false in useState), and is disabled while running.
  assert.match(SETTINGS, /useState\(false\);\n {2}const \[resetting/);
  assert.match(
    SETTINGS,
    /type="checkbox"\s*\n\s*checked=\{resetAck\}\s*\n\s*disabled=\{resetting\}/,
  );
});

test("appRestart() appears only behind the complete-check", () => {
  const callSites: string[] = [];
  for (const { path, code } of sourceFiles()) {
    if (/\bappRestart\(\)/.test(code)) callSites.push(path);
  }
  assert.deepEqual(
    callSites,
    ["components/ResetScreen.tsx"],
    "no UI other than the success branch may restart the app",
  );
  // In the screen, the awaited call lives in a `restart` helper whose ONLY
  // caller is the Restart button inside the `done` branch — and `done` IS the
  // complete-check (`shouldRestart`, pinned against complete:true/false in
  // lib/reset.test.ts). The check is evaluated before either branch renders.
  const gate = SCREEN.indexOf("const done = shouldRestart(attempt);");
  const helper = SCREEN.indexOf("const restart = async () => {");
  const call = SCREEN.indexOf("await appRestart()");
  const branch = SCREEN.indexOf("{done ? (");
  const invoke = SCREEN.indexOf("onClick={() => void restart()}");
  assert.ok(
    gate !== -1 &&
      helper !== -1 &&
      call !== -1 &&
      branch !== -1 &&
      invoke !== -1,
  );
  assert.ok(
    gate < branch,
    "the complete-check must be evaluated before either branch renders",
  );
  assert.ok(
    helper < call,
    "the awaited appRestart must sit in the restart helper",
  );
  assert.ok(
    branch < invoke,
    "the Restart button must sit inside the done branch",
  );
  assert.equal(
    (SCREEN.match(/restart\(\)/g) ?? []).length,
    1,
    "the restart helper must have exactly one caller — the done-branch button",
  );
  // The incomplete branch offers Retry only — and retry is not a restart.
  const retryBranch = SCREEN.indexOf("onClick={onRetry}");
  assert.ok(
    retryBranch > call,
    "the Retry action must live in the other branch",
  );
  // Exactly one AWAITED call (the file header also names the function in
  // prose, which is why the scan is on the code shape, not the bare name).
  assert.equal(
    (SCREEN.match(/await appRestart\(\)/g) ?? []).length,
    1,
    "the success branch's helper is the only appRestart call in the screen",
  );
});

test("the shell holds the attempt in top-level state; the terminal screen outranks the workspace", () => {
  // Top-level state, not navigation state the user could reverse.
  assert.match(SHELL, /useState<ResetAttempt \| null>\(null\)/);
  // Through the shell's handler, not the raw setter: holding the attempt is
  // where the vault keys are dropped and the shell's modals closed (H3), and
  // where a throw is probed against the still-live database before it may be
  // terminal at all (H6).
  assert.match(SHELL, /onResetFinished=\{handleResetFinished\}/);
  // Rendered BEFORE the boot/lock stage branches, so while an attempt is held
  // no workspace screen can render — H3 gates the workspace off behind it.
  const screen = SHELL.indexOf("if (resetAttempt !== null)");
  const booting = SHELL.indexOf('if (stage === "booting")');
  assert.ok(screen !== -1 && booting !== -1 && screen < booting);
  // "Retry reset" drops the attempt and returns to Settings' Danger zone over
  // the (possibly closed) database — D1's decision, kept out of the result
  // screen so the ack + ConfirmButton gate stays single-sited — and it is not
  // a restart.
  assert.match(SHELL, /onRetry=\{retryReset\}/);
  const retry = handlerSource(SHELL, "retryReset");
  assert.match(
    retry,
    /setResetAttempt\(null\);\s*setPage\("settings"\);/,
    "the retry must drop the attempt and land on Settings' Danger zone",
  );
  assert.doesNotMatch(SHELL, /appRestart/);
});

test("a throw only reaches the terminal screen when the database is gone (H6)", () => {
  const body = handlerSource(SHELL, "handleResetFinished");
  // The probe runs first and only for a throw-shaped attempt: an engine
  // report always closed the database, while an abort where a read still
  // answers deleted and closed nothing (H6) — so evicting the user onto a
  // screen that claims a closed connection would be false, and its "close
  // Purple Memo" advice would hide the window to the tray instead of quitting.
  const gate = body.indexOf('attempt.kind === "ipc-error"');
  const probe = body.indexOf("await databaseStillOpen()");
  const hold = body.indexOf("setResetAttempt(attempt)");
  assert.notEqual(gate, -1, "the probe must be gated on a thrown attempt");
  assert.notEqual(
    probe,
    -1,
    "the shell must probe the database before holding the attempt",
  );
  assert.ok(gate < probe, "the kind check must come before the probe");
  assert.ok(
    probe < hold,
    "the attempt may only be held once the probe has failed",
  );
  // The session survives the abort: the vault lock sits on the other side of
  // the probe, so an abort that deleted nothing keeps its keys usable.
  assert.ok(
    body.indexOf("vaultRepo.lockVault()") > probe,
    "the vault may only be locked when the attempt is actually held",
  );
  // And every workspace effect keys off the held attempt for as long as one
  // is held (H3) — pollers, idle auto-lock and the global shortcuts.
  assert.match(
    SHELL,
    /const workspaceLive = unlocked && resetAttempt === null;/,
    "the workspace must be gated off while the terminal screen owns the window",
  );
});
