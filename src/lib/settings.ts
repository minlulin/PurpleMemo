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
      const rows = await driver.query<{ value: string }>(
        "SELECT value FROM settings WHERE key = ?",
        [key],
      );
      const raw = rows[0]?.value;
      if (raw === undefined) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        return null;
      }
    },

    async setJSON(key: string, value: unknown): Promise<void> {
      await driver.execute(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, JSON.stringify(value)],
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
  };
}

export type SettingsRepo = ReturnType<typeof createSettingsRepo>;
