// Backup & restore: a backup is a zip of `backup.json` — the manifest
// `{ app: "purple-memo", version, exportedAt, data }` with one key per table
// — plus the `photos/` tree as raw bytes. Data only: the encryption key is
// never inside the zip (it is exported separately). Import rejects
// files not made by this app, upgrades by payload version, writes photo files
// first so a failure leaves the current data untouched, then replaces all
// rows in a single batch.
//
// Schema migrations are the app's own job (`schema.rs`) — this import path
// upgrades the PAYLOAD format only, table by table, so a v1 archive still
// opens in a v2 app. A payload is never asked to migrate the database.
//
// `notes_fts` is deliberately NOT in BACKUP_TABLES: it is a derived index
// kept in sync by triggers on `notes` (schema.rs), so importing the notes
// rows rebuilds it — backing it up too would double every entry on import.
//
// A backup is a plain zip unless the user asks for a password, in which case
// the zip is sealed inside the fixed container in `backupContainer.ts` and
// saved with a `.pmbk` extension. The inner format is identical either way, so
// every limit below runs on the same bytes: once on the sealed file (the
// container overhead) and once on the authenticated archive inside it.

import { strFromU8, strToU8, unzipSync, zip, zipSync } from "fflate";
import type { BatchStatement, DataDriver, Row } from "../data/driver.ts";
import {
  BACKUP_CONTAINER_OVERHEAD_BYTES,
  isEncryptedBackup,
  openBackupContainer,
  sealBackupContainer,
} from "./backupContainer.ts";
import { sha256HexBytes } from "./crypto.ts";
import {
  isLinkableType,
  linkIsCanonical,
  linkIsSelfReferential,
} from "./entityLinks.ts";
import { validateTrashPayload } from "./trash.ts";
import type { LinkableEntityType } from "./types.ts";

export const BACKUP_APP = "purple-memo";
/**
 * Payload version. v2 adds the quick-capture inbox; v1 remains importable and
 * upgrades with an empty `inbox_items`, because a capture inbox that vanished
 * on upgrade would be data loss dressed as a migration.
 */
export const BACKUP_FORMAT_VERSION = 4;
export const BACKUP_JSON_ENTRY = "backup.json";
export const PHOTOS_ZIP_PREFIX = "photos/";

// Import limits keep a user-selected archive from exhausting renderer memory
// before its manifest can be validated. fflate's filter sees ZIP metadata
// before extracting an entry, so expansion and per-entry limits are enforced
// before the corresponding bytes are allocated.
//
// 128 MiB, not 256: measured the whole-buffer encrypted
// path (`scripts/measure-backup-limits.mjs`) on the target Windows machine. At
// 256 MiB the export peaked at ~1.26 GB process RSS and the import at ~1.19 GB,
// because a password-protected archive holds the archive and its ciphertext at
// the same time. At 128 MiB the peaks are ~740 MB and ~647 MB. The approved
// limits are recorded in docs/RELEASE.md.
export const MAX_BACKUP_ARCHIVE_BYTES = 128 * 1024 * 1024;
export const MAX_BACKUP_EXPANDED_BYTES = 512 * 1024 * 1024;
export const MAX_BACKUP_ENTRIES = 10_000;
export const MAX_BACKUP_MANIFEST_BYTES = 16 * 1024 * 1024;
export const MAX_BACKUP_PHOTOS = 5_000;
export const MAX_BACKUP_PHOTO_BYTES = 25 * 1024 * 1024;

/**
 * The most bytes an encrypted backup may occupy: the same archive ceiling plus
 * the container's header and authentication tag.
 *
 * Checked on the sealed file BEFORE anything is decrypted, so a hostile or
 * simply enormous input never gets to allocate a plaintext copy of itself.
 */
export const MAX_ENCRYPTED_BACKUP_BYTES =
  MAX_BACKUP_ARCHIVE_BYTES + BACKUP_CONTAINER_OVERHEAD_BYTES;

/** The size rule as one pure predicate, so the order of checks is testable. */
export function exceedsEncryptedBackupCap(byteLength: number): boolean {
  return byteLength > MAX_ENCRYPTED_BACKUP_BYTES;
}

