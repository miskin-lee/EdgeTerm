//! The font families installed on this machine, for Display Settings.
//!
//! A WebView cannot list the machine's fonts: `queryLocalFonts` exists only
//! in Chromium and behind a permission prompt, and `document.fonts.check`
//! answers for web fonts. The frontend can only probe names it already knows
//! (see `fonts.ts`), which leaves every family it does not know to guess at
//! (issue #28). Reading the font directories here fills the gap: `fontdb`
//! parses each face's name table without rendering anything, and the picker
//! merges the result with the frontend's own probe.
//!
//! The same scan tells which families carry the Nerd Font icons prompt
//! themes print (Powerlevel10k, Starship, oh-my-posh). The WebView does not
//! look through the machine's fonts for a private-use codepoint the stack
//! cannot draw (WKWebView at least), so those icons came out as boxes unless
//! the user happened to pick a Nerd Font as the terminal family (issue #56);
//! the frontend appends such a family to the terminal stack as a fallback
//! instead.

use std::collections::BTreeMap;

use serde::Serialize;

/// One family, whether it is fixed-pitch, which is what the terminal's
/// picker lists by default, and whether it draws the Nerd Font icons.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub name: String,
    pub monospaced: bool,
    pub symbols: bool,
}

/// Every family the system font directories hold, sorted by name. About 900
/// faces on a stock macOS, read in under a quarter of a second.
pub fn system_font_families() -> Vec<FontFamily> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    collect(db.faces().map(|face| {
        let (latin_monospaced, symbols) = db
            .with_face_data(face.id, |data, index| {
                ttf_parser::Face::parse(data, index).map_or((false, false), |face| {
                    (latin_widths_agree(&face), draws_nerd_font_icons(&face))
                })
            })
            .unwrap_or((false, false));
        (
            face.families.first().map(|(name, _)| name.as_str()),
            face.monospaced || latin_monospaced,
            symbols,
        )
    }))
}

/// The face fontconfig gives for the generic `monospace` family on Linux,
/// by name; `None` elsewhere or when `fc-match` cannot answer.
///
/// The terminal stack names it explicitly (see `fontStack` in `fonts.ts`)
/// because WebKitGTK does not resolve the stack's generic tail the same
/// way everywhere: xterm.js measures its cell on an `OffscreenCanvas`
/// while the DOM draws the text, and when the two land on different faces
/// the cell is as wide as a proportional `W` and the monospaced letters
/// sit spread out inside it (issue #78). A family named outright is the
/// same face in both.
pub fn system_monospace_family() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        let output = std::process::Command::new("fc-match")
            .args(["--format=%{family[0]}", "monospace"])
            .output()
            .ok()
            .filter(|output| output.status.success())?;
        parse_fc_family(&output.stdout)
    }
    #[cfg(not(target_os = "linux"))]
    {
        None
    }
}

/// `fc-match`'s answer, trimmed; nothing when it printed nothing usable.
#[cfg_attr(not(any(target_os = "linux", test)), allow(dead_code))]
fn parse_fc_family(stdout: &[u8]) -> Option<String> {
    let name = String::from_utf8_lossy(stdout).trim().to_string();
    (!name.is_empty() && !name.contains(['"', '\\', '\n'])).then_some(name)
}

/// Whether the face draws Latin letters, digits and punctuation at one
/// advance. The `post` table's fixed-pitch flag is what `fontdb` reports,
/// and it is not to be trusted on its own: Monaco and Courier both leave it
/// clear. A face without Latin glyphs (symbols, a pure CJK face) is not
/// monospaced for the terminal's purposes either way.
fn latin_widths_agree(face: &ttf_parser::Face) -> bool {
    let mut width = None;
    for c in ['i', 'l', 'M', 'W', '0', '.'] {
        let Some(glyph) = face.glyph_index(c) else {
            return false;
        };
        let Some(advance) = face.glyph_hor_advance(glyph) else {
            return false;
        };
        if *width.get_or_insert(advance) != advance {
            return false;
        }
    }
    width.is_some_and(|w| w > 0)
}

