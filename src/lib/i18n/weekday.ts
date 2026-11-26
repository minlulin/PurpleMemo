export const enWeekday = {
  // Weekday headings for the month grid. Abbreviations, so they are keys
  // rather than echoed locale data.
  "weekday.sun": "Su",
  "weekday.mon": "Mo",
  "weekday.tue": "Tu",
  "weekday.wed": "We",
  "weekday.thu": "Th",
  "weekday.fri": "Fr",
  "weekday.sat": "Sa",
} as const;

export const myWeekday: Record<keyof typeof enWeekday, string> = {
  "weekday.sun": "နွေ",
  "weekday.mon": "လာ",
  "weekday.tue": "ဂါ",
  "weekday.wed": "ဟူး",
  // Each abbreviation is the day's distinguishing syllable: ကြာသပတေး → ကြာ,
  // သောကြာ → သော, စနေ → နေ. Thursday and Friday share a syllable (ကြာ), so
  // reading down the column is not enough to spot a shift — Sunday..Saturday
  // must be spelled out in order.
  "weekday.thu": "ကြာ",
  "weekday.fri": "သော",
  "weekday.sat": "နေ",
};