/**
 * Row ceiling for one import. Every other resource in an import
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
 * Export cap. The import path refuses an archive above
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

/** The 31 data tables (the 32nd, notes_fts, is trigger-maintained). */
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
  "inbox_items",
  "links",
  "trash_items",
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
  /** Raw bytes, never a `number[]`. */
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
  /**
   * False when the library cannot produce an importable archive: either the
   * photos exceed the total cap, or a SINGLE photo exceeds
   * [`MAX_BACKUP_PHOTO_BYTES`] — inspection refuses those on restore, so an
   * export that included one would write a backup this app cannot read back
   * (E6).
   */
  ok: boolean;
  /** The cap `bytes` was measured against. */
  limit: number;
  /** The largest single photo, so the caller can name it in the refusal. */
  largest: number;
}

/**
 * Pure: can this library be exported as ONE archive? `size_bytes` is stored on
 * every `photos` row, so the answer needs no bytes to be read — which is the
 * point: a refused export must not first pull the whole library through IPC.
 * A row with a nonsense size counts as zero rather than poisoning the sum.
 *
 * The per-photo check (E6) is deliberately part of `ok`: it is decided from
 * the same stored sizes, before a single byte is read or a destination file
 * is touched — the moment to refuse an oversized library is BEFORE the
 * export replaces the previous backup with an unrestorable one.
 */
export function exportBudget(
  rows: { size_bytes: number }[],
  limit: number = MAX_EXPORT_PHOTO_BYTES,
): ExportBudget {
  let bytes = 0;
  let largest = 0;
  for (const row of rows) {
    const size = Number(row.size_bytes);
    if (Number.isFinite(size) && size > 0) {
      bytes += size;
      if (size > largest) largest = size;
    }
  }
  return {
    bytes,
    photos: rows.length,
    ok: bytes <= limit && largest <= MAX_BACKUP_PHOTO_BYTES,
    limit,
    largest,
  };
}

/** Read every data table + photo bytes into a storable backup. */
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
    if (budget.largest > MAX_BACKUP_PHOTO_BYTES) {
      // E6: name the offending photo rather than the total — the total may
      // be perfectly fine, and the user needs to know which single file makes
      // the archive un-restorable. Nothing was read, nothing was written.
      throw new Error(
        `One photo in this library is ${budget.largest} bytes — over the ${mib(MAX_BACKUP_PHOTO_BYTES)} MiB a single backup photo may be, so any backup containing it would be refused on restore. Delete or replace that photo and export again; the library was not touched and no backup file was written.`,
      );
    }
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
 * Zip the manifest + photos tree into backup bytes (fflate).
 *
 * Async on purpose: `zipSync` deflates the whole archive on the
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
 * The version-upgrade seam: map an older backup format forward to the
 * current one. Anything newer is rejected by the caller before this runs,
 * anything unknown is rejected here.
 *
 * Older payloads gain each table introduced by a later version as an empty
 * array. The reader can then treat every current table as present.
 */
function upgradeBackupData(payload: BackupPayload): BackupPayload {
  switch (payload.version) {
    case BACKUP_FORMAT_VERSION:
      return payload;
    case 1:
      return {
        ...payload,
        version: BACKUP_FORMAT_VERSION,
        data: { ...payload.data, inbox_items: [], links: [], trash_items: [] },
      };
    case 2:
      // v2 has the capture inbox but no relationships table.
      return {
        ...payload,
        version: BACKUP_FORMAT_VERSION,
        data: { ...payload.data, links: [], trash_items: [] },
      };
    case 3:
      // v3 has links but no Trash table.
      return {
        ...payload,
        version: BACKUP_FORMAT_VERSION,
        data: { ...payload.data, trash_items: [] },
      };
    default:
      throw new Error(
        `Unsupported backup version ${payload.version} — this app only reads version ${BACKUP_FORMAT_VERSION}.`,
      );
  }
}

/**
 * Reject a payload whose relationships could not have been created by this app.
 *
 * Runs during `parseBackupJson`, which is BEFORE any photo file is written and
 * before the single batch that replaces every table — so a malformed archive is
 * refused with the workspace untouched, rather than half-imported.
 *
 * Four things are checked, and each one is a case that would otherwise produce a
 * relationship the app cannot show or repair:
 *
 * - unknown `kind` or endpoint type — the table's CHECK would refuse it;
 * - a self-link — refused, in both directions;
 * - a pair that is not in canonical order, or the same pair twice — the UNIQUE
 *   constraint would refuse it, but as an opaque error mid-batch;
 * - an endpoint that is not in the payload's own note/task/contact rows.
 *   Nothing in SQL can catch this one (the pair is polymorphic), and it is the
 *   one that matters: it is how an import silently retargets a relationship to
 *   a different row that happens to take the id.
 */
