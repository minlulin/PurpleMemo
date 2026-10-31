import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { createMockDriver } from "../data/mock-driver.ts";
import {
  birthdayLabel,
  contactInitial,
  createContactsRepo,
  normalizeMonthDay,
  searchContacts,
  upcomingBirthday,
} from "./contacts.ts";
import { formatBirthday } from "./format.ts";
import type { ContactRow } from "./types.ts";

test("upcomingBirthday: within the window, same year", () => {
  assert.equal(upcomingBirthday("1990-10-20", "2026-10-10", 14), true);
  assert.equal(
    upcomingBirthday("1990-10-24", "2026-10-10", 14),
    true,
    "exactly 14 days",
  );
  assert.equal(
    upcomingBirthday("1990-10-25", "2026-10-10", 14),
    false,
    "15 days out",
  );
});

test("upcomingBirthday: today counts", () => {
  assert.equal(upcomingBirthday("1990-10-10", "2026-10-10", 14), true);
});

test("upcomingBirthday: already passed this year does not count", () => {
  assert.equal(upcomingBirthday("1990-10-01", "2026-10-10", 14), false);
});

test("upcomingBirthday: month-day birthdays (no year) match by MM-DD", () => {
  assert.equal(upcomingBirthday("10-20", "2026-10-10", 14), true);
  assert.equal(upcomingBirthday("10-01", "2026-10-10", 14), false);
});

test("upcomingBirthday: wraps the year boundary (Dec -> Jan)", () => {
  assert.equal(upcomingBirthday("1990-01-05", "2026-12-30", 14), true);
  assert.equal(upcomingBirthday("01-05", "2026-12-30", 14), true);
  assert.equal(upcomingBirthday("1990-02-01", "2026-12-30", 14), false);
});

test("upcomingBirthday: today counts as upcoming", () => {
  assert.equal(upcomingBirthday("1990-10-10", "2026-10-10", 14), true);
});

test("setPrimaryChannel rejects a channel from another contact", async () => {
  const driver = createMockDriver({
    results: [
      [
        /* no rows: wrong contact */
      ],
    ],
  });
  const contacts = createContactsRepo(driver);
  await assert.rejects(
    contacts.setPrimaryChannel(1, 99),
    /does not belong to contact/,
  );
  assert.equal(driver.callsTo("batch").length, 0);
});

