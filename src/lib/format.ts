// Locale-aware display formatting.
//
// Stored values never change: dates stay `yyyy-mm-dd` / `yyyy-mm-ddTHH:mm`
// (local, ISO) and money stays integer cents. These helpers convert them at
// the display edge only, with two explicit choices:
//
// * Gregorian calendar, always — a stored ISO date means that civil date, even
//   if a locale's default calendar is different.
// * Latin (`latn`) digits, always — the approved decision, so Burmese
//   screens show the same digits as the rest of the app and as exported files.
//
// Invalid input is returned unchanged: display code must not throw over a
// malformed row, and the raw value is still more useful than "Invalid Date".

import { getLocale, type Locale } from "./i18n.ts";

const numberFormatters = new Map<Locale, Intl.NumberFormat>();

function numberFormatter(locale: Locale): Intl.NumberFormat {
  const cached = numberFormatters.get(locale);
  if (cached !== undefined) return cached;
  const formatter = new Intl.NumberFormat(locale, {
    numberingSystem: "latn",
  });
  numberFormatters.set(locale, formatter);
  return formatter;
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

function dateFormatter(locale: Locale, withTime: boolean): Intl.DateTimeFormat {
  const key = `${locale}:${withTime ? "datetime" : "date"}`;
  const cached = dateFormatters.get(key);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat(locale, {
    calendar: "gregory",
    numberingSystem: "latn",
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(withTime ? { hour: "2-digit", minute: "2-digit", hour12: false } : {}),
  });
  dateFormatters.set(key, formatter);
  return formatter;
}

/** `yyyy-mm-dd` -> local civil date, at local midnight (never UTC). */
function parseISODate(isoDate: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) return null;
  const date = new Date(`${isoDate}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** `yyyy-mm-dd` -> a readable date in `locale`. Invalid input is unchanged. */
export function formatDate(locale: Locale, isoDate: string): string {
  const date = parseISODate(isoDate);
  if (date === null) return isoDate;
  return dateFormatter(locale, false).format(date);
}

/**
 * `yyyy-mm-ddTHH:mm` (or a plain date) -> readable date and time. The time is
 * shown in the user's local clock, which is how it was stored.
 */
export function formatDateTime(locale: Locale, isoDateTime: string): string {
  const date = new Date(isoDateTime);
  if (Number.isNaN(date.getTime())) return isoDateTime;
  return dateFormatter(locale, true).format(date);
}

const yearMonthFormatters = new Map<Locale, Intl.DateTimeFormat>();

/** `yyyy-mm` -> month and year, for month navigation labels. */
export function formatYearMonth(locale: Locale, yearMonth: string): string {
  const date = parseISODate(`${yearMonth}-01`);
  if (date === null) return yearMonth;
  let formatter = yearMonthFormatters.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, {
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "short",
    });
    yearMonthFormatters.set(locale, formatter);
  }
  return formatter.format(date);
}

const longDateFormatters = new Map<Locale, Intl.DateTimeFormat>();

/** `yyyy-mm-dd` -> full weekday, day, month, and year in `locale`. */
export function formatLongDate(locale: Locale, isoDate: string): string {
  const date = parseISODate(isoDate);
  if (date === null) return isoDate;
  let formatter = longDateFormatters.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, {
      calendar: "gregory",
      numberingSystem: "latn",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    longDateFormatters.set(locale, formatter);
  }
  return formatter.format(date);
}

const weekdayFormatters = new Map<Locale, Intl.DateTimeFormat>();

/** `yyyy-mm-dd` -> the narrow weekday glyph (one letter in English). */
export function weekdayNarrow(locale: Locale, isoDate: string): string {
  const date = parseISODate(isoDate);
  if (date === null) return isoDate;
  let formatter = weekdayFormatters.get(locale);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(locale, {
      calendar: "gregory",
      numberingSystem: "latn",
      weekday: "narrow",
    });
    weekdayFormatters.set(locale, formatter);
  }
  return formatter.format(date);
}

/** Counts and other whole numbers with locale grouping (Latin digits). */
export function formatNumber(
  locale: Locale,
  value: number,
  options?: Intl.NumberFormatOptions,
): string {
  if (options === undefined) return numberFormatter(locale).format(value);
  return new Intl.NumberFormat(locale, {
    ...options,
    numberingSystem: "latn",
  }).format(value);
}

/** The active locale's date, for components that do not need to subscribe. */
export function formatLocalDate(isoDate: string): string {
  return formatDate(getLocale(), isoDate);
}

/** The active locale's date and time. */
export function formatLocalDateTime(isoDateTime: string): string {
  return formatDateTime(getLocale(), isoDateTime);
}
