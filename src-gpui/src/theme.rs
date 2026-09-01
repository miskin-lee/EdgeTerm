use gpui::{Hsla, rgb};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ThemeMode {
    Dark,
    Light,
}

#[derive(Clone, Copy)]
pub struct Theme {
    pub app: Hsla,
    pub panel: Hsla,
    pub surface: Hsla,
    pub field: Hsla,
    pub active: Hsla,
    pub hover: Hsla,
    pub border: Hsla,
    pub border_strong: Hsla,
    pub text: Hsla,
    pub text_dim: Hsla,
    pub text_faint: Hsla,
    pub accent: Hsla,
    pub accent_contrast: Hsla,
    pub green: Hsla,
    pub yellow: Hsla,
    pub red: Hsla,
    pub directory: Hsla,
    pub gutter_time: Hsla,
    pub gutter_text: Hsla,
}

impl Theme {
    pub fn for_mode(mode: ThemeMode) -> Self {
        match mode {
            ThemeMode::Dark => Self {
                app: rgb(0x181818).into(),
                panel: rgb(0x181818).into(),
                surface: rgb(0x1f1f1f).into(),
                field: rgb(0x313131).into(),
                active: rgb(0x04395e).into(),
                hover: rgb(0x2a2d2e).into(),
                border: rgb(0x2b2b2b).into(),
                border_strong: rgb(0x3c3c3c).into(),
                text: rgb(0xcccccc).into(),
                text_dim: rgb(0x9d9d9d).into(),
                text_faint: rgb(0x6e7681).into(),
                accent: rgb(0x0078d4).into(),
                accent_contrast: rgb(0xffffff).into(),
                green: rgb(0x89d185).into(),
                yellow: rgb(0xcca700).into(),
                red: rgb(0xf85149).into(),
                directory: rgb(0x9cdcfe).into(),
                gutter_time: rgb(0x5a5d63).into(),
                gutter_text: rgb(0x6e7681).into(),
            },
            ThemeMode::Light => Self {
                app: rgb(0xf8f8f8).into(),
                panel: rgb(0xf8f8f8).into(),
                surface: rgb(0xffffff).into(),
                field: rgb(0xffffff).into(),
                active: rgb(0xe8e8e8).into(),
                hover: rgb(0xf2f2f2).into(),
                border: rgb(0xe5e5e5).into(),
                border_strong: rgb(0xcecece).into(),
                text: rgb(0x3b3b3b).into(),
                text_dim: rgb(0x616161).into(),
                text_faint: rgb(0x868686).into(),
                accent: rgb(0x005fb8).into(),
                accent_contrast: rgb(0xffffff).into(),
                green: rgb(0x107c10).into(),
                yellow: rgb(0xbf8803).into(),
                red: rgb(0xcd3131).into(),
                directory: rgb(0x26569e).into(),
                gutter_time: rgb(0xa3a8ae).into(),
                gutter_text: rgb(0x6e7681).into(),
            },
        }
    }
}
