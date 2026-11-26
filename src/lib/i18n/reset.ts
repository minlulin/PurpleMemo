export const enReset = {
  "reset.dangerZone": "Danger zone",
  "reset.dangerZoneBadge": "Permanent",
  "reset.factoryReset": "Factory reset",
  "reset.irreversible": "A factory reset cannot be undone.",
  "reset.acknowledge":
    "I understand this permanently deletes everything Purple Memo stores on this device, and that it cannot be undone.",
  "reset.confirmWhat": "everything Purple Memo stores",
  "reset.run": "Factory reset…",
  "reset.running":
    "Factory reset is running — the database is being closed and everything is being deleted. Do not close the app.",
  "reset.successTitle": "Factory reset complete",
  "reset.successBody":
    "Everything Purple Memo stored on this device was removed. Restart to run first-run setup again.",
  "reset.restart": "Restart Purple Memo",
  "reset.incompleteTitle": "Factory reset did NOT complete",
  "reset.incompleteBody":
    "Some items could not be removed, and this session is over: the database connection is closed, so Purple Memo cannot be used until it is started again. The reset is safe to run again — retry it. If it keeps failing, close Purple Memo and start it yourself: the next launch opens either with whatever remains or into first-run setup, and the list below is exactly what was left behind.",
  "reset.retry": "Retry reset",
  "reset.errorTitle": "The factory reset could not run",
  "reset.errorBody":
    "The reset attempt failed before a full report could be produced. Nothing can be assumed about what was removed — the session is over either way: the database connection is closed, so retry the reset or close Purple Memo and start it yourself.",
  "reset.component.listenersStop": "Pairing listener",
  "reset.component.database": "Encrypted database",
  "reset.component.photos": "Photos",
  "reset.component.backups": "Backup copies the app made",
  "reset.component.logs": "Log files",
  "reset.component.keyringKey": "Database key (Windows credential store)",
  "reset.status.removed": "Removed",
  "reset.status.alreadyAbsent": "Already absent",
  "reset.status.failed": "Failed",
  "reset.status.notAttempted": "Not attempted",
} as const;

export const myReset: Record<keyof typeof enReset, string> = {
  "reset.dangerZone": "အန္တရာယ်ရှိ အပိုင်း",
  "reset.dangerZoneBadge": "အပြီးအပိုင်း ဖျက်မည်",
  "reset.factoryReset": "ဖက်တိုရီ ရိစတေ့ (Factory reset)",
  "reset.irreversible": "ဖက်တိုရီ ရိစတေ့ကို ပြန်လည်ရယူ၍ မရနိုင်ပါ။",
  "reset.acknowledge":
    "ဤလုပ်ဆောင်ချက်က Purple Memo ဤစက်တွင် သိမ်းဆည်းထားသမျှအားလုံးကို အပြီးအပိုင်း ဖျက်ပစ်မည်ဖြစ်ပြီး ပြန်လည်ရယူ၍ မရကြောင်း ကျွန်ုပ် နားလည်ပါသည်။",
  "reset.confirmWhat": "Purple Memo သိမ်းဆည်းထားသမျှ",
  "reset.run": "ဖျက်ပစ်မည်…",
  "reset.running":
    "ဖက်တိုရီ ရိစတေ့ လုပ်ဆောင်နေပါသည် — ဒေတာဘေ့စ်ကို ပိတ်ပြီး အားလုံးကို ဖျက်နေပါသည်။ အက်ပ်ကို မပိတ်ပါနှင့်။",
  "reset.successTitle": "ဖက်တိုရီ ရိစတေ့ ပြီးဆုံးပါပြီ",
  "reset.successBody":
    "ဤစက်တွင် Purple Memo သိမ်းဆည်းထားသမျှအားလုံး ဖျက်ပြီးပါပြီ။ ပထမဆုံး သတ်မှတ်ခြင်း အဆင့် ပြန်စရန် အက်ပ်ကို ပြန်ဖွင့်ပါ။",
  "reset.restart": "Purple Memo ကို ပြန်ဖွင့်မည်",
  "reset.incompleteTitle": "ဖက်တိုရီ ရိစတေ့ ပြီးဆုံးခြင်း မရှိပါ",
  "reset.incompleteBody":
    "အချို့ အစိတ်အပိုင်းများကို ဖျက်၍ မရသေးပါ၊ ပြီးတော့ ဤအသုံးပြုချိန် ပြီးဆုံးပါပြီ — ဒေတာဘေ့စ် ချိတ်ဆက်မှု ပိတ်ထားသဖြင့် ပြန်မဖွင့်မီ Purple Memo ကို အသုံးပြု၍ မရပါ။ ရိစတေ့ကို ထပ်ဖွင့်ရန် ဘေးကင်းပါသည် — ထပ်စမ်းကြည့်ပါ။ ထပ်မံ မအောင်မြင်ပါက Purple Memo ကို ပိတ်ပြီး ကိုယ်တိုင် ပြန်ဖွင့်ပါ — နောက်တစ်ကြိမ် ဖွင့်သောအခါ ကျန်ရှိသည်များဖြင့် ပုံမှန်အတိုင်း ဖွင့်လာမည် သို့မဟုတ် ပထမဆုံး သတ်မှတ်ခြင်း အဆင့်သို့ ရောက်သွားပါမည် — အောက်ပါ စာရင်းက အပြင်ကျန်ခဲ့သည်များအားလုံး ဖြစ်ပါသည်။",
  "reset.retry": "ထပ်စမ်းမည်",
  "reset.errorTitle": "ဖက်တိုရီ ရိစတေ့ မလုပ်ဆောင်နိုင်ပါ",
  "reset.errorBody":
    "ရိစတေ့ ကြိုးစားမှု မအောင်မြင်ပါ။ အဘယ်အရာ ဖျက်ခဲ့သည်ကို မည်သို့မျှ မယူဆရပါ — မည်သို့ဖြစ်စေ ဤအသုံးပြုချိန် ပြီးဆုံးပါပြီ — ဒေတာဘေ့စ် ချိတ်ဆက်မှု ပိတ်ထားသဖြင့် ရိစတေ့ကို ထပ်စမ်းပါ သို့မဟုတ် Purple Memo ကို ပိတ်ပြီး ကိုယ်တိုင် ပြန်ဖွင့်ပါ။",
  "reset.component.listenersStop": "တွဲချိတ် ဝင်းဒိုး",
  "reset.component.database": "ကုဒ်ဝှက်ထားသော ဒေတာဘေ့စ်",
  "reset.component.photos": "ဓာတ်ပုံများ",
  "reset.component.backups": "အက်ပ်၏ အရန်မိတ္တူများ",
  "reset.component.logs": "မှတ်တမ်းဖိုင်များ",
  "reset.component.keyringKey": "ဒေတာဘေ့စ် သော့ (Windows credential store)",
  "reset.status.removed": "ဖျက်ပြီး",
  "reset.status.alreadyAbsent": "မရှိတော့ပါ",
  "reset.status.failed": "မအောင်မြင်ပါ",
  "reset.status.notAttempted": "မကြိုးစားရသေးပါ",
};
