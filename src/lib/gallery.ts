// Gallery repository (§2.7): photo bytes go through the driver's
// photo_save/photo_read/photo_delete commands (content-addressed files under
// the app-data dir); this layer manages the `photos`/`photo_refs` rows and
// links photos to notes/memories/jobs.

import type { DataDriver } from "../data/driver.ts";
import { todayLocal } from "./dates.ts";
import type { PhotoRefEntity, PhotoRefRow, PhotoRow } from "./types.ts";

export interface SavePhotoInput {
  bytes: number[];
  ext: string;
  takenDate?: string | null;
  note?: string;
}

async function sha256Hex(bytes: number[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes) as BufferSource,
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
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
          await sha256Hex(input.bytes),
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

    /** Read photo bytes by row id (rel_path -> photo_read command). */
    async readPhotoBytes(id: number): Promise<number[] | undefined> {
      const photo = await this.getPhoto(id);
      if (!photo) return undefined;
      return driver.readPhoto(photo.rel_path);
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
  };
}

export type GalleryRepo = ReturnType<typeof createGalleryRepo>;
