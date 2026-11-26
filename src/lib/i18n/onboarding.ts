export const enOnboarding = {
  "onboarding.title": "Welcome to Purple Memo",
  "onboarding.intro": "A quick note on what this app can and cannot do.",
  "onboarding.pinTitle": "PIN recovery has limits",
  "onboarding.pinBody":
    "If you forget your PIN, recovery depends on the security question you set. There is no master reset that keeps your data.",
  "onboarding.keyTitle": "Keep the database key safe",
  "onboarding.keyBody":
    "Settings → Encryption key export writes a separate key file. Without it, a backup cannot open the database it came from.",
  "onboarding.backupTitle": "Backups replace everything",
  "onboarding.backupBody":
    "Restoring a backup replaces all current data. Export first if you are unsure.",
  "onboarding.offlineTitle": "Offline, with limits",
  "onboarding.offlineBody":
    "Reminders appear only while Purple Memo is open and unlocked. Nothing syncs to a server.",
  "onboarding.dismiss": "Got it",
} as const;

export const myOnboarding: Record<keyof typeof enOnboarding, string> = {
  "onboarding.title": "Purple Memo မှ ကြိုဆိုပါသည်",
  "onboarding.intro": "ဤအက်ပ်က ဘာလုပ်နိုင်သည်၊ ဘာမလုပ်နိုင်သည်ကို အမြန်ရှင်းပြချက်။",
  "onboarding.pinTitle": "PIN ပြန်လည်ရယူမှုတွင် ကန့်သတ်ချက်များ ရှိသည်",
  "onboarding.pinBody":
    "PIN မေ့သွားပါက ပြန်လည်ရယူမှုသည် သင်သတ်မှတ်ထားသော လုံခြုံရေးမေးခွန်းအပေါ် မူတည်သည်။ ဒေတာများ ဆက်လက်ရှိနေစေမည့် master reset မရှိပါ။",
  "onboarding.keyTitle": "ဒေတာဘေ့စ်သော့ကို လုံခြုံစွာ သိမ်းထားပါ",
  "onboarding.keyBody":
    "ဆက်တင်များ → ကုဒ်ဖျက်သော့ ထုတ်ယူမှုသည် သီးခြားသော့ဖိုင်တစ်ခု ရေးသည်။ ၎င်းမရှိလျှင် အရန်သိမ်းဆည်းမှုဖြင့် မူလဒေတာဘေ့စ်ကို ဖွင့်၍ မရပါ။",
  "onboarding.backupTitle": "အရန်သိမ်းဆည်းမှုများသည် အရာအားလုံးကို အစားထိုးသည်",
  "onboarding.backupBody":
    "အရန်သိမ်းဆည်းမှု ပြန်လည်ရယူခြင်းသည် လက်ရှိဒေတာအားလုံးကို အစားထိုးမည်။ မသေချာပါက ဦးစွာ ထုတ်ယူပါ။",
  "onboarding.offlineTitle": "အော့ဖ်လိုင်း၊ ကန့်သတ်ချက်များနှင့်အတူ",
  "onboarding.offlineBody":
    "သတိပေးချက်များသည် Purple Memo ဖွင့်ထားပြီး လော့ခ်ဖွင့်ထားစဉ်တွင်သာ ပေါ်လာမည်။ ဆာဗာသို့ မည်သည့်အရာမျှ မထပ်တူပြုပါ။",
  "onboarding.dismiss": "နားလည်ပါပြီ",
};
