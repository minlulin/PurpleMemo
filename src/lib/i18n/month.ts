export const enMonth = {
  // Months — the month/year headings on Budget, Journal, Habits and Memories.
  // The name and the word order around the year both come from here, so a
  // Burmese page does not show "October 2026" under Burmese tabs.
  "month.01": "January",
  "month.02": "February",
  "month.03": "March",
  "month.04": "April",
  "month.05": "May",
  "month.06": "June",
  "month.07": "July",
  "month.08": "August",
  "month.09": "September",
  "month.10": "October",
  "month.11": "November",
  "month.12": "December",
  "month.year": "{month} {year}",
  "month.gridCaption": "{month} for {name}",
  // Month navigation is shared chrome (Budget's month/limits views and the
  // Habits grid), not one page's namespace.
  "month.previous": "Previous month",
  "month.next": "Next month",
  "month.this": "This month",
} as const;

export const myMonth: Record<keyof typeof enMonth, string> = {
  // Months — the year comes first in Burmese, so the template carries that
  // order rather than the pages gluing the two halves together.
  "month.01": "ဇန်နဝါရီ",
  "month.02": "ဖေဖော်ဝါရီ",
  "month.03": "မတ်",
  "month.04": "ဧပြီ",
  "month.05": "မေ",
  "month.06": "ဇွန်",
  "month.07": "ဇူလိုင်",
  "month.08": "ဩဂုတ်",
  "month.09": "စက်တင်ဘာ",
  "month.10": "အောက်တိုဘာ",
  "month.11": "နိုဝင်ဘာ",
  "month.12": "ဒီဇင်ဘာ",
  "month.year": "{year} ခုနှစ် {month}လ",
  "month.gridCaption": "{name} အတွက် {month}",
  "month.previous": "ယမန်လ",
  "month.next": "နောက်လ",
  "month.this": "ယခုလ",
};
