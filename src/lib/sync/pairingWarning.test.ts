/**
 * The line before Trust (F1 Task 2): the policy, the read behind its third
 * fact, and the card's wiring.
 *
 * The policy is pure, so the three cases the spec names — different identity
 * WITH data, an identity matching the pin, a phone with no data — are unit
 * tests here rather than DOM shapes: `node --test` cannot mount JSX and this
 * project has no React testing library, so the card's own half is pinned by
 * reading its source, the way `Toast.test.ts` and `mobilePairing.test.ts`
 * pin theirs.
 *
 * The read runs against the REAL baseline (`openBaselineStore()`), because
 * "this phone holds data" is precisely the claim a fresh install must fail:
 * `BASELINE_SQL` seeds five wallets and eleven categories into every new
 * database, so a count that counted them could never be zero.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { translateFor } from "../i18n.ts";
import { holdsLocalData, warnBeforeTrust } from "./pairingWarning.ts";
import { openBaselineStore } from "./testSchema.ts";

const PINNED = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OFFERED = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("the warning needs a different desktop AND data to keep", () => {
  const base = { pinnedDeviceIds: [PINNED], holdsLocalData: true };

  // The case the spec names: another desktop is offered, and this phone has
  // records that pairing would keep and merge.
  assert.equal(warnBeforeTrust({ ...base, offerDeviceId: OFFERED }), true);

  // Control 1: the offered identity IS the one already pinned — a re-pair
  // changes no identity, so there is nothing to warn about.
  assert.equal(warnBeforeTrust({ ...base, offerDeviceId: PINNED }), false);

  // Control 2: a different desktop, but nothing on this phone to keep — the
  // merge has no local side to speak of.
  assert.equal(
    warnBeforeTrust({ ...base, offerDeviceId: OFFERED, holdsLocalData: false }),
    false,
  );

  // A first pairing is not a DIFFERENT desktop: with no pin there is no
  // other identity to differ from, however much data this phone holds.
  assert.equal(
    warnBeforeTrust({
      offerDeviceId: OFFERED,
      pinnedDeviceIds: [],
      holdsLocalData: true,
    }),
    false,
  );

  // Nothing is being paired yet — no offer on screen, no line.
  assert.equal(
    warnBeforeTrust({
      offerDeviceId: null,
      pinnedDeviceIds: [PINNED],
      holdsLocalData: true,
    }),
    false,
  );
});

test("a fresh install holds no data; what the person adds does", async () => {
  const store = openBaselineStore();

  assert.equal(
    await holdsLocalData(store.driver),
    false,
    "the shipped seeds are not data — a fresh install must not warn",
  );

  // Preferences describe the installation (theme, locale, the app PIN); they
  // are not records a merge would carry, so they never count as data.
  store.db.exec("INSERT INTO settings (key, value) VALUES ('theme', 'dark')");
  assert.equal(await holdsLocalData(store.driver), false);

  // A sixth wallet, on top of the five `BASELINE_SQL` ships, IS the person's.
  store.db.exec(
    "INSERT INTO wallets (name, created_at) VALUES ('Mingalaba', '2026-11-16')",
  );
  assert.equal(await holdsLocalData(store.driver), true);
});

test("deleting the seeds leaves an empty phone, and one note fills it", async () => {
  const store = openBaselineStore();

  // Deletions stick: a phone that removed every seeded row holds nothing of
  // its own, and the count must say so instead of seeing the rows it used to
  // have.
  store.db.exec("DELETE FROM wallets");
  store.db.exec("DELETE FROM expense_categories");
  store.db.exec("DELETE FROM income_categories");
  assert.equal(await holdsLocalData(store.driver), false);

  // One record is enough — the seeds are still all there underneath it.
  store.db.exec(
    "INSERT INTO notes (title, content, created_at, updated_at) VALUES ('Keep me', '', '2026-11-16', '2026-11-16')",
  );
  assert.equal(await holdsLocalData(store.driver), true);
});

test("the card shows the line before Confirm, through the policy alone", () => {
  const card = readFileSync(
    new URL("../../components/MobilePairingCard.tsx", import.meta.url),
    "utf8",
  );

  // The third fact is read, not assumed, and the policy decides — the card
  // holds no comparison of its own.
  assert.match(card, /phoneHoldsLocalData\(\)/, "the data fact is read");
  assert.match(
    card,
    /const mergeWarning = warnBeforeTrust\(\{/,
    "the warning is the policy's answer, not an inline condition",
  );
  assert.match(card, /offerDeviceId: offerDesktopId/);
  assert.match(card, /pinnedDeviceIds: pins\.map\(\(row\) => row\.device_id\)/);

  // The line itself, guarded by that answer and worded in both languages
  // (the catalogue parity test proves the MY key exists).
  assert.match(card, /mergeWarning \?/);
  assert.match(card, /mobile\.settings\.pairMergeWarning/);
  assert.match(
    card,
    /className="alert alert-warn"/,
    "a warning line, not an error and not a new style",
  );

  // …and it is BEFORE the step it warns about: Confirm is where the desktop
  // gets trusted.
  const warning = card.indexOf("const mergeWarning = warnBeforeTrust({");
  const confirm = card.indexOf('t("mobile.settings.pairConfirm")');
  assert.notEqual(warning, -1, "the warning must be computed");
  assert.notEqual(confirm, -1, "the confirm step must still exist");
  assert.ok(
    warning < confirm,
    "the warning has to be seen before the person confirms",
  );
});

test("the line is written in English and in Burmese", () => {
  const en = translateFor("en", "mobile.settings.pairMergeWarning");
  const my = translateFor("my", "mobile.settings.pairMergeWarning");

  assert.notEqual(my, en, "the Burmese side must not be the English copy");
  assert.match(my, /[\u1000-\u109F]/u, "the Burmese side must be Burmese");
  // The escape hatch is named in both: a person has to be able to follow it.
  assert.match(en, /Settings → Reset Purple Memo/);
  assert.match(my, /Purple Memo/);
});
