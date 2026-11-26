export const enImport = {
  "import.chooseFile": "Choose CSV file",
  "import.chooseAnother": "Choose another file",
  "import.fileHint":
    "CSV files only. Nothing is written until you confirm the preview.",
  "import.downloadTemplate": "Download template CSV",
  "import.savingTemplate": "Saving…",
  "import.saveTemplateTitle": "Save CSV template",
  "import.csvFilter": "CSV file",
  "import.templateSaved": "Template CSV saved to {path}.",
  "import.previewCapped":
    "Showing the first {shown} of {total} rows in the preview — all {total} valid rows will be imported.",
  "import.yes": "Yes",
  "import.no": "No",
  "import.reading": "Reading…",
  "import.rowsToImportAria": "Rows to import",
  "import.errorsTitle": "Rows that will be skipped",
  "import.errorsAria": "Row errors",
  "import.rowError": "Row {row}: {reason}",
  "import.nothing":
    "No rows can be imported — fix the errors and choose the file again.",
  "import.import": "Import",
  "import.importing": "Importing…",
  "import.resultTitle": "Import complete",
  "import.done": "Done",
  "import.error.tooLarge":
    "CSV file is larger than the {limit} MiB limit — import rejected.",
  "import.error.tooManyRows":
    "CSV has more than {rows} rows — import rejected.",
  "import.error.missingColumn":
    "CSV is missing the required column {columns} — import rejected.",
  "import.error.missingColumns":
    "CSV is missing the required columns {columns} — import rejected.",
  "import.reason.titleRequired": "Title is required.",
  "import.reason.dueDate":
    "Due date must be a valid YYYY-MM-DD date (or empty).",
  "import.reason.done": "Done must be true, false, yes, no, 1 or 0 (or empty).",
  "import.reason.repeat":
    "Repeat must be none, daily, weekly or monthly (or empty).",
  "import.reason.nameRequired": "Name is required.",
  "import.reason.birthday":
    "Birthday must be a valid YYYY-MM-DD or MM-DD date (or empty).",
} as const;

export const myImport: Record<keyof typeof enImport, string> = {
  "import.chooseFile": "CSV ဖိုင် ရွေးချယ်မည်",
  "import.chooseAnother": "အခြားဖိုင် ရွေးချယ်မည်",
  "import.fileHint": "CSV ဖိုင်များသာ။ အစမ်းကြည့်ရှုမှုကို အတည်ပြုသည်အထိ မည်သည့်အရာမျှ မရေးပါ။",
  "import.downloadTemplate": "စံပြစာရွက် CSV ဒေါင်းလုဒ်လုပ်မည်",
  "import.savingTemplate": "သိမ်းဆည်းနေသည်…",
  "import.saveTemplateTitle": "CSV စံပြစာရွက် သိမ်းဆည်းမည်",
  "import.csvFilter": "CSV ဖိုင်",
  "import.templateSaved": "စံပြစာရွက် CSV ကို {path} တွင် သိမ်းဆည်းပြီးပါပြီ။",
  "import.previewCapped":
    "အစမ်းကြည့်ရှုမှုတွင် အတန်း {total} ခုအနက် ပထမ {shown} ခုကိုသာ ပြနေသည် — မှန်ကန်သော အတန်း {total} ခုလုံး တင်သွင်းပါမည်။",
  "import.yes": "ပြီး",
  "import.no": "မပြီးသေး",
  "import.reading": "ဖတ်နေသည်…",
  "import.rowsToImportAria": "တင်သွင်းမည့် အတန်းများ",
  "import.errorsTitle": "ကျော်သွားမည့် အတန်းများ",
  "import.errorsAria": "အတန်း အမှားများ",
  "import.rowError": "အတန်း {row}: {reason}",
  "import.nothing": "တင်သွင်း၍ ရသော အတန်း မရှိပါ — အမှားများကို ပြင်ပြီး ဖိုင်ကို ပြန်ရွေးပါ။",
  "import.import": "တင်သွင်းမည်",
  "import.importing": "တင်သွင်းနေသည်…",
  "import.resultTitle": "တင်သွင်းမှု ပြီးပါပြီ",
  "import.done": "ပြီးပါပြီ",
  "import.error.tooLarge":
    "CSV ဖိုင်သည် {limit} MiB ကန့်သတ်ချက်ထက် ကြီးနေသည် — တင်သွင်းမှု ငြင်းပယ်ခဲ့သည်။",
  "import.error.tooManyRows":
    "CSV တွင် အတန်း {rows} ခုထက် ပိုနေသည် — တင်သွင်းမှု ငြင်းပယ်ခဲ့သည်။",
  "import.error.missingColumn":
    "CSV တွင် လိုအပ်သော ကော်လံ {columns} မပါဝင်ပါ — တင်သွင်းမှု ငြင်းပယ်ခဲ့သည်။",
  "import.error.missingColumns":
    "CSV တွင် လိုအပ်သော ကော်လံများ {columns} မပါဝင်ပါ — တင်သွင်းမှု ငြင်းပယ်ခဲ့သည်။",
  "import.reason.titleRequired": "ခေါင်းစဉ် လိုအပ်ပါသည်။",
  "import.reason.dueDate":
    "ရက်ချိန်းသည် မှန်ကန်သော YYYY-MM-DD ရက်စွဲ ဖြစ်ရမည် (သို့မဟုတ် အလွတ်ထားနိုင်သည်)။",
  "import.reason.done":
    "done သည် true၊ false၊ yes၊ no၊ 1 သို့မဟုတ် 0 ဖြစ်ရမည် (သို့မဟုတ် အလွတ်ထားနိုင်သည်)။",
  "import.reason.repeat":
    "repeat သည် none၊ daily၊ weekly သို့မဟုတ် monthly ဖြစ်ရမည် (သို့မဟုတ် အလွတ်ထားနိုင်သည်)။",
  "import.reason.nameRequired": "အမည် လိုအပ်ပါသည်။",
  "import.reason.birthday":
    "မွေးနေ့သည် မှန်ကန်သော YYYY-MM-DD သို့မဟုတ် MM-DD ရက်စွဲ ဖြစ်ရမည် (သို့မဟုတ် အလွတ်ထားနိုင်သည်)။",
};
