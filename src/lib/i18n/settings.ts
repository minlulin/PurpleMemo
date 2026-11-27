export const enSettings = {
  "settings.pinUpdated": "PIN updated.",
  "settings.title": "Settings",
  "settings.filterPlaceholder": "Filter settings…",
  "settings.filterLabel": "Filter settings",
  "settings.sectionsLabel": "Settings sections",
  "settings.noMatches": "No settings match “{query}”.",
  "settings.section.appearance": "Appearance",
  "settings.section.lock": "App lock & PIN",
  "settings.section.notifications": "Notifications",
  "settings.section.vault": "Vault",
  "settings.section.keyExport": "Key export",
  "settings.section.backup": "Backup",
  "settings.section.pairing": "Pairing",
  "settings.section.pairedPhone": "Paired phone",
  "settings.section.updates": "Updates",
  "settings.section.about": "About",
  "settings.theme": "Theme",
  "settings.themeDark": "Dark",
  "settings.themeLight": "Light",
  "settings.themeOled": "OLED Black",
  "settings.themeMidnight": "Midnight",
  "settings.themeForest": "Forest",
  "settings.themeSepia": "Sepia",
  "settings.themeClean": "Clean White",
  "settings.autoLock": "Lock after idle",
  "settings.autoLockNever": "Never",
  "settings.currentPin": "Current PIN",
  "settings.newPin": "New PIN (at least {count} characters)",
  "settings.confirmNewPin": "Confirm new PIN",
  "settings.newQuestion": "New security question (blank keeps the old one)",
  "settings.newAnswer": "New answer",
  "settings.changingPin": "Updating…",
  "settings.changePin": "Change PIN",
  "settings.pinAbsent": "No PIN is set yet — complete the first-run setup.",
  "settings.pinUnreadable.corrupt":
    "The stored PIN is corrupt (not valid JSON) — nothing was changed.",
  "settings.pinUnreadable.malformed":
    "The stored PIN is in an unexpected shape — nothing was changed.",
  "settings.pinUnreadable.weakIterations":
    "The stored PIN was hashed with too few iterations to be trusted — nothing was changed.",
  "settings.pinWrong": "Current PIN is wrong.",
  "settings.pinTooShort": "New PIN must be at least {count} characters.",
  "settings.pinMismatch": "New PINs do not match.",
  "settings.pinQuestionPair":
    "Provide BOTH a question and an answer to change the fallback — nothing was changed.",
  "settings.biometric.label": "Fingerprint or face unlock",
  "settings.biometric.description":
    "Unlock with the phone's fingerprint or face instead of typing your PIN. The PIN keeps working exactly as before — biometric is an extra way in, never a replacement.",
  "settings.biometric.on": "Fingerprint or face unlock is on.",
  "settings.biometric.off": "Fingerprint or face unlock is off.",
  "settings.biometric.turnOn": "Turn on",
  "settings.biometric.turnOff": "Turn off",
  "settings.biometric.pinPrompt": "Enter your current PIN to turn this on.",
  "settings.biometric.wrongPin": "Wrong PIN — unlock is still off.",
  "settings.biometric.reasonNoneEnrolled":
    "Nothing is enrolled on this phone. Add a fingerprint or face in the phone's own settings first.",
  "settings.biometric.reasonNoHardware":
    "This phone has no fingerprint or face sensor.",
  "settings.biometric.reasonUnavailable":
    "Not available on this phone right now.",
  "settings.biometric.setPinFirst":
    "Set an app PIN first — fingerprint or face unlock sits beside the PIN, not in place of it.",
  "settings.previewsOn": "previews on",
  "settings.previewsOff": "previews off",
  "settings.previewHint":
    "Include reminder text in notifications. Off (the default) means every notification says only that a reminder is due — never its title or note. When several come due at once, they share one summary alert either way.",
  "settings.openVault": "Open Vault",
  "settings.keyExportTitle": "Encryption key export",
  "settings.sensitive": "Sensitive",
  "settings.keyExportWarn":
    "If this key is lost, the data it protects cannot be recovered.",
  "settings.keyExportAck":
    "I understand — the key goes into its own file, never into a backup.",
  "settings.keyExportAckRequired":
    "Tick the acknowledgement first — the key must go into its own file, never into a backup.",
  "settings.keyWriting": "Writing…",
  "settings.keySave": "Save encryption key…",
  "settings.keySaveTitle": "Save Purple Memo encryption key",
  "settings.keyTextFile": "Text file",
  "settings.keySaved":
    "Encryption key saved to {path}. Store it separately from backups.",
  "settings.pairTitle": "Pair a phone",
  "settings.signedReleases": "Signed releases",
  "settings.checkUpdates": "Check for updates",
  "settings.downloading": "Downloading…",
  "settings.downloadingPercent": "Downloading… {percent}%",
  "settings.installVersion": "Install {version}",
  "settings.updateAvailable":
    "Purple Memo {version} is available — you have {current}.",
  "settings.published": "Published {date}",
  "settings.noNewerRelease": "No newer release is published yet.",
  "settings.updateInstalled":
    "Update installed — restart Purple Memo to run the new version.",
  "settings.checkFailed": "Could not check for updates: {error}",
  "settings.updateFailed": "Update failed: {error}",
  "settings.openSource": "Open Source",
  "settings.version": "Version {version}",

  "settings.language": "Language",
  "settings.closeToTray": "Minimize to tray on close",
  "settings.closeToTrayHint":
    "Closing the window keeps Purple Memo running in the system tray, so reminders keep firing while it looks closed. Turn this off to make closing quit the app instead.",

  "settings.pairedPhoneTitle": "Paired phone",
  "settings.pairedPhoneNoneBadge": "No phone paired",
  "settings.pairedPhoneTrustedBadge": "Remembered",
  "settings.pairedPhoneReachable": "Let my paired phone stay connected",
  "settings.pairedPhoneReachableHint":
    "While this app is running, your paired phone can sync without a new code — like a phone and notebook that have already met. Turn this off and the notebook is reachable only while pairing is on screen.",
  "settings.pairedPhoneNoneBody":
    "No phone is paired yet. Pair one from the Sync panel above — after that it stays remembered until you forget it here.",
  "settings.pairedPhoneName": "Trusted phone",
  "settings.pairedPhoneNameFallback": "Phone",
  "settings.pairedPhoneDeviceId": "Device id",
  "settings.pairedPhonePending":
    "{count} change(s) are still waiting to be sent to this phone.",
  "settings.pairedPhoneForgetWhat":
    "Forget this phone — it will never sync with this notebook again until you pair it with a fresh code",
  "settings.pairedPhoneForgetWhatPending":
    "Forget this phone and drop the {count} undelivered change(s) addressed to it",
  "settings.pairedPhoneForget": "Forget this phone",
  "settings.pairedPhoneForgotten":
    "Phone forgotten — it will not sync again until you pair it with a fresh code. ({count} undelivered change(s) dropped.)",

  "settings.backupTitle": "Backup & restore",
  "settings.backupBadge": ".zip or password-protected",
  "settings.lastBackupNever":
    "No backup has been made on this device. Everything here lives only on this machine — export one now.",
  "settings.lastBackupAge":
    "Last backup: {age} ({date}) — {rows} rows, {photos} photos.",
  "settings.lastBackupStale":
    "Last backup: {age} ({date}) — more than {days} days old. A disk failure would now lose everything written since then.",
  "settings.protectBackup":
    "Protect the backup with a password (a .{ext} file that needs this password to open)",
  "settings.backupPassword": "Backup password",
  "settings.confirmBackupPassword": "Confirm backup password",
  "settings.exporting": "Exporting…",
  "settings.exportBackup": "Export backup",
  "settings.importing": "Importing…",
  "settings.importBackup": "Import backup",
  "settings.opening": "Opening…",
  "settings.openBackup": "Open backup",
  "settings.summary":
    "Backup from {date}: {rows} rows across {tables} tables, {photos} photos. Continuing replaces ALL current data.",
  "settings.replaceAll": "Replace all data",
  "settings.passwordMismatch":
    "The two passwords do not match — nothing was exported.",
  "settings.passwordRequired":
    "Tick password protection and choose a password before exporting, or untick it to export without one — nothing was exported.",
  "settings.saveBackupTitle": "Save Purple Memo backup",
  "settings.encryptedBackupFilter": "Password-protected Purple Memo backup",
  "settings.backupFilter": "Purple Memo backup",
  "settings.backupSaved":
    "Backup saved to {path} — {rows} rows, {photos} photos",
  "settings.backupSavedEncrypted":
    "Backup saved to {path} — {rows} rows, {photos} photos, password-protected",
  "settings.tooLarge":
    "Backup archive is larger than the {limit} byte limit — import rejected.",
  "settings.imported":
    "Imported {rows} rows and {photos} photos — the previous data is in {path}. Reloading…",
} as const;

