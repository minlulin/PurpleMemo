// Vault repository (§5.3): password-protected secrets. Each item is encrypted
// with AES-256-GCM under a key derived from the vault password + that item's
// own PBKDF2 salt (600k iterations — same cost as the PIN, §2.9); salt + IV
// are stored per item as plain base64. Derived keys live in memory only and
// are never stored; there is no recovery — the UI says so before the
// password is set.

import type { DataDriver } from "../data/driver.ts";
import {
  decryptWithKey,
  deriveVaultKey,
  encryptWithKey,
  randomSaltB64,
  sha256HexText,
} from "./crypto.ts";
import { todayLocal } from "./dates.ts";
import type { VaultItemRow } from "./types.ts";

/** Settings marker — its presence means the vault password has been set up. */
export const VAULT_SETUP_KEY = "vault_setup";

/**
 * Settings key holding a verifier: a known string encrypted under the vault
 * password with its own salt + IV. Without it, a vault that has been set up
 * but holds no items has nothing to decrypt, so `unlock` would have to accept
 * any password — and the user's first secret would end up encrypted under a
 * password they never chose.
 */
export const VAULT_VERIFY_KEY = "vault_verify";

const VERIFIER_PLAINTEXT = "purple-memo/vault/verifier/v1";

interface VaultVerifier {
  salt: string;
  iv: string;
  ciphertext: string;
}

async function sealVerifier(
  driver: DataDriver,
  password: string,
): Promise<void> {
  const salt = randomSaltB64();
  const key = await deriveVaultKey(password, salt);
  const cipher = await encryptWithKey(key, VERIFIER_PLAINTEXT);
  const verifier: VaultVerifier = {
    salt,
    iv: cipher.iv,
    ciphertext: cipher.ciphertext,
  };
  await driver.execute("INSERT INTO settings (key, value) VALUES (?, ?)", [
    VAULT_VERIFY_KEY,
    JSON.stringify(verifier),
  ]);
}

async function checkVerifier(
  driver: DataDriver,
  password: string,
): Promise<boolean> {
  const rows = await driver.query<{ value: string }>(
    "SELECT value FROM settings WHERE key = ?",
    [VAULT_VERIFY_KEY],
  );
  const raw = rows[0]?.value;
  if (!raw) return false; // nothing stored — nothing to check
  let verifier: VaultVerifier;
  try {
    verifier = JSON.parse(raw) as VaultVerifier;
  } catch {
    throw new Error("stored vault verifier is corrupt");
  }
  // A wrong password fails the GCM auth tag. Translate that into "this
  // password did not open the verifier" rather than leaking a raw WebCrypto
  // OperationError to the caller.
  const key = await deriveVaultKey(password, verifier.salt);
  try {
    const plain = await decryptWithKey(key, {
      ciphertext: verifier.ciphertext,
      iv: verifier.iv,
    });
    return plain === VERIFIER_PLAINTEXT;
  } catch {
    return false;
  }
}