function validateLinks(payload: BackupPayload): void {
  const links = payload.data.links;
  if (!Array.isArray(links) || links.length === 0) return;
  const idsByType: Record<LinkableEntityType, Set<number>> = {
    note: new Set(),
    task: new Set(),
    contact: new Set(),
  };
  for (const [type, table] of [
    ["note", "notes"],
    ["task", "tasks"],
    ["contact", "contacts"],
  ] as const) {
    for (const row of payload.data[table] ?? []) {
      const id = (row as Row).id;
      if (typeof id === "number") idsByType[type].add(id);
    }
  }
  const seen = new Set<string>();
  for (const [index, raw] of links.entries()) {
    const row = raw as Row;
    const kind = row.kind;
    const a = row.type_a;
    const b = row.type_b;
    const idA = row.id_a;
    const idB = row.id_b;
    const reject = (why: string): never => {
      throw new Error(
        `Backup links row ${index + 1} is not a valid relationship (${why}) — import rejected, nothing was changed.`,
      );
    };
    if (kind !== "related") reject("unknown kind");
    if (!isLinkableType(String(a)) || !isLinkableType(String(b))) {
      reject("unknown entity type");
    }
    if (typeof idA !== "number" || typeof idB !== "number") {
      reject("missing endpoint");
    }
    const rowTyped = {
      type_a: a as LinkableEntityType,
      id_a: idA as number,
      type_b: b as LinkableEntityType,
      id_b: idB as number,
    };
    if (linkIsSelfReferential(rowTyped)) reject("an item linked to itself");
    if (!linkIsCanonical(rowTyped)) reject("the two ends are out of order");
    const key = `${rowTyped.type_a}:${rowTyped.id_a}|${rowTyped.type_b}:${rowTyped.id_b}`;
    if (seen.has(key)) reject("the same pair appears twice");
    seen.add(key);
    for (const end of [
      rowTyped,
      {
        ...rowTyped,
        type_a: rowTyped.type_b,
        id_a: rowTyped.id_b,
        type_b: rowTyped.type_a,
        id_b: rowTyped.id_a,
      },
    ]) {
      if (!idsByType[end.type_a].has(end.id_a)) {
        reject(
          `it points at ${end.type_a} #${end.id_a}, which is not in this backup`,
        );
      }
    }
  }
}

/**
 * Re-check the size limits against the bytes that were ACTUALLY extracted,
 * not the sizes the ZIP headers declared (review P3-26).
 *
 * The `filter` above sums `originalSize`, which is read straight out of the
 * archive and is therefore attacker-controlled. A zip can declare 1 KB per
 * entry and expand to a gigabyte, passing the pre-check and decompressing
 * anyway. fflate does bound each entry while inflating, so this is
 * defense-in-depth rather than a live hole — but the pre-check was the only
 * thing standing between a crafted archive and `MAX_BACKUP_EXPANDED_BYTES` of
 * allocation, and it was measuring the wrong number.
 *
 * Measuring after extraction is the independent version of the same bound: it
 * cannot be lied to, because it counts what is in memory.
 *
 * Exported for direct testing: the zip that would trip the real 512 MB ceiling
 * is far too large to build in a test, so the *rule* is tested here with
 * synthetic entries and the *ordering* is asserted by reading the source.
 */
export function assertExpandedLimits(
  entries: Record<string, Uint8Array>,
): void {
  let expandedBytes = 0;
  let photoCount = 0;
  for (const [name, data] of Object.entries(entries)) {
    expandedBytes += data.length;
    if (expandedBytes > MAX_BACKUP_EXPANDED_BYTES) {
      throw new Error(
        `Backup expands beyond the ${MAX_BACKUP_EXPANDED_BYTES} byte limit — import rejected.`,
      );
    }
    if (name === BACKUP_JSON_ENTRY) {
      if (data.length > MAX_BACKUP_MANIFEST_BYTES) {
        throw new Error(
          `backup.json is larger than the ${MAX_BACKUP_MANIFEST_BYTES} byte limit — import rejected.`,
        );
      }
      continue;
    }
    if (!name.startsWith(PHOTOS_ZIP_PREFIX)) continue;
    photoCount += 1;
    if (photoCount > MAX_BACKUP_PHOTOS) {
      throw new Error(
        `Backup contains more than ${MAX_BACKUP_PHOTOS} photos — import rejected.`,
      );
    }
    if (data.length > MAX_BACKUP_PHOTO_BYTES) {
      throw new Error(
        `A backup photo is larger than the ${MAX_BACKUP_PHOTO_BYTES} byte limit — import rejected.`,
      );
    }
  }
}

