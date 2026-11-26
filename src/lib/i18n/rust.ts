export const enRust = {
  "rust.error.generic": "Purple Memo could not complete that action: {detail}",
  "rust.error.dbClosed":
    "The database is closed — restart Purple Memo to use it again.",
  "rust.error.rawBody":
    "The photo data arrived in the wrong form — nothing was saved.",
  "rust.error.headerMissing":
    "The request was missing its {name} details — nothing was saved.",
  "rust.error.headerNotAscii":
    "The request's {name} details could not be read — nothing was saved.",
  "rust.error.leaseNotNumber":
    "The import session could not be identified — nothing was saved.",
  "rust.error.batchDuringTxn":
    "A database batch cannot run while a manual transaction is open.",
  "rust.error.txnAlreadyOpen": "A manual transaction is already open.",
  "rust.error.noTxnToCommit": "There is no open transaction to commit.",
  "rust.error.noTxnToRollback": "There is no open transaction to roll back.",
  "rust.error.photoTooLarge":
    "This photo is {size} MiB. Purple Memo accepts up to {limit} MiB per photo, because a larger one would make every backup containing it unrestorable. Compress or resize the image and try again — nothing was saved.",
  "rust.error.photoExt": "That image type is not one Purple Memo stores: {ext}",
  "rust.error.photoMonth":
    "That photo date is not one Purple Memo writes: {value}",
  "rust.error.photoPath": "That is not a photo path Purple Memo wrote: {path}",
  "rust.error.photoRead": "The photo could not be read: {detail}",
  "rust.error.photoWrite": "The photo could not be saved: {detail}",
  "rust.error.photoDelete": "The photo could not be deleted: {detail}",
  "rust.error.desktopOnly":
    "This part of Purple Memo exists only in the desktop app.",
  "rust.error.keyWrite":
    "The encryption key could not be written to that file: {detail}",
  "rust.error.flushFailed":
    "The database could not be flushed before the safety copy: {detail}",
  "rust.error.flushIncomplete":
    "The database flush before the safety copy did not finish ({checkpointed} of {logPages} pages), so the copy would have been stale and the import was cancelled before anything was replaced. Close any other program using this app's data folder and try again.",
  "rust.error.syncState":
    "This device's sync state could not be read: {detail}",
  "rust.error.schemaVersion":
    "The database version could not be read: {detail}",
  "rust.error.pairingHistory":
    "This device's pairing history could not be read: {detail}",
  "rust.error.rePairFlag": "The re-pair flag could not be read: {detail}",
  "rust.error.rePairRecord": "The re-pair flag could not be recorded: {detail}",
  "rust.error.pairingIdentity":
    "This device's pairing key could not be used: {detail}",
  "rust.error.offerIncomplete":
    "A pairing code needs both its six digits and its expiry.",
  "rust.error.notPinned":
    "This phone has not pinned that desktop, or the pairing was revoked, so there is nothing to pull.",
  "rust.error.uploadOutcome":
    "An upload result is either its counts or its failure, never both or neither.",
  "rust.error.syncOutcome":
    "A sync result is either its applied position or its failure, never both or neither.",
  "rust.error.rePairConfirm":
    "Re-pairing replaces this device's pairing key, so it needs an explicit confirmation.",
  "rust.error.stateUnavailable":
    "This part of Purple Memo is not ready yet — restart the app.",
  "rust.error.resetInProgress":
    "A factory reset owns this app's data now — restart Purple Memo before writing again.",
  "rust.error.importInProgress":
    "An import is replacing this app's data — this change was refused; try again when it finishes.",
  "rust.error.emptyArchive": "The file is empty, so nothing was written.",
  "rust.error.pathIsDirectory": "{path} is a folder — pick a file name for it.",
  "rust.error.pathHasNoDirectory":
    "{path} has no folder to write into — pick a different name.",
  "rust.error.invalidDestination": "{path} is not a usable file name.",
  "rust.error.folderCreate":
    "The folder for {path} could not be created: {detail}",
  "rust.error.writeFailed": "{path} could not be written: {detail}",
  "rust.error.replaceFailed":
    "{path} could not be replaced ({detail}); the file is still at {temp}",
  "rust.error.linkEmpty": "That link is empty or too long to open.",
  "rust.error.linkPadded":
    "That link has spaces or control characters at its edges, so it was not opened.",
  "rust.error.linkScheme":
    "Only http and https links open outside Purple Memo.",
  "rust.error.browserStart": "The system browser could not be started.",
  "rust.error.locale": "That interface language is not one Purple Memo ships.",
} as const;