export function createVaultRepo(driver: DataDriver) {
  /**
   * In-memory derived keys (item id -> {salt, key, pwdHash}); cleared by
   * `lockVault`. The pwdHash binds each cached key to the password it was
   * derived from — without it, a cached key would let ANY password decrypt
   * the item (e.g. getItem with a wrong password succeeding after unlock,
   * or changePassword accepting a wrong old password).
   */
  const keyCache = new Map<
    number,
    { salt: string; key: CryptoKey; pwdHash: string }
  >();

  async function deriveItemKey(
    itemId: number,
    password: string,
  ): Promise<{ salt: string; key: CryptoKey }> {
    const pwdHash = await sha256HexText(password);
    const cached = keyCache.get(itemId);
    if (cached && cached.pwdHash === pwdHash) return cached;
    const rows = await driver.query<{ salt: string }>(
      "SELECT salt FROM vault_items WHERE id = ?",
      [itemId],
    );
    const salt = rows[0]?.salt;
    if (!salt) throw new Error(`vault item ${itemId} has no salt`);
    const key = await deriveVaultKey(password, salt);
    const entry = { salt, key, pwdHash };
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
      // Seal the verifier FIRST: if this throws, the marker above is never
      // followed by a usable vault, and setupVault rejects.
      await sealVerifier(driver, password);
      await this.unlock(password);
    },

    /**
     * Unlock: the password is proven against the sealed verifier (always
     * present after setup) and, once items exist, against the first item's
     * GCM tag too. A wrong password fails closed — an empty vault no longer
     * accepts any password at all.
     */
    async unlock(password: string): Promise<void> {
      const rows = await driver.query<VaultItemRow>(
        "SELECT * FROM vault_items WHERE id = (SELECT MIN(id) FROM vault_items) LIMIT 1",
      );
      const first = rows[0];
      if (first) {
        const { key } = await deriveItemKey(first.id, password);
        await decryptWithKey(key, {
          ciphertext: first.ciphertext,
          iv: first.iv,
        });
        return;
      }
      // No items: the sealed verifier is the only proof available. A vault
      // that has been set up MUST reject a wrong password here rather than
      // waving it through — otherwise the first secret would be encrypted
      // under a password the user never chose.
      if (await checkVerifier(driver, password)) return;
      const marker = await driver.query<{ key: string }>(
        "SELECT key FROM settings WHERE key = ?",
        [VAULT_SETUP_KEY],
      );
      if (marker[0]) {
        throw new Error("wrong vault password");
      }
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
      const salt = randomSaltB64();
      const key = await deriveVaultKey(password, salt);
      const cipher = await encryptWithKey(key, plaintext);
      const r = await driver.execute(
        `INSERT INTO vault_items (title, ciphertext, salt, iv, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [title, cipher.ciphertext, salt, cipher.iv, todayLocal(), todayLocal()],
      );
      keyCache.set(r.lastInsertRowid, {
        salt,
        key,
        pwdHash: await sha256HexText(password),
      });
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
     * per-item salt + key.
     *
     * Two-phase for safety: phase 1 decrypts with the old password and
     * re-encrypts with the new one entirely in memory (a wrong old password
     * fails here on the first item's GCM auth tag, before anything is
     * written); phase 2 writes all items in ONE atomic batch, and only then
     * is the key cache rebuilt. A failure can never leave items split
     * between the old and new password.
     */
    async changePassword(
      oldPassword: string,
      newPassword: string,
    ): Promise<void> {
      const items = await driver.query<VaultItemRow>(
        "SELECT * FROM vault_items ORDER BY id",
      );
      // With no items the loop below cannot prove the old password, so the
      // verifier does it instead.
      if (items.length === 0 && !(await checkVerifier(driver, oldPassword))) {
        throw new Error("wrong current password");
      }
      const migrated: {
        id: number;
        ciphertext: string;
        salt: string;
        iv: string;
        key: CryptoKey;
      }[] = [];
      for (const item of items) {
        const { key } = await deriveItemKey(item.id, oldPassword);
        const plaintext = await decryptWithKey(key, {
          ciphertext: item.ciphertext,
          iv: item.iv,
        });
        const salt = randomSaltB64();
        const newKey = await deriveVaultKey(newPassword, salt);
        const cipher = await encryptWithKey(newKey, plaintext);
        migrated.push({
          id: item.id,
          ciphertext: cipher.ciphertext,
          salt,
          iv: cipher.iv,
          key: newKey,
        });
      }
      await driver.batch(
        migrated.map((m) => ({
          sql: "UPDATE vault_items SET ciphertext = ?, salt = ?, iv = ?, updated_at = ? WHERE id = ?",
          params: [m.ciphertext, m.salt, m.iv, todayLocal(), m.id],
        })),
      );
      // Re-seal the verifier under the new password, so a later unlock proves
      // against the NEW password rather than the one just replaced.
      await sealVerifier(driver, newPassword);
      const newPwdHash = await sha256HexText(newPassword);
      for (const m of migrated) {
        keyCache.set(m.id, { salt: m.salt, key: m.key, pwdHash: newPwdHash });
      }
    },

    async deleteItem(id: number): Promise<void> {
      await driver.execute("DELETE FROM vault_items WHERE id = ?", [id]);
      keyCache.delete(id);
    },
  };
}
