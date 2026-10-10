// Vault repository (§5.3): password-protected secrets. Each item is encrypted
// with AES-256-GCM under a key derived from the vault password + that item's
// own PBKDF2 salt (600k iterations — same cost as the PIN, §2.9); salt + IV
// are stored per item as plain base64. Derived keys live in memory only and
// are never stored; there is no recovery — the UI says so before the
// password is set.

import type { DataDriver } from "../data/driver.ts";
import { decryptWithKey, encryptWithKey, PBKDF2_ITERATIONS } from "./crypto.ts";
import { todayLocal } from "./dates.ts";
import type { VaultItemRow } from "./types.ts";

/** Settings marker — its presence means the vault password has been set up. */
export const VAULT_SETUP_KEY = "vault_setup";

export function createVaultRepo(driver: DataDriver) {
  /** In-memory derived keys (item id -> {salt, key}); cleared by `lockVault`. */
  const keyCache = new Map<number, { salt: string; key: CryptoKey }>();

  async function deriveItemKey(
    itemId: number,
    password: string,
  ): Promise<{ salt: string; key: CryptoKey }> {
    const cached = keyCache.get(itemId);
    if (cached) return cached;
    const rows = await driver.query<{ salt: string }>(
      "SELECT salt FROM vault_items WHERE id = ?",
      [itemId],
    );
    const salt = rows[0]?.salt;
    if (!salt) throw new Error(`vault item ${itemId} has no salt`);
    const keyMaterial = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(password),
      "PBKDF2",
      false,
      ["deriveKey"],
    );
    const saltBytes = Uint8Array.from(atob(salt), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.deriveKey(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: saltBytes as BufferSource,
        iterations: PBKDF2_ITERATIONS,
      },
      keyMaterial,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
    const entry = { salt, key };
    keyCache.set(itemId, entry);
    return entry;
  }

  return {
    async isSetUp(): Promise<boolean> {
      const rows = await driver.query<{ key: string }>(
        "SELECT key FROM settings WHERE key = ?",
        [VAULT_SETUP_KEY],
      );
      return rows.length > 0;
    },

    /**
     * Set up the vault password (no items yet — the password is proven by
     * the first encrypted item). Fails if already set up.
     */
    async setupVault(password: string): Promise<void> {
      if (await this.isSetUp()) throw new Error("vault is already set up");
      await driver.execute("INSERT INTO settings (key, value) VALUES (?, ?)", [
        VAULT_SETUP_KEY,
        JSON.stringify({ version: 1 }),
      ]);
      await this.unlock(password);
    },

    /**
     * Unlock: verifies the password by decrypting the verifier item (item id
     * 1 doubles as the canary) and pre-derives its key. Fails on a wrong
     * password (GCM auth tag mismatch).
     */
    async unlock(password: string): Promise<void> {
      const rows = await driver.query<VaultItemRow>(
        "SELECT * FROM vault_items WHERE id = (SELECT MIN(id) FROM vault_items) LIMIT 1",
      );
      const first = rows[0];
      if (!first) {
        // No items yet — nothing to verify against; trust the marker.
        return;
      }
      const { key } = await deriveItemKey(first.id, password);
      await decryptWithKey(key, { ciphertext: first.ciphertext, iv: first.iv });
    },

    /** Drop all in-memory keys (auto-lock bounds the unlocked window, §5.3). */
    lockVault(): void {
      keyCache.clear();
    },

    async addItem(
      title: string,
      plaintext: string,
      password: string,
    ): Promise<number> {
      const saltBytes = new Uint8Array(16);
      crypto.getRandomValues(saltBytes);
      const salt = btoa(String.fromCharCode(...saltBytes));
      const keyMaterial = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"],
      );
      const key = await crypto.subtle.deriveKey(
        {
          name: "PBKDF2",
          hash: "SHA-256",
          salt: saltBytes as BufferSource,
          iterations: PBKDF2_ITERATIONS,
        },
        keyMaterial,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      const cipher = await encryptWithKey(key, plaintext);
      const r = await driver.execute(
        `INSERT INTO vault_items (title, ciphertext, salt, iv, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [title, cipher.ciphertext, salt, cipher.iv, todayLocal(), todayLocal()],
      );
      keyCache.set(r.lastInsertRowid, { salt, key });
      return r.lastInsertRowid;
    },

    /** Item metadata only — never the ciphertext (§5.3). */
    async listItems(): Promise<
      Omit<VaultItemRow, "ciphertext" | "salt" | "iv">[]
    > {
      return driver.query(
        "SELECT id, title, created_at, updated_at FROM vault_items ORDER BY id",
      );
    },

    async getItem(
      id: number,
      password: string,
    ): Promise<{ title: string; plaintext: string } | undefined> {
      const rows = await driver.query<VaultItemRow>(
        "SELECT * FROM vault_items WHERE id = ?",
        [id],
      );
      const row = rows[0];
      if (!row) return undefined;
      const { key } = await deriveItemKey(id, password);
      const plaintext = await decryptWithKey(key, {
        ciphertext: row.ciphertext,
        iv: row.iv,
      });
      return { title: row.title, plaintext };
    },

    async updateItem(
      id: number,
      fields: { title?: string; plaintext?: string },
      password: string,
    ): Promise<void> {
      const rows = await driver.query<VaultItemRow>(
        "SELECT * FROM vault_items WHERE id = ?",
        [id],
      );
      const row = rows[0];
      if (!row) throw new Error(`vault item ${id} not found`);
      const { key } = await deriveItemKey(id, password);
      const plaintext =
        fields.plaintext ??
        (await decryptWithKey(key, { ciphertext: row.ciphertext, iv: row.iv }));
      const cipher = await encryptWithKey(key, plaintext);
      await driver.execute(
        "UPDATE vault_items SET title = ?, ciphertext = ?, iv = ?, updated_at = ? WHERE id = ?",
        [
          fields.title ?? row.title,
          cipher.ciphertext,
          cipher.iv,
          todayLocal(),
          id,
        ],
      );
    },

    /**
     * Change the vault password: re-encrypt every item under a fresh
     * per-item salt + key. Old keys are dropped; the cache is rebuilt as
     * items are re-encrypted.
     */
    async changePassword(
      oldPassword: string,
      newPassword: string,
    ): Promise<void> {
      const items = await driver.query<VaultItemRow>(
        "SELECT * FROM vault_items ORDER BY id",
      );
      for (const item of items) {
        const { key } = await deriveItemKey(item.id, oldPassword);
        const plaintext = await decryptWithKey(key, {
          ciphertext: item.ciphertext,
          iv: item.iv,
        });
        const newSaltBytes = new Uint8Array(16);
        crypto.getRandomValues(newSaltBytes);
        const salt = btoa(String.fromCharCode(...newSaltBytes));
        const keyMaterial = await crypto.subtle.importKey(
          "raw",
          new TextEncoder().encode(newPassword),
          "PBKDF2",
          false,
          ["deriveKey"],
        );
        const newKey = await crypto.subtle.deriveKey(
          {
            name: "PBKDF2",
            hash: "SHA-256",
            salt: newSaltBytes as BufferSource,
            iterations: PBKDF2_ITERATIONS,
          },
          keyMaterial,
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt", "decrypt"],
        );
        const cipher = await encryptWithKey(newKey, plaintext);
        await driver.execute(
          "UPDATE vault_items SET ciphertext = ?, salt = ?, iv = ?, updated_at = ? WHERE id = ?",
          [cipher.ciphertext, salt, cipher.iv, todayLocal(), item.id],
        );
        keyCache.set(item.id, { salt, key: newKey });
      }
    },

    async deleteItem(id: number): Promise<void> {
      await driver.execute("DELETE FROM vault_items WHERE id = ?", [id]);
      keyCache.delete(id);
    },
  };
}

export type VaultRepo = ReturnType<typeof createVaultRepo>;
