use std::collections::HashMap;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::model::{
    AppData, AuthKind, CommandHistoryEntry, CommandScope, DataSummary, SavedCommand, SessionGroup,
    SessionKind, SessionProfile, APP_DATA_APP, APP_DATA_EXTENSION, APP_DATA_FORMAT,
};

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
/// `session_groups.json` holds the user-defined folders of the Session panel;
/// it is a separate file so older builds keep reading `sessions.json` as a
/// plain profile list.
/// `sender_commands.json` keeps reusable Sender tags across restarts and upgrades.
/// `command_history.json` remembers executed commands for inline suggestions;
/// like credentials it may contain sensitive text, so it is owner-only too.
pub struct Store {
    path: PathBuf,
    credentials_path: PathBuf,
    groups_path: PathBuf,
    sender_commands_path: PathBuf,
    command_history_path: PathBuf,
    profiles: Mutex<Vec<SessionProfile>>,
    credentials: Mutex<HashMap<String, StoredSecrets>>,
    groups: Mutex<Vec<SessionGroup>>,
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
        let groups_path = groups_path_for(&path);
        let groups = read_json(&groups_path).unwrap_or_default();
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
            groups_path,
            sender_commands_path,
            command_history_path,
            path,
            profiles: Mutex::new(profiles),
            credentials: Mutex::new(credentials),
            groups: Mutex::new(groups),
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

        // A stale or foreign group id (deleted group, kind switched in the
        // editor) must not strand the profile: fall back to the kind root.
        if let Some(group_id) = &profile.group_id {
            let valid = self
                .groups
                .lock()
                .iter()
                .any(|group| &group.id == group_id && group.kind == profile.kind);
            if !valid {
                profile.group_id = None;
            }
        }

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

    /// Removes a profile together with everything that belongs to it: its
    /// stored credentials and the Sender commands scoped to it alone.
    pub fn delete(&self, id: &str) -> Result<()> {
        self.credentials.lock().remove(id);
        self.profiles.lock().retain(|p| p.id != id);
        self.persist()?;

        let removed_commands = {
            let mut commands = self.sender_commands.lock();
            let before = commands.len();
            commands.retain(
                |command| !matches!(&command.scope, CommandScope::Profile { id: scoped } if scoped == id),
            );
            commands.len() != before
        };
        if removed_commands {
            self.persist_sender_commands()?;
        }
        Ok(())
    }

    pub fn list_groups(&self) -> Vec<SessionGroup> {
        self.groups.lock().clone()
    }

    /// Creates or renames / re-parents a group. The parent must be an
    /// existing group of the same kind and must not be the group itself or
    /// one of its descendants, so the tree can never form a cycle.
    pub fn save_group(&self, mut group: SessionGroup) -> Result<SessionGroup> {
        group.name = group.name.trim().to_string();
        if group.name.is_empty() {
            return Err(AppError::new("group name cannot be empty"));
        }
        if group.id.is_empty() {
            group.id = uuid::Uuid::new_v4().to_string();
        }
        if group.parent_id.as_deref() == Some("") {
            group.parent_id = None;
        }

        {
            let mut groups = self.groups.lock();
            if let Some(existing) = groups.iter().find(|g| g.id == group.id) {
                if existing.kind != group.kind {
                    return Err(AppError::new("a group cannot change its session kind"));
                }
            }
            if let Some(parent_id) = &group.parent_id {
                if *parent_id == group.id {
                    return Err(AppError::new("a group cannot contain itself"));
                }
                match groups.iter().find(|g| &g.id == parent_id) {
                    None => return Err(AppError::new("parent group does not exist")),
                    Some(parent) if parent.kind != group.kind => {
                        return Err(AppError::new(
                            "a group can only be nested under a group of the same session kind",
                        ))
                    }
                    Some(_) => {}
                }
                if subtree_ids(&groups, &group.id).contains(parent_id) {
                    return Err(AppError::new(
                        "a group cannot be moved into one of its own subgroups",
                    ));
                }
            }
            match groups.iter_mut().find(|g| g.id == group.id) {
                Some(existing) => *existing = group.clone(),
                None => groups.push(group.clone()),
            }
        }
        self.persist_groups()?;
        Ok(group)
    }

