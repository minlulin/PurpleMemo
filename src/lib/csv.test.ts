// CSV import parser: quoting, BOM/CRLF tolerance, header matching, and the
// two caps — each pinned independently so a future "small" change cannot
// quietly widen what an import accepts.

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { first } from "../test-utils.ts";
import {
  CsvImportError,
  cellText,
  encodeCsvTemplate,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  PREVIEW_ROW_LIMIT,
  parseCsv,
  readCsvFile,
  unescapeSpreadsheetCell,
} from "./csv.ts";

test("parses a header and rows, matching headers case-insensitively and trimmed", () => {
  const table = parseCsv(" Title , NOTES \nCall shop,hello\n", ["title"]);
  assert.deepEqual(table.headers, ["title", "notes"]);
  assert.deepEqual(table.rows, [{ title: "Call shop", notes: "hello" }]);
});

test("unknown columns are not an error and stay readable for optional fields", () => {
  // `priority` was not asked about; the caller (a mapper) picks what it needs.
  const table = parseCsv("title,priority\nA,high\n", ["title"]);
  assert.deepEqual(table.rows, [{ title: "A", priority: "high" }]);
});

test("values are raw strings — the parser does not trim them", () => {
  const table = parseCsv("title,note\n  spaced  , x \n", ["title"]);
  const row = first(table.rows, "rows");
  assert.equal(row.title, "  spaced  ");
  assert.equal(row.note, " x ");
});

test("quoted fields carry commas, newlines and doubled quotes", () => {
  const csv =
    'title,note\n"Call, then wait","He said ""hi""\nand left"\n"plain",done\n';
  const table = parseCsv(csv, ["title"]);
  assert.equal(table.rows.length, 2);
  assert.equal(first(table.rows, "rows").title, "Call, then wait");
  assert.equal(first(table.rows, "rows").note, 'He said "hi"\nand left');
  assert.equal(table.rows[1]?.title, "plain");
  assert.equal(table.rows[1]?.note, "done");
});

test("a quote that does not start a field is literal text", () => {
  const table = parseCsv('title\nab"cd\n', ["title"]);
  assert.equal(first(table.rows, "rows").title, 'ab"cd');
});

test("strips a leading UTF-8 BOM", () => {
  const table = parseCsv("\uFEFFtitle,note\nA,B\n", ["title"]);
  assert.deepEqual(table.headers, ["title", "note"]);
  assert.equal(first(table.rows, "rows").title, "A");
});

test("accepts CRLF, LF and CR line endings, and skips blank or empty-cell lines", () => {
  const crlf = parseCsv("title,note\r\nA,one\r\nB,two\r\n", ["title"]);
  assert.deepEqual(crlf.rows, [
    { title: "A", note: "one" },
    { title: "B", note: "two" },
  ]);
  const lf = parseCsv("title,note\nA,one\nB,two\n\n", ["title"]);
  assert.deepEqual(lf.rows, [
    { title: "A", note: "one" },
    { title: "B", note: "two" },
  ]);
  // Spreadsheet exports emit trailing empty rows as comma-only lines (`,`).
  const sheet = parseCsv("title,note\r\nA,one\r\n,\r\n  , \t \r\nB,two\r\n", [
    "title",
  ]);
  assert.deepEqual(sheet.rows, [
    { title: "A", note: "one" },
    { title: "B", note: "two" },
  ]);
});

test("an empty value is an empty string, not a missing key", () => {
  const table = parseCsv("title,note\nA,\n", ["title"]);
  assert.deepEqual(table.rows, [{ title: "A", note: "" }]);
});

test("missing required columns are named before any row is returned", () => {
  assert.throws(
    () => parseCsv("title,note\nA,B\n", ["title", "due_date"]),
    (error: unknown) => {
      assert.ok(error instanceof CsvImportError);
      assert.equal(error.messageKey, "import.error.missingColumn");
      assert.deepEqual(error.params, { columns: '"due_date"' });
      assert.match(error.message, /required column/);
      return true;
    },
  );
  // Two missing columns are both named.
  assert.throws(
    () => parseCsv("title\nA\n", ["title", "due_date", "done"]),
    (error: unknown) => {
      assert.ok(error instanceof CsvImportError);
      assert.equal(error.messageKey, "import.error.missingColumns");
      assert.deepEqual(error.params, {
        columns: '"due_date", "done"',
      });
      return true;
    },
  );
});

test("a file over the byte cap is refused before it is parsed", () => {
  // The header is valid and `due_date` is absent — the size error must win,
  // which is what proves the cap runs before parsing/validation.
  const huge = `title\n${"x".repeat(MAX_CSV_BYTES)}`;
  assert.throws(
    () => parseCsv(huge, ["title", "due_date"]),
    (error: unknown) => {
      assert.ok(error instanceof CsvImportError);
      assert.equal(error.messageKey, "import.error.tooLarge");
      assert.deepEqual(error.params, { limit: 5 });
      assert.match(error.message, /5 MiB limit/);
      return true;
    },
  );
});

