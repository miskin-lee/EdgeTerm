use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use std::path::Path;
use std::time::UNIX_EPOCH;
use tauri::{ipc::Channel, AppHandle, State};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::mpsc;

use crate::error::{err, AppError, Result};
use crate::fs_local;
use crate::model::{
    AppData, CommandHistoryEntry, DataSummary, DirListing, OpenSessionOutcome, SavedCommand,
    SerialPortDesc, SessionGroup, SessionInfo, SessionKind, SessionProfile, ZmodemFileInfo,
    APP_DATA_EXTENSION,
};
use crate::session::ssh::ConnectOutcome;
use crate::session::{
    self, SessionCommand, SessionHandle, SessionManager, SftpRequest, SftpResponse,
    TransferProgress,
};
use crate::store::{self, Store};

pub struct AppState {
    pub sessions: SessionManager,
    pub store: Store,
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
        SessionKind::Ssh => match session::ssh::connect(&profile).await? {
            ConnectOutcome::Ready(conn) => {
                session::ssh::spawn(app.clone(), id.clone(), conn, rx);
                None
            }
            // Nothing was opened; the user decides whether to trust the new
            // key and the frontend retries with the same session id.
            ConnectOutcome::HostKeyChanged(change) => {
                return Ok(OpenSessionOutcome::HostKeyChanged { change });
            }
        },
    };

    state.sessions.insert(SessionHandle {
        info: info.clone(),
        tx,
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

/// Keyboard and paste input, which xterm.js hands us as a UTF-8 string.
#[tauri::command]
pub fn write_session(state: State<'_, AppState>, id: String, data: String) -> Result<()> {
    state
        .sessions
        .send(&id, SessionCommand::Write(data.into_bytes()))
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

// --- ZMODEM local file streaming -------------------------------------------

/// Keep file IPC bounded. zmodem.js further divides outgoing data into 8 KiB
/// protocol subpackets, while this larger application-level chunk keeps the
/// number of disk and IPC round trips reasonable.
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

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    id: String,
    remote: String,
    local: String,
    on_progress: Channel<TransferProgress>,
) -> Result<()> {
    state
        .sessions
        .sftp(
            &id,
            SftpRequest::Download {
                remote,
                local,
                progress: on_progress,
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
) -> Result<()> {
    state
        .sessions
        .sftp(
            &id,
            SftpRequest::DownloadDirectory {
                remote,
                local,
                progress: on_progress,
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
) -> Result<()> {
    state
        .sessions
        .sftp(
            &id,
            SftpRequest::Upload {
                local,
                remote,
                progress: on_progress,
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
) -> Result<()> {
    state
        .sessions
        .sftp(
            &id,
            SftpRequest::UploadDirectory {
                local,
                remote,
                progress: on_progress,
            },
        )
        .await?;
    Ok(())
}

// --- local filesystem -------------------------------------------------------

#[tauri::command]
pub fn local_home() -> String {
    fs_local::home()
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
pub fn local_is_directory(path: String) -> bool {
    fs_local::is_directory(&path)
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
