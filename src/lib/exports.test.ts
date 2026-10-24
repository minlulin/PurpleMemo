import { strict as assert } from "node:assert";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import {
  ALL_EXPORT_GROUPS,
  buildExportArchive,
  buildExportFiles,
  centsToDecimal,
  contactVcard,
  csvText,
  EXPORT_FIELD_MAPPING,
  type ExportContact,
  type ExportData,
  journalMarkdown,
  noteMarkdown,
  sanitizeFilePart,
} from "./exports.ts";

function fixture(): ExportData {
  return {
    collections: [
      { id: 1, name: "ရန်ကုန်", created_at: "2026-01-01" },
      { id: 2, name: "Work", created_at: "2026-01-01" },
    ],
    notes: [
      {
        id: 7,
        title: 'Same: "name"?',
        content: "Line one\r\nLine two, with a comma\n\u1031\u1019\u1031",
        tags: "alpha, beta",
        collection_id: 1,
        pinned: 1,
        archived: 1,
        created_at: "2026-01-02",
        updated_at: "2026-01-03",
      },
      {
        id: 8,
        title: 'Same: "name"?',
        content: "Second note",
        tags: "",
        collection_id: null,
        pinned: 0,
        archived: 0,
        created_at: "2026-01-04",
        updated_at: "2026-01-05",
      },
    ],
    noteAttachments: new Map([[7, ["photos/2026/01/abc.jpg"]]]),
    journal: [
      {
        id: 3,
        entry_date: "2026-10-20",
        content: "Journal body",
        created_at: "2026-10-20",
        updated_at: "2026-10-20",
      },
    ],
    income: [
      {
        id: 11,
        amount_cents: 125050,
        category: "Salary",
        wallet: "KBZ",
        entry_date: "2026-10-01",
        note: "=SUM(A1:A2)",
        created_at: "2026-10-01",
      },
    ],
    expenses: [
      {
        id: 12,
        amount_cents: 99,
        category: "Food",
        wallet: "Cash",
        entry_date: "2026-10-02",
        note: "tea, snack",
        created_at: "2026-10-02",
      },
    ],
    loans: [
      {
        id: 13,
        counterparty: "Aung",
        direction: "lent",
        amount_cents: 5000,
        repaid_cents: 2000,
        due_date: "2026-09-01",
        note: "",
        created_at: "2026-08-01",
        state: "overdue",
      },
    ],
    jobs: [
      {
        id: 14,
        title: "Repair",
        shop_id: 4,
        total_cents: 10000,
        paid_cents: 2500,
        job_date: "2026-10-03",
        warranty_days: 30,
        status: "open",
        note: "+1 day",
        created_at: "2026-10-03",
        shop: "Shop, One",
      },
    ],
    payables: [
      {
        id: 15,
        title: "Parts",
        amount_cents: 3000,
        shop_id: null,
        due_date: null,
        paid: 0,
        note: "@lookup",
        created_at: "2026-10-04",
        shop: null,
      },
    ],
    contacts: [
      {
        contact: {
          id: 21,
          name: "Daw \u1000\u103c\u100a\u103a",
          address: "No. 1, Main St; Yangon",
          birthday: "10-20",
          notes: "Met at, coffee",
          created_at: "2026-01-01",
        },
        channels: [
          {
            id: 1,
            contact_id: 21,
            kind: "phone",
            value: "+95 9 123",
            is_primary: 1,
            sort_order: 0,
          },
          {
            id: 2,
            contact_id: 21,
            kind: "email",
            value: "a@example.com",
            is_primary: 0,
            sort_order: 1,
          },
        ],
        tags: ["family", "yangon"],
      },
    ],
    today: "2026-10-20",
  };
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\r" && text[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
    } else {
      field += char;
    }
  }
  return rows;
}

