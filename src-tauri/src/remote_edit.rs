//! Remote files opened in a local application. The front end downloads the
//! file to a temp location and launches the application; from then on the
//! local copy is watched through the OS file notification API and uploaded
//! back over the session's SFTP channel as soon as it is saved, so saving in
//! the editor updates the file on the server.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher as _};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::async_runtime::JoinHandle;
use tauri::{ipc::Channel, AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio::time::timeout;

use crate::commands::AppState;
use crate::error::{err, AppError, Result};
use crate::session::transfer::safe_local_child;
use crate::session::{SftpRequest, TransferProgress};

pub const EVENT_REMOTE_EDIT: &str = "remote-edit:state";

/// Marks a leftover copy that still holds changes which never reached the
/// server, so `clean_leftovers` leaves it for the user.
const UNSYNCED_MARKER: &str = ".unsynced";

/// One save produces a burst of notifications (editors truncate, write and
/// rename in steps); the upload starts once the burst has been quiet for
/// this long.
const DEBOUNCE: Duration = Duration::from_millis(300);
/// Pause after a failed upload before the change is tried again; doubles up
/// to `MAX_RETRY_DELAY` while the failures continue.
const RETRY_DELAY: Duration = Duration::from_secs(3);
const MAX_RETRY_DELAY: Duration = Duration::from_secs(60);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEditEvent {
    pub session_id: String,
    pub remote_path: String,
    pub name: String,
    /// `uploading`, `synced`, `error`, or `kept` when the watch ended with
    /// changes still unsent and the local copy was left in place.
    pub status: &'static str,
    pub message: Option<String>,
}

struct Watched {
    local: PathBuf,
    task: JoinHandle<()>,
    /// Set while the copy holds a save that has not reached the server.
    dirty: Arc<AtomicBool>,
    /// Dropping it ends the OS subscription.
    _watcher: RecommendedWatcher,
}

/// Every local copy lives in its own folder under here.
fn edit_root() -> PathBuf {
    std::env::temp_dir().join("EdgeTerm").join("edit")
}

/// Removes the copies a previous run left behind (it quit or crashed while
/// editors still had them open), except those flagged as holding unsent
/// changes. Run once at startup, before any watch of this run exists.
pub fn clean_leftovers() {
    let Ok(entries) = std::fs::read_dir(edit_root()) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        if dir.join(UNSYNCED_MARKER).exists() {
            continue;
        }
        if let Err(error) = std::fs::remove_dir_all(&dir) {
            eprintln!("EdgeTerm: could not remove {}: {error}", dir.display());
        }
    }
}

/// Ends a watch for good. A copy whose every save reached the server is
/// deleted along with its folder; one with unsent changes is kept and
/// flagged, and reported so the user knows where it is.
fn discard(app: &AppHandle, key: &(String, String), watched: Watched) {
    watched.task.abort();
    let Some(dir) = watched.local.parent() else {
        return;
    };
    if watched.dirty.load(Ordering::Relaxed) {
        let _ = std::fs::write(dir.join(UNSYNCED_MARKER), b"");
        let name = watched
            .local
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let _ = app.emit(
            EVENT_REMOTE_EDIT,
            RemoteEditEvent {
                session_id: key.0.clone(),
                remote_path: key.1.clone(),
                name,
                status: "kept",
                message: Some(format!(
                    "changes never reached the server; the local copy is kept at {}",
                    watched.local.display()
                )),
            },
        );
    } else if let Err(error) = std::fs::remove_dir_all(dir) {
        eprintln!("EdgeTerm: could not remove {}: {error}", dir.display());
    }
}

/// Watched files keyed by session id and remote path.
#[derive(Default)]
pub struct RemoteEdits {
    watchers: Mutex<HashMap<(String, String), Watched>>,
}