export const myRust: Record<keyof typeof enRust, string> = {
  "rust.error.generic": "Purple Memo သည် ထိုလုပ်ဆောင်ချက်ကို အပြီးသတ်၍ မရပါ — {detail}",
  "rust.error.dbClosed": "ဒေတာဘေ့စ် ပိတ်ထားသည် — ပြန်အသုံးပြုရန် Purple Memo ကို ပြန်ဖွင့်ပါ။",
  "rust.error.rawBody":
    "ဓာတ်ပုံဒေတာသည် မမှန်ကန်သော ပုံစံဖြင့် ရောက်လာသည် — မည်သည့်အရာမျှ မသိမ်းရသေးပါ။",
  "rust.error.headerMissing":
    "တောင်းဆိုမှုတွင် {name} အချက်အလက် မပါဝင်ပါ — မည်သည့်အရာမျှ မသိမ်းရသေးပါ။",
  "rust.error.headerNotAscii":
    "တောင်းဆိုမှုရှိ {name} အချက်အလက်ကို ဖတ်၍ မရပါ — မည်သည့်အရာမျှ မသိမ်းရသေးပါ။",
  "rust.error.leaseNotNumber":
    "ဒေတာ အစားထိုးမှု စက်ရှင်ကို ဖော်ထုတ်၍ မရပါ — မည်သည့်အရာမျှ မသိမ်းရသေးပါ။",
  "rust.error.batchDuringTxn":
    "ကိုယ်တိုင် ဖွင့်ထားသော transaction ရှိနေစဉ် ဒေတာဘေ့စ် အစုလိုက် ရေးသားမှုကို မလုပ်နိုင်ပါ။",
  "rust.error.txnAlreadyOpen": "ကိုယ်တိုင် ဖွင့်ထားသော transaction တစ်ခု ရှိပြီးသား ဖြစ်သည်။",
  "rust.error.noTxnToCommit": "အတည်ပြုရန် ဖွင့်ထားသော transaction မရှိပါ။",
  "rust.error.noTxnToRollback": "ပြန်လှည့်ရန် ဖွင့်ထားသော transaction မရှိပါ။",
  "rust.error.photoTooLarge":
    "ဤဓာတ်ပုံသည် {size} MiB ရှိသည်။ Purple Memo သည် တစ်ပုံလျှင် {limit} MiB အထိသာ လက်ခံသည်။ ပိုကြီးသော ပုံပါသော အရန်သိမ်းဆည်းမှုကို ပြန်မရယူနိုင်မည် ဖြစ်သောကြောင့် ဖြစ်သည်။ ပုံကို ချုံ့ပါ သို့မဟုတ် အရွယ်အစား လျှော့ပြီး ထပ်ကြိုးစားပါ — မည်သည့်အရာမျှ မသိမ်းရသေးပါ။",
  "rust.error.photoExt": "ထိုပုံအမျိုးအစားကို Purple Memo မသိမ်းဆည်းပါ — {ext}",
  "rust.error.photoMonth": "ထိုဓာတ်ပုံ ရက်စွဲကို Purple Memo မရေးပါ — {value}",
  "rust.error.photoPath":
    "ထိုသည် Purple Memo ရေးခဲ့သော ဓာတ်ပုံလမ်းကြောင်း မဟုတ်ပါ — {path}",
  "rust.error.photoRead": "ဓာတ်ပုံကို ဖတ်၍ မရပါ — {detail}",
  "rust.error.photoWrite": "ဓာတ်ပုံကို သိမ်း၍ မရပါ — {detail}",
  "rust.error.photoDelete": "ဓာတ်ပုံကို ဖျက်၍ မရပါ — {detail}",
  "rust.error.desktopOnly": "Purple Memo ၏ ဤအပိုင်းသည် ကွန်ပျူတာ အက်ပ်တွင်သာ ရှိသည်။",
  "rust.error.keyWrite": "ကုဒ်ဝှက်သော့ကို ထိုဖိုင်တွင် ရေး၍ မရပါ — {detail}",
  "rust.error.flushFailed": "အရန်မိတ္တူ မတင်မီ ဒေတာဘေ့စ်ကို flush လုပ်၍ မရပါ — {detail}",
  "rust.error.flushIncomplete":
    "အရန်မိတ္တူ မတင်မီ ဒေတာဘေ့စ် flush မပြီးစီးပါ ({checkpointed}/{logPages} စာမျက်နှာ)။ မိတ္တူသည် ခေတ်မမီ ဖြစ်မည်ဖြစ်သောကြောင့် မည်သည့်အရာမျှ မအစားထိုးမီ တင်သွင်းမှုကို ပယ်ဖျက်လိုက်သည်။ ဤအက်ပ်၏ ဒေတာဖိုလ်ဒါကို အသုံးပြုနေသော အခြားပရိုဂရမ်များကို ပိတ်ပြီး ထပ်ကြိုးစားပါ။",
  "rust.error.syncState": "ဤစက်၏ sync အခြေအနေကို ဖတ်၍ မရပါ — {detail}",
  "rust.error.schemaVersion": "ဒေတာဘေ့စ် ဗားရှင်းကို ဖတ်၍ မရပါ — {detail}",
  "rust.error.pairingHistory": "ဤစက်၏ တွဲချိတ်မှု မှတ်တမ်းကို ဖတ်၍ မရပါ — {detail}",
  "rust.error.rePairFlag": "ပြန်တွဲရန် အမှတ်အသားကို ဖတ်၍ မရပါ — {detail}",
  "rust.error.rePairRecord": "ပြန်တွဲရန် အမှတ်အသားကို မှတ်တမ်းတင်၍ မရပါ — {detail}",
  "rust.error.pairingIdentity": "ဤစက်၏ တွဲချိတ်သော့ကို အသုံးပြု၍ မရပါ — {detail}",
  "rust.error.offerIncomplete":
    "တွဲချိတ်ကုဒ်တွင် ဂဏန်းခြောက်လုံးနှင့် ၎င်း၏ သက်တမ်းကုန်ချိန် နှစ်ခုစလုံး လိုအပ်သည်။",
  "rust.error.notPinned":
    "ဤဖုန်းသည် ထိုကွန်ပျူတာကို တွဲချိတ်မထားပါ၊ သို့မဟုတ် တွဲချိတ်မှုကို ပယ်ဖျက်ထားသဖြင့် ရယူရန် မည်သည့်အရာမျှ မရှိပါ။",
  "rust.error.uploadOutcome":
    "တင်သွင်းမှု ရလဒ်သည် ၎င်း၏ အရေအတွက် သို့မဟုတ် မအောင်မြင်မှု တစ်ခုသာ ဖြစ်ရမည်။",
  "rust.error.syncOutcome":
    "sync ရလဒ်သည် ၎င်း၏ အသုံးပြုပြီး အနေအထား သို့မဟုတ် မအောင်မြင်မှု တစ်ခုသာ ဖြစ်ရမည်။",
  "rust.error.rePairConfirm":
    "ပြန်တွဲခြင်းသည် ဤစက်၏ တွဲချိတ်သော့ကို အစားထိုးသဖြင့် ရှင်းလင်းသော အတည်ပြုချက် လိုအပ်သည်။",
  "rust.error.stateUnavailable":
    "Purple Memo ၏ ဤအပိုင်း အဆင်သင့် မဖြစ်သေးပါ — အက်ပ်ကို ပြန်ဖွင့်ပါ။",
  "rust.error.resetInProgress":
    "factory reset သည် ဤအက်ပ်၏ ဒေတာကို ပိုင်ဆိုင်နေသည် — ထပ်မရေးမီ Purple Memo ကို ပြန်ဖွင့်ပါ။",
  "rust.error.importInProgress":
    "တင်သွင်းမှုတစ်ခုက ဤအက်ပ်၏ ဒေတာကို အစားထိုးနေသည် — ဤပြောင်းလဲမှုကို ပယ်ခဲ့သည်; ပြီးဆုံးလျှင် ထပ်ကြိုးစားပါ။",
  "rust.error.emptyArchive": "ဖိုင်သည် ဗလာဖြစ်သဖြင့် မည်သည့်အရာမျှ မရေးရသေးပါ။",
  "rust.error.pathIsDirectory": "{path} သည် ဖိုလ်ဒါ ဖြစ်သည် — ၎င်းအတွက် ဖိုင်အမည် ရွေးပါ။",
  "rust.error.pathHasNoDirectory":
    "{path} တွင် ရေးရန် ဖိုလ်ဒါ မရှိပါ — အခြားအမည် ရွေးပါ။",
  "rust.error.invalidDestination": "{path} သည် အသုံးပြုနိုင်သော ဖိုင်အမည် မဟုတ်ပါ။",
  "rust.error.folderCreate": "{path} အတွက် ဖိုလ်ဒါကို ဖန်တီး၍ မရပါ — {detail}",
  "rust.error.writeFailed": "{path} ကို ရေး၍ မရပါ — {detail}",
  "rust.error.replaceFailed":
    "{path} ကို အစားထိုး၍ မရပါ ({detail}); ဖိုင်သည် {temp} တွင် ရှိနေဆဲဖြစ်သည်။",
  "rust.error.linkEmpty": "ထိုလင့်ခ်သည် ဗလာ သို့မဟုတ် ရှည်လွန်းသဖြင့် မဖွင့်နိုင်ပါ။",
  "rust.error.linkPadded":
    "ထိုလင့်ခ်တွင် အစွန်းများ၌ ကွက်လပ်များ သို့မဟုတ် ထိန်းချုပ်စာလုံးများ ပါသဖြင့် မဖွင့်ပါ။",
  "rust.error.linkScheme": "http နှင့် https လင့်ခ်များကိုသာ Purple Memo ပြင်ပတွင် ဖွင့်သည်။",
  "rust.error.browserStart": "စနစ် ဘရောက်ဇာကို ဖွင့်၍ မရပါ။",
  "rust.error.locale": "ထို အင်တာဖေ့စ် ဘာသာစကားကို Purple Memo မထောက်ပံ့ပါ။",
};
