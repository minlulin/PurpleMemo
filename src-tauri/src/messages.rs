//! What Rust says — the tray, the boot dialogs, and every command's refusal.
//!
//! Rust used to answer in finished English sentences. That left a Burmese
//! reader with an English tray menu, English boot dialogs, and English banners
//! under a translated screen (D7). The rule is now: **Rust names things, the
//! renderer says them.**
//!
//! Two surfaces cannot wait for the renderer, and they are the whole reason a
//! table lives here at all:
//!
//! * the tray menu is built during `setup`, before any command exists;
//! * the boot-failure dialogs run when the database could not be opened — the
//!   very moment the renderer has no commands to call.
//!
//! Both read a locale marker the renderer writes (`ui_locale_set`), so they
//! still follow the language the user chose in Settings. Everything after boot
//! is a [`Refusal`]: a key plus params, resolved by the renderer's catalogue,
//! which is also where the completeness test lives (`src/lib/i18n.test.ts`).
//! Keeping the Rust table to boot and tray is deliberate — a second full
//! catalogue would have to be kept complete in step with the first.

use serde::Serialize;
use std::collections::BTreeMap;
use std::fmt;

/// The languages the app ships. Parsed from the marker file and from the
/// renderer's `ui_locale_set`, never guessed from the environment: the stored
/// setting (and therefore the marker) is the user's choice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    En,
    My,
}

impl Locale {
    /// `None` for anything unrecognised, so a corrupt marker falls back to
    /// English instead of silently picking a language.
    pub fn parse(tag: &str) -> Option<Self> {
        match tag.trim().to_ascii_lowercase().as_str() {
            "en" => Some(Locale::En),
            "my" => Some(Locale::My),
            _ => None,
        }
    }

    /// The tag the renderer's `LOCALES` uses, written into the marker file.
    pub fn code(self) -> &'static str {
        match self {
            Locale::En => "en",
            Locale::My => "my",
        }
    }
}

/// Every word the boot-failure dialogs use.
///
/// One struct per language rather than a map of loose strings: the compiler
/// then refuses a language that forgets a field, which is the same guarantee
/// the renderer's catalogue gets from `Record<MessageKey, string>`.
pub struct BootStrings {
    pub title: &'static str,
    pub retry: &'static str,
    pub quit: &'static str,
    pub restore: &'static str,
    pub choose_key_file: &'static str,
    /// Ends where the cause begins: `format!("{prefix}{cause}.")`.
    pub failed_prefix: &'static str,
    pub retry_guidance: &'static str,
    pub restore_guidance: &'static str,
    pub keyring_hint: &'static str,
    pub restore_failed_prefix: &'static str,
    pub restore_failed_suffix: &'static str,
}

impl BootStrings {
    /// The headline plus the cause. The cause is the diagnostic the failing
    /// layer produced (a database or credential-store message) and is shown
    /// as it is — translating SQLite's or the OS's own words is not ours.
    pub fn failed(&self, cause: &str) -> String {
        format!("{}{cause}.", self.failed_prefix)
    }

    /// The dialog after a restore attempt failed: nothing was changed.
    pub fn restore_failed(&self, reason: &str) -> String {
        format!(
            "{}{reason}.{}",
            self.restore_failed_prefix, self.restore_failed_suffix
        )
    }
}

const BOOT_EN: BootStrings = BootStrings {
    title: "Purple Memo can't start",
    retry: "Retry",
    quit: "Quit",
    restore: "Restore exported key…",
    choose_key_file: "Choose your exported Purple Memo key file",
    failed_prefix: "Purple Memo failed to start: ",
    retry_guidance: " Fix that and choose Retry, or choose Quit to close Purple Memo.",
    restore_guidance: " Choose Restore exported key… and pick the key file you exported in \
                       Settings (Backup & key), or choose Quit to close Purple Memo.",
    keyring_hint: " Hint: your OS credential store looks unavailable — Purple Memo keeps its \
                   database key there, so it cannot start without it.",
    restore_failed_prefix: "Purple Memo failed to start: restoring the key failed: ",
    restore_failed_suffix: " Nothing was changed — the database and the credential store are \
                            untouched.",
};

