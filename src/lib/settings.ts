// Settings repository: typed access to the key-value
// `settings` table. Values are stored as JSON text; this module is the only
// place that knows the key names.

import type { DataDriver } from "../data/driver.ts";
import { isLocale, type Locale } from "./i18n.ts";
import {
  type NotesViewMode,
  parseCollectionsCollapsed,
  parseViewMode,
} from "./notesView.ts";

export const SETTING_KEYS = {
  theme: "theme",
  locale: "locale",
  onboardingDismissed: "onboarding_dismissed",
  pinHash: "pin_hash",
  securityQuestion: "security_question",
  securityAnswerHash: "security_answer_hash",
  vault: "vault",
  autoLockMinutes: "auto_lock_minutes",
  notificationPreview: "notification_preview",
  notesViewMode: "notes_view_mode",
  notesCollectionsCollapsed: "notes_collections_collapsed",
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
     * (setup must be refused).
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

    /** Presentation language only; domain rows are never rewritten. */
    async getLocale(): Promise<Locale | null> {
      const stored = await this.getJSON<string>(SETTING_KEYS.locale);
      return isLocale(stored) ? stored : null;
    },

    async setLocale(locale: Locale): Promise<void> {
      await this.setJSON(SETTING_KEYS.locale, locale);
    },

    /**
     * The first-run guide is dismissed and never shown again. Only the
     * dismissal is persisted — the guide itself is static copy.
     */
    async getOnboardingDismissed(): Promise<boolean> {
      return (
        (await this.getJSON<boolean>(SETTING_KEYS.onboardingDismissed)) === true
      );
    },

    async setOnboardingDismissed(dismissed: boolean): Promise<void> {
      await this.setJSON(SETTING_KEYS.onboardingDismissed, dismissed);
    },

    async getAutoLockMinutes(): Promise<number | null> {
      return this.getJSON<number>(SETTING_KEYS.autoLockMinutes);
    },

    async setAutoLockMinutes(minutes: number): Promise<void> {
      await this.setJSON(SETTING_KEYS.autoLockMinutes, minutes);
    },

    /**
     * Whether OS notifications may carry reminder text. Default OFF.
     *
     * `=== true` is deliberate: a fresh install, an install that predates the
     * key, and an unreadable row all answer "no content" — the private
     * direction. A privacy default that depends on a migration having run is
     * not a default.
     */
    async getNotificationPreview(): Promise<boolean> {
      return (
        (await this.getJSON<boolean>(SETTING_KEYS.notificationPreview)) === true
      );
    },

    async setNotificationPreview(enabled: boolean): Promise<void> {
      await this.setJSON(SETTING_KEYS.notificationPreview, enabled);
    },

    /**
     * The Notes editor view mode (Edit | Split | Read). Default SPLIT —
     * the side-by-side layout the app shipped with, so an absent row, a
     * corrupt row and a pre-view-mode install all land on today's behaviour.
     * Parsing lives in `notesView.ts` so the fallback is unit-tested pure.
     */
    async getNotesViewMode(): Promise<NotesViewMode> {
      return parseViewMode(
        await this.getJSON<unknown>(SETTING_KEYS.notesViewMode),
      );
    },

    async setNotesViewMode(mode: NotesViewMode): Promise<void> {
      await this.setJSON(SETTING_KEYS.notesViewMode, mode);
    },

    /** Whether the Collections sidebar was collapsed by the writer. */
    async getNotesCollectionsCollapsed(): Promise<boolean> {
      return parseCollectionsCollapsed(
        await this.getJSON<unknown>(SETTING_KEYS.notesCollectionsCollapsed),
      );
    },

    async setNotesCollectionsCollapsed(collapsed: boolean): Promise<void> {
      await this.setJSON(SETTING_KEYS.notesCollectionsCollapsed, collapsed);
    },

    /**
     * Write the DB encryption key to `path` for the Settings key-export step
     *. The UI copies nothing and holds nothing: the key is read,
     * written and dropped inside Rust, so it never reaches this process. The
     * key still never goes into the backup zip.
     */
    async saveDatabaseKeyFile(path: string): Promise<void> {
      await driver.saveDbKeyFile(path);
    },
  };
}
