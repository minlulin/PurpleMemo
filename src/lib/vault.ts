// Vault repository: password-protected secrets. Each item is encrypted
// with AES-256-GCM under a key derived from the vault password + that item's
// own PBKDF2 salt (600k iterations — same cost as the PIN); salt + IV
// are stored per item as plain base64. Derived keys live in memory only and
// are never stored; there is no recovery — the UI says so before the
// password is set.

import type { BatchStatement, DataDriver } from "../data/driver.ts";
import { mapConcurrent } from "./concurrency.ts";
import {
  decryptWithKey,
  deriveVaultKey,
  deriveVaultTag,
  encryptWithKey,
  randomSaltB64,
} from "./crypto.ts";
import { todayLocal } from "./dates.ts";
import { errText } from "./errors.ts";
import {
  createSettingsRepo,
  SETTING_KEYS,
  settingsUpsertStatement,
} from "./settings.ts";
import type { OpKind, Origin } from "./sync/protocol.ts";
import {
  outboxStatements,
  readRowId,
  readRowUid,
  readVaultMetadata,
  VAULT_GENERATION_FIELD,
  VAULT_VERIFIER_FIELD,
} from "./sync/store.ts";
import type { VaultItemRow } from "./types.ts";
import { newUid } from "./uid.ts";

/**
 * How many vault items `changePassword` re-encrypts at once. Items are few and
 * each holds its plaintext in memory while in flight, so this stays small
 * (docs/AUDIT.md PERF-13).
 */
const VAULT_REENCRYPT_CONCURRENCY = 4;

/**
 * Settings marker — its presence means the vault password has been set up.
 * The key name itself lives in `SETTING_KEYS` (docs/AUDIT.md DUP-06); this
 * alias keeps the name the rest of the app and the tests already use.
 */
export const VAULT_SETUP_KEY = SETTING_KEYS.vaultSetup;

/**
 * Settings key holding a verifier: a known string encrypted under the vault
 * password with its own salt + IV. Without it, a vault that has been set up
 * but holds no items has nothing to decrypt, so `unlock` would have to accept
 * any password — and the user's first secret would end up encrypted under a
 * password they never chose.
 */
export const VAULT_VERIFY_KEY = SETTING_KEYS.vaultVerify;

/**
 * Settings key holding the vault's **password** generation (§12.3). It is not
 * the §10 data generation: this one counts password changes, only ever moves
 * forward with the single writer that owns the vault, and is what the phone
 * compares an incoming item against before it may hold it.
 */
export const VAULT_GENERATION_KEY = SETTING_KEYS.vaultGeneration;

/**
 * Thrown when the supplied password demonstrably failed to open the vault —
 * an AES-GCM auth-tag rejection or a verifier mismatch. Everything else (a
 * locked database, a full disk, an IPC failure) throws its own error and must
 * NOT be reported as "wrong password": the old UI caught
 * everything and claimed nothing had changed, which hid a real failure behind
 * a wrong and reassuring sentence.
 */
export class WrongPasswordError extends Error {
  constructor(message = "wrong vault password") {
    super(message);
    this.name = "WrongPasswordError";
  }
}

/**
 * Decrypt with `key`, translating a GCM tag mismatch into the one error the UI
 * may honestly call a wrong password.
 *
 * Only `OperationError` qualifies — that is what WebCrypto raises when the
 * auth tag does not verify, i.e. "this key did not open this ciphertext".
 * Everything else is a structurally broken row: an undecodable field, an IV
 * that is not 12 bytes, a ciphertext cut shorter than its own tag. `crypto.ts`
 * refuses those with a plain error before WebCrypto can blur them into an
 * `OperationError` (H5), and they are named as corruption here — telling the
 * user they mistyped their password would send them looking in the wrong
 * place.
 */
async function decryptItem(
  key: CryptoKey,
  cipher: { ciphertext: string; iv: string },
): Promise<string> {
  try {
    return await decryptWithKey(key, cipher);
  } catch (e) {
    if (e instanceof Error && e.name === "OperationError") {
      throw new WrongPasswordError();
    }
    throw new Error(
      `Stored vault entry is corrupt and cannot be decrypted: ${errText(e)}`,
    );
  }
}

const VERIFIER_PLAINTEXT = "purple-memo/vault/verifier/v1";

