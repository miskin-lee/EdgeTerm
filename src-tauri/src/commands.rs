use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use tauri::{ipc::Channel, AppHandle, State};
use tokio::sync::mpsc;

use crate::error::{err, AppError, Result};
use crate::fs_local;
use crate::model::{
    DirListing, SerialPortDesc, SessionInfo, SessionKind, SessionProfile,
};
use crate::session::{
    self, SessionCommand, SessionHandle, SessionManager, SftpRequest, SftpResponse,
    TransferProgress,
};
use crate::store::Store;

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
pub fn save_profile(
    state: State<'_, AppState>,
    profile: SessionProfile,
) -> Result<SessionProfile> {
    state.store.save(profile)
}

#[tauri::command]
pub fn delete_profile(state: State<'_, AppState>, id: String) -> Result<()> {
    state.store.delete(&id)
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
) -> Result<SessionInfo> {
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

    match profile.kind {
        SessionKind::Local => session::local::spawn(app.clone(), id.clone(), &profile, rx)?,
        SessionKind::Serial => session::serial::spawn(app.clone(), id.clone(), &profile, rx)?,
        SessionKind::Ssh => {
            let conn = session::ssh::connect(&profile).await?;
            session::ssh::spawn(app.clone(), id.clone(), conn, rx);
        }
    }

    state.sessions.insert(SessionHandle {
        info: info.clone(),
        tx,
    });
    Ok(info)
}

#[tauri::command]
pub fn close_session(state: State<'_, AppState>, id: String) -> Result<()> {
    if let Some(handle) = state.sessions.remove(&id) {
        let _ = handle.tx.send(SessionCommand::Close);
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
pub fn write_session_binary(
    state: State<'_, AppState>,
    id: String,
    data: String,
) -> Result<()> {
    let bytes = B64.decode(data).map_err(err)?;
    state.sessions.send(&id, SessionCommand::Write(bytes))
}

#[tauri::command]
pub fn resize_session(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<()> {
    state
        .sessions
        .send(&id, SessionCommand::Resize { cols, rows })
}

// --- remote filesystem ------------------------------------------------------

#[tauri::command]
pub async fn sftp_home(state: State<'_, AppState>, id: String) -> Result<String> {
    expect_path(state.sessions.sftp(&id, SftpRequest::Home).await?)
}

#[tauri::command]
pub async fn sftp_list(
    state: State<'_, AppState>,
    id: String,
    path: String,
) -> Result<DirListing> {
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
    state.sessions.sftp(&id, SftpRequest::Mkdir { path }).await?;
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

// --- local filesystem -------------------------------------------------------

#[tauri::command]
pub fn local_home() -> String {
    fs_local::home()
}

#[tauri::command]
pub fn local_list(path: String) -> Result<DirListing> {
    fs_local::list(&path)
}

#[tauri::command]
pub fn local_parent(path: String) -> String {
    fs_local::parent_of(&path)
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
