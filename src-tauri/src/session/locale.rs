//! The locale a shell is asked to run in.
//!
//! The terminal shows whatever bytes the far side sends; whether a Chinese
//! file name arrives as UTF-8 or as the `$'\346\226\207'` escapes GNU `ls`
//! prints in a non-UTF-8 locale is decided by the shell's locale, not by the
//! terminal (issue #39). Two things are under the terminal's control: the
//! environment a local shell starts with — a process launched from the Dock
//! or Finder has no `LANG` at all, so the shell ran in the C locale and `ls`
//! printed `???` for anything non-ASCII — and the `LANG` an SSH session can
//! ask the server for.

use encoding_rs::UTF_8;

use super::encoding;
use crate::model::SessionProfile;

/// The `LANG` to put in a local shell's environment, or None to leave the
/// environment as it is. An explicit profile locale always wins. Otherwise a
/// UTF-8 session whose environment names no locale at all gets a UTF-8 one —
/// the system's on macOS, `C.UTF-8` elsewhere — the way Terminal.app and
/// iTerm2 set one for the shells they start. An environment that does name a
/// locale is left alone even when it is not UTF-8: the user chose it.
pub fn local_shell_lang(profile: &SessionProfile) -> Option<String> {
    decide_local(profile, &Environment::current(), default_utf8_locale)
}

/// The `LANG` an SSH session requests from the server before the shell is
/// started (servers apply it only with `AcceptEnv LANG`), or None to keep
/// the server's own default. Only an explicit profile locale is sent: a
/// guessed one that the server has not installed makes bash warn on every
/// login and drop *every* category to the C locale, which would break a
/// server whose own default was fine.
pub fn ssh_lang(profile: &SessionProfile) -> Option<String> {
    explicit_locale(profile)
}

/// The profile's own locale, when it looks like one.
fn explicit_locale(profile: &SessionProfile) -> Option<String> {
    let locale = profile.locale.as_deref()?.trim();
    is_locale_name(locale).then(|| locale.to_string())
}

/// `en_US.UTF-8`, `C.UTF-8`, `zh_CN.GB18030@euro`: letters, digits and the
/// separators locale names use. Anything else does not go into an
/// environment. The frontend applies the same rule to the Locale field.
pub fn is_locale_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.' | b'@'))
}

/// The locale variables of this process, which a local shell inherits.
struct Environment {
    lc_all: Option<String>,
    lc_ctype: Option<String>,
    lang: Option<String>,
}

impl Environment {
    fn current() -> Self {
        let var = |name: &str| std::env::var(name).ok().filter(|v| !v.trim().is_empty());
        Self {
            lc_all: var("LC_ALL"),
            lc_ctype: var("LC_CTYPE"),
            lang: var("LANG"),
        }
    }

    fn names_a_locale(&self) -> bool {
        self.lc_all.is_some() || self.lc_ctype.is_some() || self.lang.is_some()
    }
}

fn decide_local(
    profile: &SessionProfile,
    env: &Environment,
    default: impl FnOnce() -> Option<String>,
) -> Option<String> {
    if let Some(locale) = explicit_locale(profile) {
        return Some(locale);
    }
    // A GBK session wants the shell in a GBK locale, and only the profile
    // can say which one.
    if encoding::terminal_encoding(profile) != UTF_8 || env.names_a_locale() {
        return None;
    }
    default()
}

