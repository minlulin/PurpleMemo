// The i18n layer. These tests pin the properties that make
// partial localization safe: both catalogues cover the same keys with the same
// placeholders, plurals choose by count, and a forgotten key fails loudly in
// development while an installed build keeps working.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  DEFAULT_LOCALE,
  en,
  enPlurals,
  getLocale,
  interpolate,
  isLocale,
  isMessageKeyError,
  LOCALES,
  localeFromLanguageTag,
  type MessageKey,
  missingMessageKeys,
  my,
  myPlurals,
  placeholdersIn,
  setLocale,
  subscribeLocale,
  translateFor,
  translatePluralFor,
} from "./i18n.ts";

test("both catalogues cover exactly the same keys", () => {
  // The typing already requires `my` to be a Record of every English key. This
  // is the runtime half: a stray extra key would still be a translation nobody
  // can reach, and a gap would be a blank control in Burmese.
  assert.deepEqual(missingMessageKeys("my"), []);
  assert.deepEqual(Object.keys(my).sort(), Object.keys(en).sort());
  assert.deepEqual(missingMessageKeys("en"), []);
});

test("placeholders match between the two languages", () => {
  // A translator who drops `{count}` turns a sentence into a dead end; one who
  // invents `{name}` renders the braces. Both are caught here, per key.
  for (const key of Object.keys(en) as MessageKey[]) {
    assert.deepEqual(
      placeholdersIn(my[key]),
      placeholdersIn(en[key]),
      `placeholder mismatch for ${key}`,
    );
  }
  for (const key of Object.keys(enPlurals) as (keyof typeof enPlurals)[]) {
    assert.deepEqual(
      placeholdersIn(myPlurals[key].one),
      placeholdersIn(enPlurals[key].one),
      `plural placeholder mismatch for ${key}`,
    );
    assert.deepEqual(
      placeholdersIn(myPlurals[key].other),
      placeholdersIn(enPlurals[key].other),
      `plural placeholder mismatch for ${key}`,
    );
  }
});

test("interpolation fills known slots and preserves unknown ones", () => {
  assert.equal(interpolate("Delete {what}", { what: "note" }), "Delete note");
  assert.equal(
    interpolate("{count} of {total}", { count: 2, total: 5 }),
    "2 of 5",
  );
  // An unknown slot stays visible rather than becoming "undefined".
  assert.equal(interpolate("Hi {name}", {}), "Hi {name}");
});

test("plural forms are chosen by the count", () => {
  const key = "session.remindersDue";
  assert.equal(
    translatePluralFor("en", key, 1),
    "1 reminder is due — open Purple Memo.",
  );
  assert.equal(
    translatePluralFor("en", key, 2),
    "2 reminders are due — open Purple Memo.",
  );
  // Zero is the plural in English, and Burmese does not inflect at all.
  assert.match(translatePluralFor("en", key, 0), /reminders/);
  // Burmese has no singular/plural inflection; only the filled count changes.
  assert.match(translatePluralFor("my", key, 1), /^သတိပေးချက် 1 ခု/);
  assert.match(translatePluralFor("my", key, 2), /^သတိပေးချက် 2 ခု/);
});

test("a missing key throws in development and returns the key in release", () => {
  const missing = "test.not-a-key" as MessageKey;
  assert.throws(
    () => translateFor("en", missing, {}, "development"),
    /Missing message key/,
  );
  assert.equal(translateFor("en", missing, {}, "production"), missing);
  assert.equal(translateFor("my", missing, {}, "production"), missing);
});

test("a missing Burmese message falls back to English in release", () => {
  // The release contract: an untranslated string is readable, never blank. The
  // key is removed and restored so the catalogue itself stays complete.
  const saved = my["common.cancel"];
  delete (my as Partial<Record<MessageKey, string>>)["common.cancel"];
  try {
    assert.equal(translateFor("my", "common.cancel"), "Cancel");
    assert.throws(
      () => translateFor("my", "common.cancel", {}, "development"),
      /Missing message key/,
    );
  } finally {
    my["common.cancel"] = saved;
  }
});

test("only Burmese language tags select Burmese", () => {
  assert.equal(localeFromLanguageTag("my"), "my");
  assert.equal(localeFromLanguageTag("my-MM"), "my");
  assert.equal(localeFromLanguageTag("MY-mm"), "my");
  assert.equal(localeFromLanguageTag("en-GB"), "en");
  assert.equal(localeFromLanguageTag("ja-JP"), DEFAULT_LOCALE);
  assert.equal(localeFromLanguageTag(undefined), DEFAULT_LOCALE);
  assert.equal(isLocale("en"), true);
  assert.equal(isLocale("my"), true);
  assert.equal(isLocale("fr"), false);
  assert.equal(isLocale(undefined), false);
  assert.deepEqual([...LOCALES], ["en", "my"]);
});

test("switching locale notifies subscribed components exactly once", () => {
  const seen: string[] = [];
  const unsubscribe = subscribeLocale(() => seen.push(getLocale()));
  try {
    setLocale("my");
    assert.equal(getLocale(), "my");
    // Setting the same locale again is not a change.
    setLocale("my");
    assert.deepEqual(seen, ["my"]);
  } finally {
    unsubscribe();
    setLocale("en");
  }
});

test("the import refusals and row reasons have Burmese text", () => {
  // Presence is checked by the catalogue test; this catches an English copy
  // pasted into the Burmese side of the import feature.
  const keys: MessageKey[] = [
    "import.savingTemplate",
    "import.saveTemplateTitle",
    "import.csvFilter",
    "import.templateSaved",
    "import.error.tooLarge",
    "import.error.tooManyRows",
    "import.error.missingColumn",
    "import.error.missingColumns",
    "import.reason.titleRequired",
    "import.reason.dueDate",
    "import.reason.done",
    "import.reason.repeat",
    "import.reason.nameRequired",
    "import.reason.birthday",
  ];
  for (const key of keys) {
    assert.notEqual(translateFor("my", key), translateFor("en", key), key);
  }
});

test("a key-carrying error is recognized and a plain Error is not", () => {
  const keyed = Object.assign(new Error("keyed"), {
    messageKey: "import.reason.done",
    params: {},
  });
  assert.equal(isMessageKeyError(keyed), true);
  assert.equal(isMessageKeyError(new Error("plain")), false);
  assert.equal(isMessageKeyError("not an error"), false);
});
