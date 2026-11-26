export const enLinkPicker = {
  "linkPicker.title": "Link to",
  "linkPicker.close": "Close the link picker",
  "linkPicker.searchLabel": "Search",
  "linkPicker.searchAria": "Search notes, tasks and contacts",
  "linkPicker.includeInactive": "Include archived notes and completed tasks",
  "linkPicker.empty":
    "Nothing to link here. A note, task or contact has to exist first.",
  "linkPicker.listAria": "Things you can link to",
  "linkPicker.capped":
    "Showing {shown} of {matched} matches. Narrow the search, or include archived and completed items.",
  "linkPicker.due": "Due",
  "linkPicker.birthday": "Birthday",
  "linkPicker.linking": "Linking…",
  "linkPicker.loading": "Loading your notes, tasks and contacts…",
} as const;

export const myLinkPicker: Record<keyof typeof enLinkPicker, string> = {
  "linkPicker.title": "ချိတ်ဆက်မည့်အရာ",
  "linkPicker.close": "ချိတ်ဆက်မှု ရွေးချယ်ကွက်ကို ပိတ်မည်",
  "linkPicker.searchLabel": "ရှာဖွေမည်",
  "linkPicker.searchAria": "မှတ်စုများ၊ လုပ်ငန်းများနှင့် ဆက်သွယ်ရန်များ ရှာဖွေမည်",
  "linkPicker.includeInactive":
    "မော်ကွန်းတင်ထားသော မှတ်စုများနှင့် ပြီးစီးသော လုပ်ငန်းများ ပါဝင်စေမည်",
  "linkPicker.empty":
    "ဤနေရာတွင် ချိတ်ဆက်ရန် မရှိပါ။ မှတ်စု၊ လုပ်ငန်း သို့မဟုတ် ဆက်သွယ်ရန် တစ်ခု ရှိရပါမည်။",
  "linkPicker.listAria": "ချိတ်ဆက်နိုင်သော အရာများ",
  "linkPicker.capped":
    "ကိုက်ညီမှု {matched} ခုအနက် {shown} ခု ပြနေသည်။ ရှာဖွေမှုကို ကျဉ်းမြောင်းစေပါ၊ သို့မဟုတ် မော်ကွန်းတင်ထားသော၊ ပြီးစီးသော အရာများ ပါဝင်စေပါ။",
  "linkPicker.due": "ရက်စွဲ",
  "linkPicker.birthday": "မွေးနေ့",
  "linkPicker.linking": "ချိတ်ဆက်နေသည်…",
  "linkPicker.loading": "သင့်မှတ်စုများ၊ လုပ်ငန်းများနှင့် ဆက်သွယ်ရန်များကို ဖွင့်နေသည်…",
};
