// Gallery repository: photo bytes go through the driver's
// photo_save/photo_read/photo_delete commands (content-addressed files under
// the app-data dir); this layer manages the `photos`/`photo_refs` rows and
// links photos to notes/memories/jobs. Bytes are `Uint8Array` end to end
// — the driver hands them over raw, never as a `number[]`.

import type { BatchStatement, DataDriver } from "../data/driver.ts";
import { MAX_BACKUP_PHOTO_BYTES } from "./backup.ts";
import { sha256HexBytes } from "./crypto.ts";
import { todayLocal } from "./dates.ts";
import {
  createSettingsRepo,
  SETTING_KEYS,
  settingsUpsertStatement,
} from "./settings.ts";
import type { PhotoRefEntity, PhotoRefRow, PhotoRow } from "./types.ts";

/**
 * Did this error come from a UNIQUE constraint rather than from anything worse?
 *
 * Structural, not driver-specific: `SQLiteError` codes differ between rusqlite,
 * sql.js and the Tauri bridge, but every one of them reports a uniqueness
 * failure in the message text. Used to absorb a lost insert race (review P3-25)
 * without swallowing real errors — a rethrow is the fallback whenever the shape
 * does not match.
 */
export function isUniqueViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message.includes("UNIQUE constraint failed") ||
    message.includes("constraint failed: UNIQUE")
  );
}

/**
 * Durable photo-cleanup records live in `settings` — the schema's existing
 * key/value table, exported with every backup — under a prefix no setting
 * uses (M2).
 *
 * A key carries BOTH the photo id and the file it names:
 * `gallery.pendingPhotoFile.<id>.<rel_path>`, with the rel_path repeated as
 * the value so a sweeper never parses the key. The id is what lets a retry
 * find "its own" pending work; the path inside the key is what keeps a record
 * for a RECYCLED rowid distinct — SQLite hands a freed id to the next insert,
 * so an id-only key would be overwritten by the next photo that inherits the
 * number, orphaning the first file forever.
 *
 * The prefix contains no LIKE wildcards (`_`, `%`), so
 * `key LIKE '<prefix>%'` matches cleanup records and nothing else.
 */
// The prefix lives with the other setting key names (docs/AUDIT.md DUP-06).
const PENDING_CLEANUP_PREFIX = SETTING_KEYS.photoCleanupPrefix;

/**
 * "The row is gone; the file cleanup is still pending" (M2).
 *
 * `deletePhoto` commits the row deletion together with a record naming the
 * file, then unlinks. When the unlink fails, both stand: the row cannot come
 * back, and the record is the only thing that still points at the bytes on
 * disk. This error is what that state surfaces as — thrown rather than
 * resolved, so no caller (and no UI) can mistake "cleanup pending" for
 * "photo deleted". The next `deletePhoto` for that photo finds the record,
 * finishes the unlink and clears it.
 *
 * `photoId` and `relPath` are public so a caller can render the specifics;
 * the driver's own failure rides along as `cause`.
 */
export class PhotoCleanupPendingError extends Error {
  readonly photoId: number;
  readonly relPath: string;

  constructor(photoId: number, relPath: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Photo #${photoId} is already gone from Gallery, but its file (${relPath}) is still on disk — cleanup pending: ${reason}. Deleting it again finishes the job.`,
      { cause },
    );
    this.name = "PhotoCleanupPendingError";
    this.photoId = photoId;
    this.relPath = relPath;
  }
}

/**
 * Is this the "row gone, file cleanup pending" state (M2)?
 *
 * A completed delete throws nothing, and a refusal that changed nothing (a
 * photo held by Trash) is a plain `Error` — only the typed error passes. The
 * check is `instanceof`, not a message match: this error is created in this
 * realm and never crosses IPC, and a structural match would let any message
 * reading "cleanup pending" masquerade as the state.
 */
export function isPhotoCleanupPending(
  error: unknown,
): error is PhotoCleanupPendingError {
  return error instanceof PhotoCleanupPendingError;
}

/** The durable record's key for one photo's pending file. */
function pendingCleanupKey(photoId: number, relPath: string): string {
  return `${PENDING_CLEANUP_PREFIX}${photoId}.${relPath}`;
}

/** The photo a cleanup record belongs to (`NaN` for a key that is not ours). */
function pendingCleanupId(key: string): number {
  const rest = key.slice(PENDING_CLEANUP_PREFIX.length);
  return Number(rest.slice(0, rest.indexOf(".")));
}

