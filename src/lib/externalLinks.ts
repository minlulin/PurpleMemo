// External links on the phone.
//
// The desktop app hands a URL to `plugin-opener`; that plugin is deliberately
// not registered on Android (docs/ANDROID_IPC_SURFACE.md finding #3), so the
// phone needs its own path: a Rust command that starts the matching system
// intent. The URL is checked on both sides of that boundary — here before
// anything is invoked, and again in Rust — because note text (and imported
// backups) can contain anything.
//
// The four schemes here are exactly the ones `routeLink` calls external, and
// the Rust validator and tests pin the same set. If one layer gains a scheme,
// the other must too: `externalLinks.test.ts` checks the two functions agree.

import { invoke } from "@tauri-apps/api/core";

/**
 * The schemes the system may be asked to handle: the browser for `http(s)`,
 * the dialer for `tel`, a mail client for `mailto`.
 */
const OPENABLE_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

/**
 * True when `value` is an absolute URL in one of the four offered schemes and
 * has a target (`tel:` and `mailto:` with nothing after the colon are not
 * links).
 *
 * Everything else — `javascript:`, `intent:`, `file:`, `content:`, a relative
 * string — is refused: this is the one place a note's link reaches another app.
 */
export function isOpenableUrl(value: string): boolean {
  if (value.trim() !== value || value.length === 0) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!OPENABLE_SCHEMES.has(url.protocol)) return false;
  // `new URL("tel:")` and `new URL("mailto:")` parse; neither names a target.
  return url.href.length > url.protocol.length;
}

/**
 * Ask Android to open `value` in the app registered for its scheme.
 *
 * Throws when the URL is not openable or when no app can handle it, so the
 * caller can say so instead of a tap that silently does nothing.
 */
export async function openExternalUrl(value: string): Promise<void> {
  if (!isOpenableUrl(value)) {
    throw new Error("refusing to open an unsupported link");
  }
  await invoke("open_external_url", { url: value });
}
