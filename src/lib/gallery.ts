// Gallery repository: photo bytes go through the driver's
// photo_save/photo_read/photo_delete commands (content-addressed files under
// the app-data dir); this layer manages the `photos`/`photo_refs` rows and
// links photos to notes/memories/jobs. Bytes are `Uint8Array` end to end
// — the driver hands them over raw, never as a `number[]`.

import type { BatchStatement, DataDriver } from "../data/driver.ts";
import { sha256HexBytes } from "./crypto.ts";
import { todayLocal } from "./dates.ts";
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

    /** Delete the row + the file (idempotent file delete). */
    async deletePhoto(id: number): Promise<void> {
      const photo = await this.getPhoto(id);
      if (!photo) return;
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
      ]);
      await driver.deletePhoto(photo.rel_path);
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
