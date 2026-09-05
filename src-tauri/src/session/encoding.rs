//! The character encoding of a terminal session's byte stream.
//!
//! xterm.js reads UTF-8. A server or device that talks GBK, Big5 or another
//! legacy encoding needs converting in both directions: its output is decoded
//! in the frontend (`encodings.ts`, after the ZMODEM / XMODEM sentries have
//! seen the raw bytes), and the keyboard input going back is encoded here,
//! through `SessionManager::write_text`. Binary writes are never converted.

use encoding_rs::{EncoderResult, Encoding, UTF_16BE, UTF_16LE, UTF_8};

use crate::model::SessionProfile;

/// The encoding a profile's `encoding` label names.
pub fn terminal_encoding(profile: &SessionProfile) -> &'static Encoding {
    resolve(profile.encoding.as_deref().unwrap_or_default())
}

/// Resolves a WHATWG encoding label (`gbk`, `Big5`, `shift_jis`, …) the way
/// the frontend's `TextDecoder` does, so both directions agree. An unknown
/// label and UTF-16, which cannot carry a terminal's control bytes, mean
/// UTF-8: a hand-edited or imported profile never disables the terminal.
pub fn resolve(label: &str) -> &'static Encoding {
    match Encoding::for_label_no_replacement(label.trim().as_bytes()) {
        Some(encoding) if encoding != UTF_16LE && encoding != UTF_16BE => encoding,
        _ => UTF_8,
    }
}

/// Encodes keyboard or paste text for the session. A character the encoding
/// has no code for becomes `?`; the WHATWG default of an HTML numeric
/// reference (`&#128512;`) would reach the shell as those literal characters.
pub fn encode_input(encoding: &'static Encoding, text: &str) -> Vec<u8> {
    if encoding == UTF_8 {
        return text.as_bytes().to_vec();
    }
    let mut encoder = encoding.new_encoder();
    let mut out = Vec::with_capacity(text.len() + 16);
    let mut rest = text;
    loop {
        let room = encoder
            .max_buffer_length_from_utf8_without_replacement(rest.len())
            .unwrap_or(rest.len() * 4)
            .max(16);
        let start = out.len();
        out.resize(start + room, 0);
        let (result, read, written) =
            encoder.encode_from_utf8_without_replacement(rest, &mut out[start..], true);
        out.truncate(start + written);
        rest = &rest[read..];
        match result {
            EncoderResult::InputEmpty => return out,
            EncoderResult::OutputFull => {}
            EncoderResult::Unmappable(_) => out.push(b'?'),
        }
    }
}

#[cfg(test)]
mod tests {
    use encoding_rs::{BIG5, GB18030, GBK, WINDOWS_1252};

    use super::*;

    #[test]
    fn labels_resolve_like_the_frontend_and_default_to_utf8() {
        assert_eq!(resolve("gbk"), GBK);
        assert_eq!(resolve(" GB18030 "), GB18030);
        assert_eq!(resolve("big5"), BIG5);
        // ISO-8859-1 is an alias of Windows-1252 in the WHATWG registry.
        assert_eq!(resolve("iso-8859-1"), WINDOWS_1252);
        assert_eq!(resolve(""), UTF_8);
        assert_eq!(resolve("utf-8"), UTF_8);
        assert_eq!(resolve("no-such-encoding"), UTF_8);
        assert_eq!(resolve("utf-16le"), UTF_8);
        assert_eq!(resolve("utf-16"), UTF_8);
        // The "replacement" family (hz-gb-2312, iso-2022-cn, …) decodes to
        // nothing useful and must not be selected either.
        assert_eq!(resolve("hz-gb-2312"), UTF_8);
    }

    #[test]
    fn a_profile_without_a_label_is_utf8() {
        let mut profile = crate::tests::profile(crate::model::SessionKind::Ssh);
        assert_eq!(terminal_encoding(&profile), UTF_8);
        profile.encoding = Some("GBK".into());
        assert_eq!(terminal_encoding(&profile), GBK);
    }

    #[test]
    fn input_is_encoded_for_the_session() {
        assert_eq!(
            encode_input(GBK, "ls 你好\r"),
            b"ls \xc4\xe3\xba\xc3\r".to_vec()
        );
        assert_eq!(encode_input(BIG5, "你好"), b"\xa7\x41\xa6\x6e".to_vec());
    }

    #[test]
    fn utf8_input_passes_through_unchanged() {
        assert_eq!(encode_input(UTF_8, "ls 你好\r"), "ls 你好\r".as_bytes());
    }

    #[test]
    fn unmappable_characters_become_question_marks() {
        // GBK has no emoji; GB18030 covers all of Unicode.
        assert_eq!(encode_input(GBK, "a😀b"), b"a?b".to_vec());
        assert_eq!(encode_input(WINDOWS_1252, "你a"), b"?a".to_vec());
        let gb18030 = encode_input(GB18030, "😀");
        assert_eq!(gb18030.len(), 4);
        assert!(!gb18030.contains(&b'?'));
    }

    #[test]
    fn long_input_is_encoded_completely() {
        let text = "中文".repeat(50_000);
        let bytes = encode_input(GBK, &text);
        assert_eq!(bytes.len(), text.chars().count() * 2);
        assert_eq!(&bytes[..4], b"\xd6\xd0\xce\xc4");
    }
}
