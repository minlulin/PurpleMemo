// Error text helper — single shared copy.
//
// Every feature page turns a caught value into a display string with the
// same helper; it was declared 14 times and inlined 13 more. The contract
// (J6): whatever was caught, the caller gets displayable, NON-EMPTY text —
// never "[object Object]", never a blank that a `{error ? <p>}` banner
// would render as nothing at all.

import { getLocale, isMessageKeyError, translate } from "./i18n.ts";

export function errText(e: unknown): string {
  // A keyed refusal names a key, not text: render it in the locale active
  // NOW, not the English `InboxError`/`LinkTargetGoneError` baked into
  // `message` at throw time. This is the guard the manual
  // `isMessageKeyError(e) ? t(...) : errText(e)` wrappers used to carry —
  // now every errText caller gets it (J6).
  if (isMessageKeyError(e)) {
    return translate(getLocale(), e.messageKey, e.params);
  }
  const text = describe(e);
  // An empty message must still render an alert: `{error ? …}` treats ""
  // as "no error" and silently swallows the failure (J6).
  return text.trim() === ""
    ? translate(getLocale(), "common.somethingWentWrong")
    : text;
}

/** The raw display text of a caught value, before the empty-text fallback. */
function describe(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (typeof e === "object" && e !== null) {
    // Structured rejections — `{ message }` / `{ error }` from Tauri
    // plugins and serialized cross-realm errors. `String(e)` here is the
    // literal "[object Object]" this helper exists to make unreachable.
    const record = e as Record<string, unknown>;
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
    try {
      // Last resort: some shape at least the user (or a bug report) can
      // read. Circular structures stringify not at all, hence the guard.
      return JSON.stringify(e) ?? "";
    } catch {
      return "";
    }
  }
  // Primitives (numbers, booleans, null, undefined, bigint): String() is
  // the honest rendering and is never "".
  return String(e);
}
