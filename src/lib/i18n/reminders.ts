export const enReminders = {
  "reminders.noticeExact":
    "Reminders are scheduled on this phone and fire even when Purple Memo is closed.",
  "reminders.noticeInexact":
    "Exact alarms are not allowed on this phone, so reminders may arrive a few minutes late.",
  "reminders.noticeUnknown":
    "Reminders are scheduled on this phone; this device could not report whether they are exact.",
  "reminders.allowExact": "Allow exact alarms",

  "session.remindersTitle": "Reminders",
  "session.previewTitle": "Reminder: {title}",
  "session.dueTitle": "Reminder due",
  "session.dueBody": "Open Purple Memo to see the reminder.",
} as const;

export const myReminders: Record<keyof typeof enReminders, string> = {
  "reminders.noticeExact":
    "သတိပေးချက်များကို ဤဖုန်းတွင် အချိန်သတ်မှတ်ထားသောကြောင့် Purple Memo ပိတ်ထားလည်း အချိန်တိုင်း အသိပေးပါမည်။",
  "reminders.noticeInexact":
    "ဤဖုန်းတွင် တိကျသော နှိုးဆော်ချက် (exact alarm) ခွင့်မပြုထားပါ၊ ထို့ကြောင့် သတိပေးချက်များ မိနစ်အနည်းငယ် နောက်ကျနိုင်သည်။",
  "reminders.noticeUnknown":
    "သတိပေးချက်များကို ဤဖုန်းတွင် အချိန်သတ်မှတ်ထားသည်; သို့သော် တိကျမှုကို ဤစက်က မဖော်ပြနိုင်ပါ။",
  "reminders.allowExact": "တိကျသော နှိုးဆော်ချက်ကို ခွင့်ပြုရန်",

  "session.remindersTitle": "သတိပေးချက်များ",
  "session.previewTitle": "သတိပေးချက် − {title}",
  "session.dueTitle": "သတိပေးချက် ရောက်နေသည်",
  "session.dueBody": "သတိပေးချက်ကို ကြည့်ရန် Purple Memo ကို ဖွင့်ပါ။",
};
