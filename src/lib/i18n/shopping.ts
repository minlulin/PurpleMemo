export const enShopping = {
  // Shopping — the fifth page on the catalogue (F6). The tabs are list names
  // (user data), so only the chrome around them is here: the two create forms,
  // the rename row, the per-item moves and the delete nouns.
  "shopping.title": "Shopping Lists",
  "shopping.subtitle":
    "Checkable shopping & packing lists with manual priority ordering",
  "shopping.newListAria": "New list name",
  "shopping.newListPlaceholder": "New list (e.g. Market)",
  "shopping.addList": "Add list",
  "shopping.emptyLists": "No shopping lists yet — add one above.",
  "shopping.deleteListWhat": "list “{name}” and its items",
  "shopping.deleteListAria": "Delete list {name}",
  "shopping.itemsAria": "Selected list items",
  "shopping.fallbackList": "List",
  "shopping.checked": "{done}/{total} checked",
  "shopping.listNameAria": "List name",
  "shopping.rename": "Rename list",
  "shopping.emptyItems": "Empty list — add items below.",
  "shopping.moveUpAria": "Move {name} up",
  "shopping.moveDownAria": "Move {name} down",
  "shopping.deleteItemWhat": "item",
  "shopping.newItemAria": "New item",
  "shopping.newItemPlaceholder": "Add item (e.g. Rice 5kg)",
  "shopping.addItem": "Add item",
  "shopping.itemMissing":
    "That shopping item no longer exists — it may have been deleted.",
} as const;

export const myShopping: Record<keyof typeof enShopping, string> = {
  // Shopping — mirrors the English block above key for key ({name}, {done},
  // {total}).
  "shopping.title": "ဈေးဝယ် စာရင်းများ",
  "shopping.subtitle":
    "အမှန်ခြစ် မှတ်နိုင်သော ဈေးဝယ်နှင့် ပစ္စည်းထုပ်ပိုး စာရင်းများ — ကိုယ်တိုင် ဦးစားပေး အစီအစဉ် သတ်မှတ်နိုင်သည်",
  "shopping.newListAria": "စာရင်း အမည် အသစ်",
  "shopping.newListPlaceholder": "စာရင်း အသစ် (ဥပမာ ဈေး)",
  "shopping.addList": "စာရင်း ထည့်မည်",
  "shopping.emptyLists": "ဈေးဝယ် စာရင်း မရှိသေးပါ — အပေါ်တွင် တစ်ခု ထည့်ပါ။",
  "shopping.deleteListWhat": "စာရင်း “{name}” နှင့် ၎င်း၏ ပစ္စည်းများ",
  "shopping.deleteListAria": "{name} စာရင်းကို ဖျက်မည်",
  "shopping.itemsAria": "ရွေးထားသော စာရင်း၏ ပစ္စည်းများ",
  "shopping.fallbackList": "စာရင်း",
  "shopping.checked": "{done}/{total} ပြီး",
  "shopping.listNameAria": "စာရင်း အမည်",
  "shopping.rename": "စာရင်း အမည်ပြောင်းမည်",
  "shopping.emptyItems": "စာရင်း လွတ်နေသည် — အောက်တွင် ပစ္စည်းများ ထည့်ပါ။",
  "shopping.moveUpAria": "{name} ကို အပေါ်သို့ ရွှေ့မည်",
  "shopping.moveDownAria": "{name} ကို အောက်သို့ ရွှေ့မည်",
  "shopping.deleteItemWhat": "ပစ္စည်း",
  "shopping.newItemAria": "ပစ္စည်း အသစ်",
  "shopping.newItemPlaceholder": "ပစ္စည်း ထည့်မည် (ဥပမာ ဆန် 5kg)",
  "shopping.addItem": "ပစ္စည်း ထည့်မည်",
  "shopping.itemMissing": "ထို ဈေးဝယ် ပစ္စည်း မရှိတော့ပါ — ဖျက်လိုက်ခြင်း ဖြစ်နိုင်သည်။",
};
