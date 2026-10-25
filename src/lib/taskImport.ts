// Tasks CSV import: row rules from the import plan §4, and the single-batch
// insert that follows them. No UI here — `ImportDialog` calls `mapTaskRows`
// from its `parse` prop and `insertTasks` from its `onConfirm`.
//
// Duplicate policy is "always insert as new": no dedupe, no merge. Two rows
// with the same title are two tasks, exactly as two manual adds would be.

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import type { MessageKey } from "./i18n.ts";
import type { TaskRow } from "./types.ts";

/** One accepted row, already validated and ready to bind. */
export interface TaskInsert {
  title: string;
  due_date: string | null;
  done: number; // 0 | 1
  repeat: TaskRow["repeat"];
  note: string;
}

/** One rejected row. */
export interface TaskImportError {
  /** 1-based DATA row — the header row is not row 1. */
  row: number;
  /** Translation key; the import dialog renders it in the active locale. */
  reason: MessageKey;
}

export interface TaskImportResult {
  valid: TaskInsert[];
  errors: TaskImportError[];
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The tolerant boolean vocabulary, lowercased. Anything else is a row error. */
const DONE_VALUES: Record<string, number> = {
  true: 1,
  yes: 1,
  "1": 1,
  false: 0,
  no: 0,
  "0": 0,
};

const REPEAT_VALUES = new Set<string>(["none", "daily", "weekly", "monthly"]);

/** A cell value; a column missing from the file reads as empty. */
function cell(row: Record<string, string>, name: string): string {
  return row[name] ?? "";
}

/**
 * Map parsed CSV rows to task inserts, collecting per-row errors instead of
 * failing the whole import: one bad date must not cost the user the other 200
 * good rows.
 *
 * A row is checked in column order and stops at its first bad value, so each
 * row reports the first thing the user has to fix.
 */
export function mapTaskRows(rows: Record<string, string>[]): TaskImportResult {
  const valid: TaskInsert[] = [];
  const errors: TaskImportError[] = [];

  rows.forEach((row, index) => {
    const rowNumber = index + 1;

    const title = cell(row, "title").trim();
    if (title === "") {
      errors.push({ row: rowNumber, reason: "import.reason.titleRequired" });
      return;
    }

    const dueDate = cell(row, "due_date").trim();
    if (dueDate !== "" && !DATE_PATTERN.test(dueDate)) {
      errors.push({
        row: rowNumber,
        reason: "import.reason.dueDate",
      });
      return;
    }

    const done = DONE_VALUES[cell(row, "done").trim().toLowerCase()];
    if (done === undefined) {
      errors.push({
        row: rowNumber,
        reason: "import.reason.done",
      });
      return;
    }

    const repeatRaw = cell(row, "repeat").trim();
    if (repeatRaw !== "" && !REPEAT_VALUES.has(repeatRaw)) {
      errors.push({
        row: rowNumber,
        reason: "import.reason.repeat",
      });
      return;
    }

    valid.push({
      title,
      due_date: dueDate === "" ? null : dueDate,
      done,
      repeat: repeatRaw === "" ? "none" : (repeatRaw as TaskRow["repeat"]),
      note: cell(row, "note"),
    });
  });

  return { valid, errors };
}

/**
 * Insert every accepted row in ONE batch.
 *
 * `driver.batch` is a single SQLCipher transaction on the Rust side
 * (`db::batch`, proven atomic by `db::tests::db_batch_is_atomic`), so a failing
 * statement rolls the whole import back — the test here pins the half this
 * layer owns: every row is handed over in exactly one `batch` call, never as
 * per-row `execute` writes that could commit the earlier rows.
 */
export async function insertTasks(
  driver: DataDriver,
  rows: TaskInsert[],
): Promise<void> {
  if (rows.length === 0) return;
  const createdAt = todayLocal();
  await driver.batch(
    rows.map((row) => ({
      sql: `INSERT INTO tasks (title, due_date, done, repeat, note, created_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      params: [
        row.title,
        row.due_date,
        row.done,
        row.repeat,
        row.note,
        createdAt,
      ],
    })),
  );
}