test("file names are safe, unique and preserve non-Latin titles", () => {
  const bundle = buildExportFiles(fixture(), ALL_EXPORT_GROUPS, "2026-10-20");
  const notePaths = bundle.files
    .map((file) => file.path)
    .filter((path) => path.startsWith("notes/"));
  assert.equal(notePaths.length, 2);
  assert.equal(new Set(notePaths).size, 2);
  for (const path of notePaths) {
    const name = path.slice(path.lastIndexOf("/") + 1);
    assert.doesNotMatch(name, /[<>:"/\\|?*]/);
    assert.ok([...name].every((char) => char.charCodeAt(0) >= 32));
  }
  assert.equal(sanitizeFilePart("CON", "note"), "CON-file");
  assert.equal(sanitizeFilePart("   ", "note"), "note");
  assert.equal(sanitizeFilePart("a/b", "note"), "a b");
});

test("markdown front matter carries archive state, tags and attachments", () => {
  const bundle = buildExportFiles(fixture(), ALL_EXPORT_GROUPS, "2026-10-20");
  const note = bundle.files.find(
    (file) => file.path === "notes/7-same-name.md",
  );
  assert.ok(note);
  assert.match(note.text, /^---\n/);
  assert.match(note.text, /tags: \["alpha", "beta"\]/);
  assert.match(
    note.text,
    /collection: "\u101b\u1014\u103a\u1000\u102f\u1014\u103a"/,
  );
  assert.match(note.text, /archived: true/);
  assert.match(note.text, / {2}- "photos\/2026\/01\/abc.jpg"/);
  assert.match(note.text, /\u1031\u1019\u1031/);
  const journal = bundle.files.find(
    (file) => file.path === "journal/2026/2026-10-20.md",
  );
  assert.ok(journal);
  assert.match(journal.text, /date: "2026-10-20"/);
});

test("CSV keeps CRLF, quoting and decimal money, and neutralizes formulas", () => {
  const bundle = buildExportFiles(fixture(), ALL_EXPORT_GROUPS, "2026-10-20");
  const income = bundle.files.find(
    (file) => file.path === "finance/income.csv",
  );
  assert.ok(income);
  assert.ok(income.text.endsWith("\r\n"));
  const rows = parseCsv(income.text);
  assert.equal(rows[0]?.[0], "id");
  assert.equal(rows[1]?.[2], "125050");
  assert.equal(rows[1]?.[3], "1250.50");
  assert.equal(rows[1]?.[6], "'=SUM(A1:A2)");
  assert.equal(centsToDecimal(5), "0.05");
  assert.equal(centsToDecimal(-125), "-1.25");
  assert.equal(csvText("+1,000"), '"\'+1,000"');
  assert.equal(csvText("plain"), "plain");
  // A trigger behind leading whitespace is still a formula payload: sheets
  // trim the spaces, then evaluate the cell.
  assert.ok(csvText(" =SUM(A1:A2)").startsWith("'"));
  assert.ok(csvText("  +1+1").startsWith("'"));
  assert.ok(csvText(" \t-2+3").startsWith("'"));
  assert.equal(csvText("John Smith"), "John Smith");
  assert.equal(csvText("   "), '"   "');
  const expenses = bundle.files.find(
    (file) => file.path === "finance/expenses.csv",
  );
  assert.ok(expenses);
  assert.equal(parseCsv(expenses.text)[1]?.[6], "tea, snack");
});

test("vCard 4.0 escapes, folds and preserves primary channels and month-day birthdays", () => {
  const bundle = buildExportFiles(fixture(), ALL_EXPORT_GROUPS, "2026-10-20");
  const card = bundle.files.find((file) => file.path === "contacts.vcf");
  assert.ok(card);
  assert.ok(card.text.startsWith("BEGIN:VCARD\r\nVERSION:4.0\r\n"));
  assert.ok(card.text.endsWith("END:VCARD\r\n"));
  assert.match(card.text, /BDAY:--10-20\r\n/);
  assert.match(card.text, /TEL;VALUE=text;TYPE=voice;PREF=1:\+95 9 123/);
  assert.match(card.text, /NOTE:Met at\\, coffee/);
  assert.match(card.text, /No\. 1\\, Main St\\; Yangon/);
  assert.match(card.text, /\u1000\u103c\u100a\u103a/);
  for (const line of card.text.split("\r\n")) {
    assert.ok(new TextEncoder().encode(line).length <= 75, line);
  }
});

test("the archive contains every selected file and omits unselected groups", async () => {
  const data = fixture();
  const all = buildExportFiles(data, ALL_EXPORT_GROUPS, "2026-10-20");
  const bytes = await buildExportArchive(all.files);
  const entries = unzipSync(bytes);
  for (const file of all.files) {
    assert.equal(strFromU8(entries[file.path] ?? new Uint8Array()), file.text);
  }
  assert.ok(entries["README.txt"]);
  assert.ok(entries["EXPORT-FIELDS.md"]);

  const notesOnly = buildExportFiles(
    data,
    { notes: true, journal: false, finance: false, contacts: false },
    "2026-10-20",
  );
  assert.ok(notesOnly.files.some((file) => file.path.startsWith("notes/")));
  assert.ok(!notesOnly.files.some((file) => file.path === "contacts.vcf"));
  assert.ok(!notesOnly.files.some((file) => file.path.startsWith("journal/")));
  assert.ok(!notesOnly.files.some((file) => file.path.startsWith("finance/")));
  assert.equal(notesOnly.counts.notes, 2);
  assert.equal(notesOnly.counts.contacts, 0);
});

test("field mapping names every exported table and every deliberate exclusion", () => {
  const sources = EXPORT_FIELD_MAPPING.map((row) => row.source).join("\n");
  for (const table of [
    "collections",
    "notes",
    "journal_entries",
    "income_entries",
    "expense_entries",
    "loans",
    "jobs",
    "payables",
    "contacts",
    "trash_items",
    "vault_items",
    "settings",
  ]) {
    assert.match(sources, new RegExp(table));
  }
});

test("markdown helpers keep a trailing newline without adding blank ones", () => {
  const journal = journalMarkdown(fixture().journal[0] as never);
  assert.ok(journal.endsWith("\n"));
  assert.ok(!journal.endsWith("\n\n"));
  const note = noteMarkdown(fixture().notes[1] as never, null, []);
  assert.match(note, /collection: null/);
  assert.ok(note.endsWith("\n"));
});

test("contactVcard escapes CATEGORIES as text; the separators stay literal", () => {
  // There used to be an `escapeVcardList` byte-for-byte identical to
  // `escapeVcardText`, used only for this line. List values are escaped as
  // text (RFC 6350 §3.3) and then joined with the literal commas that separate
  // the items — so a tag containing a comma must not become two values and a
  // tag containing a semicolon must not start a parameter.
  const entry: ExportContact = {
    contact: {
      id: 1,
      name: "Aye",
      address: "",
      birthday: null,
      notes: "",
      created_at: "2026-01-01",
    },
    channels: [],
    tags: ["fun, friends", "work; team"],
  };
  const line = contactVcard(entry)
    .split("\r\n")
    .find((l) => l.startsWith("CATEGORIES:"));
  assert.equal(
    line,
    "CATEGORIES:fun\\, friends,work\\; team",
    "escaped inside the tag, literal between tags",
  );
});
