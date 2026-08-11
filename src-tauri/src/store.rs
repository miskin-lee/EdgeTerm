use std::collections::HashMap;
use std::path::{Path, PathBuf};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, Result};
use crate::model::{AuthKind, SessionKind, SessionProfile};

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

/// Session profiles and remembered SSH credentials, persisted as two files in
/// the application config directory.
///
/// `sessions.json` never contains credentials and is safe to return to the UI.
/// `credentials.json` is readable only by the current OS user and is consulted
/// solely while opening a saved session.  Keeping credentials app-local avoids
/// the macOS Keychain authorization dialog that otherwise reappears when an
/// unsigned development build changes identity between restarts.
pub struct Store {
    path: PathBuf,
    credentials_path: PathBuf,
    profiles: Mutex<Vec<SessionProfile>>,
    credentials: Mutex<HashMap<String, StoredSecrets>>,
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
            path,
            profiles: Mutex::new(profiles),
            credentials: Mutex::new(credentials),
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
                match profile.auth.unwrap_or_default() {
                    AuthKind::Password => profile.password = stored.password.clone(),
                    AuthKind::PublicKey => profile.passphrase = stored.passphrase.clone(),
                    AuthKind::Agent => {}
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
}

fn sync_secrets(
    profile: &SessionProfile,
    credentials: &mut HashMap<String, StoredSecrets>,
) {
    if profile.kind != SessionKind::Ssh || profile.auth == Some(AuthKind::Agent) {
        credentials.remove(&profile.id);
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
