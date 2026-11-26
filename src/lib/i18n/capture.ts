export const enCapture = {
  "capture.title": "New memo",
  "capture.label": "Memo",
  "capture.aria": "New memo",
  "capture.placeholder":
    "Type it. Enter captures, Shift+Enter starts a new line.",
  "capture.capturing": "Capturing…",
  "capture.submit": "Capture",
  "capture.hint":
    "It waits in the inbox until you decide whether it is a note, a task, or a line for today's journal.",
  "capture.empty": "Type something before capturing.",
  "capture.saved": "Captured. It will wait in the inbox.",
  "capture.close": "Close new memo",
} as const;

export const myCapture: Record<keyof typeof enCapture, string> = {
  "capture.title": "မှတ်စုအသစ်",
  "capture.label": "မှတ်စု",
  "capture.aria": "မှတ်စုအသစ်",
  "capture.placeholder":
    "ရိုက်ထည့်ပါ။ Enter ဖြင့် ဖမ်းယူပြီး Shift+Enter ဖြင့် လိုင်းအသစ် စတင်ပါ။",
  "capture.capturing": "ဖမ်းယူနေသည်…",
  "capture.submit": "ဖမ်းယူမည်",
  "capture.hint":
    "၎င်းသည် မှတ်စု၊ လုပ်ငန်း သို့မဟုတ် ယနေ့ ဒိုင်ယာရီအတွက် တစ်ကြောင်း ဖြစ်မည်ကို သင်ဆုံးဖြတ်သည်အထိ ဝင်စာထဲတွင် စောင့်နေပါမည်။",
  "capture.empty": "မဖမ်းယူမီ တစ်ခုခု ရိုက်ထည့်ပါ။",
  "capture.saved": "ဖမ်းယူပြီးပါပြီ။ ဝင်စာထဲတွင် စောင့်နေပါမည်။",
  "capture.close": "မှတ်စုအသစ်ကို ပိတ်မည်",
};
