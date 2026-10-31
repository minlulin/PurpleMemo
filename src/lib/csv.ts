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

/** Maximum valid rows rendered in the preview table DOM; all valid rows still import. */
export const PREVIEW_ROW_LIMIT = 100;

/**
 * Format an imported field value for the preview table without inventing
 * entity-specific JSX. Empty strings/arrays/nulls render an em-dash, and
 * `{ kind, value }` objects keep their `kind` prefix.
 */
export function cellText(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (Array.isArray(value)) {
    return value.length === 0 ? "—" : value.map(cellText).join("; ");
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.value === "string") {
      return typeof record.kind === "string"
        ? `${record.kind}: ${record.value}`
        : record.value;
    }
    return JSON.stringify(value);
  }
  return String(value);
}

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
 * Read a picked CSV file, refusing files larger than `MAX_CSV_BYTES` before
 * `file.text()` allocates and decodes a huge buffer into renderer memory.
 */
export async function readCsvFile(file: {
  size: number;
  text: () => Promise<string>;
}): Promise<string> {
  if (file.size > MAX_CSV_BYTES) {
    throw new CsvImportError("import.error.tooLarge", {
      limit: MAX_CSV_BYTES / (1024 * 1024),
    });
  }
  return file.text();
}

/**
 * Encode a CSV template as UTF-8 bytes prefixed with a UTF-8 BOM (`\uFEFF`)
 * so spreadsheet apps on Windows open non-ASCII (e.g. Burmese) text cleanly.
 * `parseCsv` strips a leading BOM on re-import.
 */
export function encodeCsvTemplate(templateCsv: string): Uint8Array {
  const withBom = templateCsv.startsWith("\uFEFF")
    ? templateCsv
    : `\uFEFF${templateCsv}`;
  return new TextEncoder().encode(withBom);
}

function normalizeHeader(name: string): string {
  return name.trim().toLowerCase();
}

const FORMULA_TRIGGER_RE = /^(?:[\t\r]|[ \t]*[=+\-@])/;

/**
 * Inverse of spreadsheet formula-injection escaping (`exports.ts` `csvText`):
 * strips a leading `'` ONLY when it guards a formula trigger (`=`, `+`, `-`,
 * `@`, `\t`, `\r`), leaving ordinary leading apostrophes (`'90s`) untouched.
 */
export function unescapeSpreadsheetCell(raw: string): string {
  if (raw.startsWith("'") && FORMULA_TRIGGER_RE.test(raw.slice(1))) {
    return raw.slice(1);
  }
  return raw;
}

/**
 * One cell of a parsed record, by header name or one of its aliases.
 *
 * Both importers carried an identical private copy (docs/AUDIT.md DUP-01); the
 * two CSVs share the same header-alias convention and the same spreadsheet
 * formula guard, so the lookup belongs beside the parser. Missing columns read
 * as an empty string — an optional column is not an error.
 */
export function cellValue(
  row: Record<string, string>,
  name: string,
  aliases: string[] = [],
): string {
  if (row[name] !== undefined) return unescapeSpreadsheetCell(row[name]);
  for (const alias of aliases) {
    if (row[alias] !== undefined) return unescapeSpreadsheetCell(row[alias]);
  }
  return "";
}

/**
 * A record whose cells are all empty/whitespace — including an empty line
 * (`[""]`) and a trailing formatted spreadsheet row (`["", "", ""]`) — is not
 * a data row and is skipped.
 */
function isBlankRecord(record: string[]): boolean {
  return record.every((cell) => cell.trim() === "");
}

/**
 * Split the text into the header record and non-blank data records, enforcing
 * `maxDataRows` as records are completed.
 *
 * Enforcing the row cap here rather than by counting raw `\n` characters fixes
 * both directions of drift: multi-line quoted notes/addresses no longer trip
 * the row cap prematurely, and classic-CR (`\r`-only) files cannot bypass it.
 *
 * A field is quoted only when it STARTS with `"` (RFC 4180); inside quotes a
 * `""` is one literal quote and commas/newlines are content. A quote anywhere
 * else is a literal character, so a malformed file degrades to readable values
 * instead of losing data. `\r\n` and `\n` and `\r` all end a record; `\r` or
 * `\n` inside a quoted field is content.
 */
function parseRecords(
  text: string,
  maxDataRows: number,
): { headerRecord: string[]; dataRecords: string[][] } {
  let headerRecord: string[] = [];
  let hasHeader = false;
  const dataRecords: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  const commitRecord = (completed: string[]) => {
    if (!hasHeader) {
      headerRecord = completed;
      hasHeader = true;
      return;
    }
    if (isBlankRecord(completed)) return;
    if (dataRecords.length >= maxDataRows) {
      throw new CsvImportError("import.error.tooManyRows", {
        rows: maxDataRows,
      });
    }
    dataRecords.push(completed);
  };

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
      commitRecord(record);
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
    commitRecord(record);
  }
  return { headerRecord, dataRecords };
}

/**
 * Parse a CSV file for import.
 *
 * Order is part of the contract: the byte cap is decided from the raw text
 * before any record is built, the row cap is enforced while scanning records
 * (before row objects are built or headers checked), and then the header is
 * validated against `requiredColumns` — a file missing a required column is
 * refused before any row is returned, so a caller never sees a half-usable
 * table.
 *
 * @param text whole file contents, already decoded to a string.
 * @param requiredColumns normalized like headers (trimmed + lowercased), so
 * `["Title"]` matches a `title` column.
 * @param headerAliases optional lowercase alias -> canonical header map
 * (e.g. `{ notes: "note", phone: "phones" }`).
 */
export function parseCsv(
  text: string,
  requiredColumns: string[],
  headerAliases: Record<string, string> = {},
): CsvTable {
  if (utf8ByteLength(text) > MAX_CSV_BYTES) {
    throw new CsvImportError("import.error.tooLarge", {
      limit: MAX_CSV_BYTES / (1024 * 1024),
    });
  }
  const body = text.startsWith("\uFEFF") ? text.slice(1) : text;

  const { headerRecord, dataRecords } = parseRecords(body, MAX_CSV_ROWS);

  const canonicalHeader = (raw: string): string => {
    const normalized = normalizeHeader(raw);
    return headerAliases[normalized] ?? normalized;
  };

  const seen = new Set<string>();
  const columns: { name: string; index: number }[] = [];
  headerRecord.forEach((raw, index) => {
    const name = canonicalHeader(raw);
    // A blank header has no name to key a value by; a repeated one would make
    // the row object ambiguous, so the first occurrence wins.
    if (name === "" || seen.has(name)) return;
    seen.add(name);
    columns.push({ name, index });
  });

  const missing = requiredColumns
    .map(canonicalHeader)
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

  const rows = dataRecords.map((record) => {
    const row: Record<string, string> = {};
    for (const { name, index } of columns) {
      row[name] = record[index] ?? "";
    }
    return row;
  });

  return { headers: columns.map(({ name }) => name), rows };
}
