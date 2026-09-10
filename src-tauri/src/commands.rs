use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::path::Path;
use std::time::UNIX_EPOCH;
use tauri::{ipc::Channel, AppHandle, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::error::{err, AppError, Result};
use crate::fs_local;
use crate::model::{
    AppData, CommandHistoryEntry, DataSummary, DirListing, LocalCopySummary, OpenSessionOutcome,
    SavedCommand, SerialPortDesc, SessionGroup, SessionInfo, SessionKind, SessionProfile, Theme,
    ZmodemFileInfo, APP_DATA_EXTENSION,
};
use crate::remote_edit::RemoteEdits;
use crate::session::auth::{AuthPrompter, AuthPrompts};
use crate::session::ssh::{ConnectOutcome, SftpConnectOutcome};
use crate::session::transfer::Transfers;
use crate::session::{
    self, SessionCommand, SessionHandle, SessionManager, SftpRequest, SftpResponse,
    TransferProgress,
};
use crate::store::{self, Store};

pub struct AppState {
    pub sessions: SessionManager,
    pub store: Store,
    pub remote_edits: RemoteEdits,
    /// Authentication challenges a connecting session is waiting on; see
    /// `answer_auth_prompt`.
    pub auth_prompts: AuthPrompts,
    /// Transfers in flight, so `cancel_transfer` can reach one.
    pub transfers: Transfers,
}

// --- profiles ---------------------------------------------------------------

#[tauri::command]
pub fn list_profiles(state: State<'_, AppState>) -> Vec<SessionProfile> {
    state.store.list()
}

#[tauri::command]
pub fn save_profile(state: State<'_, AppState>, profile: SessionProfile) -> Result<SessionProfile> {
    state.store.save(profile)
}

/// Deletes a saved session with its credentials and the Sender commands
/// scoped to it.
#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: String) -> Result<()> {
    state.store.delete(&id)
}

// --- session groups ---------------------------------------------------------

#[tauri::command]
pub fn list_session_groups(state: State<'_, AppState>) -> Vec<SessionGroup> {
    state.store.list_groups()
}

#[tauri::command]
pub fn save_session_group(state: State<'_, AppState>, group: SessionGroup) -> Result<SessionGroup> {
    state.store.save_group(group)
}

/// Removes a group with everything in it: nested groups, their sessions
/// (credentials included) and the Sender commands scoped to any of them.
#[tauri::command]
pub fn delete_session_group(state: State<'_, AppState>, id: String) -> Result<()> {
    state.store.delete_group(&id)
}

// --- sender commands -------------------------------------------------------

#[tauri::command]
pub fn list_sender_commands(state: State<'_, AppState>) -> Vec<SavedCommand> {
    state.store.list_sender_commands()
}

#[tauri::command]
pub fn save_sender_command(
    state: State<'_, AppState>,
    command: SavedCommand,
) -> Result<SavedCommand> {
    state.store.save_sender_command(command)
}

#[tauri::command]
pub fn delete_sender_command(state: State<'_, AppState>, id: String) -> Result<()> {
    state.store.delete_sender_command(&id)
}

// --- command history --------------------------------------------------------

#[tauri::command]
pub fn list_command_history(state: State<'_, AppState>) -> Vec<CommandHistoryEntry> {
    state.store.list_command_history()
}

#[tauri::command]
pub fn record_command(state: State<'_, AppState>, command: String, host: String) -> Result<()> {
    state.store.record_command(&command, &host)
}

#[tauri::command]
pub fn clear_command_history(state: State<'_, AppState>) -> Result<()> {
    state.store.clear_command_history()
}

// --- data export / import ---------------------------------------------------

