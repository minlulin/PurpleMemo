export const enSession = {
  "session.remindersTitle": "Reminders",
  "session.previewTitle": "Reminder: {title}",
  "session.dueTitle": "Reminder due",
  "session.dueBody": "Open Purple Memo to see the reminder.",
} as const;

export const mySession: Record<keyof typeof enSession, string> = {
  "session.remindersTitle": "သတိပေးချက်များ",
  "session.previewTitle": "သတိပေးချက် − {title}",
  "session.dueTitle": "သတိပေးချက် ရောက်နေသည်",
  "session.dueBody": "သတိပေးချက်ကို ကြည့်ရန် Purple Memo ကို ဖွင့်ပါ။",
};
