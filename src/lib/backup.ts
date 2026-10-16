// Backup & restore (§8): a backup is a zip of `backup.json` — the manifest
// `{ app: "purple-memo", version, exportedAt, data }` with one key per table
// — plus the `photos/` tree as raw bytes. Data only: the encryption key is
// never inside the zip (it is exported separately, §5.4). Import rejects
// files not made by this app, upgrades by file version (this import path IS
// the schema-upgrade mechanism — §4, no SQL migrations), writes photo files
// first so a failure leaves the current data untouched, then replaces all
// rows in a single batch.
//
// `notes_fts` is deliberately NOT in BACKUP_TABLES: it is a derived index
// kept in sync by triggers on `notes` (schema.rs), so importing the notes
// rows rebuilds it — backing it up too would double every entry on import.

import { strFromU8, strToU8, unzipSync, zip, zipSync } from "fflate";
import type { BatchStatement, DataDriver, Row } from "../data/driver.ts";
import { sha256HexBytes } from "./crypto.ts";

export const BACKUP_APP = "purple-memo";
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_JSON_ENTRY = "backup.json";
export const PHOTOS_ZIP_PREFIX = "photos/";

// Import limits keep a user-selected archive from exhausting renderer memory
// before its manifest can be validated. fflate's filter sees ZIP metadata
// before extracting an entry, so expansion and per-entry limits are enforced
// before the corresponding bytes are allocated.
export const MAX_BACKUP_ARCHIVE_BYTES = 256 * 1024 * 1024;
export const MAX_BACKUP_EXPANDED_BYTES = 512 * 1024 * 1024;
export const MAX_BACKUP_ENTRIES = 10_000;
export const MAX_BACKUP_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_BACKUP_PHOTOS = 5_000;
export const MAX_BACKUP_PHOTO_BYTES = 25 * 1024 * 1024;

/**
 * Row ceiling for one import (review H-5). Every other resource in an import
 * was bounded — archive bytes, expanded bytes, entries, manifest bytes, photo
 * count — but the manifest's *row* count was not, so a 16 MB manifest
 * (well inside `MAX_BACKUP_MANIFEST_BYTES`) could expand to ~10^5 rows. Each
 * one becomes a JS statement object held in renderer memory until the batch
 * is handed to Rust.
 *
 * The cap is set against that memory, not against plausibility: a statement
 * costs roughly half a kilobyte with its params array, so 100 000 rows is
 * ~50 MB — a lot, but survivable on a desktop during a deliberate "replace
 * everything" operation. It is still ~27x a decade of daily journal entries,
 * so it rejects a pathological or hand-crafted manifest rather than any real
 * backup.
 *
 * The import stays ONE transaction on purpose. Chunking the batch would bound
 * memory further, but a failure between chunks would leave the database half
 * replaced — far worse than a refused import.
 */
export const MAX_BACKUP_ROWS = 100_000;

/**
 * Export cap (review M-02). The import path refuses an archive above
 * `MAX_BACKUP_ARCHIVE_BYTES`, so an archive this app writes must stay under
 * that: a backup it could not restore is worse than no export button at all.
 * Photos are stored already compressed, so the photo payload is essentially
 * the archive; the manifest allowance keeps the sum honest.
 */
export const MAX_EXPORT_PHOTO_BYTES =
  MAX_BACKUP_ARCHIVE_BYTES - MAX_BACKUP_MANIFEST_BYTES;