/**
 * Unlink one pending file, then drop its record — never the other way round.
 *
 * Clearing the record only after the driver confirms the unlink is what makes
 * the state durable: every failure, and a crash in between, leaves the record
 * for the next call to find. `photo_delete` treats an already-absent file as
 * success, so a record whose file went away out-of-band clears cleanly
 * instead of wedging forever.
 */
async function finishPhotoCleanup(
  driver: DataDriver,
  photoId: number,
  relPath: string,
): Promise<void> {
  try {
    await driver.deletePhoto(relPath);
  } catch (cause) {
    throw new PhotoCleanupPendingError(photoId, relPath, cause);
  }
  await createSettingsRepo(driver).remove(pendingCleanupKey(photoId, relPath));
}

export interface SavePhotoInput {
  bytes: Uint8Array;
  ext: string;
  takenDate?: string | null;
  note?: string;
}

/**
 * Extension for a picked file: the last dot segment, lowercased, when it is
 * alphanumeric and short enough to be a real extension; anything missing or
 * hostile (`"noext"`, `"weird.<script>"`) falls back to `"bin"` so a file
 * name can never steer the storage path (photos are content-addressed).
 */
export function photoExtFromName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  if (dot < 0) return "bin";
  const ext = fileName.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(ext) ? ext : "bin";
}

/**
 * Refuse, before reading it, a file the save command would refuse (I2).
 *
 * `photo_save` in `commands.rs` enforces `MAX_SAVED_PHOTO_BYTES`, which is
 * pinned to this same `MAX_BACKUP_PHOTO_BYTES` (E6, tested in `ipc.test.ts`) —
 * but only *after* the whole request body has been read out of the file and
 * copied through IPC. The picker therefore used to materialise an arbitrarily
 * large selection in full just to be told no: a multi-gigabyte pick could
 * exhaust or freeze the renderer on the way to a refusal that was never in
 * doubt.
 *
 * A `File` already knows its own length, so the ceiling is applied here, on
 * `file.size`, before `arrayBuffer()` is called. This is a preflight, not a
 * second authority: the bytes that reach `photo_save` are still checked there,
 * and the constant is imported rather than restated so the two can never drift
 * apart. The words are the native refusal's own, so the user sees one
 * sentence whichever check catches them.
 */
export function assertPickablePhotoSize(byteLength: number): void {
  if (byteLength <= MAX_BACKUP_PHOTO_BYTES) return;
  throw new Error(
    `this photo is ${(byteLength / (1024 * 1024)).toFixed(1)} MiB — Purple Memo accepts a single photo up to ${(MAX_BACKUP_PHOTO_BYTES / (1024 * 1024)).toFixed(0)} MiB, because a larger one would make every backup containing it unrestorable. Compress or resize the image and try again; nothing was saved.`,
  );
}

/**
 * Who owns the gallery grid's object URLs (review P2-4).
 *
 * Every tile is an object URL the renderer must revoke by hand, and the grid
 * was doing that bookkeeping inline: `loadThumbs` builds a whole new id → URL
 * map, then revoked only the previous entries whose id was *absent* from the
 * new map. Since every URL in the new map is freshly minted, a photo that is
 * still in the grid got a second URL and its first one leaked — ~30 kB per
 * photo per "Add photos" batch, unbounded over a bulk import, and invisible
 * because a leaked blob URL is only released when the document goes away.
 *
 * The rule the inline version kept getting wrong is "every URL this book
 * handed out is revoked exactly once, and never while the grid still uses it",
 * so it is the book's whole job: `swap` revokes the previous set except any
 * URL that is still in the new one, and adopts the new set as the only live
 * one. Pure over the `create`/`revoke` pair, so the accounting is testable
 * without a document — which is the only reason the leak was not caught before.
 */
export interface ThumbUrlBook {
  /** Mint an object URL. Not tracked until `swap`/`drop`/`clear` sees it. */
  create(bytes: Uint8Array): string;
  /** The live URLs, for the grid to render. */
  current(): Map<number, string>;
  /**
   * Replace the whole grid. Revokes every previously-tracked URL that is not in
   * `next`, then tracks `next`. The returned map is a copy: the caller may keep
   * mutating the one it passed in.
   */
  swap(next: Map<number, string>): Map<number, string>;
  /** Revoke and forget one photo's URL (a delete). */
  drop(id: number): Map<number, string>;
  /** Revoke a set the book never tracked — a load that was cancelled. */
  revokeAll(urls: Iterable<string>): void;
  /** Revoke everything (unmount). */
  clear(): void;
}

