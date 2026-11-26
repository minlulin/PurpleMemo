// Localization.
//
// One flat catalogue of dotted keys per locale, split into one file per
// top-level namespace under `i18n/` — each holds its English keys and the
// matching Burmese keys side by side. `en` below is the typed English source
// of truth, `my` the Burmese catalogue that the compiler and the suite both
// require to be complete. Pages ask for a key; they never branch on the
// language.
//
// Storage stays locale-neutral: dates remain ISO and money remains integer
// cents. Only presentation is translated — see `lib/format.ts`.
//
// Missing keys fail loudly in development and safely in release: a dev build
// throws (so a forgotten translation cannot reach a commit unnoticed), while a
// release build falls back to English, then to the key itself, because a blank
// button is worse than an English one.

import { enBudget, myBudget } from "./i18n/budget.ts";
import { enBusiness, myBusiness } from "./i18n/business.ts";
import { enCapture, myCapture } from "./i18n/capture.ts";
import { enCommon, myCommon } from "./i18n/common.ts";
import { enContacts, myContacts } from "./i18n/contacts.ts";
import { enDashboard, myDashboard } from "./i18n/dashboard.ts";
import { enExports, myExports } from "./i18n/exports.ts";
import { enGallery, myGallery } from "./i18n/gallery.ts";
import { enHabits, myHabits } from "./i18n/habits.ts";
import { enImport, myImport } from "./i18n/import.ts";
import { enInbox, myInbox } from "./i18n/inbox.ts";
import { enJournal, myJournal } from "./i18n/journal.ts";
import { enLinkPicker, myLinkPicker } from "./i18n/link-picker.ts";
import { enLinks, myLinks } from "./i18n/links.ts";
import { enLoans, myLoans } from "./i18n/loans.ts";
import { enLock, myLock } from "./i18n/lock.ts";
import { enMarkdown, myMarkdown } from "./i18n/markdown.ts";
import { enMemories, myMemories } from "./i18n/memories.ts";
import { enMobile, myMobile } from "./i18n/mobile.ts";
import { enMonth, myMonth } from "./i18n/month.ts";
import { enNav, myNav } from "./i18n/nav.ts";
import { enNotes, myNotes } from "./i18n/notes.ts";
import { enOnboarding, myOnboarding } from "./i18n/onboarding.ts";
import { enPairing, myPairing } from "./i18n/pairing.ts";
import { enReminders, myReminders } from "./i18n/reminders.ts";
import { enReset, myReset } from "./i18n/reset.ts";
import { enRust, myRust } from "./i18n/rust.ts";
import { enSearch, mySearch } from "./i18n/search.ts";
import { enSession, mySession } from "./i18n/session.ts";
import { enSettings, mySettings } from "./i18n/settings.ts";
import { enShell, myShell } from "./i18n/shell.ts";
import { enShopping, myShopping } from "./i18n/shopping.ts";
import { enShortcuts, myShortcuts } from "./i18n/shortcuts.ts";
import { enTasks, myTasks } from "./i18n/tasks.ts";
import { enTrash, myTrash } from "./i18n/trash.ts";
import { enVault, myVault } from "./i18n/vault.ts";
import { enWeekday, myWeekday } from "./i18n/weekday.ts";

export const LOCALES = ["en", "my"] as const;

export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

/** Language names as the language names itself, for the Settings switch. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  my: "မြန်မာ",
};

export function isLocale(value: unknown): value is Locale {
  return value === "en" || value === "my";
}

/**
 * `navigator.language` (or a stored tag) to a supported locale. Burmese
 * (`my`, `my-MM`) is the only non-English locale the app ships; everything
 * else reads in English rather than guessing.
 */
export function localeFromLanguageTag(tag: string | null | undefined): Locale {
  if (typeof tag !== "string") return DEFAULT_LOCALE;
  return tag.trim().toLowerCase().startsWith("my") ? "my" : DEFAULT_LOCALE;
}

// -- Catalogue ----------------------------------------------------------------

