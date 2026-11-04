// External links on the phone.
//
// The desktop app hands a URL to `plugin-opener`; that plugin is deliberately
// not registered on Android (docs/ANDROID_IPC_SURFACE.md finding #3), so the
// phone needs its own path: a Rust command that starts the system browser with a
// VIEW intent. The URL is checked on both sides of that boundary — here before
// anything is invoked, and again in Rust — because note text (and imported
// backups) can contain anything.

import { invoke } from "@tauri-apps/api/core";

/** The only schemes the system browser may be asked to handle. */
const OPENABLE_SCHEMES = new Set(["http:", "https:"]);

/**
 * True when `value` is an absolute http(s) URL.
 *
 * Everything else — `javascript:`, `intent:`, `file:`, `content:`, a relative
 * string — is refused: this is the one place a note's link reaches another app.
 */
export function isOpenableUrl(value: string): boolean {
  if (value.trim() !== value || value.length === 0) return false;
  try {
    return OPENABLE_SCHEMES.has(new URL(value).protocol);
  } catch {
    return false;
  }
}

/**
 * Ask Android to open `value` in the system browser.
 *
 * Throws when the URL is not openable or when no app can handle it, so the
 * caller can say so instead of a tap that silently does nothing.
 */
export async function openExternalUrl(value: string): Promise<void> {
  if (!isOpenableUrl(value)) {
    throw new Error("refusing to open a non-http(s) link");
  }
  await invoke("open_external_url", { url: value });
}