/**
 * `photos/<yyyy>/<mm>/<sha256>.<ext>` — the layout `photos.rs` `save_photo`
 * writes (content-addressed, lowercase hex).
 */
const CONTENT_ADDRESSED_PATH_RE =
  /^photos\/\d{4}\/\d{2}\/([0-9a-f]{64})\.[a-z0-9]{1,8}$/;

/**
 * The sha256 that a content-addressed photo path already carries, or `null`
 * when the path does not look like one.
 *
 * Restore used to re-hash every photo after the host had just hashed it to
 * build the path — megabytes through sha256 twice per file, on the UI thread's
 * critical path (docs/AUDIT.md PERF-07). Callers must still validate: `null`
 * means "hash the bytes yourself", never "trust whatever is in the name".
 */
export function digestFromPhotoPath(relPath: string): string | null {
  return CONTENT_ADDRESSED_PATH_RE.exec(relPath)?.[1] ?? null;
}

export function createThumbUrlBook(io: {
  create: (bytes: Uint8Array) => string;
  revoke: (url: string) => void;
}): ThumbUrlBook {
  let live = new Map<number, string>();
  return {
    create: io.create,
    current: () => live,
    swap(next) {
      const kept = new Set(next.values());
      for (const url of live.values()) {
        if (!kept.has(url)) io.revoke(url);
      }
      live = new Map(next);
      return live;
    },
    drop(id) {
      const url = live.get(id);
      if (url !== undefined) io.revoke(url);
      const next = new Map(live);
      next.delete(id);
      live = next;
      return next;
    },
    revokeAll(urls) {
      for (const url of urls) io.revoke(url);
    },
    clear() {
      for (const url of live.values()) io.revoke(url);
      live = new Map();
    },
  };
}

/** The table each `photo_refs.entity_type` value points into. */
const PHOTO_REF_TABLES: Record<PhotoRefEntity, string> = {
  note: "notes",
  memory: "memories",
  job: "jobs",
};

/**
 * The statements that delete an entity **and every photo link pointing at it**
 * (review P2-12).
 *
 * `photo_refs.photo_id` is a real foreign key with `ON DELETE CASCADE`, so
 * deleting a photo cleans up its own links. `(entity_type, entity_id)` is the
 * other direction, and it is a *polymorphic* pair — the column can hold a note,
 * a memory or a job id, so no SQL foreign key can enforce it. Nothing cascades
 * it, which is why `deleteNote`/`deleteMemory` used to leave rows behind that
 * the Gallery Inspector then rendered as `Note #12` under "Linked to": a link
 * to something that no longer exists, on a photo the user still has.
 *
 * One batch, so the two deletes commit or fail together (`db::batch` is
 * all-or-nothing). A half-applied delete would be worse than either outcome —
 * the row gone with its links still listed, or the links gone with the row
 * intact.
 *
 * The owning table is *derived* from the entity type rather than passed in:
 * `entity_type` is CHECK-constrained to exactly these three values and each has
 * one fixed table, so a caller supplies only the kind and the id and cannot
 * pair a type with the wrong table — the failure a free string would invite.
 * `job` is not future-proofing: `business.ts` deletes a job through
 * `deleteLinkedEntity("job", id)` — one batch for the job row and its photo
 * links, income entries deliberately left (P2-9).
 *
 * Links first: the batch is atomic, so order is a readability choice, and this
 * is the one that stays correct if a real foreign key is ever added.
 */
export function deleteLinkedEntity(
  entityType: PhotoRefEntity,
  id: number,
): BatchStatement[] {
  return [
    {
      sql: "DELETE FROM photo_refs WHERE entity_type = ? AND entity_id = ?",
      params: [entityType, id],
    },
    {
      sql: `DELETE FROM ${PHOTO_REF_TABLES[entityType]} WHERE id = ?`,
      params: [id],
    },
  ];
}