/** Whole mebibytes, for messages a person reads. */
function mib(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/** The 28 data tables (the 29th, notes_fts, is trigger-maintained). */
export const BACKUP_TABLES = [
  "collections",
  "notes",
  "journal_entries",
  "wallets",
  "income_categories",
  "expense_categories",
  "income_entries",
  "expense_entries",
  "expense_limits",
  "recurring_payments",
  "shops",
  "jobs",
  "payables",
  "loans",
  "shopping_lists",
  "shopping_items",
  "habits",
  "habit_logs",
  "tasks",
  "reminders",
  "contacts",
  "contact_channels",
  "contact_tags",
  "memories",
  "photos",
  "photo_refs",
  "vault_items",
  "settings",
];

export interface BackupPayload {
  app: string;
  version: number;
  exportedAt: string;
  data: Record<string, Row[]>;
}

export interface BackupPhotoEntry {
  /** Relative path inside the zip, e.g. `photos/2026/10/<sha256>.jpg`. */
  path: string;
  /** Raw bytes, never a `number[]` (review M-02). */
  bytes: Uint8Array;
}

export interface ParsedBackup {
  payload: BackupPayload;
  photos: BackupPhotoEntry[];
}

export interface BackupSummary {
  exportedAt: string;
  tableCount: number;
  rowCount: number;
  photoCount: number;
}

export interface BackupApplyResult {
  tables: number;
  rows: number;
  photos: number;
}

export interface ExportBudget {
  /** Bytes of the photos this export would read into the archive. */
  bytes: number;
  photos: number;
  /** False when the library is too large for one importable archive. */
  ok: boolean;
  /** The cap `bytes` was measured against. */
  limit: number;
}

/**
 * Pure: can this library be exported as ONE archive? `size_bytes` is stored on
 * every `photos` row, so the answer needs no bytes to be read — which is the
 * point: a refused export must not first pull the whole library through IPC.
 * A row with a nonsense size counts as zero rather than poisoning the sum.
 */
export function exportBudget(
  rows: { size_bytes: number }[],
  limit: number = MAX_EXPORT_PHOTO_BYTES,
): ExportBudget {
  let bytes = 0;
  for (const row of rows) {
    const size = Number(row.size_bytes);
    if (Number.isFinite(size) && size > 0) bytes += size;
  }
  return { bytes, photos: rows.length, ok: bytes <= limit, limit };
}

/** Read every data table + photo bytes into a storable backup (§8). */
export async function readBackupData(
  driver: DataDriver,
): Promise<{ payload: BackupPayload; photos: BackupPhotoEntry[] }> {
  const data: Record<string, Row[]> = {};
  for (const table of BACKUP_TABLES) {
    data[table] = await driver.query<Row>(`SELECT * FROM ${table}`);
  }
  const photoRows = await driver.query<{
    rel_path: string;
    size_bytes: number;
  }>("SELECT rel_path, size_bytes FROM photos ORDER BY id");
  const budget = exportBudget(photoRows);
  if (!budget.ok) {
    throw new Error(
      `This library holds about ${mib(budget.bytes)} MiB of photos, more than the ${mib(budget.limit)} MiB one backup can hold. Delete some photos (or export after removing the largest ones) and try again — the library was not touched.`,
    );
  }
  const photos: BackupPhotoEntry[] = [];
  for (const row of photoRows) {
    photos.push({
      path: row.rel_path,
      bytes: await driver.readPhoto(row.rel_path),
    });
  }
  return {
    payload: {
      app: BACKUP_APP,
      version: BACKUP_FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      data,
    },
    photos,
  };
}

/**
 * Zip the manifest + photos tree into backup bytes (fflate, §3).
 *
 * Async on purpose (review M-02): `zipSync` deflates the whole archive on the
 * UI thread, which freezes the window for minutes on a photo-heavy library.
 * fflate's async path does the deflate in a Web Worker. If that worker cannot
 * be created — a CSP that does not allow blob workers, or an old webview — the
 * blocking path still produces the archive, because a complete backup the user
 * must wait for beats an export that fails outright; the cap above is what
 * bounds the work either way.
 */
export async function buildBackupZip(
  payload: BackupPayload,
  photos: BackupPhotoEntry[],
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {
    [BACKUP_JSON_ENTRY]: strToU8(JSON.stringify(payload)),
  };
  for (const photo of photos) {
    files[photo.path] = photo.bytes;
  }
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      zip(files, (error, data) =>
        error ? reject(error) : resolve(data as Uint8Array),
      );
    });
  } catch {
    return zipSync(files);
  }
}

/**
 * The version-upgrade seam (§4): map an older backup format forward to the
 * current one. Format 1 is the baseline and maps to itself; anything newer
 * is rejected by the caller before this runs, anything unknown is rejected
 * here — a future schema change adds a case AND a `user_version` bump.
 */
function upgradeBackupData(payload: BackupPayload): BackupPayload {
  switch (payload.version) {
    case BACKUP_FORMAT_VERSION:
      return payload;
    default:
      throw new Error(
        `Unsupported backup version ${payload.version} — this app only reads version ${BACKUP_FORMAT_VERSION}.`,
      );
  }
}

function parseBackupJson(text: string): BackupPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("backup.json is not valid JSON — import rejected.");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("backup.json is corrupt — import rejected.");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.app !== BACKUP_APP) {
    throw new Error("Not a Purple Memo backup — import rejected.");
  }
  if (typeof obj.version !== "number") {
    throw new Error("backup.json is corrupt (no version) — import rejected.");
  }
  if (obj.version > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `This backup was made by a newer version (${obj.version}) — update the app before importing.`,
    );
  }
  if (typeof obj.exportedAt !== "string") {
    throw new Error(
      "backup.json is corrupt (no export date) — import rejected.",
    );
  }
  if (
    typeof obj.data !== "object" ||
    obj.data === null ||
    Array.isArray(obj.data)
  ) {
    throw new Error("backup.json is corrupt (no data) — import rejected.");
  }
  let totalRows = 0;
  for (const table of BACKUP_TABLES) {
    const rows = (obj.data as Record<string, unknown>)[table];
    if (rows !== undefined && !Array.isArray(rows)) {
      throw new Error(
        `backup.json is corrupt (table ${table}) — import rejected.`,
      );
    }
    totalRows += rows === undefined ? 0 : rows.length;
    if (totalRows > MAX_BACKUP_ROWS) {
      throw new Error(
        `Backup holds more than ${MAX_BACKUP_ROWS.toLocaleString()} rows — import rejected.`,
      );
    }
  }
  return upgradeBackupData({
    app: obj.app,
    version: obj.version,
    exportedAt: obj.exportedAt,
    data: obj.data as Record<string, Row[]>,
  });
}

