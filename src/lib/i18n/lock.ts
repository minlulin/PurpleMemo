export const enLock = {
  "lock.setup.badge": "Offline Encrypted Workspace",
  "lock.setup.title": "Welcome to Purple Memo",
  "lock.setup.intro":
    "Set a local PIN to protect your workspace. The PIN is required — there is no online recovery. Your security question below is the only way back in if you forget your PIN, and anyone who knows its answer can set a new PIN with it — so choose something only you know.",
  "lock.setup.choosePin": "Choose a PIN",
  "lock.setup.pinNote":
    "At least {count} characters. Stored as a salted hash — it is never written in plain text.",
  "lock.setup.pinLabel": "PIN (at least {count} characters)",
  "lock.setup.confirmPin": "Confirm PIN",
  "lock.setup.recoveryTitle": "Set your recovery question",
  "lock.setup.recoveryNote":
    "Your only way back in if you forget the PIN. Answer something only you know.",
  "lock.setup.question": "Security question",
  "lock.setup.questionPlaceholder": "e.g. What street did I grow up on?",
  "lock.setup.answer": "Security answer",
  "lock.setup.answerPlaceholder": "Memorable answer",
  "lock.setup.submit": "Set PIN and continue",
  "lock.setup.busy": "Setting up…",
  "lock.error.pinShort": "PIN must be at least {count} characters.",
  "lock.error.pinMismatch": "PINs do not match.",
  "lock.error.questionRequired":
    "A security question is required — it is your only recovery.",
  "lock.error.answerRequired": "The security answer is required.",

  "lock.badge": "Session Locked",
  "lock.title": "Purple Memo is locked",
  "lock.intro":
    "Enter your PIN to unlock your encrypted notebook and finance ledger.",
  "lock.pinLabel": "PIN",
  "lock.pinPlaceholder": "Enter PIN…",
  "lock.unlock": "Unlock",
  "lock.forgot": "Forgot PIN?",
  "lock.error.noAnswer":
    "No security answer is stored for this install — the PIN cannot be reset.",
  "lock.error.wrongPin": "Wrong PIN.",
  "lock.error.wrongAnswer": "Wrong answer.",
  "lock.error.tooMany":
    "Too many wrong attempts — wait {seconds} seconds before trying again.",
  "lock.biometric.promptTitle": "Unlock Purple Memo",
  "lock.biometric.usePin": "Use PIN",
  "lock.biometric.useFingerprint": "Use fingerprint",
  "lock.biometric.lockout": "Too many attempts. Use your PIN.",
  "lock.biometric.failed": "Fingerprint unlock did not work. Use your PIN.",
  "lock.reset.title": "Reset your PIN",
  "lock.reset.intro":
    "Answer your security question to set a new PIN. There is no other way to recover the PIN.",
  "lock.reset.warning":
    "This replaces your PIN. Anyone who knows your security answer can do the same and lock you out — if you still know your PIN, go back and use Change PIN in Settings instead.",
  "lock.reset.answer": "Answer",
  "lock.reset.answerPlaceholder": "Your security answer",
  "lock.reset.newPin": "New PIN",
  "lock.reset.confirmPin": "Confirm new PIN",
  "lock.reset.ack":
    "I understand this replaces my PIN, and that this is the only way to set one without knowing the current PIN.",
  "lock.reset.submit": "Set new PIN",
  "lock.reset.noAnswer":
    "The recovery fallback is unavailable for this install — the stored PIN is the only way in.",
  "lock.reset.shortPin": "New PIN must be at least {count} characters.",
  "lock.reset.unacknowledged":
    "Tick the acknowledgement first — a new PIN replaces the old one and cannot be undone.",
  "lock.unreadable.title": "Purple Memo is locked",
  "lock.unreadable.corrupt": "The stored PIN record could not be read.",
  "lock.unreadable.malformed":
    "The stored PIN record is not in a recognised format.",
  "lock.unreadable.weakIterations":
    "The stored PIN record was made with a key-derivation strength this version will not accept.",
  "lock.unreadable.body":
    "{detail} A PIN is set on this install, so the first-run setup is not offered and nothing can be unlocked until this record is readable. Restore the database from a backup taken before the problem started, or restore the settings row from another copy of this install.",
} as const;

