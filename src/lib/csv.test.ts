// CSV import parser: quoting, BOM/CRLF tolerance, header matching, and the
// two caps — each pinned independently so a future "small" change cannot
// quietly widen what an import accepts.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { first } from "../test-utils.ts";
import {
  CsvImportError,
  MAX_CSV_BYTES,
  MAX_CSV_ROWS,
  parseCsv,
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

test("accepts CRLF and LF line endings, and skips blank lines", () => {
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
});