test("a file over the row cap is refused, and exactly the cap is accepted", () => {
  const row = (n: number) => `Task ${n}`;
  const atCap = `title\n${Array.from({ length: MAX_CSV_ROWS }, (_, i) => row(i + 1)).join("\n")}`;
  const overCap = `title\n${Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => row(i + 1)).join("\n")}`;

  assert.equal(parseCsv(atCap, ["title"]).rows.length, MAX_CSV_ROWS);
  assert.throws(
    () => parseCsv(overCap, ["title"]),
    (error: unknown) => {
      assert.ok(error instanceof CsvImportError);
      assert.equal(error.messageKey, "import.error.tooManyRows");
      assert.deepEqual(error.params, { rows: MAX_CSV_ROWS });
      assert.match(error.message, /more than 5000 rows/);
      return true;
    },
  );
  // Classic-CR (`\r`-only) files cannot bypass the row cap either.
  const crOverCap = `title\r${Array.from({ length: MAX_CSV_ROWS + 1 }, (_, i) => row(i + 1)).join("\r")}`;
  assert.throws(
    () => parseCsv(crOverCap, ["title"]),
    (error: unknown) => {
      assert.ok(error instanceof CsvImportError);
      assert.equal(error.messageKey, "import.error.tooManyRows");
      return true;
    },
  );
});

test("multi-line quoted fields do not trip the row cap prematurely", () => {
  // 1,000 rows × 6 internal newlines = 6,000 `\n` characters (> MAX_CSV_ROWS),
  // yet only 1,000 actual CSV records.
  const multilineRow = (n: number) =>
    `"Contact ${n}","Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6"`;
  const csv = `name,notes\n${Array.from({ length: 1_000 }, (_, i) => multilineRow(i + 1)).join("\n")}`;
  const table = parseCsv(csv, ["name"]);
  assert.equal(table.rows.length, 1_000);
});

test("readCsvFile refuses a file over MAX_CSV_BYTES before calling file.text()", async () => {
  let readCalled = false;
  await assert.rejects(
    readCsvFile({
      size: MAX_CSV_BYTES + 1,
      async text() {
        readCalled = true;
        return "title\nA\n";
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof CsvImportError);
      assert.equal(error.messageKey, "import.error.tooLarge");
      return true;
    },
  );
  assert.equal(
    readCalled,
    false,
    "must not read oversized file bytes into memory",
  );

  const ok = await readCsvFile({
    size: MAX_CSV_BYTES,
    async text() {
      return "title\nA\n";
    },
  });
  assert.equal(ok, "title\nA\n");
});

test("encodeCsvTemplate prepends UTF-8 BOM once and round-trips through parseCsv", () => {
  const csv = "title,note\nမီးဖိုးပေးရန်,အွန်လိုင်း\n";
  const bytes = encodeCsvTemplate(csv);
  assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "UTF-8 BOM");
  const again = encodeCsvTemplate(`\uFEFF${csv}`);
  assert.deepEqual(again, bytes, "idempotent when BOM is already present");
  const decoded = new TextDecoder("utf-8").decode(bytes);
  const table = parseCsv(decoded, ["title"]);
  assert.deepEqual(table.rows, [{ title: "မီးဖိုးပေးရန်", note: "အွန်လိုင်း" }]);
});

test("ImportDialog saves templates via native dialog rather than blocked data: anchors, and pages use readCsvFile", () => {
  const importDialog = readFileSync(
    new URL("../components/ImportDialog.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    importDialog,
    /data:text\/csv/,
    "navigation.rs blocks data: URLs in Tauri webviews",
  );
  assert.doesNotMatch(
    importDialog,
    /<a[\s\S]{0,200}\bdownload=/,
    "template export must not rely on <a download> in Tauri",
  );
  assert.match(importDialog, /\bsaveCsvTemplate\(/);

  for (const page of ["../pages/TasksPage.tsx", "../pages/ContactsPage.tsx"]) {
    const src = readFileSync(new URL(page, import.meta.url), "utf8");
    assert.match(
      src,
      /onPick=\{readCsvFile\}/,
      `${page} must pass readCsvFile so oversized files are refused before file.text()`,
    );
  }
  assert.match(
    importDialog,
    /preview\.valid\.slice\(0,\s*PREVIEW_ROW_LIMIT\)/,
    "ImportDialog must cap rendered preview rows to PREVIEW_ROW_LIMIT",
  );
  assert.equal(PREVIEW_ROW_LIMIT, 100);
});

test("parseCsv normalizes headerAliases and unescapeSpreadsheetCell strips only formula guards", () => {
  const table = parseCsv(
    "Title, Due Date, Notes\nPay bill,2026-12-01,Paid online\n",
    ["title"],
    { notes: "note", "due date": "due_date" },
  );
  assert.deepEqual(table.headers, ["title", "due_date", "note"]);
  assert.deepEqual(table.rows, [
    { title: "Pay bill", due_date: "2026-12-01", note: "Paid online" },
  ]);

  assert.equal(unescapeSpreadsheetCell("'+95 9 123"), "+95 9 123");
  assert.equal(unescapeSpreadsheetCell("'- Call shop"), "- Call shop");
  assert.equal(unescapeSpreadsheetCell("'=SUM(A1:A2)"), "=SUM(A1:A2)");
  assert.equal(unescapeSpreadsheetCell("' @handle"), " @handle");
  assert.equal(unescapeSpreadsheetCell("'90s music"), "'90s music");
  assert.equal(unescapeSpreadsheetCell("'O'Brien"), "'O'Brien");

  assert.equal(cellText(null), "—");
  assert.equal(cellText(""), "—");
  assert.equal(cellText([]), "—");
  assert.equal(
    cellText([
      { kind: "phone", value: "555-0100" },
      { kind: "email", value: "a@x" },
    ]),
    "phone: 555-0100; email: a@x",
  );
});