const BOOT_MY: BootStrings = BootStrings {
    title: "Purple Memo ကို စတင်၍ မရပါ",
    retry: "ထပ်ကြိုးစားမည်",
    quit: "ပိတ်မည်",
    restore: "ထုတ်ယူထားသော သော့ ပြန်ထည့်မည်…",
    choose_key_file: "ထုတ်ယူထားသော Purple Memo သော့ဖိုင်ကို ရွေးပါ",
    failed_prefix: "Purple Memo ကို စတင်၍ မရပါ — ",
    retry_guidance: " ပြဿနာကို ဖြေရှင်းပြီး ထပ်ကြိုးစားမည်ကို ရွေးပါ၊ သို့မဟုတ် Purple Memo ကို ပိတ်ရန် ပိတ်မည်ကို ရွေးပါ။",
    restore_guidance: " ထုတ်ယူထားသော သော့ ပြန်ထည့်မည်… ကို ရွေးပြီး ဆက်တင် (အရန်သိမ်းဆည်းမှုနှင့် သော့) တွင် ထုတ်ယူထားသည့် သော့ဖိုင်ကို ရွေးပါ၊ သို့မဟုတ် ပိတ်မည်ကို ရွေးပါ။",
    keyring_hint: " အရိပ်အမြွက် — သင့် OS ၏ အထောက်အထား သိမ်းဆည်းရာ မရနိုင်သည်ဟု ထင်ရသည်။ Purple Memo သည် ၎င်း၏ ဒေတာဘေ့စ်သော့ကို ထိုနေရာတွင် ထားရှိသဖြင့် ၎င်းမရှိဘဲ စတင်၍ မရပါ။",
    restore_failed_prefix: "Purple Memo ကို စတင်၍ မရပါ — သော့ ပြန်ထည့်ခြင်း မအောင်မြင်ပါ — ",
    restore_failed_suffix: " မည်သည့်အရာမျှ မပြောင်းလဲရသေးပါ — ဒေတာဘေ့စ်နှင့် အထောက်အထား သိမ်းဆည်းရာ နှစ်ခုစလုံး မထိခိုက်ပါ။",
};

/// The tray menu's two items and the icon's tooltip.
pub struct TrayLabels {
    pub show: &'static str,
    pub quit: &'static str,
    pub tooltip: &'static str,
}

const TRAY_EN: TrayLabels = TrayLabels {
    show: "Show Purple Memo",
    quit: "Quit",
    tooltip: "Purple Memo",
};

const TRAY_MY: TrayLabels = TrayLabels {
    show: "Purple Memo ကို ပြမည်",
    quit: "ပိတ်မည်",
    tooltip: "Purple Memo",
};

/// The boot dialogs' words for `locale`.
pub fn boot(locale: Locale) -> &'static BootStrings {
    match locale {
        Locale::En => &BOOT_EN,
        Locale::My => &BOOT_MY,
    }
}

/// The tray's labels for `locale`.
pub fn tray(locale: Locale) -> &'static TrayLabels {
    match locale {
        Locale::En => &TRAY_EN,
        Locale::My => &TRAY_MY,
    }
}

/// A refusal the renderer translates.
///
/// `key` names a message in `src/lib/i18n.ts`; `params` fill its `{name}`
/// slots. A detail the app did not write (an OS error, SQLite's own message, a
/// protocol report) travels as a param and stays in its own words — inventing
/// a translation for it would be worse than showing it.
///
/// Serialised straight to the webview, where `errText` recognises the shape and
/// renders it in the locale active at that moment, so a banner raised before a
/// language switch is re-read in the new one.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Refusal {
    pub key: &'static str,
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub params: BTreeMap<&'static str, String>,
}

impl Refusal {
    /// A refusal with no placeholders.
    pub fn new(key: &'static str) -> Self {
        Refusal {
            key,
            params: BTreeMap::new(),
        }
    }

    /// The same refusal with one more `{name}` filled in.
    pub fn with(mut self, name: &'static str, value: impl ToString) -> Self {
        self.params.insert(name, value.to_string());
        self
    }

    /// A single string for the diagnostic channels — stderr, the boot log, and
    /// the pairing window's `note`, which also relays the peer's own words and
    /// therefore cannot be translated. The layer's detail when it has one, the
    /// key otherwise (a key is still greppable, which is what a note is for).
    pub fn diagnostic(&self) -> String {
        match self.params.get("detail") {
            Some(detail) => detail.clone(),
            None => self.key.to_string(),
        }
    }
}

impl fmt::Display for Refusal {
    /// For logs and stderr only — never for the UI, which has the catalogue.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.key)?;
        for (name, value) in &self.params {
            write!(f, " {name}={value}")?;
        }
        Ok(())
    }
}

impl std::error::Error for Refusal {}