export const en = {
  ...enCommon,
  ...enShell,
  ...enNav,
  ...enSettings,
  ...enRust,
  ...enMobile,
  ...enPairing,
  ...enReminders,
  ...enMarkdown,
  ...enShortcuts,
  ...enCapture,
  ...enSearch,
  ...enSession,
  ...enLock,
  ...enInbox,
  ...enTrash,
  ...enNotes,
  ...enTasks,
  ...enDashboard,
  ...enReset,
  ...enLinkPicker,
  ...enLinks,
  ...enImport,
  ...enContacts,
  ...enBusiness,
  ...enLoans,
  ...enHabits,
  ...enShopping,
  ...enGallery,
  ...enJournal,
  ...enMemories,
  ...enExports,
  ...enMonth,
  ...enWeekday,
  ...enOnboarding,
  ...enVault,
  ...enBudget,
} as const;

export type MessageKey = keyof typeof en;

export const my: Record<MessageKey, string> = {
  ...myCommon,
  ...myShell,
  ...myNav,
  ...mySettings,
  ...myRust,
  ...myMobile,
  ...myPairing,
  ...myReminders,
  ...myMarkdown,
  ...myShortcuts,
  ...myCapture,
  ...mySearch,
  ...mySession,
  ...myLock,
  ...myInbox,
  ...myTrash,
  ...myNotes,
  ...myTasks,
  ...myDashboard,
  ...myReset,
  ...myLinkPicker,
  ...myLinks,
  ...myImport,
  ...myContacts,
  ...myBusiness,
  ...myLoans,
  ...myHabits,
  ...myShopping,
  ...myGallery,
  ...myJournal,
  ...myMemories,
  ...myExports,
  ...myMonth,
  ...myWeekday,
  ...myOnboarding,
  ...myVault,
  ...myBudget,
};

const messages: Record<Locale, Partial<Record<MessageKey, string>>> = {
  en,
  my,
};

// -- Plurals ------------------------------------------------------------------

export interface PluralForms {
  one: string;
  other: string;
}

export const enPlurals = {
  "session.remindersDue": {
    one: "{count} reminder is due — open Purple Memo.",
    other: "{count} reminders are due — open Purple Memo.",
  },
  "search.results": {
    one: "{count} result",
    other: "{count} results",
  },
  "notes.wordCount": {
    one: "{count} word",
    other: "{count} words",
  },
  "dashboard.warrantiesSoon": {
    one: "{count} warranty expiring soon",
    other: "{count} warranties expiring soon",
  },
  "dashboard.itemsDue": {
    one: "{count} item due",
    other: "{count} items due",
  },
  "import.ready": {
    one: "{count} row ready to import",
    other: "{count} rows ready to import",
  },
  "import.failed": {
    one: "{count} row has errors",
    other: "{count} rows have errors",
  },
  "import.resultImported": {
    one: "{count} row imported",
    other: "{count} rows imported",
  },
  "import.resultSkipped": {
    one: "{count} row had errors and was skipped",
    other: "{count} rows had errors and were skipped",
  },
  "tasks.imported": {
    one: "{count} task imported",
    other: "{count} tasks imported",
  },
  "contacts.imported": {
    one: "{count} contact imported",
    other: "{count} contacts imported",
  },
  "journal.entries": {
    one: "{count} entry",
    other: "{count} entries",
  },
  "settings.autoLockMinutes": {
    one: "{count} minute",
    other: "{count} minutes",
  },
} as const;

export type PluralKey = keyof typeof enPlurals;

