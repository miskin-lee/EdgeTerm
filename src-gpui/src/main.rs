#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod app;
mod error;
mod local_pty;
#[allow(dead_code)]
#[path = "../../src-tauri/src/model.rs"]
mod model;
#[allow(dead_code)]
#[path = "../../src-tauri/src/store.rs"]
mod store;
mod terminal;
mod theme;

use std::borrow::Cow;

use app::EdgeTermApp;
use gpui::{
    App, AppContext, Application, AssetSource, Bounds, Result, SharedString, TitlebarOptions,
    WindowBackgroundAppearance, WindowBounds, WindowDecorations, WindowOptions, point, px, size,
};

struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> Result<Option<Cow<'static, [u8]>>> {
        let bytes: &'static [u8] = match path {
            "icons/file.svg" => include_bytes!("../assets/icons/file.svg"),
            "icons/folder.svg" => include_bytes!("../assets/icons/folder.svg"),
            "icons/new-file.svg" => include_bytes!("../assets/icons/new-file.svg"),
            "icons/new-folder.svg" => include_bytes!("../assets/icons/new-folder.svg"),
            "icons/upload.svg" => include_bytes!("../assets/icons/upload.svg"),
            "icons/download.svg" => include_bytes!("../assets/icons/download.svg"),
            "icons/refresh.svg" => include_bytes!("../assets/icons/refresh.svg"),
            "icons/delete.svg" => include_bytes!("../assets/icons/delete.svg"),
            "icons/parent-folder.svg" => include_bytes!("../assets/icons/parent-folder.svg"),
            "icons/terminal-folder.svg" => {
                include_bytes!("../assets/icons/terminal-folder.svg")
            }
            _ => return Ok(None),
        };
        Ok(Some(Cow::Borrowed(bytes)))
    }

    fn list(&self, _path: &str) -> Result<Vec<SharedString>> {
        Ok(Vec::new())
    }
}

fn main() {
    Application::new().with_assets(Assets).run(|cx: &mut App| {
        let bounds = Bounds::centered(None, size(px(1440.0), px(900.0)), cx);
        cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                window_min_size: Some(size(px(900.0), px(560.0))),
                titlebar: Some(TitlebarOptions {
                    title: Some("EdgeTerm".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(12.0), px(12.0))),
                }),
                window_background: WindowBackgroundAppearance::Opaque,
                window_decorations: Some(WindowDecorations::Client),
                // Keep the migration build distinct from the installed Tauri app. Sharing the
                // production bundle id makes macOS accessibility and window restoration target
                // whichever EdgeTerm process happened to launch first.
                app_id: Some("com.edgeterm.gpui".into()),
                ..Default::default()
            },
            |window, cx| cx.new(|cx| EdgeTermApp::new(window, cx)),
        )
        .expect("failed to create the EdgeTerm GPUI window");
        cx.activate(true);
    });
}
