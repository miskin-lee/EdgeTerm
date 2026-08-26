use std::collections::HashMap;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::model::{AuthKind, CommandHistoryEntry, SavedCommand, SessionKind, SessionProfile};

const MAX_SAVED_COMMANDS: usize = 1000;
const MAX_COMMAND_HISTORY: usize = 5000;
const MAX_HISTORY_COMMAND_LEN: usize = 500;

/// Secrets are kept separately from the public session profiles.  This avoids
/// returning them to the webview while still allowing a saved session to be
/// reopened after an application restart without asking the OS credential
/// store for permission.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredSecrets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    passphrase: Option<String>,
}

/// Session profiles, remembered SSH/FTP credentials, and Sender commands persisted
/// in the application config directory.
///
/// `sessions.json` never contains credentials and is safe to return to the UI.
/// `credentials.json` is readable only by the current OS user and is consulted
/// solely while opening a saved session.  Keeping credentials app-local avoids
/// the macOS Keychain authorization dialog that otherwise reappears when an
/// unsigned development build changes identity between restarts.
/// `sender_commands.json` keeps reusable Sender tags across restarts and upgrades.
/// `command_history.json` remembers executed commands for inline suggestions;
/// like credentials it may contain sensitive text, so it is owner-only too.
pub struct Store {
    path: PathBuf,
    credentials_path: PathBuf,
    sender_commands_path: PathBuf,
    command_history_path: PathBuf,
    profiles: Mutex<Vec<SessionProfile>>,
    credentials: Mutex<HashMap<String, StoredSecrets>>,
    sender_commands: Mutex<Vec<SavedCommand>>,
    command_history: Mutex<Vec<CommandHistoryEntry>>,
}

impl Store {
    pub fn load() -> Self {
        Self::load_from(config_path())
    }

    pub fn load_from(path: PathBuf) -> Self {
        let mut profiles: Vec<SessionProfile> = read_json(&path).unwrap_or_default();
        // Older files may have contained credentials. Move them into the
        // private credential map when loading, then keep the UI copy redacted.
        let mut credentials: HashMap<String, StoredSecrets> =
            read_json(&credentials_path_for(&path)).unwrap_or_default();
        let sender_commands_path = sender_commands_path_for(&path);
        let sender_commands = read_json(&sender_commands_path).unwrap_or_default();
        let command_history_path = command_history_path_for(&path);
        let command_history = read_json(&command_history_path).unwrap_or_default();
        let mut imported_legacy_credentials = false;
        for profile in &mut profiles {
            if profile.password.is_some() || profile.passphrase.is_some() {
                credentials.insert(
                    profile.id.clone(),
                    StoredSecrets {
                        password: profile.password.take(),
                        passphrase: profile.passphrase.take(),
                    },
                );
                imported_legacy_credentials = true;
            }
            profile.password = None;
            profile.passphrase = None;
        }

        let store = Store {
            credentials_path: credentials_path_for(&path),
            sender_commands_path,
            command_history_path,
            path,
            profiles: Mutex::new(profiles),
            credentials: Mutex::new(credentials),
            sender_commands: Mutex::new(sender_commands),
            command_history: Mutex::new(command_history),
        };
        if imported_legacy_credentials {
            // Best effort migration. A later explicit save will surface any
            // filesystem error to the caller.
            let _ = store.persist();
        }
        store
    }

    pub fn list(&self) -> Vec<SessionProfile> {
        self.profiles.lock().clone()
    }

    pub fn get(&self, id: &str) -> Result<Option<SessionProfile>> {
        let profile = self.profiles.lock().iter().find(|p| p.id == id).cloned();
        Ok(profile.map(|mut profile| {
            if let Some(stored) = self.credentials.lock().get(id) {
                if profile.kind == SessionKind::Ftp {
                    profile.password = stored.password.clone();
                } else {
                    match profile.auth.unwrap_or_default() {
                        AuthKind::Password => profile.password = stored.password.clone(),
                        AuthKind::PublicKey => profile.passphrase = stored.passphrase.clone(),
                        AuthKind::Agent => {}
                    }
                }
            }
            profile
        }))
    }

    pub fn save(&self, mut profile: SessionProfile) -> Result<SessionProfile> {
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
        }

        sync_secrets(&profile, &mut self.credentials.lock());
        profile.password = None;
        profile.passphrase = None;