    /// Removes a group with everything in it: the groups nested below it,
    /// the profiles in any of them (with their credentials) and the Sender
    /// commands scoped to any of those groups or profiles.
    pub fn delete_group(&self, id: &str) -> Result<()> {
        let removed_groups = {
            let mut groups = self.groups.lock();
            if !groups.iter().any(|g| g.id == id) {
                return Ok(());
            }
            let removed = subtree_ids(&groups, id);
            groups.retain(|g| !removed.contains(&g.id));
            removed
        };
        self.persist_groups()?;

        let removed_profiles: Vec<String> = {
            let mut profiles = self.profiles.lock();
            let removed: Vec<String> = profiles
                .iter()
                .filter(|p| {
                    p.group_id
                        .as_ref()
                        .is_some_and(|group_id| removed_groups.contains(group_id))
                })
                .map(|p| p.id.clone())
                .collect();
            profiles.retain(|p| !removed.contains(&p.id));
            removed
        };
        if !removed_profiles.is_empty() {
            let mut credentials = self.credentials.lock();
            for profile_id in &removed_profiles {
                credentials.remove(profile_id);
            }
            drop(credentials);
            self.persist()?;
        }

        let removed_commands = {
            let mut commands = self.sender_commands.lock();
            let before = commands.len();
            commands.retain(|command| match &command.scope {
                CommandScope::Group { id } => !removed_groups.contains(id),
                CommandScope::Profile { id } => !removed_profiles.contains(id),
                CommandScope::Global | CommandScope::Kind { .. } => true,
            });
            commands.len() != before
        };
        if removed_commands {
            self.persist_sender_commands()?;
        }
        Ok(())
    }

    pub fn list_sender_commands(&self) -> Vec<SavedCommand> {
        self.sender_commands.lock().clone()
    }

