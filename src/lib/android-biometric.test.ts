// The biometric pair is a two-file contract like `ipc.test.ts` pins: the invoke
// sites here, the command registrations in Rust. TypeScript cannot check across
// that line, and a name that drifts only fails at runtime — on the phone, in the
// one screen that has to open the app.
//
// The pair deliberately sits OUTSIDE `driver.ts`, and therefore outside the
// 46-command pin there: the reminder commands are the same case. This file is
// the pin for these two, in both directions.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { biometricAuthenticate, biometricStatus } from "./android-biometric.ts";

const moduleSrc = readFileSync(
  new URL("./android-biometric.ts", import.meta.url),
  "utf8",
);
const driverSrc = readFileSync(
  new URL("../data/driver.ts", import.meta.url),
  "utf8",
);
const libSrc = readFileSync(
  new URL("../../src-tauri/src/lib.rs", import.meta.url),
  "utf8",
);

function invokedCommands(): string[] {
  return [...moduleSrc.matchAll(/invoke(?:<[^>]*>)?\(\s*"([a-z_]+)"/g)].map(
    (match) => match[1] ?? "",
  );
}

test("the module exposes both halves of the pair", () => {
  assert.equal(typeof biometricStatus, "function");
  assert.equal(typeof biometricAuthenticate, "function");
});

test("it invokes exactly the two biometric commands", () => {
  assert.deepEqual(invokedCommands().sort(), [
    "biometric_authenticate",
    "biometric_status",
  ]);
});

test("every invoked command is registered in lib.rs, and nothing else is", () => {
  const registered = [...libSrc.matchAll(/biometric::([a-z_]+),/g)].map(
    (match) => match[1] ?? "",
  );
  assert.deepEqual(
    [...new Set(registered)].sort(),
    [...new Set(invokedCommands())].sort(),
    "registered biometric commands and invoke sites must match exactly",
  );
});

test("the prompt's words are handed to the bridge with the call", () => {
  // The native bridge cannot read the encrypted settings row that holds the
  // app's language choice, so these two strings are the renderer's job. A
  // signature that dropped either would fall back to English on a Burmese
  // phone — and would still compile, because both sides are strings.
  assert.match(moduleSrc, /title:\s*text\.title/);
  assert.match(moduleSrc, /negativeButton:\s*text\.negativeButton/);
});

test("the pair stays out of the driver's pinned 46", () => {
  // Adding it to `driver.ts` would break `ipc.test.ts`'s count for the wrong
  // reason, and would put an Android-only surface in the shared driver. The
  // biometric module is the only way in.
  assert.doesNotMatch(
    driverSrc,
    /biometric/i,
    "driver.ts must not know about the biometric commands",
  );
});