export function createGalleryRepo(driver: DataDriver) {
  return {
    /**
     * Save bytes (driver writes the file) + insert the `photos` row.
     * Content-addressed: saving identical bytes again returns the existing
     * row instead of violating the rel_path UNIQUE constraint.
     *
     * The SELECT and the INSERT are a check-then-act, so two concurrent saves of
     * the same bytes can both see no row and both insert (review P3-25). The
     * loser hit the UNIQUE constraint and surfaced as an error to the caller —
     * no data loss, since the row it collided with is the row it wanted, but a
     * save that fails for a picture the user can already see is a bug. On a
     * UNIQUE violation the existing row is re-read and returned, which is what
     * the pre-INSERT SELECT was trying to do. `isUniqueViolation` is a
     * structural test on the message, so it stays correct across drivers.
     */
    async savePhoto(input: SavePhotoInput): Promise<number> {
      const relPath = await driver.savePhoto(input.bytes, input.ext);
      const existing = await driver.query<{ id: number }>(
        "SELECT id FROM photos WHERE rel_path = ?",
        [relPath],
      );
      if (existing[0]) return existing[0].id;
      try {
        const r = await driver.execute(
          `INSERT INTO photos (rel_path, sha256, ext, size_bytes, taken_date, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            relPath,
            await sha256HexBytes(input.bytes),
            input.ext,
            input.bytes.length,
            input.takenDate ?? null,
            input.note ?? "",
            todayLocal(),
          ],
        );
        return r.lastInsertRowid;
      } catch (e) {
        // Someone else inserted the same bytes between the SELECT and here.
        if (!isUniqueViolation(e)) throw e;
        const raced = await driver.query<{ id: number }>(
          "SELECT id FROM photos WHERE rel_path = ?",
          [relPath],
        );
        // If the colliding row is gone again the violation was not ours to
        // absorb, so rethrow rather than invent an id.
        if (!raced[0]) throw e;
        return raced[0].id;
      }
    },

    async listPhotos(): Promise<PhotoRow[]> {
      return driver.query<PhotoRow>(
        "SELECT * FROM photos ORDER BY created_at DESC, id DESC",
      );
    },

    async getPhoto(id: number): Promise<PhotoRow | undefined> {
      const rows = await driver.query<PhotoRow>(
        "SELECT * FROM photos WHERE id = ?",
        [id],
      );
      return rows[0];
    },

    /**
     * Partial update: only the provided fields are written (`undefined`
     * leaves the column unchanged).
     */
    async updatePhoto(
      id: number,
      fields: { note?: string; takenDate?: string | null },
    ): Promise<void> {
      const sets: string[] = [];
      const params: unknown[] = [];
      if (fields.note !== undefined) {
        sets.push("note = ?");
        params.push(fields.note);
      }
      if (fields.takenDate !== undefined) {
        sets.push("taken_date = ?");
        params.push(fields.takenDate);
      }
      if (sets.length === 0) return;
      params.push(id);
      await driver.execute(
        `UPDATE photos SET ${sets.join(", ")} WHERE id = ?`,
        params,
      );
    },

    /** Read full photo bytes by row id (rel_path -> photo_read command). */
    async readPhotoBytes(id: number): Promise<Uint8Array | undefined> {
      const photo = await this.getPhoto(id);
      if (!photo) return undefined;
      return driver.readPhoto(photo.rel_path);
    },

    /**
     * The stored thumbnail for a photo. Rejects when none has been stored yet
     * (a photo saved before thumbnails existed, or one imported from a backup
     * — thumbnails are derived data and never travel in an archive), which
     * the caller answers by generating one and saving it.
     */
    async readThumbBytes(id: number): Promise<Uint8Array | undefined> {
      const photo = await this.getPhoto(id);
      if (!photo) return undefined;
      return driver.readPhotoThumb(photo.rel_path);
    },

    /** Persist a thumbnail the page generated (canvas downscale). */
    async saveThumb(id: number, bytes: Uint8Array): Promise<void> {
      const photo = await this.getPhoto(id);
      if (!photo) return;
      await driver.savePhotoThumb(photo.rel_path, bytes);
    },

    /**
     * Delete the row + the file, losing track of neither when the file cannot
     * go (M2).
     *
     * The old order was row-commit-then-unlink with nothing bridging them: a
     * failed unlink (a permissions error, a locked file) left the photo
     * invisible in Gallery while its bytes stayed on disk, and the next call
     * hit `if (!photo) return` — resolving as a success for a file that would
     * never be deleted. Now the row deletion and a record naming the file
     * commit in ONE batch, so the database ends up in exactly one of "photo +
     * no record" / "no photo + record"; the record is cleared only after a
     * confirmed unlink; and every call starts by finishing whatever cleanup is
     * still pending instead of trusting a missing row to mean "done".
     *
     * Records for OTHER photos are completed best-effort: once the grid
     * reloads without a photo, its id is never asked for again, so this sweep
     * is the only ordinary path that can still reach that file. A failure
     * there stays recorded for the next call and never blocks the delete in
     * progress. This photo's OWN record, though, throws as soon as no row
     * remains for it — a retry can never no-op its way past pending cleanup.
     */
    async deletePhoto(id: number): Promise<void> {
      const settings = createSettingsRepo(driver);
      const pending = await settings.listByPrefix(PENDING_CLEANUP_PREFIX);
      let ownPending: PhotoCleanupPendingError | undefined;
      for (const record of pending) {
        try {
          await finishPhotoCleanup(
            driver,
            pendingCleanupId(record.key),
            record.value,
          );
        } catch (e) {
          if (
            e instanceof PhotoCleanupPendingError &&
            pendingCleanupId(record.key) === id
          ) {
            ownPending ??= e;
          }
        }
      }

      const photo = await this.getPhoto(id);
      if (!photo) {
        // Nothing left to delete: either the delete already finished (its
        // record is gone too) or its own cleanup is what this retry must
        // complete — never a silent success while a record for it stands.
        if (ownPending) throw ownPending;
        return;
      }
      const heldByTrash = await driver.query<{ id: number }>(
        `SELECT trash_items.id
         FROM trash_items, json_each(trash_items.snapshot, '$.photoRefs') AS ref
         WHERE json_extract(ref.value, '$.photo_id') = ?
         LIMIT 1`,
        [id],
      );
      if (heldByTrash.length > 0) {
        throw new Error(
          "This photo is held by an item in Trash. Restore or permanently delete that item first.",
        );
      }
      await driver.batch([
        { sql: "DELETE FROM photos WHERE id = ?", params: [id] },
        settingsUpsertStatement(
          pendingCleanupKey(id, photo.rel_path),
          photo.rel_path,
        ),
      ]);
      await finishPhotoCleanup(driver, id, photo.rel_path);
    },

    // -- Photo links ------------------------------------------------------
    async listRefs(
      entityType: PhotoRefEntity,
      entityId: number,
    ): Promise<PhotoRefRow[]> {
      return driver.query<PhotoRefRow>(
        "SELECT * FROM photo_refs WHERE entity_type = ? AND entity_id = ? ORDER BY id",
        [entityType, entityId],
      );
    },

    /**
     * Link a photo to an entity. Attaching the same link twice is a no-op, not
     * an error: schema v5 made `(photo_id, entity_type, entity_id)` unique,
     * so the second attach is refused by SQLite — and the caller asked for a
     * state the database is already in. Absorbing it here keeps a restore, an
     * import, or a second caller from turning a correct action into a failure.
     */
    async addRef(
      photoId: number,
      entityType: PhotoRefEntity,
      entityId: number,
    ): Promise<void> {
      try {
        await driver.execute(
          "INSERT INTO photo_refs (photo_id, entity_type, entity_id) VALUES (?, ?, ?)",
          [photoId, entityType, entityId],
        );
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }
    },

    async removeRef(id: number): Promise<void> {
      await driver.execute("DELETE FROM photo_refs WHERE id = ?", [id]);
    },

    /** Photos linked to an entity (note/memory/job). */
    async listPhotosFor(
      entityType: PhotoRefEntity,
      entityId: number,
    ): Promise<PhotoRow[]> {
      return driver.query<PhotoRow>(
        `SELECT p.* FROM photos p
         JOIN photo_refs r ON r.photo_id = p.id
         WHERE r.entity_type = ? AND r.entity_id = ?
         ORDER BY r.id`,
        [entityType, entityId],
      );
    },

    /** Links a single photo points to — the gallery detail view. */
    async listRefsForPhoto(photoId: number): Promise<PhotoRefRow[]> {
      return driver.query<PhotoRefRow>(
        "SELECT * FROM photo_refs WHERE photo_id = ? ORDER BY id",
        [photoId],
      );
    },
  };
}