/// Whether the face maps both a Powerline symbol (the branch mark, U+E0A0)
/// and a Font Awesome icon (home, U+F015). Only a Nerd Font patch puts the
/// two sets together, and both sit at the same codepoints in every Nerd
/// Fonts release: a plain Powerline-patched face lacks the icons the prompt
/// themes draw, and Font Awesome alone lacks the Powerline range. Checking
/// the glyphs rather than the name also finds the patched builds that are
/// not called "Nerd Font" (romkatv's "MesloLGS NF", "Maple Mono NF CN").
fn draws_nerd_font_icons(face: &ttf_parser::Face) -> bool {
    ['\u{E0A0}', '\u{F015}']
        .into_iter()
        .all(|c| face.glyph_index(c).is_some())
}

/// Folds faces into families. A face's first name is its English one when
/// it has one (`fontdb` orders them so); a family counts as monospaced, or
/// as drawing the icons, when any of its faces does, since a "Mono" family's
/// italic or a variable face does not always flag itself. Names starting
/// with a dot are the private system faces macOS never lets an application
/// pick by name.
fn collect<'a>(faces: impl Iterator<Item = (Option<&'a str>, bool, bool)>) -> Vec<FontFamily> {
    let mut families: BTreeMap<String, (bool, bool)> = BTreeMap::new();
    for (name, monospaced, symbols) in faces {
        let Some(name) = name
            .map(str::trim)
            .filter(|n| !n.is_empty() && !n.starts_with('.'))
        else {
            continue;
        };
        let family = families.entry(name.to_string()).or_default();
        family.0 |= monospaced;
        family.1 |= symbols;
    }
    families
        .into_iter()
        .map(|(name, (monospaced, symbols))| FontFamily {
            name,
            monospaced,
            symbols,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{collect, parse_fc_family, FontFamily};

    #[test]
    fn fc_match_answer_is_one_family_name() {
        assert_eq!(
            parse_fc_family(b"Ubuntu Sans Mono\n").as_deref(),
            Some("Ubuntu Sans Mono")
        );
        assert_eq!(parse_fc_family(b"  \n"), None);
        // Nothing that would break out of the quoted CSS name.
        assert_eq!(parse_fc_family(b"Evil\", serif"), None);
    }

    #[test]
    fn faces_fold_into_sorted_families() {
        let faces = [
            (Some("Menlo"), true, false),
            (Some("Menlo"), true, false),
            (Some("Helvetica"), false, false),
            (Some(" JetBrains Mono "), true, false),
            // An italic face without the fixed-pitch flag does not demote
            // the family.
            (Some("JetBrains Mono"), false, false),
            // Nor does a face of a patched family that lost the icons.
            (Some("MesloLGS NF"), true, true),
            (Some("MesloLGS NF"), true, false),
            (Some(".SF NS Mono"), true, false),
            (Some(""), true, true),
            (None, true, true),
        ];
        assert_eq!(
            collect(faces.into_iter()),
            [
                FontFamily {
                    name: "Helvetica".into(),
                    ..Default::default()
                },
                FontFamily {
                    name: "JetBrains Mono".into(),
                    monospaced: true,
                    ..Default::default()
                },
                FontFamily {
                    name: "Menlo".into(),
                    monospaced: true,
                    ..Default::default()
                },
                FontFamily {
                    name: "MesloLGS NF".into(),
                    monospaced: true,
                    symbols: true,
                },
            ]
        );
    }

    // The heuristic against the fonts this machine actually has: a stock
    // monospaced face and a stock proportional one exist on every platform
    // the app ships for, so the test skips only where neither is installed.
    #[test]
    fn stock_faces_are_told_apart() {
        let families = super::system_font_families();
        let find = |name: &str| families.iter().find(|f| f.name == name);
        let mono = [
            "Menlo",
            "Monaco",
            "Consolas",
            "DejaVu Sans Mono",
            "Courier New",
        ];
        let proportional = ["Helvetica", "Arial", "DejaVu Sans", "Segoe UI"];
        if let Some(family) = mono.iter().find_map(|name| find(name)) {
            assert!(family.monospaced, "{} should be monospaced", family.name);
            // No stock face is patched with the Nerd Font icons.
            assert!(!family.symbols, "{} has no Nerd Font icons", family.name);
        }
        if let Some(family) = proportional.iter().find_map(|name| find(name)) {
            assert!(
                !family.monospaced,
                "{} should not be monospaced",
                family.name
            );
        }
        assert!(families.iter().all(|f| !f.name.starts_with('.')));
    }
}