export const myLock: Record<keyof typeof enLock, string> = {
  "lock.setup.badge": "အော့ဖ်လိုင်း ကုဒ်ဝှက်ထားသော လုပ်ငန်းခွင်",
  "lock.setup.title": "Purple Memo မှ ကြိုဆိုပါသည်",
  "lock.setup.intro":
    "သင့်လုပ်ငန်းခွင်ကို ကာကွယ်ရန် စက်တွင်းသုံး PIN တစ်ခု သတ်မှတ်ပါ။ PIN သည် မဖြစ်မနေ လိုအပ်ပြီး အွန်လိုင်းမှ ပြန်လည်ရယူနိုင်မည် မဟုတ်ပါ။ အောက်ပါ လုံခြုံရေးမေးခွန်းသည် PIN မေ့သွားပါက ပြန်ဝင်ရန် တစ်ခုတည်းသော နည်းလမ်းဖြစ်ပြီး ထိုအဖြေကို သိသူမည်သူမဆို ၎င်းဖြင့် PIN အသစ် သတ်မှတ်နိုင်သည် — ထို့ကြောင့် သင့်တစ်ဦးတည်း သိသောအရာကို ရွေးချယ်ပါ။",
  "lock.setup.choosePin": "PIN ရွေးချယ်ပါ",
  "lock.setup.pinNote":
    "အနည်းဆုံး စာလုံး {count} လုံး လိုအပ်သည်။ ဆားထည့်ထားသော hash အဖြစ် သိမ်းဆည်းပြီး ရိုးရိုးစာသားအဖြစ် ဘယ်တော့မှ မရေးပါ။",
  "lock.setup.pinLabel": "PIN (အနည်းဆုံး စာလုံး {count} လုံး)",
  "lock.setup.confirmPin": "PIN အတည်ပြုပါ",
  "lock.setup.recoveryTitle": "ပြန်လည်ရယူရန် မေးခွန်း သတ်မှတ်ပါ",
  "lock.setup.recoveryNote":
    "PIN မေ့သွားပါက ပြန်ဝင်ရန် တစ်ခုတည်းသော နည်းလမ်း။ သင့်တစ်ဦးတည်း သိသောအရာကို ဖြေပါ။",
  "lock.setup.question": "လုံခြုံရေးမေးခွန်း",
  "lock.setup.questionPlaceholder": "ဥပမာ − ကျွန်ုပ် ကြီးပြင်းခဲ့သော လမ်းအမည်ကား အဘယ်နည်း။",
  "lock.setup.answer": "လုံခြုံရေးအဖြေ",
  "lock.setup.answerPlaceholder": "မှတ်မိလွယ်သော အဖြေ",
  "lock.setup.submit": "PIN သတ်မှတ်ပြီး ဆက်လုပ်မည်",
  "lock.setup.busy": "ပြင်ဆင်နေသည်…",
  "lock.error.pinShort": "PIN သည် အနည်းဆုံး စာလုံး {count} လုံး ရှိရမည်။",
  "lock.error.pinMismatch": "PIN နှစ်ခု မတူညီပါ။",
  "lock.error.questionRequired":
    "လုံခြုံရေးမေးခွန်း လိုအပ်သည် — ၎င်းသည် သင့်အတွက် တစ်ခုတည်းသော ပြန်လည်ရယူရေး နည်းလမ်းဖြစ်သည်။",
  "lock.error.answerRequired": "လုံခြုံရေးအဖြေ လိုအပ်သည်။",

  "lock.badge": "စက်ရှင် သော့ခတ်ထားသည်",
  "lock.title": "Purple Memo ကို သော့ခတ်ထားသည်",
  "lock.intro": "ကုဒ်ဝှက်ထားသော မှတ်စုစာအုပ်နှင့် ဘဏ္ဍာရေးစာရင်းကို ဖွင့်ရန် PIN ထည့်ပါ။",
  "lock.pinLabel": "PIN",
  "lock.pinPlaceholder": "PIN ထည့်ပါ…",
  "lock.unlock": "ဖွင့်မည်",
  "lock.forgot": "PIN မေ့နေပါသလား။",
  "lock.error.noAnswer":
    "ဤတပ်ဆင်မှုအတွက် လုံခြုံရေးအဖြေ မသိမ်းဆည်းထားပါ — PIN ကို ပြန်လည်သတ်မှတ်၍ မရပါ။",
  "lock.error.wrongPin": "PIN မှားနေသည်။",
  "lock.error.wrongAnswer": "အဖြေ မှားနေသည်။",
  "lock.error.tooMany":
    "မှားယွင်းစွာ ကြိုးစားမှု များလွန်းသည် — ထပ်မံကြိုးစားမီ စက္ကန့် {seconds} စောင့်ပါ။",
  "lock.biometric.promptTitle": "Purple Memo ကို ဖွင့်ရန်",
  "lock.biometric.usePin": "PIN သုံးမည်",
  "lock.biometric.useFingerprint": "လက်ဗွေ ဖြင့် ဖွင့်မည်",
  "lock.biometric.lockout": "ကြိုးစားမှု များလွန်းသည်။ သင့် PIN ကို သုံးပါ။",
  "lock.biometric.failed": "လက်ဗွေ ဖြင့် ဖွင့်၍ မရပါ။ သင့် PIN ကို သုံးပါ။",
  "lock.reset.title": "PIN ပြန်လည်သတ်မှတ်ပါ",
  "lock.reset.intro":
    "PIN အသစ် သတ်မှတ်ရန် သင့်လုံခြုံရေးမေးခွန်းကို ဖြေပါ။ PIN ပြန်လည်ရယူရန် အခြားနည်းလမ်း မရှိပါ။",
  "lock.reset.warning":
    "ဤလုပ်ဆောင်ချက်သည် သင့် PIN ကို အစားထိုးပါမည်။ သင့်လုံခြုံရေးအဖြေကို သိသူမည်သူမဆို ထိုသို့ပြုလုပ်ပြီး သင့်ကို ပိတ်ဆို့နိုင်သည် — PIN ကို အလွတ်ရသေးပါက နောက်သို့ပြန်ပြီး ဆက်တင်များရှိ PIN ပြောင်းလဲခြင်းကို အသုံးပြုပါ။",
  "lock.reset.answer": "အဖြေ",
  "lock.reset.answerPlaceholder": "သင့်လုံခြုံရေးအဖြေ",
  "lock.reset.newPin": "PIN အသစ်",
  "lock.reset.confirmPin": "PIN အသစ် အတည်ပြုပါ",
  "lock.reset.ack":
    "ဤလုပ်ဆောင်ချက်သည် ကျွန်ုပ်၏ PIN ကို အစားထိုးကြောင်း၊ လက်ရှိ PIN မသိဘဲ PIN သတ်မှတ်ရန် ဤနည်းလမ်းသာ ရှိကြောင်း နားလည်ပါသည်။",
  "lock.reset.submit": "PIN အသစ် သတ်မှတ်မည်",
  "lock.reset.noAnswer":
    "ဤတပ်ဆင်မှုအတွက် ပြန်လည်ရယူရေးနည်းလမ်း မရနိုင်ပါ — သိမ်းဆည်းထားသော PIN သာ တစ်ခုတည်းသော ဝင်ပေါက်ဖြစ်သည်။",
  "lock.reset.shortPin": "PIN အသစ်သည် အနည်းဆုံး စာလုံး {count} လုံး ရှိရမည်။",
  "lock.reset.unacknowledged":
    "အသိအမှတ်ပြုချက်ကို အရင်စစ်ပါ — PIN အသစ်သည် အတူတူကို အစားထိုးပြီး ပြန်လည်ပြုပြင်၍ မရပါ။",
  "lock.unreadable.title": "Purple Memo ကို သော့ခတ်ထားသည်",
  "lock.unreadable.corrupt": "သိမ်းဆည်းထားသော PIN မှတ်တမ်းကို ဖတ်၍ မရပါ။",
  "lock.unreadable.malformed":
    "သိမ်းဆည်းထားသော PIN မှတ်တမ်းသည် အသိအမှတ်ပြုထားသော ပုံစံဖြင့် မဟုတ်ပါ။",
  "lock.unreadable.weakIterations":
    "သိမ်းဆည်းထားသော PIN မှတ်တမ်းကို ဤဗားရှင်း လက်မခံနိုင်သော key-derivation ခွန်အားဖြင့် ပြုလုပ်ထားသည်။",
  "lock.unreadable.body":
    "{detail} ဤတပ်ဆင်မှုတွင် PIN သတ်မှတ်ထားသောကြောင့် ပထမဆုံးအသုံးပြုမှု ပြင်ဆင်ခြင်းကို မကမ်းလှမ်းပါ၊ ဤမှတ်တမ်းကို ဖတ်နိုင်သည်အထိ မည်သည့်အရာကိုမျှ ဖွင့်၍ မရပါ။ ပြဿနာ မစမီ ရယူထားသော အရန်သိမ်းဆည်းမှုမှ ဒေတာဘေ့စ်ကို ပြန်လည်ရယူပါ၊ သို့မဟုတ် ဤတပ်ဆင်မှု၏ အခြားမိတ္တူမှ ဆက်တင်များအတန်းကို ပြန်လည်ရယူပါ။",
};
