// Settings repository (§2.8/§2.9/§5): typed access to the key-value
// `settings` table. Values are stored as JSON text; this module is the only
// place that knows the key names.

import type { DataDriver } from "../data/driver.ts";

export const SETTING_KEYS = {
  theme: "theme",
  pinHash: "pin_hash",
  securityQuestion: "security_question",
  securityAnswerHash: "security_answer_hash",
  vault: "vault",
  autoLockMinutes: "auto_lock_minutes",
} as const;

export type Theme = "dark" | "light";

export function createSettingsRepo(driver: DataDriver) {
  return {
    async getJSON<T>(key: string): Promise<T | null> {
      const raw = await this.getRaw(key);
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },

    /**
     * The raw stored value: `undefined` when the row does not exist, the
     * unparsed string when it does.
     *
     * `getJSON` deliberately collapses "no row" and "unparseable JSON" into a
     * single `null`, which is fine for ordinary settings but NOT for the lock
     * shell: `classifyPin` must be able to tell a PIN that was never set
     * (first-run setup is allowed) from one that is stored but unreadable
     * (setup must be refused) — see review C-3.
     */
    async getRaw(key: string): Promise<string | undefined> {
      const rows = await driver.query<{ value: string }>(
        "SELECT value FROM settings WHERE key = ?",
        [key],
      );
      return rows[0]?.value;
    },

    async setJSON(key: string, value: unknown): Promise<void> {
      await driver.execute(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, JSON.stringify(value)],
      );
    },

    /** Atomically update related settings values. */
    async setManyJSON(
      entries: { key: string; value: unknown }[],
    ): Promise<void> {
      await driver.batch(
        entries.map(({ key, value }) => ({
          sql: `INSERT INTO settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
          params: [key, JSON.stringify(value)],
        })),
      );
    },

    async remove(key: string): Promise<void> {
      await driver.execute("DELETE FROM settings WHERE key = ?", [key]);
    },

    // -- Typed helpers -----------------------------------------------------------
    async getTheme(): Promise<Theme | null> {
      return this.getJSON<Theme>(SETTING_KEYS.theme);
    },

    async setTheme(theme: Theme): Promise<void> {
      await this.setJSON(SETTING_KEYS.theme, theme);
    },

    async getAutoLockMinutes(): Promise<number | null> {
      return this.getJSON<number>(SETTING_KEYS.autoLockMinutes);
    },

    async setAutoLockMinutes(minutes: number): Promise<void> {
      await this.setJSON(SETTING_KEYS.autoLockMinutes, minutes);
    },

    /**
     * Write the DB encryption key to `path` for the Settings key-export step
     * (§5.4). The UI copies nothing and holds nothing: the key is read,
     * written and dropped inside Rust, so it never reaches this process. The
     * key still never goes into the backup zip.
     */
    async saveDatabaseKeyFile(path: string): Promise<void> {
      await driver.saveDbKeyFile(path);
    },
  };
}
