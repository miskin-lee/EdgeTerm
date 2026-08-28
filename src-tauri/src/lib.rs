mod commands;
mod error;
mod fs_local;
mod model;
mod session;
mod store;

#[cfg(test)]
mod tests;

use commands::AppState;

/// Build the main window from `tauri.conf.json` (`create: false` there keeps
/// Tauri from creating it first).
///
/// `titleBarStyle: "Overlay"` only exists on macOS, so on Windows the native
/// title bar would still sit above the menubar. Drop the decorations there and
/// let the menubar draw the window controls itself (see `MenuBar.tsx`); tao
/// keeps edge resizing, the DWM shadow and the maximized work-area fit for
/// undecorated windows. Linux keeps the native frame: undecorated windows
/// behave too differently across window managers.
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
    #[cfg(target_os = "windows")]
    {
        builder = builder.decorations(false);
    }
    builder.build()?;
    Ok(())
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
            Ok(())
        })
        .manage(AppState {
            sessions: Default::default(),
            store: store::Store::load(),
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
            commands::sftp_remove,
            commands::sftp_rename,
            commands::sftp_download,
            commands::sftp_download_directory,
            commands::sftp_upload,
            commands::sftp_upload_directory,
            commands::local_home,
            commands::local_list,
            commands::local_parent,
            commands::local_is_directory,
            commands::local_mkdir,
            commands::local_rename,
            commands::local_remove,
            commands::list_serial_ports,
        ])
        .run(tauri::generate_context!())
        .expect("error while running EdgeTerm");
}