test("setPrimaryChannel scopes both updates to the contact", async () => {
  const driver = createMockDriver({ results: [[{ id: 7 }]] });
  const contacts = createContactsRepo(driver);
  await contacts.setPrimaryChannel(1, 7);
  const batch = driver.callsTo("batch")[0]?.args[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(batch.length, 2);
  assert.match(batch[0]?.sql ?? "", /WHERE contact_id = \?/);
  assert.match(batch[1]?.sql ?? "", /WHERE id = \? AND contact_id = \?/);
});

test("addChannel: a non-primary add is one execute and answers with its rowid (J2)", async () => {
  const driver = createMockDriver();
  const contacts = createContactsRepo(driver);
  const id = await contacts.addChannel({
    contactId: 3,
    kind: "phone",
    value: "09123",
    isPrimary: false,
  });
  // The id must come from the SAME IPC that inserted the row: a second call
  // reading `last_insert_rowid()` could observe any other writer's insert —
  // that value is per-connection and moves on every insert (J2).
  const calls = driver.calls.map((call) => call.method);
  assert.deepEqual(
    calls,
    ["execute"],
    "exactly one IPC, with no read before or after it",
  );
  const args = driver.callsTo("execute")[0]?.args as [string, unknown[]];
  const [sql, params] = args;
  assert.match(sql, /INSERT INTO contact_channels/);
  // sort_order is computed inside the insert itself, so the add cannot race
  // another add that reads the same MAX first.
  assert.match(sql, /IFNULL\(MAX\(sort_order\), -1\) \+ 1/);
  assert.match(sql, /WHERE contact_id = \?/);
  assert.deepEqual(params, [3, "phone", "09123", 3]);
  // The mock's `execute` returns the row's rowid — that IS the answer now.
  assert.equal(id, 1);
});

test("addChannel: a primary add demotes and inserts in one batch, id read back contact-scoped (J2)", async () => {
  const driver = createMockDriver({ results: [[{ id: 12 }]] });
  const contacts = createContactsRepo(driver);
  const id = await contacts.addChannel({
    contactId: 3,
    kind: "phone",
    value: "09123",
    isPrimary: true,
  });
  assert.equal(
    driver.callsTo("execute").length,
    0,
    "the demote + insert must stay one batch — a demote after the insert would demote the new row",
  );
  const batch = driver.callsTo("batch")[0]?.args[0] as {
    sql: string;
    params: unknown[];
  }[];
  assert.equal(batch.length, 2);
  assert.match(
    batch[0]?.sql ?? "",
    /UPDATE contact_channels SET is_primary = 0 WHERE contact_id = \?/,
  );
  assert.match(batch[1]?.sql ?? "", /INSERT INTO contact_channels/);
  assert.match(batch[1]?.sql ?? "", /IFNULL\(MAX\(sort_order\), -1\) \+ 1/);
  // The id comes back scoped to this contact — never connection-global
  // `last_insert_rowid()`, whose value any other writer's insert moves.
  const queryArgs = driver.callsTo("query")[0]?.args as [string, unknown[]];
  const [sql, params] = queryArgs;
  assert.match(
    sql,
    /SELECT MAX\(id\) AS id FROM contact_channels WHERE contact_id = \?/,
  );
  assert.deepEqual(params, [3]);
  assert.equal(id, 12);
});

test("contacts.ts never reads connection-global last_insert_rowid (J2)", () => {
  // The race the fix removes: a cross-IPC `SELECT last_insert_rowid()` sees
  // whichever insert happened last on the connection, not whichever insert
  // this call made. Both add paths now take the id from their own write.
  // (The phrase still appears in `addChannel`'s JSDoc, explaining what was
  // removed — so the pin matches the SQL form, not the words.)
  const src = readFileSync(new URL("./contacts.ts", import.meta.url), "utf8");
  assert.doesNotMatch(
    src,
    /SELECT last_insert_rowid/,
    "the id must come from the insert itself, not a second IPC",
  );
});

test("birthdayLabel: full date includes the year, month-day does not", () => {
  assert.equal(birthdayLabel("1990-10-20"), "Oct 20, 1990");
  assert.equal(birthdayLabel("10-20"), "Oct 20");
});

test("birthdayLabel: invalid input degrades instead of throwing", () => {
  assert.equal(birthdayLabel(""), "");
  assert.equal(birthdayLabel("13-40"), "?? 40");
  assert.equal(birthdayLabel("13-40", "my"), "?? 40");
  assert.ok(birthdayLabel("1990-10-20", "my").includes("1990"));
  assert.ok(birthdayLabel("02-29", "my").includes("29"));
});

test("contactInitial: keeps Burmese extended grapheme clusters and emoji intact", () => {
  assert.equal(contactInitial("Mary Jones"), "M");
  assert.equal(contactInitial("  aye chan "), "A");
  assert.equal(contactInitial("သီတာ"), "သီ");
  assert.equal(contactInitial("ဖြိုး"), "ဖြို");
  assert.equal(contactInitial("မေ"), "မေ");
  assert.equal(contactInitial("ဦးအောင်"), "ဦ");
  assert.equal(contactInitial("🏠 Home"), "🏠");
  assert.equal(contactInitial("   "), "?");
});

test("normalizeMonthDay: pads and accepts / or - separators", () => {
  assert.equal(normalizeMonthDay("1-5"), "01-05");
  assert.equal(normalizeMonthDay("01/05"), "01-05");
  assert.equal(normalizeMonthDay("12-31"), "12-31");
});

test("normalizeMonthDay: rejects impossible or malformed values", () => {
  assert.equal(normalizeMonthDay("00-10"), null);
  assert.equal(normalizeMonthDay("13-01"), null);
  assert.equal(normalizeMonthDay("02-30"), null);
  assert.equal(normalizeMonthDay("abc"), null);
  assert.equal(normalizeMonthDay(""), null);
});

test("searchContacts: case-insensitive match on name/address/notes", () => {
  const rows: ContactRow[] = [
    {
      id: 1,
      name: "Aye Chan",
      address: "12 Main St",
      birthday: null,
      notes: "works at the market",
      created_at: "2026-10-01",
    },
    {
      id: 2,
      name: "Ko Ko",
      address: "3 River Rd",
      birthday: "10-20",
      notes: "dentist",
      created_at: "2026-10-01",
    },
  ];
  assert.deepEqual(
    searchContacts(rows, "  main ").map((c) => c.id),
    [1],
  );
  assert.deepEqual(
    searchContacts(rows, "DENTIST").map((c) => c.id),
    [2],
  );
  assert.deepEqual(searchContacts(rows, "nobody"), []);
  assert.deepEqual(
    searchContacts(rows, "").map((c) => c.id),
    [1, 2],
    "blank query lists all",
  );
});

// docs/AUDIT.md DUP-02: `birthdayLabel` grew a second implementation, so the
// Contacts list and the Memories card printed different labels for the same
// row. It delegates to `formatBirthday` now — this pins that they agree, and
// keeps a future "small tweak" here from forking them again.
test("birthdayLabel and formatBirthday agree on every valid birthday", () => {
  for (const birthday of ["1990-10-20", "10-20", "02-29", "2000-01-01"]) {
    for (const locale of ["en", "my"] as const) {
      assert.equal(
        birthdayLabel(birthday, locale),
        formatBirthday(locale, birthday),
        `${birthday} / ${locale}`,
      );
    }
  }
  // Only unparseable input may differ: the list wants a placeholder, the
  // formatter echoes what it was given.
  assert.equal(birthdayLabel("13-40"), "?? 40");
  assert.equal(formatBirthday("en", "13-40"), "13-40");
});
