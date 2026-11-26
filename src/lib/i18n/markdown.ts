export const enMarkdown = {
  "markdown.linkFailed":
    "Could not open {url} — this system has no handler for it.",
} as const;

export const myMarkdown: Record<keyof typeof enMarkdown, string> = {
  "markdown.linkFailed": "{url} ကို ဖွင့်၍မရပါ — ဤစနစ်တွင် ကိုင်တွယ်သည့် အက်ပ်မရှိပါ။",
};