        {
            let mut profiles = self.profiles.lock();
            match profiles.iter_mut().find(|p| p.id == profile.id) {
                Some(existing) => *existing = profile.clone(),
                None => profiles.push(profile.clone()),
            }
        }
        self.persist()?;
        Ok(profile)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.credentials.lock().remove(id);
        self.profiles.lock().retain(|p| p.id != id);
        self.persist()
    }

    pub fn list_sender_commands(&self) -> Vec<SavedCommand> {
        self.sender_commands.lock().clone()
    }

    pub fn save_sender_command(&self, mut command: SavedCommand) -> Result<SavedCommand> {
        if command.id.is_empty() {
            command.id = uuid::Uuid::new_v4().to_string();
        }

        {
            let mut commands = self.sender_commands.lock();
            if let Some(index) = commands.iter().position(|saved| saved.id == command.id) {
                commands[index] = command.clone();
            } else if commands.len() < MAX_SAVED_COMMANDS {
                commands.push(command.clone());
            } else {
                return Err(AppError::new(format!(
                    "saved command limit is {MAX_SAVED_COMMANDS}"
                )));
            }
        }
        self.persist_sender_commands()?;
        Ok(command)
    }

    pub fn delete_sender_command(&self, id: &str) -> Result<()> {
        self.sender_commands
            .lock()
            .retain(|command| command.id != id);
        self.persist_sender_commands()
    }

    pub fn list_command_history(&self) -> Vec<CommandHistoryEntry> {
        self.command_history.lock().clone()
    }

    pub fn record_command(&self, command: &str, host: &str) -> Result<()> {
        let command = command.trim_end();
        if command.is_empty() || command.len() > MAX_HISTORY_COMMAND_LEN {
            return Ok(());
        }
        {
            let mut entries = self.command_history.lock();
            let existing = entries
                .iter_mut()
                .find(|entry| entry.command == command && entry.host == host);
            match existing {
                Some(entry) => {
                    entry.count = entry.count.saturating_add(1);
                    entry.last_used = unix_millis();
                }
                None => {
                    entries.push(CommandHistoryEntry {
                        command: command.to_string(),
                        host: host.to_string(),
                        count: 1,
                        last_used: unix_millis(),
                    });
                    if entries.len() > MAX_COMMAND_HISTORY {
                        // Evict the least recently used entry, not the oldest
                        // insertion: a daily-driver command must never fall out
                        // just because it was learned early.
                        if let Some(oldest) = entries
                            .iter()
                            .enumerate()
                            .min_by_key(|(_, entry)| entry.last_used)
                            .map(|(index, _)| index)
                        {
                            entries.remove(oldest);
                        }
                    }
                }
            }
        }
        self.persist_command_history()
    }

    pub fn clear_command_history(&self) -> Result<()> {
        self.command_history.lock().clear();
        self.persist_command_history()
    }

    fn persist(&self) -> Result<()> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| AppError::new("config directory has no parent"))?;
        std::fs::create_dir_all(parent)?;

        let profiles = serde_json::to_string_pretty(&*self.profiles.lock())?;
        write_owner_only(&self.path, &profiles)?;

        let credentials = serde_json::to_string_pretty(&*self.credentials.lock())?;
        write_owner_only(&self.credentials_path, &credentials)
    }

    fn persist_sender_commands(&self) -> Result<()> {
        let parent = self
            .sender_commands_path
            .parent()
            .ok_or_else(|| AppError::new("config directory has no parent"))?;
        std::fs::create_dir_all(parent)?;

        let commands = serde_json::to_string_pretty(&*self.sender_commands.lock())?;
        write_owner_only(&self.sender_commands_path, &commands)
    }

    fn persist_command_history(&self) -> Result<()> {
        let parent = self
            .command_history_path
            .parent()
            .ok_or_else(|| AppError::new("config directory has no parent"))?;
        std::fs::create_dir_all(parent)?;

        // Compact JSON: unlike the other stores this file is rewritten on
        // every executed command, so keep the write as small as possible.
        let entries = serde_json::to_string(&*self.command_history.lock())?;
        write_owner_only(&self.command_history_path, &entries)
    }
}

fn unix_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis() as i64)
        .unwrap_or(0)
}

fn sync_secrets(profile: &SessionProfile, credentials: &mut HashMap<String, StoredSecrets>) {
    if !matches!(profile.kind, SessionKind::Ssh | SessionKind::Ftp)
        || (profile.kind == SessionKind::Ssh && profile.auth == Some(AuthKind::Agent))
    {
        credentials.remove(&profile.id);
        return;
    }

    if profile.kind == SessionKind::Ftp {
        let stored = credentials.entry(profile.id.clone()).or_default();
        stored.passphrase = None;
        if let Some(password) = &profile.password {
            stored.password = (!password.is_empty()).then(|| password.clone());
        }
        if stored.password.is_none() {
            credentials.remove(&profile.id);
        }
        return;
    }

    let stored = credentials.entry(profile.id.clone()).or_default();
    match profile.auth.unwrap_or_default() {
        AuthKind::Password => {
            stored.passphrase = None;
            if let Some(password) = &profile.password {
                stored.password = (!password.is_empty()).then(|| password.clone());
            }
        }
        AuthKind::PublicKey => {
            stored.password = None;
            if let Some(passphrase) = &profile.passphrase {
                stored.passphrase = (!passphrase.is_empty()).then(|| passphrase.clone());
            }
        }
        AuthKind::Agent => unreachable!(),
    }

    if stored.password.is_none() && stored.passphrase.is_none() {
        credentials.remove(&profile.id);
    }
}

fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn credentials_path_for(path: &Path) -> PathBuf {
    path.with_file_name("credentials.json")
}

fn sender_commands_path_for(path: &Path) -> PathBuf {
    path.with_file_name("sender_commands.json")
}

fn command_history_path_for(path: &Path) -> PathBuf {
    path.with_file_name("command_history.json")
}

fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("EdgeTerm")
        .join("sessions.json")
}

fn write_owner_only(path: &Path, contents: &str) -> Result<()> {
    use std::io::Write;

    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);

    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }

    let mut file = options.open(path)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    restrict_permissions(path);
    Ok(())
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) {}
