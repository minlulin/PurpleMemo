// Android biometric unlock, from the app's side.
//
// The fingerprint/face prompt is a native surface, not the webview: only the
// Activity can host `BiometricPrompt`, and asking the OS is the whole point. On
// the Rust side that is `src-tauri/src/biometric.rs`, which reaches
// `BiometricBridge.kt`; this module is the two invoke sites and the vocabulary
// those commands answer with, so a caller names an outcome instead of matching
// bare strings across the IPC boundary.
//
// Nothing here unlocks anything. The database key is unwrapped at boot, before
// the lock screen exists, so a `success` is the same evidence a correct PIN
// entry is — the PIN remains the root unlock and the permanent fallback.
//
// These commands deliberately do NOT go through `src/data/driver.ts`: that file
// is the pinned 46-command surface (`ipc.test.ts`), and `android-biometric.test.ts`
// pins this pair instead — the same split the reminder commands use.

import { invoke } from "@tauri-apps/api/core";

/** What `BiometricManager` says this phone can do right now. */
export type BiometricStatus =
  | "available"
  | "none-enrolled"
  | "no-hardware"
  | "unavailable";

/** What one prompt did. `cancelled` covers the PIN escape and the system's close. */
export type BiometricOutcome =
  | "success"
  | "cancelled"
  | "failed"
  | "lockout"
  | "unavailable";

/** Whether an enrolled fingerprint/face could unlock the app right now. */
export async function biometricStatus(): Promise<BiometricStatus> {
  return await invoke<BiometricStatus>("biometric_status");
}

/**
 * Show the phone's prompt and report the outcome.
 *
 * Resolves only when the prompt is done — this can take as long as the person
 * standing in front of the phone, which is why the Rust command runs it off the
 * main thread.
 */
export async function biometricAuthenticate(): Promise<BiometricOutcome> {
  return await invoke<BiometricOutcome>("biometric_authenticate");
}