interface VaultVerifier {
  salt: string;
  iv: string;
  ciphertext: string;
}

/**
 * The verifier write, as a BATCH STATEMENT rather than an executed one.
 *
 * Two rules ride on this shape:
 *
 * 1. It upserts. `settings.key` is the table's primary key, so a plain INSERT
 *    raised a UNIQUE violation on every password change — and it raised it
 *    *after* `changePassword` had already committed the re-encrypted items,
 *    leaving the vault readable only with the new password while the UI
 *    reported that nothing had changed. Same upsert as `settings.setJSON`.
 * 2. It is returned instead of executed so callers can seal it in the SAME
 *    transaction as the rows it has to agree with. A verifier that committed
 *    separately could disagree with the items it verifies; a setup marker that
 *    committed separately could strand `isSetUp()` true with no usable vault.
 */
async function verifierSeal(password: string): Promise<BatchStatement> {
  const salt = randomSaltB64();
  const key = await deriveVaultKey(password, salt);
  const cipher = await encryptWithKey(key, VERIFIER_PLAINTEXT);
  const verifier: VaultVerifier = {
    salt,
    iv: cipher.iv,
    ciphertext: cipher.ciphertext,
  };
  return settingsUpsertStatement(VAULT_VERIFY_KEY, JSON.stringify(verifier));
}

async function checkVerifier(
  driver: DataDriver,
  password: string,
): Promise<boolean> {
  return verifyStored(
    await createSettingsRepo(driver).getRaw(VAULT_VERIFY_KEY),
    password,
  );
}

/**
 * The verifier check itself, for callers that already hold the stored text.
 *
 * `changePassword` reads the verifier anyway — it needs both it and the
 * generation to record its ops (§12.3) — so re-reading it here would be a
 * second query for a value the caller already has.
 */
