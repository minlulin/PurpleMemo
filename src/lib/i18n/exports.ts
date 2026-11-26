export const enExports = {
  // Exports — the readable-copy page and the archive's README.txt and
  // EXPORT-FIELDS.md. Schema names, column names and paths stay literal; the
  // prose around them comes from the same keys the page shows.
  "exports.title": "Exports",
  "exports.subtitle":
    "Human-readable Markdown, CSV and vCard in one ZIP archive",
  "exports.chooseOne": "Choose at least one group to export.",
  "exports.saveTitle": "Save Purple Memo readable export",
  "exports.zipFilter": "ZIP archive",
  "exports.saved":
    "Readable export saved to {path} - {files} files ({notes} notes, {journal} journal entries, {finance} finance rows, {tasks} tasks, {contacts} contacts).",
  "exports.building": "Building archive…",
  "exports.export": "Export readable ZIP",
  "exports.whatToExport": "What to export",
  "exports.readableCopy":
    "This is a readable copy, not a restorable backup. Photo files, Vault ciphertext, settings and Trash are never included.",
  "exports.oneFile":
    "One UTF-8 ZIP file. CSV uses RFC 4180 quoting and CRLF; Markdown and vCard text keep their Unicode.",
  "exports.fieldMapping": "Field mapping",
  "exports.sameTable":
    "The same table is written into every archive as EXPORT-FIELDS.md.",
  "exports.source": "Source",
  "exports.fields": "Fields",
  "exports.destination": "Destination",
  "exports.notes": "Notes",
  "exports.group.notesBlurb":
    "Markdown files with front matter, tags, collections and archive state",
  "exports.group.journalBlurb": "One Markdown file per day under journal/yyyy/",
  "exports.group.finance": "Finance CSV",
  "exports.group.financeBlurb": "Income, expenses, loans, jobs and payables",
  "exports.group.tasks": "Tasks CSV",
  "exports.group.tasksBlurb":
    "Actionable to-dos, due dates and repeat schedules",
  "exports.group.contactsBlurb": "vCard 4.0 and CSV address book",

  // The archive's own documents. They follow the interface language, while the
  // schema names, column names and paths inside them stay literal.
  "exports.archive.title": "Purple Memo readable export - field mapping",
  "exports.archive.intro":
    "Every stored table is either mapped below or named as deliberately excluded.",
  "exports.readme.title": "Purple Memo readable export",
  "exports.readme.generated": "Generated: {date}",
  "exports.readme.contents": "Contents:",
  "exports.readme.notes": "notes/ - Markdown notes with YAML front matter",
  "exports.readme.journal": "journal/ - Markdown journal entries",
  "exports.readme.finance":
    "finance/ - income, expenses, loans, jobs, payables CSV",
  "exports.readme.tasks": "tasks.csv - tasks & repeating schedules CSV",
  "exports.readme.contacts":
    "contacts.vcf + contacts.csv - vCard 4.0 and CSV address book",
  "exports.readme.fields":
    "EXPORT-FIELDS.md - field-by-field inclusion mapping",
  "exports.readme.encoding":
    "Text is UTF-8. CSV files use RFC 4180 quoting with CRLF line endings.",
  "exports.readme.formula":
    "A CSV text value that starts with =, +, -, @, tab or carriage return is prefixed with an apostrophe so spreadsheets treat it as text, never a formula.",
  "exports.readme.money":
    "Money appears twice: amount_cents is the stored integer, amount is decimal major units with a dot separator. Dates are ISO yyyy-mm-dd.",
  "exports.readme.excluded":
    "Photo bytes, Vault ciphertext, settings and Trash are not in this export. Use a backup archive when you need a complete, restorable copy.",

  // The Notes column of the field-mapping table, one key per prose cell.
  "exports.mapping.collections":
    "The collection name is written as text; collections with no notes export no file.",
  "exports.mapping.notes":
    "Every row in the table, archived rows included. Tags are an array. Trash rows are excluded.",
  "exports.mapping.photoRefs":
    "Reference paths only. Photo bytes are not part of a readable export; they are only in a backup archive.",
  "exports.mapping.journal": "Every row; one file per calendar day.",
  "exports.mapping.amountDecimal":
    "amount is decimal major units; amount_cents is the stored integer.",
  "exports.mapping.loans":
    "state is derived at export time from repaid_cents, amount_cents and due_date.",
  "exports.mapping.jobs":
    "shop is the shop name, or empty when the job has none. Remaining never goes below zero.",
  "exports.mapping.payables":
    "Paid and unpaid rows are both exported; paid stays the stored 0/1 flag.",
  "exports.mapping.tasks":
    "Open and completed tasks are both exported; columns match the Tasks CSV importer.",
  "exports.mapping.contacts":
    "vCard 4.0 cards plus a semicolon-joined CSV matching the Contacts CSV importer; channels keep primary order.",
  "exports.mapping.referenceTables":
    "Reference tables are not separate files; a renamed row exports under its current name.",
  "exports.mapping.trash":
    "Deliberately excluded from readable exports. Trash stays recoverable in the app and is included in backup archives.",
  "exports.mapping.vault":
    "Deliberately excluded. Vault contents are ciphertext and are covered by backup archives instead.",
  "exports.mapping.notIncluded":
    "Not part of the readable export set; they remain available through backup archives.",
  "exports.mapping.settings":
    "Never exported: theme, PIN, security question and notification preferences are local app state.",
} as const;

