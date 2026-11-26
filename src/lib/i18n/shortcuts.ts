export const enShortcuts = {
  "shortcuts.esc": "Close a dialog",
  "shortcuts.tab": "Move inside a dialog, never behind it",
  "shortcuts.tabFirst": "First stop skips straight to the content",
} as const;

export const myShortcuts: Record<keyof typeof enShortcuts, string> = {
  "shortcuts.esc": "ဒိုင်ယာလော့ဂ်တစ်ခုကို ပိတ်မည်",
  "shortcuts.tab": "ဒိုင်ယာလော့ဂ်အတွင်း ရွေ့သွားမည်၊ နောက်ဘက်သို့ ဘယ်တော့မှ မရောက်ပါ",
  "shortcuts.tabFirst": "ပထမဆုံး ရပ်နားရာက အကြောင်းအရာသို့ တိုက်ရိုက် ကျော်သွားသည်",
};