/** Unzip + validate a backup file without touching the database. */
export function parseBackupZip(bytes: Uint8Array): ParsedBackup {
  if (bytes.byteLength > MAX_BACKUP_ARCHIVE_BYTES) {
    throw new Error(
      `Backup archive is larger than the ${MAX_BACKUP_ARCHIVE_BYTES} byte limit — import rejected.`,
    );
  }
  let entryCount = 0;
  let expandedBytes = 0;
  let photoCount = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes, {
      filter: ({ name, originalSize }) => {
        entryCount += 1;
        if (entryCount > MAX_BACKUP_ENTRIES) {
          throw new Error(
            `Backup contains more than ${MAX_BACKUP_ENTRIES} entries — import rejected.`,
          );
        }
        if (!Number.isSafeInteger(originalSize) || originalSize < 0) {
          throw new Error(
            "Backup contains an invalid entry size — import rejected.",
          );
        }
        expandedBytes += originalSize;
        if (expandedBytes > MAX_BACKUP_EXPANDED_BYTES) {
          throw new Error(
            `Backup expands beyond the ${MAX_BACKUP_EXPANDED_BYTES} byte limit — import rejected.`,
          );
        }
        if (name === BACKUP_JSON_ENTRY) {
          if (originalSize > MAX_BACKUP_MANIFEST_BYTES) {
            throw new Error(
              `backup.json is larger than the ${MAX_BACKUP_MANIFEST_BYTES} byte limit — import rejected.`,
            );
          }
          return true;
        }
        if (!name.startsWith(PHOTOS_ZIP_PREFIX)) return false;
        photoCount += 1;
        if (photoCount > MAX_BACKUP_PHOTOS) {
          throw new Error(
            `Backup contains more than ${MAX_BACKUP_PHOTOS} photos — import rejected.`,
          );
        }
        if (originalSize > MAX_BACKUP_PHOTO_BYTES) {
          throw new Error(
            `A backup photo is larger than the ${MAX_BACKUP_PHOTO_BYTES} byte limit — import rejected.`,
          );
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("import rejected")) {
      throw error;
    }
    throw new Error("Not a valid zip file — import rejected.");
  }
  const manifest = entries[BACKUP_JSON_ENTRY];
  if (!manifest) {
    throw new Error(
      `No ${BACKUP_JSON_ENTRY} inside — not a Purple Memo backup.`,
    );
  }
  const payload = parseBackupJson(strFromU8(manifest));
  const photos: BackupPhotoEntry[] = [];
  for (const [name, content] of Object.entries(entries)) {
    if (name === BACKUP_JSON_ENTRY || !name.startsWith(PHOTOS_ZIP_PREFIX)) {
      continue;
    }
    photos.push({ path: name, bytes: content });
  }
  return { payload, photos };
}

export function summarizeBackup(parsed: ParsedBackup): BackupSummary {
  let rowCount = 0;
  for (const table of BACKUP_TABLES) {
    rowCount += parsed.payload.data[table]?.length ?? 0;
  }
  return {
    exportedAt: parsed.payload.exportedAt,
    tableCount: BACKUP_TABLES.length,
    rowCount,
    photoCount: parsed.photos.length,
  };
}

/**
 * Table and column names are interpolated into SQL (values are always bound
 * as `?`), and they come out of a user-supplied backup file — so they are
 * checked against a strict identifier grammar first. A name is a plain
 * `[A-Za-z_][A-Za-z0-9_]*`; anything else means the file is hostile or
 * corrupt, and import stops before a single byte is written.
 */
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function requireIdentifier(name: string, kind: string): string {
  if (!IDENTIFIER.test(name)) {
    throw new Error(
      `Backup contains an invalid ${kind} name ${JSON.stringify(name)} — import cancelled.`,
    );
  }
  return name;
}

function insertStatement(table: string, row: Row): BatchStatement {
  requireIdentifier(table, "table");
  const cols = Object.keys(row).map((c) => requireIdentifier(c, "column"));
  return {
    sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
    params: cols.map((c) => row[c]),
  };
}

/**
 * Replace ALL current data with the backup's (destructive by design — the
 * UI confirms before calling). Photo files are written first: savePhoto
 * re-hashes bytes content-addressed, so a tampered zip entry lands at its
 * real hash path and the row is re-pointed there — the DB can never reference
 * a file that does not exist. Then one batch deletes every table and inserts
 * the imported rows; FK is off only around that batch (table order is then
 * irrelevant) and restored in a finally, so a failed import rolls back and
 * never leaves the connection in FK-off mode.
 */
export async function applyBackup(
  driver: DataDriver,
  parsed: ParsedBackup,
): Promise<BackupApplyResult> {
  const oldPaths = (
    await driver.query<{ rel_path: string }>("SELECT rel_path FROM photos")
  ).map((row) => row.rel_path);

  const byPath = new Map(parsed.photos.map((p) => [p.path, p]));
  let rows = 0;
  let photoCount = 0;
  const kept = new Set<string>();
  // Photo rows are copied before any path is re-pointed, so a tampered entry
  // never mutates the caller's parsed payload (the UI still holds it for a
  // retry after a failed import).
  const photoRows: Row[] = (parsed.payload.data.photos ?? []).map((r) => ({
    ...r,
  }));
  const created = new Set<string>();
  try {
    for (const row of photoRows) {
      const relPath = row.rel_path as string;
      const ext = row.ext as string;
      const entry = byPath.get(relPath);
      if (!entry) {
        throw new Error(
          `Backup is missing the file for ${relPath} — import cancelled.`,
        );
      }
      const saved = await driver.savePhoto(entry.bytes, ext);
      if (!oldPaths.includes(saved)) created.add(saved);
      if (saved !== relPath) {
        // The bytes in the zip disagree with the manifest (tampered or
        // corrupted entry), so the content-addressed path moved. Re-point the
        // row AND correct the columns that describe those bytes — a row whose
        // sha256/size_bytes still describe the old content is internally
        // inconsistent, and the schema does not catch it.
        row.rel_path = saved;
        row.sha256 = await sha256HexBytes(entry.bytes);
        row.size_bytes = entry.bytes.length;
      }
      kept.add(saved);
      photoCount++;
    }

    const data: Record<string, Row[]> = {
      ...parsed.payload.data,
      photos: photoRows,
    };

    await driver.execute("PRAGMA foreign_keys = OFF");
    try {
      const statements: BatchStatement[] = BACKUP_TABLES.map((table) => ({
        sql: `DELETE FROM ${table}`,
      }));
      for (const table of BACKUP_TABLES) {
        for (const row of data[table] ?? []) {
          statements.push(insertStatement(table, row));
          rows++;
        }
      }
      await driver.batch(statements);
    } finally {
      await driver.execute("PRAGMA foreign_keys = ON").catch(() => {
        // Best-effort: FK restore failing (e.g. the connection died during
        // the batch) is logged here but must not mask the batch error — or
        // the import success — the caller needs to see, and must not leave
        // the session silently FK-off. Swallowing it in `.catch` keeps the
        // original rejection from `batch` propagating out of this `finally`.
        console.error(
          "[backup] failed to restore foreign_keys = ON after import",
        );
      });
    }
  } catch (error) {
    for (const path of created)
      await driver.deletePhoto(path).catch(() => undefined);
    throw error;
  }

  // Files the imported backup no longer references are orphans now — they
  // are deleted only after the batch committed, so a failed import always
  // leaves rows and files consistent. A failed unlink is ignored: an orphan
  // file is harmless and must not mask a successful import.
  for (const path of oldPaths) {
    if (kept.has(path)) continue;
    await driver.deletePhoto(path).catch(() => undefined);
  }
  return { tables: BACKUP_TABLES.length, rows, photos: photoCount };
}

export function createBackupRepo(driver: DataDriver) {
  return {
    /** Build the backup zip bytes (caller saves the file wherever it wants). */
    async exportBackup(): Promise<{
      bytes: Uint8Array;
      summary: BackupSummary;
    }> {
      const parsed = await readBackupData(driver);
      return {
        bytes: await buildBackupZip(parsed.payload, parsed.photos),
        summary: summarizeBackup(parsed),
      };
    },

    /** Parse + validate without touching the DB (for the confirm step). */
    async inspectBackup(bytes: Uint8Array): Promise<{
      parsed: ParsedBackup;
      summary: BackupSummary;
    }> {
      const parsed = parseBackupZip(bytes);
      return { parsed, summary: summarizeBackup(parsed) };
    },

    /** Parse + validate + apply (the confirmed import). */
    async importBackup(bytes: Uint8Array): Promise<BackupApplyResult> {
      return applyBackup(driver, parseBackupZip(bytes));
    },
  };
}