/// Writes saved sessions, their groups, Sender tags and the frontend's
/// settings to `path` as pretty JSON. Passwords and passphrases are never
/// included, so the file needs no special permissions. The path must carry
/// the `.edgeterm` extension (the UI appends it), so every data file is
/// recognisable by name.
#[tauri::command]
pub fn export_app_data(
    state: State<'_, AppState>,
    path: String,
    settings: serde_json::Value,
    exported_at: String,
) -> Result<DataSummary> {
    require_data_file_path(&path)?;
    let mut data = state.store.snapshot();
    data.exported_at = Some(exported_at);
    data.settings = Some(settings);
    std::fs::write(&path, serde_json::to_string_pretty(&data)?)?;
    Ok(DataSummary {
        profiles: data.profiles.len(),
        groups: data.groups.len(),
        sender_commands: data.sender_commands.len(),
        skipped_sender_commands: 0,
    })
}

/// Parses an EdgeTerm data file so the UI can show what an import would
/// bring in before anything is merged: the name must end in `.edgeterm`, the
/// contents must be JSON with the EdgeTerm marker and a known layout
/// version. Credentials in the file are dropped here so they never reach
/// the webview.
#[tauri::command]
pub fn read_app_data(path: String) -> Result<AppData> {
    require_data_file_path(&path)?;
    let raw = std::fs::read_to_string(&path)?;
    let mut data: AppData = serde_json::from_str(&raw)
        .map_err(|error| AppError::new(format!("not an EdgeTerm data file: {error}")))?;
    store::validate_app_data(&data)?;
    data.profiles = data
        .profiles
        .into_iter()
        .map(store::redact_profile)
        .collect();
    Ok(data)
}

fn require_data_file_path(path: &str) -> Result<()> {
    if store::is_data_file_path(Path::new(path)) {
        Ok(())
    } else {
        Err(AppError::new(format!(
            "not an EdgeTerm data file: expected a .{APP_DATA_EXTENSION} file"
        )))
    }
}

/// Merges a file returned by `read_app_data` into the store; see
/// `Store::import_data` for the rules. The frontend applies `settings` itself.
#[tauri::command]
pub fn import_app_data(state: State<'_, AppState>, data: AppData) -> Result<DataSummary> {
    state.store.import_data(data)
}

// --- sessions ---------------------------------------------------------------

#[tauri::command]
pub async fn open_session(
    app: AppHandle,
    state: State<'_, AppState>,
    profile: SessionProfile,
    // The frontend mints the id so it can have a terminal listening before the
    // first byte of output arrives.
    session_id: String,
) -> Result<OpenSessionOutcome> {
    // A profile may arrive by id (from the tree) or inline (quick connect).
    let profile = if !profile.id.is_empty() {
        match state.store.get(&profile.id)? {
            // Prefer a secret supplied by the dialog over the saved credential.
            Some(saved) => merge_secrets(saved, profile),
            None => profile,
        }
    } else {
        profile
    };

    let id = if session_id.is_empty() {
        uuid::Uuid::new_v4().to_string()
    } else {
        session_id
    };
    let (tx, rx) = mpsc::unbounded_channel();
    let info = session::make_info(&id, &profile);

    let owner_thread = match profile.kind {
        SessionKind::Ftp => {
            let connect_profile = profile.clone();
            let conn = tokio::task::spawn_blocking(move || session::ftp::connect(&connect_profile))
                .await
                .map_err(|e| AppError::new(format!("ftp connection task failed: {e}")))??;
            session::ftp::spawn(app.clone(), id.clone(), conn, rx)?;
            None
        }
        SessionKind::Local => {
            session::local::spawn(app.clone(), id.clone(), &profile, rx)?;
            None
        }
        SessionKind::Serial => Some(session::serial::spawn(
            app.clone(),
            id.clone(),
            &profile,
            rx,
        )?),
        SessionKind::Ssh => {
            let prompter = AuthPrompter::ui(&app, &state.auth_prompts, &id);
            match session::ssh::connect(&profile, &state.store.jump_chain(&profile)?, &prompter)
                .await?
            {
                ConnectOutcome::Ready(conn) => {
                    session::ssh::spawn(app.clone(), id.clone(), conn, rx);
                    None
                }
                // Nothing was opened; the user decides whether to trust the new
                // key and the frontend retries with the same session id.
                ConnectOutcome::HostKeyChanged(change) => {
                    return Ok(OpenSessionOutcome::HostKeyChanged { change });
                }
            }
        }
        SessionKind::Sftp => {
            let prompter = AuthPrompter::ui(&app, &state.auth_prompts, &id);
            match session::ssh::connect_sftp(
                &profile,
                &state.store.jump_chain(&profile)?,
                &prompter,
            )
            .await?
            {
                SftpConnectOutcome::Ready(conn) => {
                    session::ssh::spawn_sftp(app.clone(), id.clone(), conn, rx);
                    None
                }
                // Same host-key decision as a shell session on the same transport.
                SftpConnectOutcome::HostKeyChanged(change) => {
                    return Ok(OpenSessionOutcome::HostKeyChanged { change });
                }
            }
        }
    };

    state.sessions.insert(SessionHandle {
        info: info.clone(),
        tx,
        encoding: session::encoding::terminal_encoding(&profile),
        owner_thread,
    });
    Ok(OpenSessionOutcome::Connected { info })
}