/**
 * The refusal for a current-format manifest that does not name every table
 * (decision D1, option a).
 *
 * The exporter writes all {@link BACKUP_TABLES} on every save, and
 * {@link upgradeBackupData} adds the tables an *older* format could not know
 * about — so at the current version an absent key is not "an empty table", it
 * is a file this app did not write (hand-edited, truncated, or produced by a
 * different tool). Accepting it as empty is the dangerous direction:
 * `applyBackup` deletes every table and then inserts `data[table] ?? []`, so
 * one missing key would silently wipe that table's live rows.
 */
function incompleteBackupError(missing: string[]): Error {
  const shown = missing.slice(0, 6).join(", ");
  const rest = missing.length > 6 ? `, … and ${missing.length - 6} more` : "";
  const what =
    missing.length === 1
      ? `table ${shown}`
      : `${missing.length} tables (${shown}${rest})`;
  return new Error(
    `backup.json is incomplete: this version ${BACKUP_FORMAT_VERSION} backup is missing ${what}, but a backup this app writes always contains all ${BACKUP_TABLES.length} tables. Importing it would empty the tables it leaves out — import rejected.`,
  );
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
  const missing: string[] = [];
  for (const table of BACKUP_TABLES) {
    const rows = (obj.data as Record<string, unknown>)[table];
    if (rows === undefined) {
      // D1(a): only an *older* format may leave a table out — the upgrade
      // fills those in. A current-format manifest must name every one, or
      // importing it would delete the live table it omits.
      if (obj.version === BACKUP_FORMAT_VERSION) missing.push(table);
      continue;
    }
    if (!Array.isArray(rows)) {
      throw new Error(
        `backup.json is corrupt (table ${table}) — import rejected.`,
      );
    }
    totalRows += rows.length;
    if (totalRows > MAX_BACKUP_ROWS) {
      throw new Error(
        `Backup holds more than ${MAX_BACKUP_ROWS.toLocaleString()} rows — import rejected.`,
      );
    }
  }
  if (missing.length > 0) {
    throw incompleteBackupError(missing);
  }
  const upgraded = upgradeBackupData({
    app: obj.app,
    version: obj.version,
    exportedAt: obj.exportedAt,
    data: obj.data as Record<string, Row[]>,
  });
  // After the upgrade, so a v2 payload's absent `links` key is not mistaken for
  // "no validation needed" — and still before a single byte is written.
  validateLinks(upgraded);
  const trashItems = upgraded.data.trash_items ?? [];
  if (!Array.isArray(trashItems)) {
    throw new Error(
      "backup.json is corrupt (table trash_items) — import rejected.",
    );
  }
  const ids = (table: string) =>
    new Set((upgraded.data[table] ?? []).map((row) => Number(row.id)));
  validateTrashPayload(trashItems, {
    photoIds: ids("photos"),
    liveEntities: new Map([
      ["note", ids("notes")],
      ["task", ids("tasks")],
      ["contact", ids("contacts")],
    ]),
    inboxRows: upgraded.data.inbox_items ?? [],
  });
  return upgraded;
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
    // The declared sizes above are a cheap first pass only; this is the one
    // that counts real bytes.
    assertExpandedLimits(entries);
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
 *
 * `lease` is the import exclusion window's lease (E5): every write below
 * carries it, so while the window is open no OTHER writer — a quick capture,
 * a gallery save — can commit behind the safety copy's snapshot. The window
 * itself is claimed and released by [`createBackupRepo`]'s `importBackup`,
 * which spans this whole function. Test drivers without the lease methods
 * pass `undefined` and have no barrier to cross.
 */
export async function applyBackup(
  driver: DataDriver,
  parsed: ParsedBackup,
  lease?: number,
): Promise<BackupApplyResult> {
  const oldPaths = (
    await driver.query<{ rel_path: string }>("SELECT rel_path FROM photos")
  ).map((row) => row.rel_path);
  // Membership, not a scan (review P3-28). oldPaths.includes inside the per-photo
  // loop was O(photos * paths): a 5000-photo library spent 25M string
  // comparisons on an import that then did nothing with the answer. Both loops
  // below only ever ask whether a path was already there.
  const oldPathSet = new Set(oldPaths);

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
      const saved = await driver.savePhoto(entry.bytes, ext, lease);
      if (!oldPathSet.has(saved)) created.add(saved);
      // Backup metadata is untrusted; derive every content field from the
      // bytes even when the stored path already matches.
      row.rel_path = saved;
      row.sha256 = await sha256HexBytes(entry.bytes);
      row.size_bytes = entry.bytes.length;
      kept.add(saved);
      photoCount++;
    }

    const data: Record<string, Row[]> = {
      ...parsed.payload.data,
      photos: photoRows,
    };

    await driver.execute("PRAGMA foreign_keys = OFF", undefined, lease);
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
      // Referential integrity check INSIDE the batch transaction (review
      // P3-5): the payload was parsed, not produced by this app, and the
      // batch runs FK-off — a hand-crafted file could otherwise commit rows
      // whose parent row does not exist, which every later read then trips
      // over. `pragma_foreign_key_check` reports those rows even with
      // enforcement off, and this canary turns any report into a statement
      // failure — which rolls the whole batch back (DELETEs included), so a
      // refused import leaves the pre-import data exactly as it was.
      //
      // The failure is recognized by its statement index — the canary is
      // always the last statement — and rephrased here: the raw SQLite text
      // ("NOT NULL constraint failed…") would say nothing the user can act
      // on, and a failure at any OTHER index keeps its own message.
      const canary = statements.length;
      statements.push({
        sql: "INSERT INTO settings (key, value) SELECT 'import-fk-check', NULL WHERE EXISTS (SELECT 1 FROM pragma_foreign_key_check)",
      });
      try {
        await driver.batch(statements, lease);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        const failed = /batch statement (\d+) failed/.exec(text);
        if (failed !== null && Number(failed[1]) === canary) {
          throw new Error(
            "This backup's data refers to rows the backup does not contain, so it cannot be imported safely — import cancelled; your current data was not changed.",
          );
        }
        throw error;
      }
    } finally {
      await driver
        .execute("PRAGMA foreign_keys = ON", undefined, lease)
        .catch(() => {
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
      await driver.deletePhoto(path, lease).catch(() => undefined);
    throw error;
  }

  // Files the imported backup no longer references are orphans now — they
  // are deleted only after the batch committed, so a failed import always
  // leaves rows and files consistent. A failed unlink is ignored: an orphan
  // file is harmless and must not mask a successful import.
  //
  // The residual window this does NOT cover: if the process dies between
  // `savePhoto` above and the committed batch, the files written so far stay
  // on disk with no row pointing at them. Caught failures are cleaned up
  // above; a crash is not. There is no startup orphan sweep, because adding
  // one needs approval — so the honest statement is "a crashed import can
  // leave unreferenced photo files behind", not "import is atomic".
  for (const path of oldPaths) {
    if (kept.has(path)) continue;
    await driver.deletePhoto(path, lease).catch(() => undefined);
  }
  return { tables: BACKUP_TABLES.length, rows, photos: photoCount };
}

/**
 * The zip archive inside whatever the user picked.
 *
 * Unencrypted input is returned untouched, so its behaviour is byte-for-byte
 * what it always was. Encrypted input is size-bounded first, then opened with
 * the password; a refusal here happens before any database or photo write, so
 * a wrong password leaves the workspace exactly as it was.
 */
async function innerArchive(
  bytes: Uint8Array,
  password?: string,
): Promise<Uint8Array> {
  if (!isEncryptedBackup(bytes)) return bytes;
  if (exceedsEncryptedBackupCap(bytes.byteLength)) {
    throw new Error(
      `Backup archive is larger than the ${MAX_ENCRYPTED_BACKUP_BYTES} byte limit — import rejected.`,
    );
  }
  if (password === undefined || password === "") {
    throw new Error(
      "This backup is password-protected — enter its password to import it.",
    );
  }
  return openBackupContainer(bytes, password);
}

/**
 * Lifecycle hooks the composition root attaches to the backup repo (J5).
 *
 * `onBeforeImport` runs at the top of `importBackup`, before the first
 * write — the moment old in-memory state must stop being trusted, whichever
 * caller runs the import.
 */
export interface BackupRepoHooks {
  /**
   * Called before an import replaces every table. `app.ts` uses this to
   * `vaultRepo.lockVault()`: the vault's derived-`CryptoKey` cache belongs
   * to rows that are about to be gone, and a key that survives the import
   * both decrypts nothing and answers a later open of a same-id imported
   * item with the OLD salt's key — a false "wrong password" (J5). Locking
   * here makes the invalidation unconditional, not a duty every import
   * caller must remember.
   */
  onBeforeImport?: () => void;
}

export function createBackupRepo(
  driver: DataDriver,
  hooks: BackupRepoHooks = {},
) {
  return {
    /**
     * Build the backup bytes (caller saves the file wherever it wants).
     *
     * With a password the archive is sealed in the container; without one the
     * bytes are the zip exactly as before. The photo buffers are dropped
     * before the seal, because encryption allocates a second copy of the same
     * library and both together are what the memory limits bound.
     */
    async exportBackup(password?: string): Promise<{
      bytes: Uint8Array;
      summary: BackupSummary;
      encrypted: boolean;
    }> {
      const parsed = await readBackupData(driver);
      const summary = summarizeBackup(parsed);
      const archive = await buildBackupZip(parsed.payload, parsed.photos);
      parsed.photos.length = 0;
      return {
        bytes:
          password === undefined
            ? archive
            : await sealBackupContainer(archive, password),
        summary,
        encrypted: password !== undefined,
      };
    },

    /**
     * Write the exported archive to the file the user picked (review P1-1).
     *
     * The write goes through Rust rather than `@tauri-apps/plugin-fs`: the fs
     * capability granted no accessible paths, so `writeFile` threw
     * `PathForbidden` for every destination and backup export was dead on
     * every platform. The path is where the native save dialog returned it;
     * Rust does not re-validate it against an app-owned root, which is the
     * documented renderer-trust decision in `docs/RELEASE.md` ("Renderer trust
     * boundary"). No filesystem permission is granted to the
     * webview at all.
     */
    async saveBackupFile(path: string, bytes: Uint8Array): Promise<void> {
      await driver.saveBackupFile(path, bytes);
    },

    /**
     * Copy the current database + photo library before an import destroys them
     * and return the folder.
     *
     * Called by the import confirm step, whose whole contract is that a
     * failure here cancels the import: the copy is not a convenience, it is the
     * undo. `label` is a timestamp; Rust sanitizes it and composes the path, so
     * this cannot be pointed at an arbitrary directory.
     *
     * Note what this does beyond copying (J7): Rust opens the import exclusion
     * window — every ordinary writer in the session is refused until the
     * window's lease is released. The import flow owns that window and closes
     * it on both success and failure; nothing else may call this.
     */
    async saveSafetyCopy(label: string): Promise<string> {
      return driver.safetyBackupCopy(label);
    },

    /**
     * Parse + validate without touching the DB (for the confirm step).
     *
     * Detection is by magic bytes. An encrypted file is bounded on its sealed
     * size, opened with `password`, and only then handed to the same zip
     * parser the unencrypted path has always used — so the archive, expanded,
     * entry, manifest, photo and row limits all apply to the authenticated
     * plaintext. `inner` is the archive to import; keeping it here means the
     * confirmed step needs no second password.
     */
    async inspectBackup(
      bytes: Uint8Array,
      password?: string,
    ): Promise<{
      parsed: ParsedBackup;
      summary: BackupSummary;
      inner: Uint8Array;
    }> {
      const inner = await innerArchive(bytes, password);
      const parsed = parseBackupZip(inner);
      return { parsed, summary: summarizeBackup(parsed), inner };
    },

    /**
     * Parse + validate + apply (the confirmed import). `bytes` is the archive
     * `inspectBackup` returned, so the password is not needed twice and the
     * bytes that get validated are exactly the bytes that get written.
     */
    async importBackup(bytes: Uint8Array): Promise<BackupApplyResult> {
      // Old in-memory state dies here, before the first write (J5): the
      // vault's key cache (via the composition root's hook) belongs to the
      // rows this import replaces, and every caller of importBackup gets
      // that guarantee — not only SettingsPage's confirm step.
      hooks.onBeforeImport?.();
      // The import exclusion window (E5): claim it BEFORE the first write so
      // every write below carries the lease, and release it in `finally` so
      // the window closes whether the import commits, fails, or throws while
      // parsing. When the safety copy already opened the window, this
      // attaches to the SAME lease — one window from the snapshot boundary
      // through FK restore. `undefined` on test drivers without the lease
      // methods: they have no barrier to hold.
      const lease = await driver.beginImportLease?.();
      try {
        return await applyBackup(driver, parseBackupZip(bytes), lease);
      } finally {
        if (lease !== undefined) {
          await driver.endImportLease?.(lease)?.catch(() => undefined);
        }
      }
    },
  };
}
