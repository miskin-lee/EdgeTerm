mod commands;
mod error;
mod fs_local;
mod model;
mod session;
mod ssh_config;
mod store;

#[cfg(test)]
mod tests;

use commands::AppState;

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
            commands::list_sender_commands,
            commands::save_sender_command,
            commands::delete_sender_command,
            commands::open_session,
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
            commands::ftp_download_directory,
            commands::sftp_upload,
            commands::local_home,
            commands::local_list,
            commands::local_parent,
            commands::local_mkdir,
            commands::local_rename,
            commands::local_remove,
            commands::list_serial_ports,
            commands::list_ssh_config_hosts,
            commands::get_ssh_config,
            commands::resolve_ssh_host,
            commands::import_ssh_config_hosts,
        ])
        .run(tauri::generate_context!())
        .expect("error while running EdgeTerm");
}