async function verifyStored(
  raw: string | null | undefined,
  password: string,
): Promise<boolean> {
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

/**
 * The envelope every vault op carries (§12.3 decision 2): the generation the
 * row was sealed under and the verifier that proves that password.
 *
 * They travel beside the row's fields, never as columns. The receiving device
 * writes them into its OWN settings in the same batch, so a phone that adopted
 * the desktop's items can unlock what it received with the desktop's password.
 *
 * Ciphertext, salt and IV are exactly as stored — nothing here decrypts, and no
 * op, payload or log ever holds a plaintext secret.
 */
function vaultEnvelope(metadata: {
  generation: number;
  verifier: string | null;
}): Record<string, unknown> {
  return {
    [VAULT_GENERATION_FIELD]: metadata.generation,
    [VAULT_VERIFIER_FIELD]: metadata.verifier,
  };
}

/**
 * The vault repository.
 *
 * `origin` is this installation's side of a pairing (§2.3), resolved once where
 * the repo is built (`data/app.ts`). It exists because the vault is
 * **one-way desktop→mobile**: the desktop records every vault mutation as an
 * operation, the phone records none. A phone that recorded one would have it
 * refused by the desktop's engine — and refused as a whole batch, taking the
 * phone's unrelated operations down with it.
 */
export function createVaultRepo(
  driver: DataDriver,
  origin: Origin = "desktop",
) {
  /**
   * In-memory derived keys (item id -> {salt, key, tag}); cleared by
   * `lockVault` and by a password change.
   *
   * The `tag` binds each cached key to the password it was derived from — the
   * right idea, and the reason a wrong password cannot be answered out of the
   * cache. What changed (review P3-19) is the **material**: it used to be
   * `sha256HexText(password)`, an unsalted SHA-256 of the master vault
   * password held in renderer memory beside a deliberately non-extractable
   * `CryptoKey`. SHA-256 is dictionary-crackable at billions of hashes per
   * second, so that tag handed back exactly what PBKDF2 was bought to prevent
   * and made the non-extractable key beside it pointless — the password is the
   * cheaper way in. It is now a PBKDF2 tag
   * ({@link deriveVaultTag}, {@link VAULT_TAG_ITERATIONS}), derived from the
   * item's own salt so two cached items under one password share nothing.
   *
   * The further improvement, not taken here because it is an API change rather
   * than a fix: item operations should not take a password at all. The unlocked
   * session already *is* the proof, so the argument exists only to be compared —
   * and removing it would delete the tag, and this class of problem with it.
   */
  const keyCache = new Map<
    number,
    { salt: string; key: CryptoKey; tag: string }
  >();

  /**
   * Bumped by {@link dropKeyCache}. A derivation that started before the bump
   * must not repopulate the cache after it (B4): `deriveItemKey` awaits a query
   * and ~600k PBKDF2 iterations, and `lockVault` is synchronous — without this
   * counter the clear lands on an empty cache and the key arrives right behind
   * it, leaving a decrypting `CryptoKey` cached while the vault reports itself
   * locked, which is exactly the window `lockVault`'s comment claims to bound.
   */
  let keyGeneration = 0;

  /**
   * Drop every cached key and invalidate derivations still in flight.
   *
   * Used by `lockVault` and by `changePassword` (whose keys all belong to the
   * outgoing password). The generation, not the clear, is what makes the
   * guarantee true — see {@link keyGeneration}.
   */
  function dropKeyCache(): void {
    keyGeneration += 1;
    keyCache.clear();
  }

  /**
   * The metadata this device's next vault op carries: the generation the row is
   * sealed under, and the verifier for that password.
   *
   * A vault set up before Stage 3 has no counter row and is generation 1 by
   * definition — nothing has ever rotated it. The read happens just before the
   * batch, so it is a hint rather than a lock: a rotation landing in between
   * would only make this op stale on the receiver, which is exactly what its
   * generation comparison is for.
   */
  async function currentMetadata(): Promise<{
    generation: number;
    verifier: string | null;
  }> {
    const stored = await readVaultMetadata(driver);
    return {
      generation: stored.generation ?? 1,
      verifier: stored.verifier,
    };
  }

  /**
   * §6.1/§12.3: the operations that carry a vault write to a peer, for the SAME
   * batch as the mutation — or nothing at all.
   *
   * Nothing at all on mobile: the vault is one-way (§2.3), so the phone spends
   * no query and records no op, and its outbox never carries a vault op for a
   * peer to refuse.
   */
  async function recordOps(
    entries: readonly {
      uid: string;
      kind: OpKind;
      fields?: Record<string, unknown>;
    }[],
    metadata?: { generation: number; verifier: string | null },
  ): Promise<BatchStatement[]> {
    if (origin !== "desktop" || entries.length === 0) return [];
    const envelope = vaultEnvelope(metadata ?? (await currentMetadata()));
    return outboxStatements(
      entries.map((entry) => ({
        table: "vault_items" as const,
        uid: entry.uid,
        kind: entry.kind,
        fields: { ...(entry.fields ?? {}), ...envelope },
      })),
    );
  }

  async function deriveItemKey(
    itemId: number,
    password: string,
  ): Promise<{ salt: string; key: CryptoKey; tag: string }> {
    const generation = keyGeneration;
    // Cache first, so a hit costs no query — and the entry carries the salt its
    // tag was derived from, so the tag can be recomputed without one.
    const cached = keyCache.get(itemId);
    if (cached) {
      const tag = await deriveVaultTag(password, cached.salt);
      if (cached.tag === tag) return cached;
    }
    const rows = await driver.query<{ salt: string }>(
      "SELECT salt FROM vault_items WHERE id = ?",
      [itemId],
    );
    const salt = rows[0]?.salt;
    if (!salt) throw new Error(`vault item ${itemId} has no salt`);
    const key = await deriveVaultKey(password, salt);
    const entry = { salt, key, tag: await deriveVaultTag(password, salt) };
    if (generation === keyGeneration) keyCache.set(itemId, entry);
    return entry;
  }

  return {
    async isSetUp(): Promise<boolean> {
      // `settings.value` is NOT NULL, so a present row always has a value —
      // `undefined` means "no row" (docs/AUDIT.md SCHEMA-04 for the flag).
      return (
        (await createSettingsRepo(driver).getRaw(VAULT_SETUP_KEY)) !== undefined
      );
    },

    /**
     * Set up the vault password (no items yet — the password is proven by
     * the first encrypted item). Fails if already set up.
     */
    async setupVault(password: string): Promise<void> {
      if (await this.isSetUp()) throw new Error("vault is already set up");
      // Marker and verifier in ONE batch, so a failed seal rolls the marker
      // back with it. Committing the marker alone would leave isSetUp() true
      // with nothing to unlock against — setup unreachable forever.
      await driver.batch([
        // Deliberately NOT an upsert: isSetUp() above is the guard, and a plain
        // INSERT is what makes a concurrent second setup fail rather than
        // silently overwrite the first one's marker.
        {
          sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
          params: [VAULT_SETUP_KEY, JSON.stringify({ version: 1 })],
        },
        await verifierSeal(password),
        // §12.3: the vault starts at password generation 1, written in the same
        // batch as the verifier it belongs to.
        settingsUpsertStatement(VAULT_GENERATION_KEY, JSON.stringify(1)),
      ]);
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
        // The GCM auth tag is the proof: a wrong password derives a different
        // key, and decryption throws here before anything is returned.
        const { key } = await deriveItemKey(first.id, password);
        await decryptItem(key, {
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
      const marker = await createSettingsRepo(driver).getRaw(VAULT_SETUP_KEY);
      if (marker !== undefined) {
        throw new WrongPasswordError();
      }
    },

    /**
     * Drop all in-memory keys (auto-lock bounds the unlocked window).
     *
     * Synchronous, so it also invalidates any derivation that is mid-flight —
     * see {@link dropKeyCache}. The in-flight call still gets its key back (its
     * caller is one await away from using it) but nothing is cached behind the
     * lock.
     */
    lockVault(): void {
      dropKeyCache();
    },

    async addItem(
      title: string,
      plaintext: string,
      password: string,
    ): Promise<number> {
      const salt = randomSaltB64();
      const key = await deriveVaultKey(password, salt);
      const cipher = await encryptWithKey(key, plaintext);
      const uid = newUid();
      const created = todayLocal();
      // The op carries the row's STORED fields — ciphertext, salt and IV as
      // they are written, never the plaintext it was made from.
      const stored = {
        title,
        ciphertext: cipher.ciphertext,
        salt,
        iv: cipher.iv,
        created_at: created,
        updated_at: created,
      };
      const ops = await recordOps([{ uid, kind: "create", fields: stored }]);
      await driver.batch([
        {
          sql: `INSERT INTO vault_items (uid, title, ciphertext, salt, iv, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          params: [
            uid,
            title,
            cipher.ciphertext,
            salt,
            cipher.iv,
            created,
            created,
          ],
        },
        ...ops,
      ]);
      const id = await readRowId(driver, "vault_items", uid);
      keyCache.set(id, {
        salt,
        key,
        // This key was just used to encrypt the item, so the tag is the
        // password it really came from — not a guess (review P3-19).
        tag: await deriveVaultTag(password, salt),
      });
      return id;
    },

    /** Item metadata only — never the ciphertext. */
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
      const plaintext = await decryptItem(key, {
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
      // The password is PROVEN here even when a new plaintext is supplied
      // (B5). `deriveItemKey` never fails on a wrong password — the tag only
      // decides whether a cached key may be reused, otherwise it derives
      // whatever it is handed — so skipping this decrypt would let
      // `updateItem(id, { plaintext }, wrongPassword)` re-encrypt the row under
      // a key from the wrong password, keep the item's real salt, and report
      // success. The row would then be unreadable by the real password, and at
      // `MIN(id)` (what `unlock` proves against) that rejects the vault itself.
      const stored = await decryptItem(key, {
        ciphertext: row.ciphertext,
        iv: row.iv,
      });
      const plaintext = fields.plaintext ?? stored;
      const cipher = await encryptWithKey(key, plaintext);
      // The whole row travels, not only the fields this call changed: a vault
      // row is aggregate-atomic (§4.4), so the winner's complete triple must be
      // able to land without the receiver holding any of the old one.
      const next = {
        title: fields.title ?? row.title,
        ciphertext: cipher.ciphertext,
        salt: row.salt,
        iv: cipher.iv,
        created_at: row.created_at,
        updated_at: todayLocal(),
      };
      const uid = await readRowUid(driver, "vault_items", id);
      const ops = uid
        ? await recordOps([{ uid, kind: "update", fields: next }])
        : [];
      await driver.batch([
        {
          sql: "UPDATE vault_items SET title = ?, ciphertext = ?, iv = ?, updated_at = ? WHERE id = ?",
          params: [next.title, next.ciphertext, next.iv, next.updated_at, id],
        },
        ...ops,
      ]);
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
      // The generation this device holds, read before anything else: the change
      // is what produces the next one, and every op it records names it.
      const before = await currentMetadata();
      const generation = before.generation + 1;
      const items = await driver.query<VaultItemRow>(
        "SELECT * FROM vault_items ORDER BY id",
      );
      // With no items the loop below cannot prove the old password, so the
      // verifier does it instead.
      if (
        items.length === 0 &&
        !(await verifyStored(before.verifier, oldPassword))
      ) {
        throw new WrongPasswordError("wrong current password");
      }
      const migrated: {
        id: number;
        uid: string | null;
        title: string;
        created_at: string;
        ciphertext: string;
        salt: string;
        iv: string;
        key: CryptoKey;
      }[] = [];
      // Re-encrypt a few items at a time. Every item costs two ~600k-iteration
      // PBKDF2 derivations that run off-thread, so awaiting them one by one
      // left the CPU idle between items (docs/AUDIT.md PERF-13). The pool is
      // deliberately small: each in-flight item holds its plaintext.
      const results = await mapConcurrent(
        items,
        VAULT_REENCRYPT_CONCURRENCY,
        async (item) => {
          const { key } = await deriveItemKey(item.id, oldPassword);
          const plaintext = await decryptItem(key, {
            ciphertext: item.ciphertext,
            iv: item.iv,
          });
          const salt = randomSaltB64();
          const newKey = await deriveVaultKey(newPassword, salt);
          const cipher = await encryptWithKey(newKey, plaintext);
          return {
            id: item.id,
            uid: item.uid,
            title: item.title,
            created_at: item.created_at,
            ciphertext: cipher.ciphertext,
            salt,
            iv: cipher.iv,
            key: newKey,
          };
        },
      );
      migrated.push(...results);
      // Items AND the re-sealed verifier in ONE batch: a later unlock proves
      // against the NEW password, and there is no window in which the items
      // have moved to the new password but the verifier still expects the old
      // one (which would lock the user out of their own vault).
      const sealed = await verifierSeal(newPassword);
      const updated = todayLocal();
      const verifier = (sealed.params ?? [])[1];
      // §12.3: every re-sealed item records an update op under the NEW
      // generation and the NEW verifier — the whole set, in this one batch, so
      // the receiver can wipe the old generation and take the new one whole.
      // An item with no uid (a pre-v7 row) cannot be named by an op; it is
      // rotated here and stays device-local until an edit mints it an identity.
      const ops = await recordOps(
        migrated
          .filter(
            (m): m is typeof m & { uid: string } =>
              typeof m.uid === "string" && m.uid.length > 0,
          )
          .map((m) => ({
            uid: m.uid,
            kind: "update" as const,
            fields: {
              title: m.title,
              ciphertext: m.ciphertext,
              salt: m.salt,
              iv: m.iv,
              created_at: m.created_at,
              updated_at: updated,
            },
          })),
        {
          generation,
          verifier: typeof verifier === "string" ? verifier : null,
        },
      );
      await driver.batch([
        ...migrated.map((m) => ({
          sql: "UPDATE vault_items SET ciphertext = ?, salt = ?, iv = ?, updated_at = ? WHERE id = ?",
          params: [m.ciphertext, m.salt, m.iv, updated, m.id],
        })),
        sealed,
        // §12.3 decision 1: the generation is bumped in the SAME batch as the
        // rows it describes — a counter that moved separately could name a set
        // of items it does not match.
        settingsUpsertStatement(
          VAULT_GENERATION_KEY,
          JSON.stringify(generation),
        ),
        ...ops,
      ]);
      // The cache is dropped rather than re-tagged (review P3-19): every key in
      // it was derived from the OLD password, so each would need a fresh tag
      // and a fresh key from the new one. Clearing costs one PBKDF2 per item
      // on next use, which is the price of keeping a tag of the new password in
      // memory instead of nothing. `dropKeyCache` (B4) also invalidates a
      // derivation that started under the old password and has not landed yet.
      dropKeyCache();
    },

    async deleteItem(id: number): Promise<void> {
      const uid = await readRowUid(driver, "vault_items", id);
      const ops = uid ? await recordOps([{ uid, kind: "delete" }]) : [];
      await driver.batch([
        { sql: "DELETE FROM vault_items WHERE id = ?", params: [id] },
        ...ops,
      ]);
      keyCache.delete(id);
    },
  };
}
