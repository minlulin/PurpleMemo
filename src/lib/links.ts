// Link routing for rendered markdown. Notes and journal entries
// are markdown the user (or an imported backup) supplies, and react-markdown
// renders `[x](https://…)` as a real anchor — clicking one used to replace the
// app UI with a remote page inside the app window.
//
// The rule lives here, pure and tested, so both the component and its tests
// agree on it; the Rust side (`src-tauri/src/navigation.rs`) enforces the same
// boundary no matter who tries to navigate. Two independent layers, because a
// missed renderer path must not become a missed navigation.

/**
 * What a click on a rendered link may do:
 *
 * - `external` — a real URL for another program (`http`, `https`, `mailto`,
 *   `tel`). The app hands it to the system browser or mail client and never
 *   navigates itself. These are exactly the schemes the opener capability
 *   allows (`opener:allow-default-urls`), so a link the UI offers to open is a
 *   link Rust will actually open.
 * - `hash` — an in-document anchor (`#section`). The webview scrolls; it does
 *   not replace the app.
 * - `blocked` — everything else: relative paths (the app has no route for
 *   them), `javascript:`, `data:`, `file:`, `ftp:` and unknown schemes. A click
 *   does nothing at all.
 */
/** Normalize a rendered-markdown URL the way react-markdown's default
 *  transform does, but only for the schemes this app actually opens. Used as
 *  `urlTransform` on every `ReactMarkdown` so `tel:` survives (react-markdown's
 *  default allowlist omits it) while dangerous/relative handling is unchanged.
 */
export function markdownUrlTransform(value: string): string {
  const colon = value.indexOf(":");
  const questionMark = value.indexOf("?");
  const numberSign = value.indexOf("#");
  const slash = value.indexOf("/");
  // No protocol (relative or hash): leave untouched, the router decides.
  if (colon === -1) return value;
  if (slash !== -1 && colon > slash) return value;
  if (questionMark !== -1 && colon > questionMark) return value;
  if (numberSign !== -1 && colon > numberSign) return value;
  const scheme = value.slice(0, colon).toLowerCase();
  return ["http", "https", "mailto", "tel"].includes(scheme) ? value : "";
}

/** Alias for callers that prefer the react-markdown prop name. */
export const urlTransform = markdownUrlTransform;

export type LinkRoute = "external" | "hash" | "blocked";

/** The schemes the system can open on the app's behalf. */
const EXTERNAL_SCHEMES = new Set(["http:", "https:", "mailto:", "tel:"]);

export function routeLink(href: string | null | undefined): LinkRoute {
  const raw = (href ?? "").trim();
  if (raw.length === 0) return "blocked";
  if (raw.startsWith("#")) return "hash";
  let url: URL;
  try {
    // Absolute URLs only: a relative href (or one with no scheme) throws here
    // and is blocked, which is the point — a relative link would resolve
    // against the app's own origin and load something that is not the app.
    url = new URL(raw);
  } catch {
    return "blocked";
  }
  return EXTERNAL_SCHEMES.has(url.protocol) ? "external" : "blocked";
}

/** True when the route leaves the app for the system's default handler. */
export function opensExternally(route: LinkRoute): boolean {
  return route === "external";
}