/// Record the key a host now presents, replacing every `known_hosts` entry
/// the file held for it, after the user accepted a reported `HostKeyChange`.
#[tauri::command]
pub fn accept_host_key(host: String, port: u16, public_key: String) -> Result<()> {
    session::ssh::accept_host_key(&host, port, &public_key)
}

/// Answers one round of an SSH server's keyboard-interactive challenge (an
/// MFA code, a push confirmation, a menu choice) for the connection waiting
/// on `id`. `responses` is `None` when the user cancelled. The answers are
/// used once and never stored.
#[tauri::command]
pub fn answer_auth_prompt(
    state: State<'_, AppState>,
    id: String,
    responses: Option<Vec<String>>,
) -> Result<()> {
    state.auth_prompts.answer(&id, responses)
}

#[tauri::command]
pub fn close_session(state: State<'_, AppState>, id: String) -> Result<()> {
    if let Some(handle) = state.sessions.remove(&id) {
        let _ = handle.tx.send(SessionCommand::Close);
        if let Some(owner_thread) = handle.owner_thread {
            owner_thread.join().map_err(|_| {
                AppError::new(format!("serial session {id} panicked while closing"))
            })?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Vec<SessionInfo> {
    state.sessions.list()
}

/// Keyboard and paste input, which xterm.js hands us as a UTF-8 string; it
/// goes out in the session's own encoding.
#[tauri::command]
pub fn write_session(state: State<'_, AppState>, id: String, data: String) -> Result<()> {
    state.sessions.write_text(&id, &data)
}

/// Raw bytes, base64-encoded. Used by the Sender pane's hex mode.
#[tauri::command]
pub async fn write_session_binary(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<()> {
    let bytes = B64.decode(data).map_err(err)?;
    state.sessions.write_confirmed(&id, bytes).await
}

#[tauri::command]
pub fn resize_session(state: State<'_, AppState>, id: String, cols: u16, rows: u16) -> Result<()> {
    state
        .sessions
        .send(&id, SessionCommand::Resize { cols, rows })
}

// --- local file streaming for ZMODEM / XMODEM -------------------------------

/// Keep file IPC bounded. zmodem.js further divides outgoing data into 8 KiB
/// protocol subpackets and XMODEM into 128 / 1024-byte blocks, while this
/// larger application-level chunk keeps the number of disk and IPC round
/// trips reasonable. The frontend shares these commands between the two
/// protocols (terminalTransfer.ts).
const ZMODEM_FILE_CHUNK_SIZE: usize = 1024 * 1024;

#[tauri::command]
pub async fn zmodem_file_info(path: String) -> Result<ZmodemFileInfo> {
    let metadata = tokio::fs::metadata(&path).await?;
    if !metadata.is_file() {
        return Err(AppError::new(format!("not a regular file: {path}")));
    }

    let name = Path::new(&path)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .ok_or_else(|| AppError::new(format!("file has no usable name: {path}")))?
        .to_string();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs());

    Ok(ZmodemFileInfo {
        name,
        size: metadata.len(),
        modified,
    })
}

#[tauri::command]
pub async fn zmodem_read_chunk(path: String, offset: u64, length: u32) -> Result<String> {
    let length = length as usize;
    if length == 0 || length > ZMODEM_FILE_CHUNK_SIZE {
        return Err(AppError::new(format!(
            "ZMODEM read length must be between 1 and {ZMODEM_FILE_CHUNK_SIZE} bytes"
        )));
    }

    let mut file = tokio::fs::File::open(path).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    let mut bytes = Vec::with_capacity(length);
    file.take(length as u64).read_to_end(&mut bytes).await?;
    Ok(B64.encode(bytes))
}

#[tauri::command]
pub async fn zmodem_create_file(path: String) -> Result<()> {
    let file = tokio::fs::File::create(path).await?;
    file.sync_all().await?;
    Ok(())
}

#[tauri::command]
pub async fn zmodem_write_chunk(path: String, offset: u64, data: String) -> Result<()> {
    let bytes = B64.decode(data).map_err(err)?;
    if bytes.len() > ZMODEM_FILE_CHUNK_SIZE {
        return Err(AppError::new(format!(
            "ZMODEM write chunk exceeds {ZMODEM_FILE_CHUNK_SIZE} bytes"
        )));
    }

    let mut file = tokio::fs::OpenOptions::new().write(true).open(path).await?;
    file.seek(std::io::SeekFrom::Start(offset)).await?;
    file.write_all(&bytes).await?;
    Ok(())
}

#[tauri::command]
pub async fn zmodem_finish_file(path: String, size: u64) -> Result<()> {
    let file = tokio::fs::OpenOptions::new().write(true).open(path).await?;
    file.set_len(size).await?;
    file.sync_all().await?;
    Ok(())
}

// --- remote filesystem ------------------------------------------------------

#[tauri::command]
pub async fn sftp_home(state: State<'_, AppState>, id: String) -> Result<String> {
    expect_path(state.sessions.sftp(&id, SftpRequest::Home).await?)
}

#[tauri::command]
pub async fn sftp_list(state: State<'_, AppState>, id: String, path: String) -> Result<DirListing> {
    expect_listing(state.sessions.sftp(&id, SftpRequest::List { path }).await?)
}

/// Resolves `..`, symlinks and relative paths on the remote host.
#[tauri::command]
pub async fn sftp_canonicalize(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<String> {
    expect_path(
        state
            .sessions
            .sftp(&id, SftpRequest::Canonicalize { path })
            .await?,
    )
}

#[tauri::command]
pub async fn sftp_mkdir(state: State<'_, AppState>, id: String, path: String) -> Result<()> {
    state
        .sessions
        .sftp(&id, SftpRequest::Mkdir { path })
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_create_file(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<()> {
    state
        .sessions
        .sftp(&id, SftpRequest::CreateFile { path })
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_remove(
    state: State<'_, AppState>,
    id: String,
    path: String,
    is_dir: bool,
) -> Result<()> {
    state
        .sessions
        .sftp(&id, SftpRequest::Remove { path, is_dir })
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_rename(
    state: State<'_, AppState>,
    id: String,
    from: String,
    to: String,
) -> Result<()> {
    state
        .sessions
        .sftp(&id, SftpRequest::Rename { from, to })
        .await?;
    Ok(())
}

/// `transfer`, on this and the three transfers below, is the id
/// `cancel_transfer` can name while the copy runs; without one the transfer
/// cannot be cancelled.
#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    local: String,
    on_progress: Channel<TransferProgress>,
    transfer: Option<String>,
) -> Result<()> {
    let active = state.transfers.begin(transfer);
    state
        .sessions
        .sftp(
            &id,
            SftpRequest::Download {
                remote,
                local,
                progress: on_progress,
                cancel: active.flag(),
            },
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_download_directory(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    local: String,
    on_progress: Channel<TransferProgress>,
    transfer: Option<String>,
) -> Result<()> {
    let active = state.transfers.begin(transfer);
    state
        .sessions
        .sftp(
            &id,
            SftpRequest::DownloadDirectory {
                remote,
                local,
                progress: on_progress,
                cancel: active.flag(),
            },
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    id: String,
    local: String,
    remote: String,
    on_progress: Channel<TransferProgress>,
    transfer: Option<String>,
) -> Result<()> {
    let active = state.transfers.begin(transfer);
    state
        .sessions
        .sftp(
            &id,
            SftpRequest::Upload {
                local,
                remote,
                progress: on_progress,
                cancel: active.flag(),
            },
        )
        .await?;
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload_directory(
    state: State<'_, AppState>,
    id: String,
    local: String,
    remote: String,
    on_progress: Channel<TransferProgress>,
    transfer: Option<String>,
) -> Result<()> {
    let active = state.transfers.begin(transfer);
    state
        .sessions
        .sftp(
            &id,
            SftpRequest::UploadDirectory {
                local,
                remote,
                progress: on_progress,
                cancel: active.flag(),
            },
        )
        .await?;
    Ok(())
}

/// Stops the transfer the front end registered as `transfer`, if it is still
/// running: the copy ends within a chunk and takes its half-written file
/// with it (see `CancelFlag`).
#[tauri::command]
pub fn cancel_transfer(state: State<'_, AppState>, transfer: String) {
    state.transfers.cancel(&transfer);
}

// --- local filesystem -------------------------------------------------------

#[tauri::command]
pub fn local_home() -> String {
    fs_local::home()
}

/// Where the session's shell is right now, for the Filer's "Reveal Working
/// Directory" action; see `session::cwd`.
#[tauri::command]
pub async fn session_cwd(state: State<'_, AppState>, id: String) -> Result<String> {
    state.sessions.query_cwd(&id).await
}

/// This machine's host name, so the frontend can tell a local shell's OSC 7
/// directory report from one a remote shell sent through a hand-typed ssh.
#[tauri::command]
pub fn local_hostname() -> String {
    session::cwd::local_hostname()
}

#[tauri::command]
pub async fn local_list(path: String) -> Result<DirListing> {
    tokio::task::spawn_blocking(move || fs_local::list(&path))
        .await
        .map_err(|error| AppError::new(format!("local listing task failed: {error}")))?
}

#[tauri::command]
pub fn local_parent(path: String) -> String {
    fs_local::parent_of(&path)
}

#[tauri::command]
pub fn local_mkdir(path: String) -> Result<()> {
    fs_local::mkdir(&path)
}

#[tauri::command]
pub fn local_create_file(path: String) -> Result<()> {
    fs_local::create_file(&path)
}

#[tauri::command]
pub fn local_is_directory(path: String) -> bool {
    fs_local::is_directory(&path)
}

/// Opens a local file with the system default application, or with `with`
/// (a macOS `.app` bundle, a Windows executable or a Unix program path) when
/// given. Errors only cover launching; whatever the program does afterwards is
/// its own business.
#[tauri::command]
pub fn open_local_path(path: String, with: Option<String>) -> Result<()> {
    tauri_plugin_opener::open_path(&path, with.as_deref()).map_err(err)
}

/// Remembers the theme the front end is showing, so the next launch creates
/// its window in the matching background colour (`store::save_startup_theme`).
#[tauri::command]
pub fn set_startup_theme(theme: Theme) -> Result<()> {
    store::save_startup_theme(theme)
}

/// Reveals the main window, which is created hidden so that the first thing
/// on screen is the painted interface rather than an empty frame. Called by
/// the front end as soon as it has painted; `create_main_window` shows the
/// window anyway if that call never comes.
#[tauri::command]
pub fn show_main_window(window: tauri::WebviewWindow) -> Result<()> {
    window.show().map_err(err)?;
    // The window was hidden while the application started, so on Windows it
    // would otherwise appear behind whatever the user looked at meanwhile.
    let _ = window.set_focus();
    Ok(())
}

/// The clipboard's text, read by the process rather than the page. The page
/// reads its own clipboard (`navigator.clipboard.readText`), and the window is
/// created with `enable_clipboard_access` so WebView2 grants that; but a
/// WebView2 profile that refused the permission prompt before the app granted
/// it keeps refusing (the refusal is stored per origin and the prompt is not
/// raised again), so on Windows the front end falls back to this (#45). Empty
/// when the clipboard holds no text, as the page's read is.
#[tauri::command]
pub fn read_clipboard_text() -> Result<String> {
    #[cfg(windows)]
    {
        if !clipboard_win::is_format_avail(clipboard_win::formats::CF_UNICODETEXT) {
            return Ok(String::new());
        }
        clipboard_win::get_clipboard_string().map_err(err)
    }
    #[cfg(not(windows))]
    {
        Err("the page reads the clipboard on this platform".into())
    }
}

/// Whether this copy runs in portable mode (a `data` directory next to the
/// executable holds all configuration). The updater must not run the NSIS
/// installer then; the front end opens the release page instead.
#[tauri::command]
pub fn portable_mode() -> bool {
    crate::store::portable_data_dir().is_some()
}

/// Shows the Windows "Open with" chooser for a local file. Other platforms
/// have no system-wide chooser; the front end picks an application itself.
#[tauri::command]
pub fn open_with_dialog(path: String) -> Result<()> {
    #[cfg(windows)]
    {
        // The shell's classic entry point behind Explorer's "Open with…".
        std::process::Command::new("rundll32.exe")
            .arg("shell32.dll,OpenAs_RunDLL")
            .arg(&path)
            .spawn()
            .map_err(err)?;
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = path;
        Err(AppError::new(
            "the system \"Open with\" dialog is only available on Windows",
        ))
    }
}

/// Where a remote file opened in a local application is downloaded to; the
/// same place again while the file is still being watched. See
/// `remote_edit::RemoteEdits::local_path`.
#[tauri::command]
pub fn remote_edit_path(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    name: String,
) -> Result<String> {
    let path = state.remote_edits.local_path(&id, &remote, &name)?;
    Ok(path.to_string_lossy().into_owned())
}

/// Starts sending `local` back to `remote` on session `id` whenever it
/// changes. Called right after the download, so the copy is the baseline.
#[tauri::command]
pub fn watch_remote_edit(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    local: String,
    remote: String,
) -> Result<()> {
    state
        .remote_edits
        .watch(app, id, std::path::PathBuf::from(local), remote)
}

/// Stops watching every file opened from session `id` and removes the synced
/// copies; for when its tab is closed for good (a disconnect keeps the
/// watchers, see `RemoteEdits`).
#[tauri::command]
pub fn stop_remote_edits(app: AppHandle, state: State<'_, AppState>, id: String) {
    state.remote_edits.stop_session(&app, &id);
}

// --- dragging files out of the window ---------------------------------------

/// What became of a drag started by `start_file_drag`, reported once the
/// pointer is released so the Filer can drop its dragging state.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDragOutcome {
    /// True when the file was handed to a drop target, false when the drag
    /// was cancelled or never started.
    pub dropped: bool,
    /// Set when the drag could not be started at all.
    pub error: Option<String>,
}

/// Where a remote entry is downloaded to before `start_file_drag` hands it to
/// the system; see `fs_local::drag_staging_path`.
#[tauri::command]
pub fn drag_staging_path(name: String) -> Result<String> {
    Ok(fs_local::drag_staging_path(&name)?
        .to_string_lossy()
        .into_owned())
}

/// The drag preview, the same 32×32 icon the bundle installs.
const DRAG_PREVIEW_ICON: &[u8] = include_bytes!("../icons/32x32.png");

/// Starts a system drag carrying `paths`, so an entry shown in the Filer can
/// be dropped on the desktop or in a file manager (a remote one after it has
/// been staged locally). The pointer must still be down: the drag session
/// attaches to the gesture the user is already making.
///
/// The drag is handed to the main thread rather than started here, because
/// that is the only thread AppKit and GTK accept one from, and a command is
/// not promised to run on it. Nothing waits for it either: Windows runs the
/// whole drag inside `DoDragDrop` before the closure returns, so the outcome
/// only ever arrives through `on_event`.
#[tauri::command]
pub fn start_file_drag(
    window: tauri::WebviewWindow,
    paths: Vec<String>,
    on_event: Channel<FileDragOutcome>,
) -> Result<()> {
    if paths.is_empty() {
        return Err(AppError::new("nothing to drag"));
    }
    let files: Vec<std::path::PathBuf> = paths.into_iter().map(Into::into).collect();
    let target = window.clone();
    // `DragItem` holds a boxed provider in its other variant and so is not
    // `Send`; only the paths cross to the main thread.
    window
        .run_on_main_thread(move || {
            let failed = |error: String| {
                let _ = on_event.send(FileDragOutcome {
                    dropped: false,
                    error: Some(error),
                });
            };
            let finished = {
                let on_event = on_event.clone();
                move |result: drag::DragResult, _position: drag::CursorPosition| {
                    let _ = on_event.send(FileDragOutcome {
                        dropped: matches!(result, drag::DragResult::Dropped),
                        error: None,
                    });
                }
            };
            #[cfg(target_os = "linux")]
            let handle = match target.gtk_window() {
                Ok(handle) => handle,
                Err(error) => return failed(error.to_string()),
            };
            #[cfg(not(target_os = "linux"))]
            let handle = target;
            let outcome = drag::start_drag(
                &handle,
                drag::DragItem::Files(files),
                // The application icon stands in for the file: the platforms
                // want a preview image and EdgeTerm ships no other bitmap the
                // size of a cursor.
                drag::Image::Raw(DRAG_PREVIEW_ICON.to_vec()),
                finished,
                drag::Options::default(),
            );
            if let Err(error) = outcome {
                failed(error.to_string());
            }
        })
        .map_err(err)
}

/// Copies a dropped file or folder into the folder the Filer is showing, for
/// a drop on a Filer that has no remote session to upload to. Runs off the
/// async runtime: the walk and the copies are blocking file system work.
#[tauri::command]
pub async fn local_copy_into(
    source: String,
    destination: String,
    on_progress: Channel<TransferProgress>,
) -> Result<LocalCopySummary> {
    tokio::task::spawn_blocking(move || fs_local::copy_into(&source, &destination, &on_progress))
        .await
        .map_err(err)?
}

#[tauri::command]
pub fn local_rename(from: String, to: String) -> Result<()> {
    fs_local::rename(&from, &to)
}

#[tauri::command]
pub fn local_remove(path: String, is_dir: bool) -> Result<()> {
    fs_local::remove(&path, is_dir)
}

// --- serial -----------------------------------------------------------------

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<SerialPortDesc>> {
    session::serial::list_ports()
}

// --- helpers ----------------------------------------------------------------

fn merge_secrets(mut saved: SessionProfile, incoming: SessionProfile) -> SessionProfile {
    if incoming.password.is_some() {
        saved.password = incoming.password;
    }
    if incoming.passphrase.is_some() {
        saved.passphrase = incoming.passphrase;
    }
    saved
}

fn expect_listing(response: SftpResponse) -> Result<DirListing> {
    match response {
        SftpResponse::Listing(listing) => Ok(listing),
        _ => Err(AppError::new("unexpected sftp response")),
    }
}

fn expect_path(response: SftpResponse) -> Result<String> {
    match response {
        SftpResponse::Path(path) => Ok(path),
        _ => Err(AppError::new("unexpected sftp response")),
    }
}