/// The `lang_REGION.UTF-8` names a CFLocale identifier (`en_US`,
/// `zh-Hans_CN`, `en_CN@rg=uszzzz`) can stand for, most specific first: the
/// language with the user's region, then with the language's usual region —
/// an "English, China" Mac has no `en_CN` locale, and `en_US` reads the same.
pub fn posix_candidates(identifier: &str) -> Vec<String> {
    const USUAL_REGION: &[(&str, &str)] = &[
        ("en", "US"),
        ("zh", "CN"),
        ("ja", "JP"),
        ("ko", "KR"),
        ("de", "DE"),
        ("fr", "FR"),
        ("es", "ES"),
        ("it", "IT"),
        ("pt", "BR"),
        ("ru", "RU"),
        ("nl", "NL"),
        ("sv", "SE"),
        ("pl", "PL"),
        ("tr", "TR"),
    ];
    let base = identifier.split('@').next().unwrap_or_default();
    let (language, region) = match base.split_once('_') {
        Some((language, region)) => (language, Some(region)),
        None => (base, None),
    };
    // `zh-Hans` → `zh`: POSIX locale names carry no script.
    let language = language.split('-').next().unwrap_or_default();
    if language.is_empty() || !language.bytes().all(|b| b.is_ascii_alphabetic()) {
        return Vec::new();
    }
    let language = language.to_ascii_lowercase();
    let mut candidates = Vec::new();
    if let Some(region) =
        region.filter(|r| r.len() == 2 && r.bytes().all(|b| b.is_ascii_alphabetic()))
    {
        candidates.push(format!("{language}_{}.UTF-8", region.to_ascii_uppercase()));
    }
    if let Some((_, usual)) = USUAL_REGION.iter().find(|(l, _)| *l == language) {
        let candidate = format!("{language}_{usual}.UTF-8");
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }
    candidates
}

/// The UTF-8 locale a local shell gets when its environment has none: the
/// user's own language and region when macOS ships that locale, else
/// `en_US.UTF-8`, which it always ships.
#[cfg(target_os = "macos")]
fn default_utf8_locale() -> Option<String> {
    let installed = |name: &str| {
        std::path::Path::new("/usr/share/locale")
            .join(name)
            .is_dir()
    };
    macos::current_locale_identifier()
        .into_iter()
        .flat_map(|identifier| posix_candidates(&identifier))
        .find(|candidate| installed(candidate))
        .or_else(|| Some("en_US.UTF-8".to_string()))
}

/// `C.UTF-8` is built into glibc since 2.35 and shipped by Debian, Ubuntu,
/// Fedora, RHEL 8+ and the BSDs long before that, unlike any particular
/// language's locale.
#[cfg(all(unix, not(target_os = "macos")))]
fn default_utf8_locale() -> Option<String> {
    Some("C.UTF-8".to_string())
}

/// Windows shells take their code page from the console, not from `LANG`,
/// and the MSYS2 / Cygwin tools default to UTF-8 without one.
#[cfg(windows)]
fn default_utf8_locale() -> Option<String> {
    None
}

#[cfg(target_os = "macos")]
mod macos {
    use core_foundation::base::{CFType, CFTypeRef, TCFType};
    use core_foundation::string::CFString;
    use core_foundation_sys::locale::{CFLocaleCopyCurrent, CFLocaleGetIdentifier};

