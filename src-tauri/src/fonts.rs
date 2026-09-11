//! The font families installed on this machine, for Display Settings.
//!
//! A WebView cannot list the machine's fonts: `queryLocalFonts` exists only
//! in Chromium and behind a permission prompt, and `document.fonts.check`
//! answers for web fonts. The frontend can only probe names it already knows
//! (see `fonts.ts`), which leaves every family it does not know to guess at
//! (issue #28). Reading the font directories here fills the gap: `fontdb`
//! parses each face's name table without rendering anything, and the picker
//! merges the result with the frontend's own probe.

use std::collections::BTreeMap;

use serde::Serialize;

/// One family and whether it is fixed-pitch, which is what the terminal's
/// picker lists by default.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FontFamily {
    pub name: String,
    pub monospaced: bool,
}

/// Every family the system font directories hold, sorted by name. About 900
/// faces on a stock macOS, read in under a quarter of a second.
pub fn system_font_families() -> Vec<FontFamily> {
    let mut db = fontdb::Database::new();
    db.load_system_fonts();
    collect(db.faces().map(|face| {
        let monospaced = face.monospaced
            || db
                .with_face_data(face.id, |data, index| {
                    ttf_parser::Face::parse(data, index).is_ok_and(|face| latin_widths_agree(&face))
                })
                .unwrap_or(false);
        (
            face.families.first().map(|(name, _)| name.as_str()),
            monospaced,
        )
    }))
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

/// Folds faces into families. A face's first name is its English one when
/// it has one (`fontdb` orders them so); a family counts as monospaced when
/// any of its faces is, since a "Mono" family's italic or a variable face
/// does not always flag itself. Names starting with a dot are the private
/// system faces macOS never lets an application pick by name.
fn collect<'a>(faces: impl Iterator<Item = (Option<&'a str>, bool)>) -> Vec<FontFamily> {
    let mut families: BTreeMap<String, bool> = BTreeMap::new();
    for (name, monospaced) in faces {
        let Some(name) = name
            .map(str::trim)
            .filter(|n| !n.is_empty() && !n.starts_with('.'))
        else {
            continue;
        };
        *families.entry(name.to_string()).or_insert(false) |= monospaced;
    }
    families
        .into_iter()
        .map(|(name, monospaced)| FontFamily { name, monospaced })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{collect, FontFamily};

    #[test]
    fn faces_fold_into_sorted_families() {
        let faces = [
            (Some("Menlo"), true),
            (Some("Menlo"), true),
            (Some("Helvetica"), false),
            (Some(" JetBrains Mono "), true),
            // An italic face without the fixed-pitch flag does not demote
            // the family.
            (Some("JetBrains Mono"), false),
            (Some(".SF NS Mono"), true),
            (Some(""), true),
            (None, true),
        ];
        assert_eq!(
            collect(faces.into_iter()),
            [
                FontFamily {
                    name: "Helvetica".into(),
                    monospaced: false
                },
                FontFamily {
                    name: "JetBrains Mono".into(),
                    monospaced: true
                },
                FontFamily {
                    name: "Menlo".into(),
                    monospaced: true
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