export const myExports: Record<keyof typeof enExports, string> = {
  "exports.title": "ထုတ်ယူမှုများ",
  "exports.subtitle": "Markdown၊ CSV နှင့် vCard ကို ZIP တစ်ခုတည်းအဖြစ် လူဖတ်နိုင်သော ဖိုင်များ",
  "exports.chooseOne": "ထုတ်ယူရန် အနည်းဆုံး အမျိုးအစား တစ်ခု ရွေးပါ။",
  "exports.saveTitle": "Purple Memo ဖတ်နိုင်သော ထုတ်ယူချက် သိမ်းမည်",
  "exports.zipFilter": "ZIP ဖိုင်",
  "exports.saved":
    "ဖတ်နိုင်သော ထုတ်ယူချက်ကို {path} တွင် သိမ်းပြီး — ဖိုင် {files} ခု (မှတ်စု {notes}၊ ဂျာနယ် မှတ်တမ်း {journal}၊ ငွေရေးကြေးရေး အတန်း {finance}၊ လုပ်ငန်း {tasks}၊ ဆက်သွယ်ရန် {contacts})။",
  "exports.building": "ဖိုင်စု တည်ဆောက်နေသည်…",
  "exports.export": "ဖတ်နိုင်သော ZIP ထုတ်ယူမည်",
  "exports.whatToExport": "မည်သည့်အရာ ထုတ်ယူမည်",
  "exports.readableCopy":
    "ဤသည် ဖတ်ရန်သာ ဖြစ်ပြီး ပြန်လည်ထည့်သွင်းနိုင်သော အရန်သိမ်း မဟုတ်ပါ။ ဓာတ်ပုံဖိုင်များ၊ Vault စာဝှက်စာ၊ ဆက်တင်များနှင့် အမှိုက်ပုံးကို ဘယ်တော့မှ မထည့်ပါ။",
  "exports.oneFile":
    "UTF-8 ZIP ဖိုင် တစ်ခု။ CSV တွင် RFC 4180 quoting နှင့် CRLF ကို သုံးသည်။ Markdown နှင့် vCard စာသားများ ယူနီကုဒ် အတိုင်း ကျန်သည်။",
  "exports.fieldMapping": "ဒေတာကွက် ဆက်စပ်မှု",
  "exports.sameTable": "ဤဇယားကို EXPORT-FIELDS.md အဖြစ် ဖိုင်စုတိုင်းတွင် ရေးထည့်သည်။",
  "exports.source": "ရင်းမြစ်",
  "exports.fields": "ဒေတာကွက်များ",
  "exports.destination": "သိမ်းဆည်းမည့် နေရာ",
  "exports.notes": "မှတ်ချက်များ",
  "exports.group.notesBlurb":
    "Front matter၊ တဂ်များ၊ စုစည်းမှုများနှင့် မော်ကွန်းအခြေအနေ ပါသော Markdown ဖိုင်များ",
  "exports.group.journalBlurb": "journal/yyyy/ အောက်တွင် တစ်ရက်လျှင် Markdown ဖိုင် တစ်ခု",
  "exports.group.finance": "ငွေရေးကြေးရေး CSV",
  "exports.group.financeBlurb":
    "ဝင်ငွေ၊ အသုံးစရိတ်၊ ချေးငွေ၊ အလုပ်များနှင့် ပေးချေရမည့် ငွေများ",
  "exports.group.tasks": "လုပ်ငန်း CSV",
  "exports.group.tasksBlurb":
    "လုပ်ဆောင်ရမည့်အရာများ၊ ကျသင့်ရက်များနှင့် ထပ်ခါတလဲလဲ အစီအစဉ်များ",
  "exports.group.contactsBlurb": "vCard 4.0 နှင့် CSV လိပ်စာစာအုပ်",

  "exports.archive.title": "Purple Memo ဖတ်နိုင်သော ထုတ်ယူချက် - ဒေတာကွက် ဆက်စပ်မှု",
  "exports.archive.intro":
    "သိမ်းထားသော ဇယားတိုင်းကို အောက်တွင် ဆက်စပ်ပြထားသည် သို့မဟုတ် ရည်ရွယ်ချက်ရှိရှိ ဖယ်ထားသည်ဟု အမည်တပ်ထားသည်။",
  "exports.readme.title": "Purple Memo ဖတ်နိုင်သော ထုတ်ယူချက်",
  "exports.readme.generated": "ဖန်တီးချိန်: {date}",
  "exports.readme.contents": "ပါဝင်သည်များ:",
  "exports.readme.notes": "notes/ - YAML front matter ပါသော Markdown မှတ်စုများ",
  "exports.readme.journal": "journal/ - Markdown ဂျာနယ် မှတ်တမ်းများ",
  "exports.readme.finance":
    "finance/ - ဝင်ငွေ၊ အသုံးစရိတ်၊ ချေးငွေ၊ အလုပ်များ၊ ပေးချေရမည့် ငွေများ CSV",
  "exports.readme.tasks": "tasks.csv - လုပ်ငန်းများနှင့် ထပ်ခါတလဲလဲ အစီအစဉ် CSV",
  "exports.readme.contacts":
    "contacts.vcf + contacts.csv - vCard 4.0 နှင့် CSV လိပ်စာစာအုပ်",
  "exports.readme.fields": "EXPORT-FIELDS.md - ဒေတာကွက်အလိုက် ပါဝင်မှု ဆက်စပ်ချက်",
  "exports.readme.encoding":
    "စာသားသည် UTF-8 ဖြစ်သည်။ CSV ဖိုင်များသည် RFC 4180 quoting နှင့် CRLF အဆုံးသတ်များကို သုံးသည်။",
  "exports.readme.formula":
    "= ၊ + ၊ - ၊ @ ၊ tab သို့မဟုတ် carriage return ဖြင့် စသော CSV စာသား တန်ဖိုးရှေ့တွင် apostrophe ထည့်ထားသဖြင့် spreadsheet များက ၎င်းကို ဖော်မြူလာ မဟုတ်ဘဲ စာသားအဖြစ် သတ်မှတ်သည်။",
  "exports.readme.money":
    "ငွေကို နှစ်ကြိမ် ဖော်ပြသည်: amount_cents သည် သိမ်းထားသော ကိန်းပြည့်၊ amount သည် ဒသမ အစက်ဖြင့် ပိုင်းထားသော ဒသမ ပင်မ ယူနစ် ဖြစ်သည်။ ရက်စွဲများသည် ISO yyyy-mm-dd ဖြစ်သည်။",
  "exports.readme.excluded":
    "ဓာတ်ပုံ ဒေတာ၊ Vault စာဝှက်စာ၊ ဆက်တင်များနှင့် အမှိုက်ပုံးသည် ဤထုတ်ယူချက်တွင် မပါဝင်ပါ။ ပြည့်စုံပြီး ပြန်လည်ထည့်သွင်းနိုင်သော မိတ္တူ လိုပါက အရန်သိမ်း ဖိုင်စု ကို သုံးပါ။",

  "exports.mapping.collections":
    "စုစည်းမှု အမည်ကို စာသားအဖြစ် ရေးထည့်သည်။ မှတ်စု မရှိသော စုစည်းမှုများအတွက် ဖိုင် မထုတ်ပါ။",
  "exports.mapping.notes":
    "ဇယားရှိ အတန်းတိုင်း၊ မော်ကွန်းတင်ထားသော အတန်းများ အပါအဝင်။ တဂ်များကို အခင်းအဖြစ် သိမ်းသည်။ အမှိုက်ပုံးရှိ အတန်းများ မပါဝင်ပါ။",
  "exports.mapping.photoRefs":
    "ရည်ညွှန်း လမ်းကြောင်းများ သာ။ ဓာတ်ပုံ ဒေတာများသည် ဖတ်နိုင်သော ထုတ်ယူချက်တွင် မပါဝင်ပါ; ၎င်းတို့သည် အရန်သိမ်း ဖိုင်စုတွင်သာ ရှိသည်။",
  "exports.mapping.journal": "အတန်းတိုင်း; ပြက္ခဒိန် ရက်တစ်ရက်လျှင် ဖိုင် တစ်ခု။",
  "exports.mapping.amountDecimal":
    "amount သည် ဒသမ ပင်မ ယူနစ်; amount_cents သည် သိမ်းထားသော ကိန်းပြည့် ဖြစ်သည်။",
  "exports.mapping.loans":
    "state ကို ထုတ်ယူချိန်တွင် repaid_cents၊ amount_cents နှင့် due_date တို့မှ ဆင်းသက်သည်။",
  "exports.mapping.jobs":
    "shop သည် ဆိုင်အမည် ဖြစ်ပြီး အလုပ်တွင် မရှိပါက အလွတ် ဖြစ်သည်။ ကျန်ငွေသည် သုညအောက် မရောက်ပါ။",
  "exports.mapping.payables":
    "ပေးပြီးနှင့် မပေးရသေးသော အတန်းများ နှစ်မျိုးလုံး ထုတ်ယူသည်; paid သည် သိမ်းထားသော 0/1 အလံ အတိုင်း ကျန်သည်။",
  "exports.mapping.tasks":
    "ဖွင့်ထားသော နှင့် ပြီးစီးသော လုပ်ငန်းများ နှစ်မျိုးလုံး ထုတ်ယူသည်; ကော်လံများသည် Tasks CSV တင်သွင်းမှုနှင့် ကိုက်ညီသည်။",
  "exports.mapping.contacts":
    "vCard 4.0 ကတ်များ အပြင် Contacts CSV တင်သွင်းမှုနှင့် ကိုက်ညီသော semicolon ဖြင့် ဆက်ထားသည့် CSV; ချန်နယ်များသည် ပင်မ အစီအစဉ်အတိုင်း ကျန်သည်။",
  "exports.mapping.referenceTables":
    "ရည်ညွှန်း ဇယားများကို သီးခြား ဖိုင်အဖြစ် မထုတ်ပါ; အမည်ပြောင်းထားသော အတန်းတစ်ခုကို လက်ရှိ အမည်ဖြင့် ထုတ်ယူသည်။",
  "exports.mapping.trash":
    "ဖတ်နိုင်သော ထုတ်ယူမှုများမှ ရည်ရွယ်ချက်ရှိရှိ ဖယ်ထားသည်။ အမှိုက်ပုံးသည် အက်ပ်အတွင်း ပြန်လည်ရယူနိုင်ဆဲ ဖြစ်ပြီး အရန်သိမ်း ဖိုင်စုများတွင် ပါဝင်သည်။",
  "exports.mapping.vault":
    "ရည်ရွယ်ချက်ရှိရှိ ဖယ်ထားသည်။ Vault အကြောင်းအရာများသည် စာဝှက်စာ ဖြစ်ပြီး အရန်သိမ်း ဖိုင်စုများဖြင့် ဖုံးလွှမ်းထားသည်။",
  "exports.mapping.notIncluded":
    "ဖတ်နိုင်သော ထုတ်ယူသည့် အစုတွင် မပါဝင်ပါ; ၎င်းတို့ကို အရန်သိမ်း ဖိုင်စုများမှတစ်ဆင့် ရရှိနိုင်ဆဲ ဖြစ်သည်။",
  "exports.mapping.settings":
    "ဘယ်တော့မှ မထုတ်ပါ — အပြင်အဆင်၊ PIN၊ လုံခြုံရေး မေးခွန်းနှင့် အသိပေးချက် ရွေးချယ်မှုများသည် စက်တွင်း အက်ပ် အခြေအနေ ဖြစ်သည်။",
};
