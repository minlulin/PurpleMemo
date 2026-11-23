// The decisions behind biometric unlock, kept out of the two screens that ask
// them.
//
// Three separate questions, all answerable without a DOM or a native call:
//
// * may the LOCK SCREEN offer the prompt at all (setting on + PIN set + the
//   phone says `available` + the plain locked stage);
// * why the SETTINGS toggle cannot be used, if it cannot;
// * what, if anything, one outcome says on screen (`cancelled` says nothing —
//   the user chose the PIN, which is always the point of the button).
//
// The rules live here so the screens stay wiring, and so a test can pin them
// without a phone. Nothing here unlocks anything: a `success` is the same
// evidence a correct PIN is, and the PIN remains the root unlock.

import type { BiometricOutcome, BiometricStatus } from "./android-biometric.ts";
import type { MessageKey } from "./i18n.ts";

/**
 * The lock screen's two stages. The prompt belongs to the PIN stage only: the
 * forgotten-PIN form replaces the PIN, so an unlock shortcut in front of it
 * would be a second, unaccounted way past the acknowledgement gate.
 */
export type BiometricStage = "pin" | "forgot";

/**
 * May the lock screen show the prompt?
 *
 * `status: null` is "not read yet", and it is deliberately false: the shortcut
 * appears when the phone has answered `available`, never on an assumption.
 * `pinSet` is checked separately from the setting because biometric augments
 * the PIN lock — it is not a lock of its own, so with no PIN stored there is
 * nothing for it to stand beside.
 */
export function biometricOffer(input: {
  enabled: boolean;
  pinSet: boolean;
  status: BiometricStatus | null;
  stage: BiometricStage;
}): boolean {
  return (
    input.enabled &&
    input.pinSet &&
    input.stage === "pin" &&
    input.status === "available"
  );
}

/** Why the Settings toggle is disabled, or `null` when it may be used. */
export type BiometricToggleBlock =
  | "none-enrolled"
  | "no-hardware"
  | "unavailable"
  | "no-pin";

/**
 * The first reason the toggle cannot be used.
 *
 * Order is deliberate, and it is what the tests pin: the phone's own answer
 * outranks the app's state, because "enrol a fingerprint" is the actionable
 * sentence on a phone that can do biometrics at all — and telling someone with
 * no sensor to set a PIN first would be advice that changes nothing. Only a
 * phone that says `available` is then asked whether the app has a PIN.
 */
export function biometricToggleBlock(input: {
  pinSet: boolean;
  status: BiometricStatus;
}): BiometricToggleBlock | null {
  if (input.status === "none-enrolled") return "none-enrolled";
  if (input.status === "no-hardware") return "no-hardware";
  if (input.status !== "available") return "unavailable";
  if (!input.pinSet) return "no-pin";
  return null;
}

/**
 * Every block's sentence. Typed as `MessageKey` so a reason without copy is a
 * compile error, and the suite resolves every key in both catalogues.
 */
export const BIOMETRIC_TOGGLE_REASON: Record<BiometricToggleBlock, MessageKey> =
  {
    "none-enrolled": "settings.biometric.reasonNoneEnrolled",
    "no-hardware": "settings.biometric.reasonNoHardware",
    unavailable: "settings.biometric.reasonUnavailable",
    "no-pin": "settings.biometric.setPinFirst",
  };

/**
 * What one outcome says on the lock screen — `null` for silence.
 *
 * `success` never reaches this map: it calls the same `onUnlock` a correct PIN
 * does, and the entry re-read behind it is unchanged. `cancelled` is silence on
 * purpose (D5): the user chose the PIN, and a message would punish that choice.
 * `unavailable` shares the `failed` line because both mean the same thing to
 * the person standing there: this did not work, the PIN still will.
 */
export const BIOMETRIC_OUTCOME_MESSAGE: Record<
  BiometricOutcome,
  MessageKey | null
> = {
  success: null,
  cancelled: null,
  lockout: "lock.biometric.lockout",
  failed: "lock.biometric.failed",
  unavailable: "lock.biometric.failed",
};
