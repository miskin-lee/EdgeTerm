pub mod ftp;
pub mod local;
pub mod serial;
pub mod ssh;

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{ipc::Channel, AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot};

use crate::error::{AppError, Result};
use crate::model::{DirListing, FileEntry, SessionInfo, SessionKind, SessionProfile};

pub const EVENT_OUTPUT: &str = "session:output";
pub const EVENT_STATE: &str = "session:state";

pub enum SftpRequest {
    Home,
    List {
        path: String,
    },
    Canonicalize {
        path: String,
    },
    Mkdir {
        path: String,
    },
    Remove {
        path: String,
        is_dir: bool,
    },
    Rename {
        from: String,
        to: String,
    },
    Download {
        remote: String,
        local: String,
        progress: Channel<TransferProgress>,
    },
    DownloadDirectory {
        remote: String,
        local: String,
        progress: Channel<TransferProgress>,
    },
    Upload {
        local: String,
        remote: String,
        progress: Channel<TransferProgress>,
    },
}

#[derive(Debug)]
pub enum SftpResponse {
    Listing(DirListing),
    Path(String),
    Done,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferProgress {
    pub transferred: u64,
    pub total: u64,
}

pub enum SessionCommand {
    Write(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
    },
    Sftp {
        request: SftpRequest,
        reply: oneshot::Sender<Result<SftpResponse>>,
    },
    Close,
}

pub struct SessionHandle {
    pub info: SessionInfo,
    pub tx: mpsc::UnboundedSender<SessionCommand>,
    /// Serial sessions use a blocking owner thread. Joining it during close
    /// guarantees that the OS device handle is gone before the command returns.
    pub owner_thread: Option<std::thread::JoinHandle<()>>,
}

#[derive(Default)]
pub struct SessionManager {
    sessions: Mutex<HashMap<String, SessionHandle>>,
}

impl SessionManager {
    pub fn insert(&self, handle: SessionHandle) {
        self.sessions.lock().insert(handle.info.id.clone(), handle);
    }

    pub fn remove(&self, id: &str) -> Option<SessionHandle> {
        self.sessions.lock().remove(id)
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .values()
            .map(|h| h.info.clone())
            .collect()
    }

    pub fn send(&self, id: &str, cmd: SessionCommand) -> Result<()> {
        let guard = self.sessions.lock();
        let handle = guard
            .get(id)
            .ok_or_else(|| AppError::new(format!("session {id} is not open")))?;
        handle
            .tx
            .send(cmd)
            .map_err(|_| AppError::new(format!("session {id} has terminated")))
    }

    /// Round-trips an SFTP request through the owning session task.
    pub async fn sftp(&self, id: &str, request: SftpRequest) -> Result<SftpResponse> {
        let (reply, rx) = oneshot::channel();
        self.send(id, SessionCommand::Sftp { request, reply })?;
        rx.await
            .map_err(|_| AppError::new("session closed before the request completed"))?
    }
}

// --- events -----------------------------------------------------------------

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OutputEvent {
    id: String,
    /// base64 so that multi-byte UTF-8 sequences split across reads survive the
    /// trip intact; the frontend feeds the raw bytes straight into xterm.js.
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StateEvent {
    id: String,
    state: String,
    message: Option<String>,
}

pub fn emit_output(app: &AppHandle, id: &str, bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    let _ = app.emit(
        EVENT_OUTPUT,
        OutputEvent {
            id: id.to_string(),
            data: B64.encode(bytes),
        },
    );
}

pub fn emit_state(app: &AppHandle, id: &str, state: &str, message: Option<String>) {
    let _ = app.emit(
        EVENT_STATE,
        StateEvent {
            id: id.to_string(),
            state: state.to_string(),
            message,
        },
    );
}

/// Coalesces small writes so a flood of output does not turn into a flood of
/// IPC messages. Callers must `flush` whenever their read loop goes idle.
pub struct OutputPump {
    app: AppHandle,
    id: String,
    buf: Vec<u8>,
}

impl OutputPump {
    const MAX: usize = 64 * 1024;

    pub fn new(app: AppHandle, id: String) -> Self {
        Self {
            app,
            id,
            buf: Vec::with_capacity(8192),
        }
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buf.extend_from_slice(bytes);
        if self.buf.len() >= Self::MAX {
            self.flush();
        }
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn flush(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        emit_output(&self.app, &self.id, &self.buf);
        self.buf.clear();
    }
}

// --- helpers shared by the backends ----------------------------------------

pub fn reject_sftp(cmd: SessionCommand, kind: SessionKind) {
    if let SessionCommand::Sftp { reply, .. } = cmd {
        let _ = reply.send(Err(AppError::new(format!(
            "{:?} sessions have no remote filesystem",
            kind
        ))));
    }
}

/// Normalises a possibly-relative remote path into an absolute one.
pub fn join_remote(base: &str, name: &str) -> String {
    if name.starts_with('/') {
        return name.to_string();
    }
    if base.is_empty() || base == "/" {
        format!("/{name}")
    } else if base.ends_with('/') {
        format!("{base}{name}")
    } else {
        format!("{base}/{name}")
    }
}

pub fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
}

pub fn make_info(id: &str, profile: &SessionProfile) -> SessionInfo {
    SessionInfo {
        id: id.to_string(),
        profile_id: if profile.id.is_empty() {
            None
        } else {
            Some(profile.id.clone())
        },
        name: profile.name.clone(),
        kind: profile.kind,
        protocol: profile.protocol().to_string(),
        address: profile.address(),
        color: profile.color.clone(),
        supports_remote_files: matches!(profile.kind, SessionKind::Ssh | SessionKind::Ftp),
    }
}