impl RemoteEdits {
    /// Where the local copy of `remote` lives: the copy already being watched
    /// (so reopening a file lands in the same place), otherwise a fresh
    /// directory under the OS temp folder — one per file, so equal names from
    /// different folders cannot collide.
    ///
    /// An existing watcher is stopped here: the caller is about to download
    /// over the copy, and a watcher running meanwhile could mistake the
    /// half-written download for a save and send it back. `watch` restarts
    /// it once the download is complete.
    pub fn local_path(&self, session_id: &str, remote: &str, name: &str) -> Result<PathBuf> {
        let key = (session_id.to_string(), remote.to_string());
        if let Some(watched) = self.watchers.lock().remove(&key) {
            watched.task.abort();
            return Ok(watched.local);
        }
        let dir = edit_root().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&dir).map_err(err)?;
        safe_local_child(&dir, name)
    }

    /// Starts uploading `local` to `remote` whenever it is saved, replacing
    /// any earlier watcher of the same remote file. The current state of the
    /// local copy is the baseline — it has just been downloaded — so nothing
    /// goes out until the user saves.
    pub fn watch(
        &self,
        app: AppHandle,
        session_id: String,
        local: PathBuf,
        remote: String,
    ) -> Result<()> {
        let dir = local
            .parent()
            .ok_or_else(|| AppError::new(format!("{} has no parent folder", local.display())))?;

        let (tx, rx) = mpsc::unbounded_channel();
        // Every notification from the folder counts, whatever path it names:
        // the folder holds only this file, and the mtime / size check in the
        // loop sorts out the rest (an editor's swap or backup file, the
        // folder itself, a replayed history). Matching the file name here
        // would be fragile — a file system may report it in another case
        // or Unicode normalization than the one it was created with.
        let handler = move |event: notify::Result<Event>| {
            if event.is_ok() {
                let _ = tx.send(());
            }
        };
        let mut watcher =
            RecommendedWatcher::new(handler, notify::Config::default()).map_err(err)?;
        // The folder rather than the file: editors that save by writing a new
        // file and renaming it over the old one replace the inode, and a
        // watch on the old inode would go stale after the first save.
        watcher
            .watch(dir, RecursiveMode::NonRecursive)
            .map_err(err)?;

        let key = (session_id.clone(), remote.clone());
        let dirty = Arc::new(AtomicBool::new(false));
        let task = tauri::async_runtime::spawn(watch_loop(
            app,
            session_id,
            local.clone(),
            remote,
            rx,
            Arc::clone(&dirty),
        ));
        let previous = self.watchers.lock().insert(
            key,
            Watched {
                local,
                task,
                dirty,
                _watcher: watcher,
            },
        );
        if let Some(previous) = previous {
            previous.task.abort();
        }
        Ok(())
    }

    /// Stops every watcher of a session and removes its synced copies. Called
    /// when the tab is closed for good; a plain disconnect keeps them, so a
    /// save made while offline is sent once the tab reconnects (reconnects
    /// reuse the session id).
    pub fn stop_session(&self, app: &AppHandle, session_id: &str) {
        let stopped: Vec<_> = {
            let mut watchers = self.watchers.lock();
            let keys: Vec<_> = watchers
                .keys()
                .filter(|(id, _)| id == session_id)
                .cloned()
                .collect();
            keys.into_iter()
                .filter_map(|key| watchers.remove(&key).map(|watched| (key, watched)))
                .collect()
        };
        for (key, watched) in stopped {
            discard(app, &key, watched);
        }
    }

    /// Stops everything and removes the synced copies; for application exit.
    pub fn stop_all(&self, app: &AppHandle) {
        let stopped: Vec<_> = self.watchers.lock().drain().collect();
        for (key, watched) in stopped {
            discard(app, &key, watched);
        }
    }
}

/// Modification time and size, to tell a save from a notification that
/// changed nothing (an attribute touch, the editor's own re-read). None while
/// the file is missing, which happens for a moment when an editor replaces it.
fn snapshot(path: &Path) -> Option<(SystemTime, u64)> {
    let metadata = std::fs::metadata(path).ok()?;
    Some((metadata.modified().ok()?, metadata.len()))
}

async fn watch_loop(
    app: AppHandle,
    session_id: String,
    local: PathBuf,
    remote: String,
    mut events: mpsc::UnboundedReceiver<()>,
    dirty: Arc<AtomicBool>,
) {
    let name = remote.rsplit('/').next().unwrap_or(&remote).to_string();
    let emit = |status: &'static str, message: Option<String>| {
        let _ = app.emit(
            EVENT_REMOTE_EDIT,
            RemoteEditEvent {
                session_id: session_id.clone(),
                remote_path: remote.clone(),
                name: name.clone(),
                status,
                message,
            },
        );
    };

    let mut baseline = snapshot(&local);
    // While set, the copy holds a save that has not reached the server: it
    // is retried after a pause, or sooner if the file is saved again, and
    // `discard` knows not to delete the copy.
    let unsent = |flag: bool| dirty.store(flag, Ordering::Relaxed);
    let is_unsent = || dirty.load(Ordering::Relaxed);
    let mut retry_delay = RETRY_DELAY;
    // The same failure (typically "session not found" while disconnected) is
    // reported once, not on every retry.
    let mut last_error: Option<String> = None;

    loop {
        // Sleep until the next notification. A None means the watcher was
        // dropped, i.e. this watch has been stopped.
        let notified = if is_unsent() {
            match timeout(retry_delay, events.recv()).await {
                Ok(Some(())) => true,
                Ok(None) => return,
                Err(_) => false,
            }
        } else {
            match events.recv().await {
                Some(()) => true,
                None => return,
            }
        };
        if notified {
            // Let the rest of the save's burst arrive before looking at the file.
            loop {
                match timeout(DEBOUNCE, events.recv()).await {
                    Ok(Some(())) => continue,
                    Ok(None) => return,
                    Err(_) => break,
                }
            }
        }

        let Some(current) = snapshot(&local) else {
            continue;
        };
        if !is_unsent() && Some(current) == baseline {
            continue;
        }
        unsent(true);

        emit("uploading", None);
        let state = app.state::<AppState>();
        let outcome = state
            .sessions
            .sftp(
                &session_id,
                SftpRequest::Upload {
                    local: local.to_string_lossy().into_owned(),
                    remote: remote.clone(),
                    progress: Channel::<TransferProgress>::new(|_| Ok(())),
                },
            )
            .await;
        match outcome {
            Ok(_) => {
                baseline = Some(current);
                unsent(false);
                retry_delay = RETRY_DELAY;
                last_error = None;
                emit("synced", None);
            }
            Err(error) => {
                let message = error.to_string();
                if last_error.as_deref() != Some(message.as_str()) {
                    emit("error", Some(message.clone()));
                    last_error = Some(message);
                }
                retry_delay = (retry_delay * 2).min(MAX_RETRY_DELAY);
            }
        }
    }
}
