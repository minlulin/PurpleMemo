export const enTrash = {
  "trash.title": "Trash",
  "trash.subtitle":
    "Deleted notes, tasks, contacts, memories, and journal entries stay here for {days} days, up to {max} items.",
  "trash.notice":
    "Permanent deletion removes the item from Purple Memo. It is not forensic erasure, and operating-system backups may retain copies.",
  "trash.empty": "Trash is empty.",
  "trash.restore": "Restore",
  "trash.deletePermanently": "Delete permanently",
  "trash.deletedAt": "{type} · deleted {date}",
  "trash.restored": "Restored.",
  "trash.permanentlyDeleted": "Permanently deleted.",
  "trash.deleteWhat": "Trash item permanently",
  "trash.type.note": "Note",
  "trash.type.task": "Task",
  "trash.type.contact": "Contact",
  "trash.type.memory": "Memory",
  "trash.type.journalEntry": "Journal entry",
  "trash.type.shoppingList": "Shopping list",
  "trash.type.shoppingItem": "Shopping item",
  "trash.conflictWon": "Winner: {value}",
} as const;

export const myTrash: Record<keyof typeof enTrash, string> = {
  "trash.title": "အမှိုက်ပုံး",
  "trash.subtitle":
    "ဖျက်လိုက်သော မှတ်စုများ၊ လုပ်ငန်းများ၊ ဆက်သွယ်ရန်များ၊ အမှတ်တရများနှင့် ဒိုင်ယာရီထည့်သွင်းမှုများကို ဤနေရာတွင် ရက် {days} ရက်အထိ၊ အများဆုံး {max} ခုအထိ သိမ်းထားသည်။",
  "trash.notice":
    "အပြီးအပိုင် ဖျက်ခြင်းသည် ပစ္စည်းကို Purple Memo မှ ဖယ်ရှားသည်။ ၎င်းသည် မှုခင်းဆိုင်ရာ ဖျက်ပစ်ခြင်း မဟုတ်ပါ၊ လည်ပတ်မှုစနစ်၏ အရန်သိမ်းဆည်းမှုများတွင် မိတ္တူများ ကျန်နိုင်ပါသည်။",
  "trash.empty": "အမှိုက်ပုံး ဗလာဖြစ်နေသည်။",
  "trash.restore": "ပြန်လည်ရယူမည်",
  "trash.deletePermanently": "အပြီးအပိုင် ဖျက်မည်",
  "trash.deletedAt": "{type} · {date} တွင် ဖျက်ခဲ့သည်",
  "trash.restored": "ပြန်လည်ရယူပြီးပါပြီ။",
  "trash.permanentlyDeleted": "အပြီးအပိုင် ဖျက်ပြီးပါပြီ။",
  "trash.deleteWhat": "အမှိုက်ပုံးပစ္စည်း (အပြီးအပိုင်)",
  "trash.type.note": "မှတ်စု",
  "trash.type.task": "လုပ်ငန်း",
  "trash.type.contact": "ဆက်သွယ်ရန်",
  "trash.type.memory": "အမှတ်တရ",
  "trash.type.journalEntry": "ဒိုင်ယာရီထည့်သွင်းမှု",
  "trash.type.shoppingList": "စျေးဝယ်စာရင်း",
  "trash.type.shoppingItem": "စျေးဝယ်ပစ္စည်း",
  "trash.conflictWon": "အနိုင်ရသူ — {value}",
};