impl From<String> for Refusal {
    /// An error from a layer that only speaks diagnostics. The renderer still
    /// gets a key; the layer's own words ride along as `{detail}`.
    fn from(detail: String) -> Self {
        Refusal::new("rust.error.generic").with("detail", detail)
    }
}

impl From<&str> for Refusal {
    fn from(detail: &str) -> Self {
        Refusal::from(detail.to_string())
    }
}

impl From<crate::lifecycle::Blocked> for Refusal {
    /// The lifecycle barrier's two refusals, by type rather than by message
    /// text (the same rule the boot-failure dialog follows).
    fn from(blocked: crate::lifecycle::Blocked) -> Self {
        match blocked {
            crate::lifecycle::Blocked::Reset => Refusal::new("rust.error.resetInProgress"),
            crate::lifecycle::Blocked::Import => Refusal::new("rust.error.importInProgress"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_locale_tag_parses_only_when_it_is_one_of_the_shipped_languages() {
        assert_eq!(Locale::parse("en"), Some(Locale::En));
        assert_eq!(Locale::parse(" MY "), Some(Locale::My));
        assert_eq!(Locale::parse("my-MM"), None);
        assert_eq!(Locale::parse(""), None);
        for locale in [Locale::En, Locale::My] {
            assert_eq!(Locale::parse(locale.code()), Some(locale));
        }
    }

    #[test]
    fn both_languages_say_everything_the_boot_dialog_needs() {
        // The struct already makes a missing FIELD a compile error; this pins
        // that neither language shipped an empty or placeholder string.
        for locale in [Locale::En, Locale::My] {
            let strings = boot(locale);
            for text in [
                strings.title,
                strings.retry,
                strings.quit,
                strings.restore,
                strings.choose_key_file,
                strings.failed_prefix,
                strings.retry_guidance,
                strings.restore_guidance,
                strings.keyring_hint,
                strings.restore_failed_prefix,
                strings.restore_failed_suffix,
            ] {
                assert!(!text.trim().is_empty(), "{locale:?} has an empty boot text");
            }
            let tray = tray(locale);
            for text in [tray.show, tray.quit, tray.tooltip] {
                assert!(!text.trim().is_empty(), "{locale:?} has an empty tray text");
            }
        }
    }

    #[test]
    fn the_two_languages_actually_differ_so_a_switch_is_visible() {
        assert_ne!(boot(Locale::En).title, boot(Locale::My).title);
        assert_ne!(boot(Locale::En).retry, boot(Locale::My).retry);
        assert_ne!(tray(Locale::En).show, tray(Locale::My).show);
    }

    #[test]
    fn a_boot_message_keeps_the_cause_inside_the_translated_headline() {
        let strings = boot(Locale::My);
        let body = strings.failed("open /x/y.db: no such file or directory");
        assert!(body.starts_with(strings.failed_prefix));
        assert!(body.contains("open /x/y.db: no such file or directory"));
        let restored = strings.restore_failed("the key does not open this database");
        assert!(restored.contains("the key does not open this database"));
        assert!(restored.ends_with(strings.restore_failed_suffix));
    }

    #[test]
    fn a_refusal_serialises_as_a_key_and_its_params_only() {
        let refusal = Refusal::new("rust.error.photoPath").with("path", "photos/x");
        let json = serde_json::to_value(&refusal).expect("a refusal serialises");
        assert_eq!(json["key"], "rust.error.photoPath");
        assert_eq!(json["params"]["path"], "photos/x");
        // An empty param map is omitted, so the renderer never sees `{}`.
        let bare = serde_json::to_value(Refusal::new("rust.error.desktopOnly"))
            .expect("a refusal serialises");
        assert!(bare.get("params").is_none());
    }

    #[test]
    fn a_legacy_detail_string_becomes_a_key_with_its_detail_as_a_param() {
        let refusal = Refusal::from("prepare failed: no such column: nope".to_string());
        assert_eq!(refusal.key, "rust.error.generic");
        assert_eq!(
            refusal.params.get("detail").map(String::as_str),
            Some("prepare failed: no such column: nope")
        );
        // Display is the log form: the key, then the params, never a sentence.
        assert!(refusal.to_string().contains("rust.error.generic"));
    }

    #[test]
    fn the_lifecycle_barrier_refuses_by_type_not_by_text() {
        let reset = Refusal::from(crate::lifecycle::Blocked::Reset);
        let import = Refusal::from(crate::lifecycle::Blocked::Import);
        assert_eq!(reset.key, "rust.error.resetInProgress");
        assert_eq!(import.key, "rust.error.importInProgress");
        assert!(reset.params.is_empty() && import.params.is_empty());
    }
}
