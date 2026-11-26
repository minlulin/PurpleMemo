export const enInbox = {
  "inbox.title": "Inbox",
  "inbox.subtitle":
    "Write it down the moment you think of it. Decide later what it becomes.",
  "inbox.newMemo": "New memo",
  "inbox.placeholder":
    "Type it. Enter captures, Shift+Enter starts a new line.",
  "inbox.capture": "Capture",
  "inbox.capturing": "Capturing…",
  "inbox.empty":
    "Nothing waiting. Write something above, or press Ctrl+Shift+M from anywhere.",
  "inbox.capturedAt": "captured {date}",
  "inbox.archive": "Archive",
  "inbox.archiving": "Archiving…",
  "inbox.converting": "Converting…",
  // The three conversion refusals: thrown keyed from lib/inbox.ts so a
  // raced or stale Convert click explains itself in the active locale (D11).
  "inbox.convertGone": "That capture no longer exists.",
  "inbox.convertArchived":
    "That capture was archived, so there is nothing to convert.",
  "inbox.convertFailed":
    "The capture was not converted and nothing was written. Try again.",
  "inbox.convertedToast": "Converted to {target} #{id}.",
  "inbox.earlier": "Earlier",
  "inbox.earlierBadge": "converted & archived",
  "inbox.earlierNote":
    "A converted capture records which note, task or journal entry it became. That record stays even if the target is later deleted — the capture was still captured, and it is never converted a second time.",
  "inbox.show": "Show",
  "inbox.hide": "Hide",
  "inbox.nothingEarlier": "Nothing converted or archived yet.",
  "inbox.convertedTo": "converted to {target} #{id}",
  "inbox.convertedGone": "converted to {target} #{id}, which no longer exists",
  "inbox.convertedOnly": "converted",
  "inbox.archivedAt": "archived {date}",
  "inbox.target.note": "note",
  "inbox.target.task": "task",
  "inbox.target.journal": "journal",
  "inbox.makeNote": "Make a note",
  "inbox.makeTask": "Make a task",
  "inbox.addToJournal": "Add to today's journal",
  "inbox.what.capture": "capture",
  "inbox.what.convertedCapture": "converted capture",
  "inbox.what.archivedCapture": "archived capture",
} as const;

export const myInbox: Record<keyof typeof enInbox, string> = {
  "inbox.title": "ဝင်စာ",
  "inbox.subtitle":
    "စဉ်းစားမိသည့် အခိုက်အတန့်တွင် ချရေးပါ။ ၎င်းသည် ဘာဖြစ်လာမည်ကို နောက်မှ ဆုံးဖြတ်ပါ။",
  "inbox.newMemo": "မှတ်စုအသစ်",
  "inbox.placeholder":
    "ရိုက်ထည့်ပါ။ Enter ဖြင့် ဖမ်းယူပြီး Shift+Enter ဖြင့် လိုင်းအသစ် စတင်ပါ။",
  "inbox.capture": "ဖမ်းယူမည်",
  "inbox.capturing": "ဖမ်းယူနေသည်…",
  "inbox.empty":
    "စောင့်နေသည့်အရာ မရှိပါ။ အပေါ်တွင် ချရေးပါ၊ သို့မဟုတ် မည်သည့်နေရာမှမဆို Ctrl+Shift+M ကို နှိပ်ပါ။",
  "inbox.capturedAt": "{date} တွင် ဖမ်းယူသည်",
  "inbox.archive": "စုစည်းသိမ်းမည်",
  "inbox.archiving": "စုစည်းသိမ်းနေသည်…",
  "inbox.converting": "ပြောင်းလဲနေသည်…",
  "inbox.convertGone": "အဆိုပါ ဖမ်းယူမှု မရှိတော့ပါ။",
  "inbox.convertArchived":
    "အဆိုပါ ဖမ်းယူမှုကို စုစည်းသိမ်းထားပြီးဖြစ်သောကြောင့် ပြောင်းလဲ၍ မရပါ။",
  "inbox.convertFailed":
    "ဖမ်းယူမှုကို ပြောင်းလဲခြင်း မပြုနိုင်ခဲ့ပါ။ ဘာမျှ မရေးသိမ်းထားပါ။ ထပ်မံကြိုးစားပါ။",
  "inbox.convertedToast": "{target} #{id} သို့ ပြောင်းလဲပြီးပါပြီ။",
  "inbox.earlier": "ယခင်က",
  "inbox.earlierBadge": "ပြောင်းလဲပြီး စုစည်းထားသည်",
  "inbox.earlierNote":
    "ပြောင်းလဲထားသော ဖမ်းယူမှုသည် မည်သည့် မှတ်စု၊ လုပ်ငန်း သို့မဟုတ် ဒိုင်ယာရီထည့်သွင်းမှု ဖြစ်သွားသည်ကို မှတ်တမ်းတင်ထားသည်။ ထို မှတ်တမ်းသည် ပစ်မှတ်ကို နောက်ပိုင်း ဖျက်လိုက်သော်လည်း ကျန်ရှိနေပြီး ထပ်မံပြောင်းလဲခြင်း မရှိပါ။",
  "inbox.show": "ပြမည်",
  "inbox.hide": "ဖျောက်မည်",
  "inbox.nothingEarlier": "ပြောင်းလဲထားသည် သို့မဟုတ် စုစည်းထားသည် မရှိသေးပါ။",
  "inbox.convertedTo": "{target} #{id} သို့ ပြောင်းလဲထားသည်",
  "inbox.convertedGone": "{target} #{id} သို့ ပြောင်းလဲထားသည်၊ သို့သော် ၎င်းမရှိတော့ပါ",
  "inbox.convertedOnly": "ပြောင်းလဲထားသည်",
  "inbox.archivedAt": "{date} တွင် စုစည်းသိမ်းထားသည်",
  "inbox.target.note": "မှတ်စု",
  "inbox.target.task": "လုပ်ငန်း",
  "inbox.target.journal": "ဒိုင်ယာရီ",
  "inbox.makeNote": "မှတ်စုတစ်ခု ပြုလုပ်မည်",
  "inbox.makeTask": "လုပ်ငန်းတစ်ခု ပြုလုပ်မည်",
  "inbox.addToJournal": "ယနေ့ ဒိုင်ယာရီသို့ ထည့်မည်",
  "inbox.what.capture": "ဖမ်းယူမှု",
  "inbox.what.convertedCapture": "ပြောင်းလဲထားသော ဖမ်းယူမှု",
  "inbox.what.archivedCapture": "စုစည်းထားသော ဖမ်းယူမှု",
};
