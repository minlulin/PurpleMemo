export const enShell = {
  "shell.skipToContent": "Skip to content",
  "shell.sections": "Sections",
  "shell.brandTagline": "Offline Workspace",
  "shell.search": "Search",
  "shell.searchTitle": "Search the workspace",
  "shell.searchAria": "Search workspace",
  "shell.newMemo": "New memo",
  "shell.newMemoTitle": "Capture a memo without leaving this page",
  "shell.lock": "Lock workspace",
  "shell.lockTitle": "Lock the app now",
  "shell.shortcuts": "Shortcuts",
  "shell.shortcutsTitle": "Keyboard shortcuts",
  "shell.shortcutsClose": "Close keyboard shortcuts",
  "shell.navGroup.workspace": "Workspace",
  "shell.navGroup.finance": "Finance",
  "shell.navGroup.personal": "Personal",
  "shell.navGroup.system": "System",
  "shell.error.readDb": "Could not read the encrypted database: {error}",
  "shell.error.bootFailed": "Purple Memo could not open its database: {error}",
  "shell.error.reloadWarning":
    "{error} Purple Memo will ask you to restart before the next lock.",
  "shell.notificationsBlocked":
    "Notifications are blocked — due reminders stay listed in Tasks.",
  "shell.listenerStopFailed":
    "The pairing window did not close — open the pairing panel and close it.",

  "shortcuts.esc": "Close a dialog",
  "shortcuts.tab": "Move inside a dialog, never behind it",
  "shortcuts.tabFirst": "First stop skips straight to the content",
} as const;

export const myShell: Record<keyof typeof enShell, string> = {
  "shell.skipToContent": "အကြောင်းအရာသို့ ကျော်သွားမည်",
  "shell.sections": "ကဏ္ဍများ",
  "shell.brandTagline": "အော့ဖ်လိုင်း လုပ်ငန်းခွင်",
  "shell.search": "ရှာဖွေမည်",
  "shell.searchTitle": "လုပ်ငန်းခွင်ကို ရှာဖွေမည်",
  "shell.searchAria": "လုပ်ငန်းခွင်ကို ရှာဖွေမည်",
  "shell.newMemo": "မှတ်စုအသစ်",
  "shell.newMemoTitle": "ဤစာမျက်နှာမှ မထွက်ဘဲ မှတ်စုတိုတစ်ခု ဖမ်းယူမည်",
  "shell.lock": "လုပ်ငန်းခွင်ကို သော့ခတ်မည်",
  "shell.lockTitle": "အက်ပ်ကို ယခု သော့ခတ်မည်",
  "shell.shortcuts": "အတိုကောက်များ",
  "shell.shortcutsTitle": "ကီးဘုတ်အတိုကောက်များ",
  "shell.shortcutsClose": "ကီးဘုတ်အတိုကောက်များကို ပိတ်မည်",
  "shell.navGroup.workspace": "လုပ်ငန်းခွင်",
  "shell.navGroup.finance": "ဘဏ္ဍာရေး",
  "shell.navGroup.personal": "ကိုယ်ပိုင်",
  "shell.navGroup.system": "စနစ်",
  "shell.error.readDb": "ကုဒ်ဝှက်ထားသော ဒေတာဘေ့စ်ကို ဖတ်၍ မရပါ — {error}",
  "shell.error.bootFailed": "Purple Memo က ၎င်း၏ဒေတာဘေ့စ်ကို ဖွင့်၍ မရပါ — {error}",
  "shell.error.reloadWarning":
    "{error} နောက်တစ်ကြိမ် သော့ခတ်မီ Purple Memo က ပြန်လည်စတင်ရန် တောင်းဆိုပါမည်။",
  "shell.notificationsBlocked":
    "အသိပေးချက်များ ပိတ်ထားသည် — ရောက်ရှိနေသော သတိပေးချက်များကို လုပ်ငန်းများတွင် စာရင်းပြထားဆဲဖြစ်သည်။",
  "shell.listenerStopFailed": "တွဲချိတ်ဝင်းဒိုး မရပ်တန့်နိုင်ပါ — တွဲချိတ်အကန့်ကို ဖွင့်ပြီး ပြန်ပိတ်ပါ။",

  "shortcuts.esc": "ဒိုင်ယာလော့ဂ်တစ်ခုကို ပိတ်မည်",
  "shortcuts.tab": "ဒိုင်ယာလော့ဂ်အတွင်း ရွေ့သွားမည်၊ နောက်ဘက်သို့ ဘယ်တော့မှ မရောက်ပါ",
  "shortcuts.tabFirst": "ပထမဆုံး ရပ်နားရာက အကြောင်းအရာသို့ တိုက်ရိုက် ကျော်သွားသည်",
};