export const myPlurals: Record<PluralKey, PluralForms> = {
  // Burmese does not inflect for number; both forms deliberately read the same.
  "session.remindersDue": {
    one: "သတိပေးချက် {count} ခု ရောက်နေသည် — Purple Memo ကို ဖွင့်ပါ။",
    other: "သတိပေးချက် {count} ခု ရောက်နေသည် — Purple Memo ကို ဖွင့်ပါ။",
  },
  "search.results": {
    one: "ရလဒ် {count} ခု",
    other: "ရလဒ် {count} ခု",
  },
  "notes.wordCount": {
    one: "စကားလုံး {count} လုံး",
    other: "စကားလုံး {count} လုံး",
  },
  "dashboard.warrantiesSoon": {
    one: "အာမခံ {count} ခု မကြာမီ သက်တမ်းကုန်မည်",
    other: "အာမခံ {count} ခု မကြာမီ သက်တမ်းကုန်မည်",
  },
  "dashboard.itemsDue": {
    one: "ရက်ချိန်းရောက် {count} ခု",
    other: "ရက်ချိန်း ရောက် {count} ခု",
  },
  "import.ready": {
    one: "တင်သွင်းရန် အသင့်ဖြစ်သော အတန်း {count} ခု",
    other: "တင်သွင်းရန် အသင့်ဖြစ်သော အတန်း {count} ခု",
  },
  "import.failed": {
    one: "အမှားရှိသော အတန်း {count} ခု",
    other: "အမှားရှိသော အတန်း {count} ခု",
  },
  "import.resultImported": {
    one: "တင်သွင်းပြီးသော အတန်း {count} ခု",
    other: "တင်သွင်းပြီးသော အတန်း {count} ခု",
  },
  "import.resultSkipped": {
    one: "အမှားရှိသဖြင့် ကျော်သွားသော အတန်း {count} ခု",
    other: "အမှားရှိသဖြင့် ကျော်သွားသော အတန်း {count} ခု",
  },
  "tasks.imported": {
    one: "လုပ်ငန်း {count} ခု တင်သွင်းပြီး",
    other: "လုပ်ငန်း {count} ခု တင်သွင်းပြီး",
  },
  "contacts.imported": {
    one: "ဆက်သွယ်ရန် {count} ခု တင်သွင်းပြီး",
    other: "ဆက်သွယ်ရန် {count} ခု တင်သွင်းပြီး",
  },
  "journal.entries": {
    one: "မှတ်တမ်း {count} ခု",
    other: "မှတ်တမ်း {count} ခု",
  },
  "settings.autoLockMinutes": {
    one: "{count} မိနစ်",
    other: "{count} မိနစ်",
  },
};

const plurals: Record<Locale, Partial<Record<PluralKey, PluralForms>>> = {
  en: enPlurals,
  my: myPlurals,
};

// -- Lookup -------------------------------------------------------------------

export type MessageParams = Record<string, string | number>;

/**
 * An Error that names a translation key instead of pre-rendering text, so the
 * UI can render it in the locale active when it is shown rather than the one
 * active when it was thrown.
 */
export interface MessageKeyError extends Error {
  readonly messageKey: MessageKey;
  readonly params: MessageParams;
}

export function isMessageKeyError(value: unknown): value is MessageKeyError {
  if (!(value instanceof Error)) return false;
  const record = value as unknown as Record<string, unknown>;
  return (
    typeof record.messageKey === "string" &&
    typeof record.params === "object" &&
    record.params !== null
  );
}

/** `development` throws on a missing key; `production` falls back to English. */
export type TranslationMode = "development" | "production";

const PLACEHOLDER = /\{([a-zA-Z0-9_]+)\}/g;

/** Placeholder names used by a template, sorted, for parity tests. */
export function placeholdersIn(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found].sort();
}

/**
 * Fill `{name}` slots. An unknown placeholder is left alone rather than
 * rendered as "undefined": a half-filled sentence still names what is missing.
 */
