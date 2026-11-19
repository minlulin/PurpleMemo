import { strict as assert } from "node:assert";
import { test } from "node:test";
import { errText } from "./errors.ts";
import { setLocale } from "./i18n.ts";

/** A duck-typed MessageKeyError, the shape `isMessageKeyError` accepts. */
function keyed(
  messageKey: string,
  params: Record<string, string | number> = {},
): Error {
  const e = new Error("English baked in at throw time");
  (e as unknown as Record<string, unknown>).messageKey = messageKey;
  (e as unknown as Record<string, unknown>).params = params;
  return e;
}

test("errText: Errors, strings, and primitives render their own text", () => {
  assert.equal(errText(new Error("boom")), "boom");
  assert.equal(errText("a plain string refusal"), "a plain string refusal");
  assert.equal(errText(42), "42");
  assert.equal(errText(true), "true");
  assert.equal(errText(null), "null");
  assert.equal(errText(undefined), "undefined");
});

test("errText: a plain object never renders as [object Object] (J6)", () => {
  // Structured rejections from Tauri plugins carry `.message` or `.error`
  // on a plain object — not an Error, so `String(e)` used to be the literal
  // "[object Object]" in the error banner.
  assert.equal(
    errText({ message: "structured message" }),
    "structured message",
  );
  assert.equal(errText({ error: "plugin refusal" }), "plugin refusal");
  // Neither field: JSON is at least a shape a user or a bug report can read.
  assert.equal(errText({ code: 404 }), '{"code":404}');
  assert.equal(errText({}), "{}");
  // Circular structures cannot be stringified — the fallback stands in,
  // never "[object Object]" and never "".
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(errText(circular), "Something went wrong.");
});

test("errText: an empty or whitespace message still renders a banner (J6)", () => {
  // Pages render `{error ? <p className="alert-error">{error}</p> : null}`:
  // a "" here used to swallow the failure with no alert at all.
  assert.equal(errText(new Error("")), "Something went wrong.");
  assert.equal(errText(new Error("   ")), "Something went wrong.");
  assert.equal(errText(""), "Something went wrong.");
});

test("errText: a MessageKeyError renders in the locale active NOW (J6)", () => {
  // This is the guard the manual `isMessageKeyError(e) ? t(...) : errText(e)`
  // wrappers used to carry: the baked English message is bypassed, the key
  // is resolved per call, in whatever locale the banner is shown under.
  const e = keyed("common.tryAgain");
  try {
    setLocale("my");
    assert.equal(errText(e), "ထပ်စမ်းကြည့်မည်");
  } finally {
    setLocale("en");
  }
  assert.equal(
    errText(e),
    "Try again",
    "the same error, re-rendered in English",
  );
});

test("errText: a keyed refusal interpolates its params in the active locale", () => {
  const e = keyed("common.deleteWhat", { what: "Note" });
  assert.equal(errText(e), "Delete Note");
});

test("errText: a Rust refusal renders from the catalogue, not as an object (D7)", () => {
  // What Tauri hands back from `messages::Refusal`: a plain object, not an
  // Error — it used to reach the banner as `{"key":…}` JSON.
  const refusal = {
    key: "rust.error.photoTooLarge",
    params: { size: "30.0", limit: "25" },
  };
  assert.match(errText(refusal), /30\.0 MiB/);
  assert.match(errText(refusal), /up to 25 MiB/);
  try {
    setLocale("my");
    const burmese = errText(refusal);
    assert.notEqual(burmese, "[object Object]");
    assert.ok(burmese.includes("30.0"), "the params survive the switch");
  } finally {
    setLocale("en");
  }
});

test("errText: an unknown refusal key falls back to its detail, then itself", () => {
  // A newer Rust build against an older catalogue must still say something
  // useful: the failing layer's own words if it sent them, else the key.
  assert.equal(
    errText({
      key: "rust.error.notInThisBuild",
      params: { detail: "prepare failed: no such column: nope" },
    }),
    "prepare failed: no such column: nope",
  );
  assert.equal(
    errText({ key: "rust.error.notInThisBuild", params: {} }),
    "rust.error.notInThisBuild",
  );
  // A plain object with a `key` that is not ours is still JSON, not a refusal.
  assert.equal(
    errText({ key: "some-other-field" }),
    '{"key":"some-other-field"}',
  );
});