    /// Creates or updates a Sender command. A scope pointing at a group or
    /// profile that does not exist falls back to `Global`, the one level that
    /// always exists.
    pub fn save_sender_command(&self, mut command: SavedCommand) -> Result<SavedCommand> {
        if command.id.is_empty() {
            command.id = uuid::Uuid::new_v4().to_string();
        }
        command.scope = self.resolve_scope(command.scope);

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

    fn resolve_scope(&self, scope: CommandScope) -> CommandScope {
        let exists = match &scope {
            CommandScope::Global | CommandScope::Kind { .. } => true,
            CommandScope::Group { id } => self.groups.lock().iter().any(|g| &g.id == id),
            CommandScope::Profile { id } => self.profiles.lock().iter().any(|p| &p.id == id),
        };
        if exists {
            scope
        } else {
            CommandScope::Global
        }
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

    /// Everything the backend contributes to a data export: saved sessions,
    /// their groups and Sender tags. Profiles are already credential-free in
    /// memory; `redact_profile` guards against that ever changing. The
    /// caller fills in the frontend's settings and the timestamp.
    pub fn snapshot(&self) -> AppData {
        AppData {
            app: APP_DATA_APP.to_string(),
            format: APP_DATA_FORMAT,
            exported_at: None,
            settings: None,
            profiles: self
                .profiles
                .lock()
                .iter()
                .cloned()
                .map(redact_profile)
                .collect(),
            groups: self.groups.lock().clone(),
            sender_commands: self.sender_commands.lock().clone(),
        }
    }

    /// Merges an exported file into the store. Entries are matched by id: a
    /// known id replaces the local entry, everything else is added, and
    /// nothing local is deleted. Credentials in the file are ignored — an
    /// export never carries any, so a value here was hand-written — and
    /// `credentials.json` keeps whatever it already holds for a replaced
    /// profile. Group parents and profile group ids that point nowhere, to a
    /// group of another kind or around a cycle are detached so the Session
    /// panel tree stays finite.
    pub fn import_data(&self, data: AppData) -> Result<DataSummary> {
        validate_app_data(&data)?;
        let mut summary = DataSummary::default();

        {
            let mut groups = self.groups.lock();
            for mut group in data.groups {
                group.name = group.name.trim().to_string();
                if group.name.is_empty() {
                    continue;
                }
                if group.id.is_empty() {
                    group.id = uuid::Uuid::new_v4().to_string();
                }
                if group.parent_id.as_deref() == Some("") {
                    group.parent_id = None;
                }
                match groups.iter_mut().find(|g| g.id == group.id) {
                    // A group cannot change kind: its profiles would no longer
                    // belong under it.
                    Some(existing) if existing.kind != group.kind => continue,
                    Some(existing) => *existing = group,
                    None => groups.push(group),
                }
                summary.groups += 1;
            }
            detach_invalid_parents(&mut groups);
        }

        {
            let groups = self.groups.lock().clone();
            let mut profiles = self.profiles.lock();
            for profile in data.profiles {
                let mut profile = redact_profile(profile);
                if profile.id.is_empty() {
                    profile.id = uuid::Uuid::new_v4().to_string();
                }
                if let Some(group_id) = &profile.group_id {
                    let valid = groups
                        .iter()
                        .any(|group| &group.id == group_id && group.kind == profile.kind);
                    if !valid {
                        profile.group_id = None;
                    }
                }
                match profiles.iter_mut().find(|p| p.id == profile.id) {
                    Some(existing) => *existing = profile,
                    None => profiles.push(profile),
                }
                summary.profiles += 1;
            }
        }

        {
            // Groups and profiles are in place by now, so a scope can be
            // checked against the merged lists.
            let resolved: Vec<SavedCommand> = data
                .sender_commands
                .into_iter()
                .map(|mut command| {
                    command.scope = self.resolve_scope(command.scope);
                    command
                })
                .collect();
            let mut commands = self.sender_commands.lock();
            for mut command in resolved {
                if command.id.is_empty() {
                    command.id = uuid::Uuid::new_v4().to_string();
                }
                if let Some(index) = commands.iter().position(|saved| saved.id == command.id) {
                    commands[index] = command;
                } else if commands.len() < MAX_SAVED_COMMANDS {
                    commands.push(command);
                } else {
                    summary.skipped_sender_commands += 1;
                    continue;
                }
                summary.sender_commands += 1;
            }
        }

        self.persist_groups()?;
        self.persist()?;
        self.persist_sender_commands()?;
        Ok(summary)
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

    fn persist_groups(&self) -> Result<()> {
        let parent = self
            .groups_path
            .parent()
            .ok_or_else(|| AppError::new("config directory has no parent"))?;
        std::fs::create_dir_all(parent)?;

        let groups = serde_json::to_string_pretty(&*self.groups.lock())?;
        write_owner_only(&self.groups_path, &groups)
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

/// Whether `path` carries the data-file extension (`.edgeterm`, any case).
pub fn is_data_file_path(path: &Path) -> bool {
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case(APP_DATA_EXTENSION))
}

/// Refuses files that are not EdgeTerm exports or come from a newer layout.
pub fn validate_app_data(data: &AppData) -> Result<()> {
    if data.app != APP_DATA_APP {
        return Err(AppError::new("not an EdgeTerm data file"));
    }
    if data.format == 0 {
        return Err(AppError::new("not an EdgeTerm data file: missing format"));
    }
    if data.format > APP_DATA_FORMAT {
        return Err(AppError::new(format!(
            "this data file was written by a newer EdgeTerm (format {} > {})",
            data.format, APP_DATA_FORMAT
        )));
    }
    Ok(())
}

/// Strips the secrets a profile may carry; every profile that leaves the
/// store in an export, or enters it from an import, passes through here.
pub fn redact_profile(mut profile: SessionProfile) -> SessionProfile {
    profile.password = None;
    profile.passphrase = None;
    profile
}

/// Drops parent links that point nowhere, to a group of another kind, to the
/// group itself or around a cycle. Detaching one link never invalidates
/// another, so a single pass is enough.
fn detach_invalid_parents(groups: &mut [SessionGroup]) {
    for index in 0..groups.len() {
        let Some(parent_id) = groups[index].parent_id.clone() else {
            continue;
        };
        let group_id = groups[index].id.clone();
        let kind = groups[index].kind;
        let valid_parent = parent_id != group_id
            && groups
                .iter()
                .any(|group| group.id == parent_id && group.kind == kind);
        if !valid_parent || subtree_ids(groups, &group_id).contains(&parent_id) {
            groups[index].parent_id = None;
        }
    }
}

/// Ids of `root` and every group nested below it, in no particular order.
fn subtree_ids(groups: &[SessionGroup], root: &str) -> Vec<String> {
    let mut ids = vec![root.to_string()];
    let mut cursor = 0;
    while cursor < ids.len() {
        let parent = ids[cursor].clone();
        for group in groups {
            if group.parent_id.as_deref() == Some(parent.as_str()) && !ids.contains(&group.id) {
                ids.push(group.id.clone());
            }
        }
        cursor += 1;
    }
    ids
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

fn groups_path_for(path: &Path) -> PathBuf {
    path.with_file_name("session_groups.json")
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
