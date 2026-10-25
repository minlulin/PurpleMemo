// Contacts CSV import: every column rule, the semicolon/primary/order rules,
// tag de-duplication, and the one-batch write.
//
// The rollback test runs against real SQLite through Node's built-in
// `node:sqlite` (the same approach as `entityLinks.test.ts`), because "a
// failure leaves no contact, channel or tag behind" is a property of the
// transaction — a recording mock cannot prove it.

import { strict as assert } from "node:assert";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type {
  BatchStatement,
  DataDriver,
  ExecuteOutcome,
  Queryable,
} from "../data/driver.ts";
import { createMockDriver } from "../data/mock-driver.ts";
import { first } from "../test-utils.ts";
import { insertContacts, mapContactRows } from "./contactImport.ts";
import { todayLocal } from "./dates.ts";
import type { ContactChannelKind } from "./types.ts";

const SQLITE_FIXTURE = `
CREATE TABLE contacts (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  address    TEXT NOT NULL DEFAULT '',
  birthday   TEXT,
  notes      TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE contact_channels (
  id         INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('phone', 'email', 'other')),
  value      TEXT NOT NULL,
  is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE contact_tags (
  id         INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  tag        TEXT NOT NULL,
  UNIQUE (contact_id, tag)
);
`;

const OFF_SHARE = {
  running: false,
  url: null,
  key: null,
  port: null,
  publishedAt: null,
  note: null,
};

