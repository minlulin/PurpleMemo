// CSV parser for the import feature: one header row + data rows, RFC-4180
// quoting, BOM/CRLF tolerated, and both caps enforced before a single row is
// built. Values come back as raw strings — interpreting them is the caller's
// job (`taskImport.ts` today, `contactImport.ts` next), which is what keeps
// this parser free of any one entity's column rules.
//
// "Unknown columns ignored" means exactly that: a column the caller did not
// ask about is not an error, and it is carried through in `rows` so a mapper
// can read optional columns (`due_date`, `done`, …) that were never in the
// required list. The parser has no way to know which extra columns are known.

import {
  getLocale,
  type MessageKey,
  type MessageParams,
  translate,
} from "./i18n.ts";

/**
 * Largest accepted file, in bytes — checked before the text is parsed.
 * The cap is a guard against a user pasting an entire spreadsheet export
 * into an import that then keeps every cell in renderer memory.
 */
export const MAX_CSV_BYTES = 5 * 1024 * 1024;

/** Largest accepted number of data rows (the header row does not count). */
export const MAX_CSV_ROWS = 5_000;

/**
 * A refused file, carrying a translation key and its placeholders instead of
 * a pre-rendered sentence. The import dialog renders it in the locale active
 * when the error is shown; `message` is the readable fallback for logs and
 * for any caller that only has `Error.message`.
 */
export class CsvImportError extends Error {
  readonly messageKey: MessageKey;
  readonly params: MessageParams;

  constructor(messageKey: MessageKey, params: MessageParams = {}) {
    super(translate(getLocale(), messageKey, params));
    this.name = "CsvImportError";
    this.messageKey = messageKey;
    this.params = params;
  }
}

/** The parsed file: header names + one raw record per data row. */
export interface CsvTable {
  /**
   * Normalized header names (trimmed, lowercased), in column order — exactly
   * the keys every row uses. A blank header and a repeated header are dropped
   * (first occurrence wins).
   */
  headers: string[];
  /** One raw record per data row, keyed by `headers`. */
  rows: Record<string, string>[];
}

/**
 * UTF-8 byte length without encoding a copy of the text. The file may be far
 * larger than the cap, so `TextEncoder` (which allocates the whole thing) is
 * the wrong tool for deciding to refuse it.
 */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
      continue;
    }
    if (code < 0x800) {
      bytes += 2;
      continue;
    }
    const next = text.charCodeAt(i + 1);
    if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      bytes += 4; // one code point, two UTF-16 units
      i += 1;
      continue;
    }
    bytes += 3;
  }
  return bytes;
}

/**
 * Cheap record count for the row cap: every newline terminates one record, and
 * a final record without a trailing newline counts too. Deliberately NOT a
 * parse — a full parse is what the cap exists to avoid. A newline inside a
 * quoted field is counted as a record boundary, which only ever makes the
 * count an over-estimate; the cap is a refusal threshold, so erring upward is
 * the safe direction.
 */
function countRecords(text: string): number {
  let newlines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") newlines += 1;
  }
  return text.length > 0 && !text.endsWith("\n") ? newlines + 1 : newlines;
}

function normalizeHeader(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Split the text into records of raw fields.
 *
 * A field is quoted only when it STARTS with `"` (RFC 4180); inside quotes a
 * `""` is one literal quote and commas/newlines are content. A quote anywhere
 * else is a literal character, so a malformed file degrades to readable values
 * instead of losing data. `\r\n` and `\n` both end a record; `\r` inside a
 * quoted field is content.
 */
function parseRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"' && field.length === 0) {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ",") {
      record.push(field);
      field = "";
      i += 1;
      continue;
    }
    if (char === "\n" || char === "\r") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      // CRLF is one terminator, not two.
      i += char === "\r" && text[i + 1] === "\n" ? 2 : 1;
      continue;
    }
    field += char;
    i += 1;
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** A line with no cells at all is not a row (blank lines are skipped). */
function isBlankRecord(record: string[]): boolean {
  return record.length === 1 && record[0] === "";
}

/**
 * Parse a CSV file for import.
 *
 * Order is part of the contract: both caps are decided from the raw text
 * before any record is built, then the header is validated against
 * `requiredColumns` — a file missing a required column is refused before any
 * row is returned, so a caller never sees a half-usable table.
 *
 * @param text whole file contents, already decoded to a string.
 * @param requiredColumns normalized like headers (trimmed + lowercased), so
 * `["Title"]` matches a `title` column.
 */
export function parseCsv(text: string, requiredColumns: string[]): CsvTable {
  if (utf8ByteLength(text) > MAX_CSV_BYTES) {
    throw new CsvImportError("import.error.tooLarge", {
      limit: MAX_CSV_BYTES / (1024 * 1024),
    });
  }
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;

  const dataRowCount = Math.max(0, countRecords(body) - 1);
  if (dataRowCount > MAX_CSV_ROWS) {
    throw new CsvImportError("import.error.tooManyRows", {
      rows: MAX_CSV_ROWS,
    });
  }

  const records = parseRecords(body);
  const headerRecord = records[0] ?? [];
  const dataRecords = records.slice(1);

  const seen = new Set<string>();
  const columns: { name: string; index: number }[] = [];
  headerRecord.forEach((raw, index) => {
    const name = normalizeHeader(raw);
    // A blank header has no name to key a value by; a repeated one would make
    // the row object ambiguous, so the first occurrence wins.
    if (name === "" || seen.has(name)) return;
    seen.add(name);
    columns.push({ name, index });
  });

  const missing = requiredColumns
    .map(normalizeHeader)
    .filter((name) => !seen.has(name));
  if (missing.length > 0) {
    const list = missing.map((name) => `"${name}"`).join(", ");
    throw new CsvImportError(
      missing.length === 1
        ? "import.error.missingColumn"
        : "import.error.missingColumns",
      { columns: list },
    );
  }

  const rows = dataRecords
    .filter((record) => !isBlankRecord(record))
    .map((record) => {
      const row: Record<string, string> = {};
      for (const { name, index } of columns) {
        row[name] = record[index] ?? "";
      }
      return row;
    });

  return { headers: columns.map(({ name }) => name), rows };
}
