export const enLinks = {
  "links.relatedAria": "Related items",
  "links.related": "Related",
  "links.linkTo": "Link to…",
  "links.loading": "Loading related items…",
  "links.alreadyLinked": "Those two are already linked.",
  "links.empty": "Not related to anything yet.",
  "links.unavailable": "{type} — unavailable (it was deleted)",
  "links.unlinkWhat": "link",
  "links.unlink": "Unlink",

  "markdown.linkFailed":
    "Could not open {url} — this system has no handler for it.",
} as const;

export const myLinks: Record<keyof typeof enLinks, string> = {
  "links.relatedAria": "ဆက်စပ်အရာများ",
  "links.related": "ဆက်စပ်မှု",
  "links.linkTo": "ချိတ်ဆက်မည်…",
  "links.loading": "ဆက်စပ်အရာများကို ဖွင့်နေသည်…",
  "links.alreadyLinked": "ထို နှစ်ခု ချိတ်ဆက်ပြီးဖြစ်သည်။",
  "links.empty": "မည်သည့်အရာနှင့်မျှ မဆက်စပ်ရသေးပါ။",
  "links.unavailable": "{type} — မရနိုင်တော့ပါ (ဖျက်လိုက်ခြင်း)",
  "links.unlinkWhat": "ချိတ်ဆက်မှု",
  "links.unlink": "ချိတ်ဆက်မှု ဖြုတ်မည်",

  "markdown.linkFailed": "{url} ကို ဖွင့်၍မရပါ — ဤစနစ်တွင် ကိုင်တွယ်သည့် အက်ပ်မရှိပါ။",
};
