// Gallery repository (§2.7): photo bytes go through the driver's
// photo_save/photo_read/photo_delete commands (content-addressed files under
// the app-data dir); this layer manages the `photos`/`photo_refs` rows and
// links photos to notes/memories/jobs. Bytes are `Uint8Array` end to end
// (review M-02) — the driver hands them over raw, never as a `number[]`.

import type { DataDriver } from "../data/driver.ts";
import { sha256HexBytes } from "./crypto.ts";
import { todayLocal } from "./dates.ts";
import type { PhotoRefEntity, PhotoRefRow, PhotoRow } from "./types.ts";

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
 * name can never steer the storage path (§4 photos are content-addressed).
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

export function createGalleryRepo(driver: DataDriver) {
  return {
    /**
     * Save bytes (driver writes the file) + insert the `photos` row.
     * Content-addressed: saving identical bytes again returns the existing
     * row instead of violating the rel_path UNIQUE constraint.
     */
    async savePhoto(input: SavePhotoInput): Promise<number> {
      const relPath = await driver.savePhoto(input.bytes, input.ext);
      const existing = await driver.query<{ id: number }>(
        "SELECT id FROM photos WHERE rel_path = ?",
        [relPath],
      );
      if (existing[0]) return existing[0].id;
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
      await driver.batch([
        { sql: "DELETE FROM photos WHERE id = ?", params: [id] },
      ]);
      await driver.deletePhoto(photo.rel_path);
    },

    // -- Photo links (§2.7) ------------------------------------------------------
    async listRefs(
      entityType: PhotoRefEntity,
      entityId: number,
    ): Promise<PhotoRefRow[]> {
      return driver.query<PhotoRefRow>(
        "SELECT * FROM photo_refs WHERE entity_type = ? AND entity_id = ? ORDER BY id",
        [entityType, entityId],
      );
    },

    async addRef(
      photoId: number,
      entityType: PhotoRefEntity,
      entityId: number,
    ): Promise<void> {
      await driver.execute(
        "INSERT INTO photo_refs (photo_id, entity_type, entity_id) VALUES (?, ?, ?)",
        [photoId, entityType, entityId],
      );
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
