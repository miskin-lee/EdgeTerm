mod commands;
mod error;
mod fs_local;
mod model;
mod remote_edit;
mod session;
mod store;

#[cfg(test)]
mod tests;

use commands::AppState;
use tauri::Manager;

/// Build the main window from `tauri.conf.json` (`create: false` there keeps
/// Tauri from creating it first).
///
/// The menubar is the title bar: it is the drag region and shares its row
/// with the window controls (see `MenuBar.tsx`), the VS Code arrangement.
/// - macOS keeps `titleBarStyle: "Overlay"`: the native traffic lights are
///   painted over the menubar, which leaves room for them.
/// - Windows and Linux drop the native decorations and the menubar draws the
///   app icon and minimize / maximize / close itself. tao keeps edge resizing
///   on both (a hit-test on the undecorated GTK window, X11 and Wayland
///   alike), plus the DWM shadow and the maximized work-area fit on Windows.
///   Linux loses the GTK client-side shadow, which is the price of not
///   carrying a 46px GNOME header bar above the menubar.
fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let config = app
        .config()
        .app
        .windows
        .first()
        .cloned()
        .expect("tauri.conf.json defines the main window");
    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    {
        builder = builder.decorations(false);
    }
    builder.build()?;
    Ok(())
}

/// Minimize / maximize / restore the main window.
///
/// The menubar's window controls (and a double-click on the drag region) call
/// this instead of `window.minimize()` / `window.toggleMaximize()`. On Linux
/// (and macOS, for the drag-region double-click) it simply forwards to the
/// window. On Windows those go
/// through tao's `set_maximized`, which follows `ShowWindow(SW_MAXIMIZE)` with
/// a `SetWindowLong` + `SetWindowPos(SWP_FRAMECHANGED)` style refresh, and on
/// the undecorated window that cuts the DWM grow / shrink animation short, so
/// the window just snaps between sizes. Posting `WM_SYSCOMMAND` is exactly
/// what the native caption buttons send: `DefWindowProc` does the
/// `ShowWindow` itself and nothing else touches the frame, so DWM animates
/// the transition. tao still tracks the result through `WM_SIZE` /
/// `WM_SYSCOMMAND`, so `isMaximized()` stays right.
#[tauri::command]
fn window_control(window: tauri::Window, action: String) -> std::result::Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{
            IsZoomed, PostMessageW, SC_MAXIMIZE, SC_MINIMIZE, SC_RESTORE, WM_SYSCOMMAND,
        };

        let hwnd = window.hwnd().map_err(|e| e.to_string())?.0
            as windows_sys::Win32::Foundation::HWND;
        // SAFETY: `hwnd` is the live handle of a window tauri owns; IsZoomed
        // only reads its state and PostMessageW copies its arguments, so
        // neither cares that the command runs off the window's thread.
        let command = match action.as_str() {
            "minimize" => SC_MINIMIZE,
            "toggle-maximize" => {
                if unsafe { IsZoomed(hwnd) } != 0 {
                    SC_RESTORE
                } else {
                    SC_MAXIMIZE
                }
            }
            other => return Err(format!("unknown window action: {other}")),
        };
        if unsafe { PostMessageW(hwnd, WM_SYSCOMMAND, command as usize, 0) } == 0 {
            return Err(format!("failed to post WM_SYSCOMMAND for {action}"));
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let err = |e: tauri::Error| e.to_string();
        match action.as_str() {
            "minimize" => window.minimize().map_err(err),
            "toggle-maximize" => {
                if window.is_maximized().map_err(err)? {
                    window.unmaximize().map_err(err)
                } else {
                    window.maximize().map_err(err)
                }
            }
            other => Err(format!("unknown window action: {other}")),
        }
    }
}

/// The default macOS menu's Quit item sends `terminate:` straight to
/// NSApplication, so ⌘Q would kill the app without the webview ever seeing
/// it — bypassing the close-requested hook that guards live sessions. Swap
/// it for an ordinary ⌘Q item whose event is forwarded to the frontend,
/// which confirms and then exits the process itself.
#[cfg(target_os = "macos")]
fn install_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, MenuItemKind};
    use tauri::Emitter;

    let handle = app.handle();
    let menu = Menu::default(handle)?;
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        let quit = MenuItem::with_id(
            handle,
            "quit",
            format!("Quit {}", handle.package_info().name),
            true,
            Some("Cmd+Q"),
        )?;
        // The predefined Quit entry is the last item of the app submenu.
        let items = app_menu.items()?;
        if !items.is_empty() {
            app_menu.remove_at(items.len() - 1)?;
        }
        app_menu.append(&quit)?;
    }
    app.set_menu(menu)?;
    app.on_menu_event(|handle, event| {
        if event.id().as_ref() == "quit" {
            let _ = handle.emit("app:quit-requested", ());
        }
    });
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // In portable mode the WebView2 profile must travel with the data
    // directory as well — localStorage holds the frontend preferences.  The
    // WebView2 loader reads this variable and it takes precedence over the
    // user data folder wry passes, so it must be set before the webview is
    // created; an already-set variable is the user's and is left alone.
    #[cfg(target_os = "windows")]
    if std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none() {
        if let Some(dir) = store::portable_data_dir() {
            std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", dir.join("webview"));
        }
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            create_main_window(app)?;
            #[cfg(target_os = "macos")]
            install_menu(app)?;
            // Off the startup path; no watch of this run exists yet.
            std::thread::spawn(remote_edit::clean_leftovers);
            Ok(())
        })
        .manage(AppState {
            sessions: Default::default(),
            store: store::Store::load(),
            remote_edits: Default::default(),
            auth_prompts: Default::default(),
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_profiles,
            commands::save_profile,
            commands::delete_profile,
            commands::list_session_groups,
            commands::save_session_group,
            commands::delete_session_group,
            commands::list_sender_commands,
            commands::save_sender_command,
            commands::delete_sender_command,
            commands::list_command_history,
            commands::record_command,
            commands::clear_command_history,
            commands::export_app_data,
            commands::read_app_data,
            commands::import_app_data,
            commands::open_session,
            commands::accept_host_key,
            commands::answer_auth_prompt,
            commands::close_session,
            commands::list_sessions,
            commands::write_session,
            commands::write_session_binary,
            commands::resize_session,
            commands::zmodem_file_info,
            commands::zmodem_read_chunk,
            commands::zmodem_create_file,
            commands::zmodem_write_chunk,
            commands::zmodem_finish_file,
            commands::sftp_home,
            commands::sftp_list,
            commands::sftp_canonicalize,
            commands::sftp_mkdir,
            commands::sftp_create_file,
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_download,
            commands::sftp_download_directory,
            commands::sftp_upload,
            commands::sftp_upload_directory,
            commands::local_home,
            commands::session_cwd,
            commands::local_hostname,
            commands::local_list,
            commands::local_parent,
            commands::local_is_directory,
            commands::local_mkdir,
            commands::local_create_file,
            commands::local_rename,
            commands::local_remove,
            commands::open_local_path,
            commands::open_with_dialog,
            commands::remote_edit_path,
            commands::watch_remote_edit,
            commands::stop_remote_edits,
            commands::list_serial_ports,
            commands::portable_mode,
            window_control,
        ])
        .build(tauri::generate_context!())
        .expect("error while building EdgeTerm")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                // Copies of remote files opened in local editors have no one
                // to sync them once the app is gone.
                app.state::<AppState>().remote_edits.stop_all(app);
            }
        });
}