export const mySettings: Record<keyof typeof enSettings, string> = {
  "settings.pinUpdated": "PIN ကို အပ်ဒိတ်လုပ်ပြီးပါပြီ။",
  "settings.title": "ဆက်တင်",
  "settings.filterPlaceholder": "ဆက်တင်များကို စစ်ထုတ်ရန်…",
  "settings.filterLabel": "ဆက်တင်များကို စစ်ထုတ်ရန်",
  "settings.sectionsLabel": "ဆက်တင်အပိုင်းများ",
  "settings.noMatches": "“{query}” နှင့် ကိုက်ညီသော ဆက်တင် မရှိပါ။",
  "settings.section.appearance": "အပြင်အဆင်",
  "settings.section.lock": "အက်ပ် လော့ခ်နှင့် PIN",
  "settings.section.notifications": "အသိပေးချက်များ",
  "settings.section.vault": "လျှို့ဝှက်သေတ္တာ",
  "settings.section.keyExport": "သော့ ထုတ်ယူမှု",
  "settings.section.backup": "အရန်သိမ်းဆည်းမှု",
  "settings.section.pairing": "တွဲချိတ်ခြင်း",
  "settings.section.pairedPhone": "တွဲချိတ်ထားသော ဖုန်း",
  "settings.section.updates": "အပ်ဒိတ်များ",
  "settings.section.about": "အကြောင်း",
  "settings.theme": "အရောင် အပြင်အဆင်",
  "settings.themeDark": "အမည်းရောင်",
  "settings.themeLight": "အဖြူရောင်",
  "settings.themeOled": "OLED အမည်း",
  "settings.themeMidnight": "ညသန်းခေါင်",
  "settings.themeForest": "သစ်တော",
  "settings.themeSepia": "စာရွက်ဝါ",
  "settings.themeClean": "အဖြူသန့်",
  "settings.autoLock": "အလုပ်မလုပ်ဘဲ နေလျှင် လော့ခ်ချမည့်အချိန်",
  "settings.autoLockNever": "ဘယ်တော့မှ မလော့ခ်ချပါ",
  "settings.currentPin": "လက်ရှိ PIN",
  "settings.newPin": "PIN အသစ် (အနည်းဆုံး အက္ခရာ {count} လုံး)",
  "settings.confirmNewPin": "PIN အသစ် အတည်ပြုပါ",
  "settings.newQuestion": "လုံခြုံရေး မေးခွန်း အသစ် (ဗလာထားပါက ယခင်အတိုင်း ရှိမည်)",
  "settings.newAnswer": "အဖြေ အသစ်",
  "settings.changingPin": "အပ်ဒိတ်လုပ်နေသည်…",
  "settings.changePin": "PIN ပြောင်းမည်",
  "settings.pinAbsent": "PIN မသတ်မှတ်ရသေးပါ — ပထမဆုံး သတ်မှတ်ခြင်းကို အပြီးသတ်ပါ။",
  "settings.pinUnreadable.corrupt":
    "သိမ်းထားသော PIN သည် ပျက်စီးနေသည် (JSON မမှန်ကန်ပါ) — မည်သည့်အရာမျှ မပြောင်းလဲရသေးပါ။",
  "settings.pinUnreadable.malformed":
    "သိမ်းထားသော PIN သည် မမျှော်လင့်သော ပုံစံဖြင့် ရှိနေသည် — မည်သည့်အရာမျှ မပြောင်းလဲရသေးပါ။",
  "settings.pinUnreadable.weakIterations":
    "သိမ်းထားသော PIN ကို ယုံကြည်နိုင်ရန် အလွန်နည်းသော iteration ဖြင့် hash လုပ်ထားသည် — မည်သည့်အရာမျှ မပြောင်းလဲရသေးပါ။",
  "settings.pinWrong": "လက်ရှိ PIN မှားနေသည်။",
  "settings.pinTooShort": "PIN အသစ်သည် အနည်းဆုံး အက္ခရာ {count} လုံး ရှိရမည်။",
  "settings.pinMismatch": "PIN အသစ်နှစ်ခု မကိုက်ညီပါ။",
  "settings.pinQuestionPair":
    "အရန်မေးခွန်း ပြောင်းလဲရန် မေးခွန်းနှင့် အဖြေ နှစ်ခုစလုံး ဖြည့်ပါ — မည်သည့်အရာမျှ မပြောင်းလဲရသေးပါ။",
  "settings.biometric.label": "လက်ဗွေ သို့မဟုတ် မျက်နှာ ဖြင့် ဖွင့်ခြင်း",
  "settings.biometric.description":
    "PIN ရိုက်ထည့်မည့်အစား ဖုန်း၏ လက်ဗွေ သို့မဟုတ် မျက်နှာ ဖြင့် အက်ပ်ကို ဖွင့်နိုင်သည်။ PIN သည် ယခင်အတိုင်း ဆက်လက် အလုပ်လုပ်သည် — biometric သည် အစားထိုး မဟုတ်ဘဲ ထပ်ဆောင်း ဖွင့်နည်း တစ်ခုသာ ဖြစ်သည်။",
  "settings.biometric.on": "လက်ဗွေ/မျက်နှာ ဖြင့် ဖွင့်ခြင်း ဖွင့်ထားသည်။",
  "settings.biometric.off": "လက်ဗွေ/မျက်နှာ ဖြင့် ဖွင့်ခြင်း ပိတ်ထားသည်။",
  "settings.biometric.turnOn": "ဖွင့်မည်",
  "settings.biometric.turnOff": "ပိတ်မည်",
  "settings.biometric.pinPrompt": "ဖွင့်ရန် လက်ရှိ PIN ကို ရိုက်ထည့်ပါ။",
  "settings.biometric.wrongPin": "PIN မှားနေသည် — ဖွင့်မထားရသေးပါ။",
  "settings.biometric.reasonNoneEnrolled":
    "ဤဖုန်းတွင် မှတ်ပုံတင်ထားခြင်း မရှိပါ။ ဖုန်း၏ ကိုယ်ပိုင် ဆက်တင်တွင် လက်ဗွေ သို့မဟုတ် မျက်နှာ အရင်ထည့်ပါ။",
  "settings.biometric.reasonNoHardware":
    "ဤဖုန်းတွင် လက်ဗွေ သို့မဟုတ် မျက်နှာ အာရုံခံကိရိယာ မရှိပါ။",
  "settings.biometric.reasonUnavailable": "ဤဖုန်းတွင် ယခု အချိန်တွင် မရနိုင်ပါ။",
  "settings.biometric.setPinFirst":
    "ဦးစွာ အက်ပ် PIN သတ်မှတ်ပါ — လက်ဗွေ/မျက်နှာ ဖြင့် ဖွင့်ခြင်းသည် PIN ၏ အစားထိုး မဟုတ်ဘဲ ၎င်းဘေးတွင် ရှိသည်။",
  "settings.previewsOn": "အစမ်းပြချက် ဖွင့်ထားသည်",
  "settings.previewsOff": "အစမ်းပြချက် ပိတ်ထားသည်",
  "settings.previewHint":
    "အသိပေးချက်များတွင် သတိပေးချက်၏ စာသားကို ထည့်ပါ။ ပိတ်ထားပါက (မူလအတိုင်း) သတိပေးချက် ရောက်လာကြောင်းကိုသာ ဖော်ပြမည်ဖြစ်ပြီး ခေါင်းစဉ် သို့မဟုတ် မှတ်စုကို ဘယ်တော့မှ မပြပါ။ တစ်ချိန်တည်းတွင် အများအပြား ရောက်လာပါက မည်သို့ပင်ဖြစ်စေ အကျဉ်းချုပ် အသိပေးချက် တစ်ခုတည်းကို မျှဝေမည်။",
  "settings.openVault": "လျှို့ဝှက်သေတ္တာကို ဖွင့်မည်",
  "settings.keyExportTitle": "ကုဒ်ဝှက်သော့ ထုတ်ယူမှု",
  "settings.sensitive": "ဂရုပြုရန်",
  "settings.keyExportWarn":
    "ဤသော့ ပျောက်ဆုံးပါက ၎င်း ကာကွယ်ထားသော ဒေတာကို ပြန်လည်ရယူ၍ မရနိုင်ပါ။",
  "settings.keyExportAck":
    "နားလည်ပါသည် — သော့ကို သီးခြားဖိုင်တွင် ထည့်မည်ဖြစ်ပြီး အရန်သိမ်းဆည်းမှုထဲ ဘယ်တော့မှ မထည့်ပါ။",
  "settings.keyExportAckRequired":
    "အသိအမှတ်ပြုချက်ကို အရင်စစ်ပါ — သော့ကို သီးခြားဖိုင်တွင် ထည့်ရမည်ဖြစ်ပြီး အရန်သိမ်းဆည်းမှုထဲ ဘယ်တော့မှ မထည့်ရပါ။",
  "settings.keyWriting": "ရေးနေသည်…",
  "settings.keySave": "ကုဒ်ဝှက်သော့ သိမ်းမည်…",
  "settings.keySaveTitle": "Purple Memo ကုဒ်ဝှက်သော့ သိမ်းမည်",
  "settings.keyTextFile": "စာသားဖိုင်",
  "settings.keySaved":
    "ကုဒ်ဝှက်သော့ကို {path} တွင် သိမ်းပြီးပါပြီ။ အရန်သိမ်းဆည်းမှုများနှင့် သီးခြား သိမ်းထားပါ။",
  "settings.pairTitle": "ဖုန်း တွဲချိတ်မည်",
  "settings.signedReleases": "လက်မှတ်ထိုးထားသော ထုတ်ဝေမှုများ",
  "settings.checkUpdates": "အပ်ဒိတ်များ စစ်ဆေးမည်",
  "settings.downloading": "ဒေါင်းလုဒ်လုပ်နေသည်…",
  "settings.downloadingPercent": "ဒေါင်းလုဒ်လုပ်နေသည်… {percent}%",
  "settings.installVersion": "{version} ကို တပ်ဆင်မည်",
  "settings.updateAvailable":
    "Purple Memo {version} ကို ရရှိနိုင်ပါပြီ — လက်ရှိ ဗားရှင်းမှာ {current} ဖြစ်သည်။",
  "settings.published": "ထုတ်ဝေခဲ့သည် {date}",
  "settings.noNewerRelease": "အသစ်သော ထုတ်ဝေမှု မရှိသေးပါ။",
  "settings.updateInstalled":
    "အပ်ဒိတ် တပ်ဆင်ပြီးပါပြီ — ဗားရှင်းအသစ် အသုံးပြုရန် Purple Memo ကို ပြန်ဖွင့်ပါ။",
  "settings.checkFailed": "အပ်ဒိတ်များကို စစ်ဆေး၍ မရပါ — {error}",
  "settings.updateFailed": "အပ်ဒိတ် မအောင်မြင်ပါ — {error}",
  "settings.openSource": "ပွင့်လင်းရင်းမြစ်",
  "settings.version": "ဗားရှင်း {version}",

  "settings.language": "ဘာသာစကား",
  "settings.closeToTray": "ပိတ်လိုက်ပါက Tray တွင် ချုံ့ထားမည်",
  "settings.closeToTrayHint":
    "စာမျက်နှာ ပိတ်လိုက်ပါက Purple Memo သည် စနစ် tray တွင် ဆက်လက်အလုပ်လုပ်နေဆဲဖြစ်၍ ပိတ်ထားသည့်အတိုင်းပင် သတိပေးချက်များ ဆက်လက်ပေါ်လာနိုင်ပါသည်။ ဤခလုတ်ကို ပိတ်လိုက်ပါက စာမျက်နှာ ပိတ်လိုက်တိုင်း အက်ပ်လည်း ပိတ်သွားပါမည်။",

  "settings.pairedPhoneTitle": "တွဲချိတ်ထားသော ဖုန်း",
  "settings.pairedPhoneNoneBadge": "ဖုန်း မတွဲချိတ်ရသေးပါ",
  "settings.pairedPhoneTrustedBadge": "မှတ်ထားသည်",
  "settings.pairedPhoneReachable": "တွဲချိတ်ထားသော ဖုန်းကို ချိတ်ဆက်ထားခွင့်ပြုမည်",
  "settings.pairedPhoneReachableHint":
    "ဤအက်ပ် အလုပ်လုပ်နေစဉ် တွဲချိတ်ထားသော ဖုန်းသည် ကုဒ်အသစ် မလိုဘဲ sync လုပ်နိုင်ပါသည် — တစ်ကြိမ်တွေ့ပြီးသော ဖုန်းနှင့် နိုတ်ဘွတ်ကဲ့သို့ ဖြစ်သည်။ ပိတ်လိုက်ပါက pairing စခရင် ဖွင့်ထားမှသာ ချိတ်ဆက်၍ ရပါမည်။",
  "settings.pairedPhoneNoneBody":
    "ဖုန်း မတွဲချိတ်ရသေးပါ။ အထက်ပါ pairing စခရင်မှ တစ်ခု တွဲချိတ်ပါ — ထို့နောက် ဤနေရာတွင် မေ့ပစ်မှသာ မေ့သွားပါမည်။",
  "settings.pairedPhoneName": "ယုံကြည်ထားသော ဖုန်း",
  "settings.pairedPhoneNameFallback": "ဖုန်း",
  "settings.pairedPhoneDeviceId": "စက် ID",
  "settings.pairedPhonePending":
    "ဤဖုန်းသို့ ပို့ရန် မပြီးသေးသော ပြောင်းလဲမှု {count} ခု ရှိနေပါသည်။",
  "settings.pairedPhoneForgetWhat":
    "ဤဖုန်းကို မေ့မည် — ကုဒ်အသစ်ဖြင့် ပြန်တွဲချိတ်မှသာ ဤနိုတ်ဘွတ်နှင့် ပြန် sync လုပ်နိုင်ပါမည်",
  "settings.pairedPhoneForgetWhatPending":
    "ဤဖုန်းကို မေ့ပြီး ဤဖုန်းသို့ ပို့ရန် မပြီးသေးသော ပြောင်းလဲမှု {count} ခုကိုလည်း ဖျက်ပစ်မည်",
  "settings.pairedPhoneForget": "ဤဖုန်းကို မေ့မည်",
  "settings.pairedPhoneForgotten":
    "ဖုန်းကို မေ့ပြီးပါပြီ — ကုဒ်အသစ်ဖြင့် ပြန်တွဲချိတ်မှသာ ပြန် sync လုပ်နိုင်ပါမည်။ (ပို့ရန် မပြီးသေးသော ပြောင်းလဲမှု {count} ခု ဖျက်ပစ်ခဲ့သည်။)",

  "settings.backupTitle": "အရန်သိမ်းဆည်းမှုနှင့် ပြန်လည်ရယူမှု",
  "settings.backupBadge": ".zip သို့မဟုတ် စကားဝှက်ကာကွယ်ထားသည်",
  "settings.lastBackupNever":
    "ဤစက်တွင် အရန်သိမ်းဆည်းမှု မပြုလုပ်ရသေးပါ။ ဤနေရာရှိ အရာအားလုံးသည် ဤစက်တွင်သာ တည်ရှိသည် — ယခုပင် အရန်တစ်ခု ထုတ်ယူပါ။",
  "settings.lastBackupAge":
    "နောက်ဆုံး အရန်သိမ်းဆည်းမှု — {age} ({date})၊ အတန်း {rows} ခု၊ ဓာတ်ပုံ {photos} ခု။",
  "settings.lastBackupStale":
    "နောက်ဆုံး အရန်သိမ်းဆည်းမှု — {age} ({date})၊ ရက် {days} ကျော် ကြာနေပါပြီ။ ယခု ဒစ်ခ် ပျက်သွားပါက ထိုနောက်ပိုင်း ရေးထားသမျှ အားလုံး ဆုံးရှုံးပါမည်။",
  "settings.protectBackup":
    "အရန်သိမ်းဆည်းမှုကို စကားဝှက်ဖြင့် ကာကွယ်မည် (ဖွင့်ရန် ဤစကားဝှက် လိုအပ်သော .{ext} ဖိုင်)",
  "settings.backupPassword": "အရန်သိမ်းဆည်းမှု စကားဝှက်",
  "settings.confirmBackupPassword": "အရန်သိမ်းဆည်းမှု စကားဝှက် အတည်ပြုမည်",
  "settings.exporting": "ထုတ်ယူနေသည်…",
  "settings.exportBackup": "အရန်သိမ်းဆည်းမှု ထုတ်ယူမည်",
  "settings.importing": "တင်သွင်းနေသည်…",
  "settings.importBackup": "အရန်သိမ်းဆည်းမှု တင်သွင်းမည်",
  "settings.opening": "ဖွင့်နေသည်…",
  "settings.openBackup": "အရန်သိမ်းဆည်းမှု ဖွင့်မည်",
  "settings.summary":
    "{date} မှ အရန်သိမ်းဆည်းမှု — ဇယား {tables} ခုတွင် အတန်း {rows} ခု၊ ဓာတ်ပုံ {photos} ခု။ ဆက်လုပ်ပါက လက်ရှိဒေတာအားလုံးကို အစားထိုးမည်။",
  "settings.replaceAll": "ဒေတာအားလုံး အစားထိုးမည်",
  "settings.passwordMismatch": "စကားဝှက်နှစ်ခု မကိုက်ညီပါ — မည်သည့်အရာမျှ မထုတ်ယူရသေးပါ။",
  "settings.passwordRequired":
    "စကားဝှက်ဖြင့် ကာကွယ်ရန် ရွေးချယ်ပြီး စကားဝှက် သတ်မှတ်ပါ — မဟုတ်ပါက ကာကွယ်မှုမထားဘဲ ထုတ်ယူရန် ရွေးချယ်ပါ — မည်သည့်အရာမျှ မထုတ်ယူရသေးပါ။",
  "settings.saveBackupTitle": "Purple Memo အရန်သိမ်းဆည်းမှု သိမ်းမည်",
  "settings.encryptedBackupFilter": "စကားဝှက်ကာကွယ်ထားသော Purple Memo အရန်သိမ်းဆည်းမှု",
  "settings.backupFilter": "Purple Memo အရန်သိမ်းဆည်းမှု",
  "settings.backupSaved":
    "အရန်သိမ်းဆည်းမှုကို {path} တွင် သိမ်းပြီးပါပြီ — အတန်း {rows} ခု၊ ဓာတ်ပုံ {photos} ခု",
  "settings.backupSavedEncrypted":
    "အရန်သိမ်းဆည်းမှုကို {path} တွင် သိမ်းပြီးပါပြီ — အတန်း {rows} ခု၊ ဓာတ်ပုံ {photos} ခု၊ စကားဝှက်ကာကွယ်ထားသည်",
  "settings.tooLarge":
    "အရန်သိမ်းဆည်းမှု ဖိုင်သည် {limit} ဘိုက် ကန့်သတ်ချက်ထက် ကြီးနေသည် — တင်သွင်းမှုကို ပယ်ခဲ့သည်။",
  "settings.imported":
    "အတန်း {rows} ခုနှင့် ဓာတ်ပုံ {photos} ခုကို တင်သွင်းပြီးပါပြီ — ယခင်ဒေတာကို {path} တွင် သိမ်းထားသည်။ ပြန်လည်ဖွင့်နေသည်…",
};
