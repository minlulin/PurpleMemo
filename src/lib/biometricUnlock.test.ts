// The three rules the biometric screens share. Pure, so the phone's answers are
// the only thing a test has to supply — no prompt, no Settings row, no UI.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  BIOMETRIC_OUTCOME_MESSAGE,
  BIOMETRIC_TOGGLE_REASON,
  biometricOffer,
  biometricToggleBlock,
} from "./biometricUnlock.ts";
import { en } from "./i18n.ts";

const OFFER = {
  enabled: true,
  pinSet: true,
  status: "available",
  stage: "pin",
} as const;

test("the offer needs the setting, a PIN, an available phone and the PIN stage", () => {
  assert.equal(biometricOffer(OFFER), true);
  assert.equal(biometricOffer({ ...OFFER, enabled: false }), false);
  assert.equal(biometricOffer({ ...OFFER, pinSet: false }), false);
  assert.equal(biometricOffer({ ...OFFER, stage: "forgot" }), false);
  for (const status of [
    "none-enrolled",
    "no-hardware",
    "unavailable",
  ] as const) {
    assert.equal(biometricOffer({ ...OFFER, status }), false, status);
  }
  // Not read yet is not "available": the shortcut never appears on a guess.
  assert.equal(biometricOffer({ ...OFFER, status: null }), false);
});

test("the toggle's block names the phone's answer before the app's state", () => {
  // A phone that cannot do it says so, even when no PIN is set: "set a PIN
  // first" would be advice that changes nothing there.
  assert.equal(
    biometricToggleBlock({ pinSet: false, status: "none-enrolled" }),
    "none-enrolled",
  );
  assert.equal(
    biometricToggleBlock({ pinSet: true, status: "no-hardware" }),
    "no-hardware",
  );
  assert.equal(
    biometricToggleBlock({ pinSet: true, status: "unavailable" }),
    "unavailable",
  );
  // Only an available phone is then asked about the PIN it augments.
  assert.equal(
    biometricToggleBlock({ pinSet: false, status: "available" }),
    "no-pin",
  );
  assert.equal(
    biometricToggleBlock({ pinSet: true, status: "available" }),
    null,
  );
});

test("every block has a sentence in the catalogue", () => {
  for (const key of Object.values(BIOMETRIC_TOGGLE_REASON)) {
    assert.equal(typeof en[key], "string", key);
  }
});

test("only lockout and failure say anything; success and cancel are silent", () => {
  assert.equal(BIOMETRIC_OUTCOME_MESSAGE.success, null);
  assert.equal(BIOMETRIC_OUTCOME_MESSAGE.cancelled, null);
  assert.equal(BIOMETRIC_OUTCOME_MESSAGE.lockout, "lock.biometric.lockout");
  assert.equal(BIOMETRIC_OUTCOME_MESSAGE.failed, "lock.biometric.failed");
  // A missing sensor mid-session reads the same as any other non-result: this
  // did not work, the PIN still will.
  assert.equal(BIOMETRIC_OUTCOME_MESSAGE.unavailable, "lock.biometric.failed");
  for (const key of Object.values(BIOMETRIC_OUTCOME_MESSAGE)) {
    if (key !== null) assert.equal(typeof en[key], "string", key);
  }
});
