// React bindings for the locale store in `lib/i18n.ts`.
//
// A store rather than a context provider: the shell early-returns into booting,
// error, setup and locked screens before the workspace tree exists, and every
// one of them must render in the chosen language. `useSyncExternalStore` lets
// each component subscribe without a provider wrapping those branches.

import { useCallback, useSyncExternalStore } from "react";
import {
  getLocale,
  type Locale,
  type MessageKey,
  type MessageParams,
  type PluralKey,
  subscribeLocale,
  translate,
  translatePlural,
} from "../lib/i18n.ts";

export type Translate = (key: MessageKey, params?: MessageParams) => string;

export type TranslatePlural = (
  key: PluralKey,
  count: number,
  params?: MessageParams,
) => string;

/** The active locale; re-renders the caller when Settings switches it. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribeLocale, getLocale, getLocale);
}

/** Translate a message key in the active locale. */
export function useT(): Translate {
  const locale = useLocale();
  return useCallback(
    (key: MessageKey, params?: MessageParams) => translate(locale, key, params),
    [locale],
  );
}

/** Translate a plural message; `{count}` is filled automatically. */
export function usePlural(): TranslatePlural {
  const locale = useLocale();
  return useCallback(
    (key: PluralKey, count: number, params?: MessageParams) =>
      translatePlural(locale, key, count, params),
    [locale],
  );
}