export function interpolate(template: string, params: MessageParams): string {
  return template.replace(PLACEHOLDER, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** Keys present in English but absent from `locale`, sorted. */
export function missingMessageKeys(locale: Locale): MessageKey[] {
  const catalogue = messages[locale];
  return (Object.keys(en) as MessageKey[]).filter(
    (key) => catalogue[key] === undefined,
  );
}

/**
 * The mode-aware lookup the suite can pin in both directions. Production never
 * throws — a release build with a forgotten key shows English, not a crash.
 */
export function translateFor(
  locale: Locale,
  key: MessageKey,
  params: MessageParams = {},
  mode: TranslationMode = "production",
): string {
  const own = messages[locale][key];
  if (own === undefined) {
    // Development is strict about the REQUESTED locale, not just about keys
    // that exist nowhere: a Burmese gap must be visible while translating, or
    // it ships as English and is never noticed.
    if (mode === "development") {
      throw new Error(`Missing message key: ${key} (${locale})`);
    }
    const fallback = messages.en[key];
    return fallback === undefined ? key : interpolate(fallback, params);
  }
  return interpolate(own, params);
}

/** The plural form for `count` in `locale`, with `{count}` already filled. */
export function translatePluralFor(
  locale: Locale,
  key: PluralKey,
  count: number,
  params: MessageParams = {},
  mode: TranslationMode = "production",
): string {
  const own = plurals[locale][key];
  if (own === undefined && mode === "development") {
    throw new Error(`Missing plural message key: ${key} (${locale})`);
  }
  // Release: the English plural is still readable, and a key with no plural
  // anywhere returns itself rather than a blank string.
  const forms = own ?? plurals.en[key];
  if (forms === undefined) return key;
  const category = new Intl.PluralRules(locale).select(count);
  const template = category === "one" ? forms.one : forms.other;
  return interpolate(template, { ...params, count });
}

/**
 * Vite replaces `import.meta.env` at build time. `node --test` imports this
 * module directly and has no `env`, so the cast keeps that path readable
 * without a bundler-only global.
 */
function buildMode(): TranslationMode {
  const meta = import.meta as ImportMeta & {
    readonly env?: { readonly DEV?: boolean };
  };
  return meta.env?.DEV === true ? "development" : "production";
}

export function translate(
  locale: Locale,
  key: MessageKey,
  params?: MessageParams,
): string {
  return translateFor(locale, key, params, buildMode());
}

export function translatePlural(
  locale: Locale,
  key: PluralKey,
  count: number,
  params?: MessageParams,
): string {
  return translatePluralFor(locale, key, count, params, buildMode());
}

/**
 * A refusal from Rust (D7): the message key and its params, never a sentence.
 *
 * The shape is `messages::Refusal` in `src-tauri/src/messages.rs` — Rust names
 * what happened, this catalogue says it, so a banner raised before a language
 * switch re-reads in the new one.
 */
export interface KeyedRefusal {
  readonly key: string;
  readonly params?: Record<string, string>;
}

/**
 * True for the `{ key, params }` shape a command rejects with. The `rust.`
 * prefix is what keeps an arbitrary object with a `key` field from being read
 * as one — only this app's Rust side mints those names.
 */
export function isKeyedRefusal(value: unknown): value is KeyedRefusal {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.key === "string" && record.key.startsWith("rust.");
}

/**
 * Render a Rust refusal in the active locale, or `null` when `value` is not
 * one. A key this build does not know falls back to its `{detail}` param (the
 * failing layer's own words), then to the key — never to a blank banner.
 */
export function refusalText(value: unknown): string | null {
  if (!isKeyedRefusal(value)) return null;
  const key = value.key as MessageKey;
  const params = (value.params ?? {}) as MessageParams;
  if (messages.en[key] === undefined) {
    // A key this build does not know: the layer's own words if it sent any,
    // else the key, which is still greppable in a bug report.
    const detail = params.detail;
    return typeof detail === "string" ? detail : value.key;
  }
  return translate(getLocale(), key, params);
}

// -- Current locale -----------------------------------------------------------

/**
 * The active locale, kept outside React so every early return in the shell
 * (booting, error, setup, locked) renders in the same language, and so the
 * reminder poll can read it without a provider above the lock screen.
 */
let currentLocale: Locale = detectInitialLocale();

/** `navigator.language` before the database opens; the stored setting wins after. */
export function detectInitialLocale(): Locale {
  const tag = typeof navigator === "undefined" ? undefined : navigator.language;
  return localeFromLanguageTag(tag);
}

export function getLocale(): Locale {
  return currentLocale;
}

const localeListeners = new Set<() => void>();

export function subscribeLocale(listener: () => void): () => void {
  localeListeners.add(listener);
  return () => {
    localeListeners.delete(listener);
  };
}

/** Switch the presentation language. Domain rows are never touched. */
export function setLocale(locale: Locale): void {
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
  }
  if (locale === currentLocale) return;
  currentLocale = locale;
  for (const listener of localeListeners) listener();
}
