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

import type { Locale } from "./i18n.ts";

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
 * `yyyy-mm-ddTHH:mm` -> readable date and time. The time is shown in the
 * user's local clock, which is how it was stored.
 *
 * A plain `yyyy-mm-dd` renders as the date alone (D7): a date-only row stores
 * no clock time, and `new Date("2026-10-27")` is a UTC parse per ECMAScript —
 * it would invent midnight and, west of UTC, show the previous day.
 */
export function formatDateTime(locale: Locale, isoDateTime: string): string {
  const dateOnly = parseISODate(isoDateTime);
  if (dateOnly !== null) return formatDate(locale, isoDateTime);
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

const monthDayFormatters = new Map<Locale, Intl.DateTimeFormat>();

/** `MM-DD` -> "Oct 20" (localized), for a yearless contact birthday. */
function monthDayFormatter(locale: Locale): Intl.DateTimeFormat {
  const cached = monthDayFormatters.get(locale);
  if (cached !== undefined) return cached;
  const formatter = new Intl.DateTimeFormat(locale, {
    calendar: "gregory",
    numberingSystem: "latn",
    month: "short",
    day: "numeric",
  });
  monthDayFormatters.set(locale, formatter);
  return formatter;
}

/**
 * A stored date that may be full (`yyyy-mm-dd`) or a yearless birthday
 * (`MM-DD`).
 *
 * `formatDate` only understands the full form, so a month-day birthday came
 * through raw as "10-20" in both locales (G8). The leap-day year 2024 is used
 * purely as a calendar to render the month and day — no year is shown, and a
 * Feb 29 birthday stays valid. Malformed input is returned unchanged.
 */
export function formatBirthday(locale: Locale, birthday: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(birthday)) return formatDate(locale, birthday);
  if (!/^\d{2}-\d{2}$/.test(birthday)) return birthday;
  const leapDate = new Date(`2024-${birthday}T00:00:00`);
  if (
    Number.isNaN(leapDate.getTime()) ||
    leapDate.getMonth() + 1 !== Number(birthday.slice(0, 2)) ||
    leapDate.getDate() !== Number(birthday.slice(3, 5))
  ) {
    return birthday;
  }
  return monthDayFormatter(locale).format(leapDate);
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
