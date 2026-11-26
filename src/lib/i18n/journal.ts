export const enJournal = {
  // Journal — one entry per day. Its day headings and month navigation are
  // the shared `weekday.*` / `month.*` chrome, so only the page's own text is
  // here.
  "journal.calendar": "Calendar",
  "journal.monthGrid": "Month grid",
  "journal.today": "Today",
  "journal.entryAria": "Journal entry",
  "journal.missing":
    "That journal entry no longer exists — it may have been deleted.",
  "journal.saved": "Saved",
  "journal.unsaved": "Unsaved draft",
  "journal.discard": "Discard draft",
  "journal.discardTitle":
    "Discard the unsaved draft and reload the saved entry",
  "journal.save": "Save entry",
  "journal.saving": "Saving…",
  "journal.deleteWhat": "journal entry to Trash",
  "journal.reflection": "Daily reflection",
  "journal.history": "History",
  "journal.placeholder": "Write today's entry in markdown…",
  "journal.contentAria": "Journal entry content (markdown)",
  "journal.preview": "Live preview",
  "journal.previewEmpty": "Live preview appears here.",
} as const;

export const myJournal: Record<keyof typeof enJournal, string> = {
  "journal.calendar": "ပြက္ခဒိန်",
  "journal.monthGrid": "လ ဇယားကွက်",
  "journal.today": "ယနေ့",
  "journal.entryAria": "ဂျာနယ် မှတ်တမ်း",
  "journal.missing": "ထို ဂျာနယ် မှတ်တမ်း မရှိတော့ပါ — ဖျက်လိုက်ခြင်း ဖြစ်နိုင်သည်။",
  "journal.saved": "သိမ်းပြီး",
  "journal.unsaved": "မသိမ်းရသေးသော မူကြမ်း",
  "journal.discard": "မူကြမ်း ပယ်ဖျက်",
  "journal.discardTitle": "မသိမ်းရသေးသော မူကြမ်းကို ပယ်ပြီး သိမ်းထားသည့် မှတ်တမ်းကို ပြန်ဖွင့်မည်",
  "journal.save": "မှတ်တမ်း သိမ်းမည်",
  "journal.saving": "သိမ်းနေသည်…",
  "journal.deleteWhat": "အမှိုက်ပုံးသို့ ပို့မည့် ဂျာနယ် မှတ်တမ်း",
  "journal.reflection": "နေ့စဉ် ဆင်ခြင်မှတ်စု",
  "journal.history": "သမိုင်း",
  "journal.placeholder": "ယနေ့ မှတ်တမ်းကို markdown ဖြင့် ရေးပါ…",
  "journal.contentAria": "ဂျာနယ် မှတ်တမ်း အကြောင်းအရာ (markdown)",
  "journal.preview": "တိုက်ရိုက် အစမ်းကြည့်ရှုမှု",
  "journal.previewEmpty": "တိုက်ရိုက် အစမ်းကြည့်ရှုမှုကို ဤနေရာတွင် ပြမည်။",
};