    /// The identifier of the user's current locale (`en_US`, `zh-Hans_CN`),
    /// from Language & Region in System Settings.
    pub fn current_locale_identifier() -> Option<String> {
        // SAFETY: CFLocaleCopyCurrent returns an owned CFLocale (or NULL);
        // the wrapper releases it when dropped. CFLocaleGetIdentifier
        // returns a string owned by that locale, so it is read under the
        // "get" rule while the locale is still alive.
        unsafe {
            let locale = CFLocaleCopyCurrent();
            if locale.is_null() {
                return None;
            }
            let _owner = CFType::wrap_under_create_rule(locale as CFTypeRef);
            let identifier = CFLocaleGetIdentifier(locale);
            if identifier.is_null() {
                return None;
            }
            Some(CFString::wrap_under_get_rule(identifier).to_string())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::SessionKind;

    fn env(lc_all: Option<&str>, lc_ctype: Option<&str>, lang: Option<&str>) -> Environment {
        Environment {
            lc_all: lc_all.map(str::to_string),
            lc_ctype: lc_ctype.map(str::to_string),
            lang: lang.map(str::to_string),
        }
    }

    fn local_profile() -> SessionProfile {
        crate::tests::profile(SessionKind::Local)
    }

    #[test]
    fn a_shell_started_without_any_locale_gets_a_utf8_one() {
        let lang = decide_local(&local_profile(), &env(None, None, None), || {
            Some("en_US.UTF-8".into())
        });
        assert_eq!(lang.as_deref(), Some("en_US.UTF-8"));
    }

    #[test]
    fn an_environment_that_names_a_locale_is_left_alone() {
        let default = || Some("en_US.UTF-8".to_string());
        assert_eq!(
            decide_local(
                &local_profile(),
                &env(None, None, Some("zh_CN.UTF-8")),
                default
            ),
            None
        );
        // Even a non-UTF-8 one: the user chose it.
        assert_eq!(
            decide_local(&local_profile(), &env(None, Some("C"), None), default),
            None
        );
        assert_eq!(
            decide_local(&local_profile(), &env(Some("POSIX"), None, None), default),
            None
        );
    }

    #[test]
    fn an_explicit_locale_wins_everywhere() {
        let mut profile = local_profile();
        profile.locale = Some("  zh_CN.UTF-8 ".into());
        let lang = decide_local(&profile, &env(None, None, Some("en_US.UTF-8")), || None);
        assert_eq!(lang.as_deref(), Some("zh_CN.UTF-8"));
        assert_eq!(ssh_lang(&profile).as_deref(), Some("zh_CN.UTF-8"));
    }

    #[test]
    fn a_non_utf8_session_is_not_given_a_utf8_locale() {
        let mut profile = local_profile();
        profile.encoding = Some("gbk".into());
        let lang = decide_local(&profile, &env(None, None, None), || {
            Some("en_US.UTF-8".into())
        });
        assert_eq!(lang, None);
    }

    #[test]
    fn ssh_only_sends_a_locale_the_profile_names() {
        assert_eq!(ssh_lang(&crate::tests::profile(SessionKind::Ssh)), None);
        let mut profile = crate::tests::profile(SessionKind::Ssh);
        profile.locale = Some("C.UTF-8".into());
        assert_eq!(ssh_lang(&profile).as_deref(), Some("C.UTF-8"));
    }

    #[test]
    fn only_locale_names_reach_an_environment() {
        assert!(is_locale_name("en_US.UTF-8"));
        assert!(is_locale_name("C.UTF-8"));
        assert!(is_locale_name("zh_CN.GB18030"));
        assert!(is_locale_name("de_DE@euro"));
        assert!(!is_locale_name(""));
        assert!(!is_locale_name("en_US.UTF-8; rm -rf /"));
        assert!(!is_locale_name("en US"));
        assert!(!is_locale_name(&"x".repeat(65)));
        let mut profile = local_profile();
        profile.locale = Some("en_US.UTF-8\n".into());
        assert_eq!(explicit_locale(&profile).as_deref(), Some("en_US.UTF-8"));
        profile.locale = Some("$(id)".into());
        assert_eq!(explicit_locale(&profile), None);
    }

    #[test]
    fn cflocale_identifiers_map_to_posix_names() {
        assert_eq!(posix_candidates("en_US"), ["en_US.UTF-8"]);
        assert_eq!(posix_candidates("en_CN"), ["en_CN.UTF-8", "en_US.UTF-8"]);
        assert_eq!(posix_candidates("zh-Hans_CN"), ["zh_CN.UTF-8"]);
        assert_eq!(
            posix_candidates("zh-Hant_TW"),
            ["zh_TW.UTF-8", "zh_CN.UTF-8"]
        );
        assert_eq!(posix_candidates("en_US@rg=gbzzzz"), ["en_US.UTF-8"]);
        assert_eq!(posix_candidates("es_419"), ["es_ES.UTF-8"]);
        assert_eq!(posix_candidates("zh"), ["zh_CN.UTF-8"]);
        assert!(posix_candidates("xx").is_empty());
        assert!(posix_candidates("").is_empty());
        assert!(posix_candidates("_US").is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_macos_default_is_a_locale_the_system_ships() {
        let lang = default_utf8_locale().expect("macOS always has a UTF-8 locale");
        assert!(lang.ends_with(".UTF-8"), "{lang}");
        assert!(
            std::path::Path::new("/usr/share/locale")
                .join(&lang)
                .is_dir(),
            "{lang}"
        );
    }
}
