// Contacts CSV import: row rules from the import plan §4, and the one-batch
// insert that follows them. No UI here — `ImportDialog` calls `mapContactRows`
// from its `parse` prop and `insertContacts` from its `onConfirm`.
//
// One import is ONE contact family: each contact row, then its channels, then
// its tags, all in a single `driver.batch` (a single SQLCipher transaction on
// the Rust side). A failure anywhere rolls the whole import back, so a partial
// address book can never be left behind.
//
// Duplicate policy is "always insert as new": no dedupe against existing
// contacts, no merge. Two rows with the same name are two people, exactly as
// two manual adds would be.

import type { BatchStatement, DataDriver } from "../data/driver.ts";
import { normalizeMonthDay } from "./contacts.ts";
import { cellValue, unescapeSpreadsheetCell } from "./csv.ts";
import { isValidISODate, todayLocal } from "./dates.ts";
import type { MessageKey } from "./i18n.ts";
import type { ContactChannelKind } from "./types.ts";

/** Common singular/plural header spellings accepted for Contacts CSV imports. */
export const CONTACT_CSV_ALIASES: Record<string, string> = {
  phone: "phones",
  email: "emails",
  other: "others",
  note: "notes",
  tag: "tags",
};

/** One channel as it will be inserted (primary/order already decided). */
export interface ImportedChannel {
  kind: ContactChannelKind;
  value: string;
  is_primary: number; // 0 | 1
  sort_order: number;
}

/** One accepted contact row, already validated and ready to bind. */
export interface ContactInsert {
  name: string;
  address: string;
  birthday: string | null;
  notes: string;
  channels: ImportedChannel[];
  tags: string[];
}

/** One rejected row. */
export interface ContactImportError {
  /** 1-based DATA row — the header row is not row 1. */
  row: number;
  /** Translation key; the import dialog renders it in the active locale. */
  reason: MessageKey;
}

export interface ContactImportResult {
  valid: ContactInsert[];
  errors: ContactImportError[];
}

/**
 * Parse an optional birthday cell: empty -> null, strict calendar `YYYY-MM-DD`,
 * or month-day (`MM-DD`, `M-D`, `MM/DD`, or vCard `--MM-DD`) normalized to
 * `MM-DD` — matching the two birthday shapes `ContactsPage` and `contacts.ts`
 * support. Impossible calendar dates (`1990-02-30`, `02-30`) return `"invalid"`.
 */
function parseImportedBirthday(raw: string): string | null | "invalid" {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (isValidISODate(trimmed)) return trimmed;
  const mmddCandidate = trimmed.startsWith("--") ? trimmed.slice(2) : trimmed;
  const normalized = normalizeMonthDay(mmddCandidate);
  if (normalized !== null) return normalized;
  return "invalid";
}

/**
 * Split a `;` list into trimmed, formula-unescaped, non-empty values. Trimming
 * is what makes `"555-0100; 555-0101"` two usable numbers instead of one with a
 * leading space, and unescaping per item handles `"; '+95 9 777"` as well as a
 * leading `'+95 9 123` at the start of the cell.
 */
function splitValues(raw: string): string[] {
  return raw
    .split(";")
    .map((value) => unescapeSpreadsheetCell(value.trim()))
    .filter((value) => value !== "");
}

/**
 * Build the channel list in column order. `sort_order` is continuous across
 * phones → emails → others, and only the FIRST channel overall is primary,
 * even when a contact has no phone number and its first channel is an email.
 */
function channelsOf(
  phones: string,
  emails: string,
  others: string,
): ImportedChannel[] {
  const raw: { kind: ContactChannelKind; value: string }[] = [
    ...splitValues(phones).map((value) => ({ kind: "phone" as const, value })),
    ...splitValues(emails).map((value) => ({ kind: "email" as const, value })),
    ...splitValues(others).map((value) => ({ kind: "other" as const, value })),
  ];
  return raw.map((channel, index) => ({
    ...channel,
    is_primary: index === 0 ? 1 : 0,
    sort_order: index,
  }));
}

/**
 * Tags: trimmed, empty dropped, and de-duplicated WITHIN the row so the
 * UNIQUE (contact_id, tag) constraint can never be tripped by a single CSV
 * row. Order is preserved so the stored tags read like the file.
 */
function tagsOf(raw: string): string[] {
  return [...new Set(splitValues(raw))];
}

/**
 * Map parsed CSV rows to contact inserts, collecting per-row errors instead of
 * failing the whole import: one bad birthday must not cost the other 200
 * contacts. A row stops at its first bad value.
 */
export function mapContactRows(
  rows: Record<string, string>[],
): ContactImportResult {
  const valid: ContactInsert[] = [];
  const errors: ContactImportError[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 1;

    const name = cellValue(row, "name").trim();
    if (name === "") {
      errors.push({ row: rowNumber, reason: "import.reason.nameRequired" });
      return;
    }

    const birthday = parseImportedBirthday(cellValue(row, "birthday"));
    if (birthday === "invalid") {
      errors.push({
        row: rowNumber,
        reason: "import.reason.birthday",
      });
      return;
    }

    valid.push({
      name,
      address: cellValue(row, "address"),
      birthday,
      notes: cellValue(row, "notes", ["note"]),
      channels: channelsOf(
        cellValue(row, "phones", ["phone"]),
        cellValue(row, "emails", ["email"]),
        cellValue(row, "others", ["other"]),
      ),
      tags: tagsOf(cellValue(row, "tags", ["tag"])),
    });
  });

  return { valid, errors };
}

/**
 * Insert every accepted contact in ONE batch.
 *
 * A batch cannot hand a statement's generated id back to the next statement
 * (`driver.batch` returns nothing), so the channel and tag statements address
 * the contact this import just wrote with `MAX(id)` on `contacts`. Inside the
 * same transaction that is unambiguous — the connection is single and no other
 * writer can insert between statements — and it is chosen over
 * `last_insert_rowid()` because inserting a channel moves that value away from
 * the contact's id.
 *
 * `driver.batch` is one transaction on the Rust side (`db::batch`), so a
 * failing statement rolls every contact, channel and tag back.
 */
export async function insertContacts(
  driver: DataDriver,
  rows: ContactInsert[],
): Promise<void> {
  if (rows.length === 0) return;
  const createdAt = todayLocal();
  const statements: BatchStatement[] = [];
  for (const row of rows) {
    statements.push({
      sql: `INSERT INTO contacts (name, address, birthday, notes, created_at)
            VALUES (?, ?, ?, ?, ?)`,
      params: [row.name, row.address, row.birthday, row.notes, createdAt],
    });
    for (const channel of row.channels) {
      statements.push({
        sql: `INSERT INTO contact_channels (contact_id, kind, value, is_primary, sort_order)
              SELECT (SELECT MAX(id) FROM contacts), ?, ?, ?, ?`,
        params: [
          channel.kind,
          channel.value,
          channel.is_primary,
          channel.sort_order,
        ],
      });
    }
    for (const tag of row.tags) {
      statements.push({
        sql: `INSERT INTO contact_tags (contact_id, tag)
              SELECT (SELECT MAX(id) FROM contacts), ?`,
        params: [tag],
      });
    }
  }
  await driver.batch(statements);
}
