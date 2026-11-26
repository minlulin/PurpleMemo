export const enHabits = {
  // Habits — the fourth page on the catalogue (F6). The week strip, the
  // streak line and the grid's month toggle all read from here; the month
  // headings and weekday names come from `month.*` and `weekday.*`.
  "habits.title": "Habits & Streaks",
  "habits.subtitle":
    "Build daily consistency with check-ins over the last 7 days and monthly history",
  "habits.newNameAria": "New habit name",
  "habits.namePlaceholder": "e.g. Read 20 minutes",
  "habits.add": "Add habit",
  "habits.empty": "No habits yet — add one above.",
  "habits.streak": "streak {current} · best {best}",
  "habits.doneToday": "Done today ✓",
  "habits.markDoneToday": "Mark done today",
  "habits.deleteWhat": "habit “{name}” and its streak history",
  "habits.last7": "Last 7 days",
  "habits.monthHistory": "Month history",
  "habits.showMonth": "Show month",
  "habits.hideMonth": "Hide month",
} as const;

export const myHabits: Record<keyof typeof enHabits, string> = {
  // Habits — mirrors the English block above key for key ({current}, {best},
  // {name}). Numbers stay as stored, the way amounts do elsewhere.
  "habits.title": "အလေ့အထနှင့် ဆက်တိုက်မှု",
  "habits.subtitle":
    "နောက်ဆုံး 7 ရက် မှတ်တမ်းတင်မှုနှင့် လစဉ် မှတ်တမ်းဖြင့် နေ့စဉ် စဉ်ဆက်မပြတ် လုပ်ဆောင်မှု တည်ဆောက်ပါ",
  "habits.newNameAria": "အလေ့အထ အမည် အသစ်",
  "habits.namePlaceholder": "ဥပမာ မိနစ် 20 ဖတ်မည်",
  "habits.add": "အလေ့အထ ထည့်မည်",
  "habits.empty": "အလေ့အထ မရှိသေးပါ — အပေါ်တွင် တစ်ခု ထည့်ပါ။",
  "habits.streak": "ဆက်တိုက် {current} ရက် · အကောင်းဆုံး {best} ရက်",
  "habits.doneToday": "ယနေ့ ပြီးပြီ ✓",
  "habits.markDoneToday": "ယနေ့ ပြီးပြီဟု မှတ်မည်",
  "habits.deleteWhat": "အလေ့အထ “{name}” နှင့် ၎င်း၏ ဆက်တိုက်မှု မှတ်တမ်း",
  "habits.last7": "နောက်ဆုံး 7 ရက်",
  "habits.monthHistory": "လစဉ် မှတ်တမ်း",
  "habits.showMonth": "လ ပြမည်",
  "habits.hideMonth": "လ ဖျောက်မည်",
};