/** A `DataDriver` over real SQLite, with the same batch atomicity as Rust. */
function sqliteDriver(): DataDriver & { db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  db.exec(SQLITE_FIXTURE);
  return {
    db,
    async query<T extends Queryable>(sql: string, params: unknown[] = []) {
      return db.prepare(sql).all(...(params as never[])) as T[];
    },
    async execute(
      sql: string,
      params: unknown[] = [],
    ): Promise<ExecuteOutcome> {
      const r = db.prepare(sql).run(...(params as never[]));
      return {
        rowsAffected: Number(r.changes),
        lastInsertRowid: Number(r.lastInsertRowid),
      };
    },
    async batch(statements: BatchStatement[]) {
      db.exec("BEGIN");
      try {
        for (const s of statements) {
          db.prepare(s.sql).run(...(s.params as never[]));
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
    async begin() {},
    async commit() {},
    async rollback() {},
    async resetTxn() {},
    async savePhoto() {
      return "photos/2026/10/x.jpg";
    },
    async readPhoto() {
      return new Uint8Array(0);
    },
    async readPhotoThumb() {
      return new Uint8Array(0);
    },
    async savePhotoThumb() {
      return "photos/2026/10/x.thumb.jpg";
    },
    async deletePhoto() {},
    async saveBackupFile() {},
    async saveExportFile() {},
    async saveDbKeyFile() {},
    async safetyBackupCopy() {
      throw new Error("no safety copy in this test driver");
    },
    async shareStart() {
      return OFF_SHARE;
    },
    async shareStop() {
      return OFF_SHARE;
    },
    async shareStatus() {
      return OFF_SHARE;
    },
    async sharePublish() {
      return OFF_SHARE;
    },
    async shareArm() {
      return "";
    },
  };
}

function rows<T>(db: DatabaseSync, sql: string): T[] {
  return db.prepare(sql).all() as T[];
}

interface ChannelDbRow {
  contact_id: number;
  kind: ContactChannelKind;
  value: string;
  is_primary: number;
  sort_order: number;
}

test("maps every column rule", () => {
  const result = mapContactRows([
    {
      name: "  Mary Jones  ",
      phones: "555-0100; 555-0101",
      emails: "mary@example.com",
      others: "Telegram @mary",
      address: "12 Market Road",
      birthday: "1990-04-18",
      notes: "Met at the market",
      tags: " friends ; supplier ",
    },
  ]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(first(result.valid, "valid"), {
    name: "Mary Jones",
    address: "12 Market Road",
    birthday: "1990-04-18",
    notes: "Met at the market",
    channels: [
      { kind: "phone", value: "555-0100", is_primary: 1, sort_order: 0 },
      { kind: "phone", value: "555-0101", is_primary: 0, sort_order: 1 },
      {
        kind: "email",
        value: "mary@example.com",
        is_primary: 0,
        sort_order: 2,
      },
      { kind: "other", value: "Telegram @mary", is_primary: 0, sort_order: 3 },
    ],
    tags: ["friends", "supplier"],
  });
});

test("semicolon splitting drops empty items and a trailing `;`", () => {
  const [row] = mapContactRows([
    {
      name: "Ada",
      phones: "; 555-0100 ;; 555-0101 ;",
      emails: ";",
      others: " ",
      tags: "a;; b ; a ;",
    },
  ]).valid;
  assert.ok(row);
  assert.deepEqual(
    row.channels.map((channel) => [channel.kind, channel.value]),
    [
      ["phone", "555-0100"],
      ["phone", "555-0101"],
    ],
  );
  assert.deepEqual(row.tags, ["a", "b"]);
});

test("the first channel overall is primary, even when it is not a phone", () => {
  const [row] = mapContactRows([
    { name: "Ada", phones: "", emails: "a@x; b@x", others: "handle" },
  ]).valid;
  assert.ok(row);
  assert.deepEqual(
    row.channels.map((channel) => ({
      kind: channel.kind,
      primary: channel.is_primary,
      order: channel.sort_order,
    })),
    [
      { kind: "email", primary: 1, order: 0 },
      { kind: "email", primary: 0, order: 1 },
      { kind: "other", primary: 0, order: 2 },
    ],
  );
});

test("an absent optional column falls back to its empty value", () => {
  const result = mapContactRows([{ name: "Only a name" }]);
  assert.deepEqual(result.valid, [
    {
      name: "Only a name",
      address: "",
      birthday: null,
      notes: "",
      channels: [],
      tags: [],
    },
  ]);
});

test("every row-error case is reported with its 1-based data row number", () => {
  const result = mapContactRows([
    { name: "Good", birthday: "1990-04-18" }, // 1
    { name: "   " }, // 2: blank name
    { name: "Bad birthday", birthday: "18/04/1990" }, // 3
  ]);
  assert.equal(result.valid.length, 1);
  assert.deepEqual(
    result.errors.map((error) => error.row),
    [2, 3],
  );
  assert.deepEqual(
    result.errors.map((error) => error.reason),
    ["import.reason.nameRequired", "import.reason.birthday"],
  );
});

test("the header is not row 1", () => {
  const result = mapContactRows([{ name: "fine" }, { name: "" }]);
  assert.deepEqual(result.errors, [
    { row: 2, reason: "import.reason.nameRequired" },
  ]);
});

test("insertContacts writes the whole import in one batch", async () => {
  const driver = createMockDriver();
  const { valid } = mapContactRows([
    { name: "Ada", phones: "1; 2", tags: "friend;friend" },
    { name: "Grace", emails: "g@x" },
  ]);
  await insertContacts(driver, valid);

  const batches = driver.callsTo("batch");
  assert.equal(batches.length, 1, "one batch for the whole import");
  const statements = first(batches, "batches").args[0] as BatchStatement[];
  // contact, 2 channels, 1 tag, contact, 1 channel.
  assert.equal(statements.length, 6);
  assert.match(first(statements, "statements").sql, /INSERT INTO contacts/);
  assert.match(statements[1]?.sql ?? "", /INSERT INTO contact_channels/);
  assert.match(statements[3]?.sql ?? "", /INSERT INTO contact_tags/);
  assert.deepEqual(driver.callsTo("execute"), []);
});

test("an empty accepted list writes nothing", async () => {
  const driver = createMockDriver();
  await insertContacts(driver, []);
  assert.deepEqual(driver.calls, []);
});

test("contacts, channels and tags land attached to the right contact", async () => {
  const driver = sqliteDriver();
  const { valid } = mapContactRows([
    {
      name: "Mary Jones",
      phones: "555-0100; 555-0101",
      emails: "mary@example.com",
      address: "12 Market Road",
      birthday: "1990-04-18",
      notes: "Met at the market",
      tags: "friends;friends;supplier",
    },
    {
      name: "Grace Hopper",
      emails: "grace@example.com",
      tags: "work",
    },
  ]);
  await insertContacts(driver, valid);

  const contacts = rows<{
    id: number;
    name: string;
    address: string;
    birthday: string | null;
    notes: string;
    created_at: string;
  }>(driver.db, "SELECT * FROM contacts ORDER BY id");
  assert.equal(contacts.length, 2);
  // `node:sqlite` rows have a null prototype; spread into a plain object for
  // a strict comparison.
  assert.deepEqual(
    { ...first(contacts, "contacts") },
    {
      id: 1,
      name: "Mary Jones",
      address: "12 Market Road",
      birthday: "1990-04-18",
      notes: "Met at the market",
      created_at: todayLocal(),
    },
  );
  assert.equal(contacts[1]?.name, "Grace Hopper");

  const channels = rows<ChannelDbRow>(
    driver.db,
    "SELECT contact_id, kind, value, is_primary, sort_order FROM contact_channels ORDER BY contact_id, sort_order",
  );
  assert.deepEqual(
    channels.map((channel) => ({ ...channel })),
    [
      {
        contact_id: 1,
        kind: "phone",
        value: "555-0100",
        is_primary: 1,
        sort_order: 0,
      },
      {
        contact_id: 1,
        kind: "phone",
        value: "555-0101",
        is_primary: 0,
        sort_order: 1,
      },
      {
        contact_id: 1,
        kind: "email",
        value: "mary@example.com",
        is_primary: 0,
        sort_order: 2,
      },
      {
        contact_id: 2,
        kind: "email",
        value: "grace@example.com",
        is_primary: 1,
        sort_order: 0,
      },
    ],
  );

  const tags = rows<{ contact_id: number; tag: string }>(
    driver.db,
    "SELECT contact_id, tag FROM contact_tags ORDER BY contact_id, tag",
  );
  assert.deepEqual(
    tags.map((tag) => ({ ...tag })),
    [
      { contact_id: 1, tag: "friends" },
      { contact_id: 1, tag: "supplier" },
      { contact_id: 2, tag: "work" },
    ],
  );
});

test("a failing statement rolls back every contact, channel and tag", async () => {
  const driver = sqliteDriver();
  // A trigger that refuses one tag, so the failure happens AFTER the contacts
  // and channels have already been inserted — the exact partial state the
  // transaction must not leave behind.
  driver.db.exec(`
    CREATE TRIGGER refuse_boom BEFORE INSERT ON contact_tags
    WHEN NEW.tag = 'boom' BEGIN SELECT RAISE(ABORT, 'boom tag refused'); END;
  `);
  const { valid } = mapContactRows([
    { name: "Good", phones: "555-0100", tags: "ok" },
    { name: "Bad", phones: "555-0101", tags: "boom" },
  ]);
  assert.equal(valid.length, 2);

  await assert.rejects(insertContacts(driver, valid), /boom tag refused/);

  for (const table of ["contacts", "contact_channels", "contact_tags"]) {
    assert.equal(
      rows<{ n: number }>(driver.db, `SELECT count(*) AS n FROM ${table}`)[0]
        ?.n,
      0,
      `${table} must be empty after the rollback`,
    );
  }
});

test("a rejected row never reaches the batch", async () => {
  const driver = sqliteDriver();
  const { valid, errors } = mapContactRows([
    { name: "Good", tags: "ok" },
    { name: "", tags: "bad" },
  ]);
  assert.equal(errors.length, 1);
  await insertContacts(driver, valid);
  assert.equal(
    rows<{ n: number }>(driver.db, "SELECT count(*) AS n FROM contacts")[0]?.n,
    1,
  );
});
