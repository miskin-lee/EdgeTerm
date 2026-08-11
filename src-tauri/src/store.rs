use std::path::PathBuf;

use parking_lot::Mutex;

use crate::error::{AppError, Result};
use crate::model::SessionProfile;

/// Session profiles, persisted as JSON next to the app's other config.
///
/// Secrets are only written to disk when a profile opts in via `saveSecrets`;
/// otherwise they live for the lifetime of the process and the saved file keeps
/// everything except the password and passphrase.
pub struct Store {
    path: PathBuf,
    profiles: Mutex<Vec<SessionProfile>>,
}

impl Store {
    pub fn load() -> Self {
        Self::load_from(config_path())
    }

    pub fn load_from(path: PathBuf) -> Self {
        let profiles = std::fs::read_to_string(&path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Vec<SessionProfile>>(&raw).ok())
            .unwrap_or_default();
        Store {
            path,
            profiles: Mutex::new(profiles),
        }
    }

    pub fn list(&self) -> Vec<SessionProfile> {
        self.profiles.lock().clone()
    }

    pub fn get(&self, id: &str) -> Option<SessionProfile> {
        self.profiles.lock().iter().find(|p| p.id == id).cloned()
    }

    pub fn save(&self, mut profile: SessionProfile) -> Result<SessionProfile> {
        if profile.id.is_empty() {
            profile.id = uuid::Uuid::new_v4().to_string();
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

    pub fn delete(&self, id: &str) -> Result<()> {
        self.profiles.lock().retain(|p| p.id != id);
        self.persist()
    }

    fn persist(&self) -> Result<()> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| AppError::new("config directory has no parent"))?;
        std::fs::create_dir_all(parent)?;

        let redacted: Vec<SessionProfile> = self
            .profiles
            .lock()
            .iter()
            .cloned()
            .map(|mut p| {
                p.password = None;
                p.passphrase = None;
                p
            })
            .collect();

        let json = serde_json::to_string_pretty(&redacted)?;
        std::fs::write(&self.path, json)?;
        restrict_permissions(&self.path);
        Ok(())
    }
}

fn config_path() -> PathBuf {
    dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("EdgeTerm")
        .join("sessions.json")
}

#[cfg(unix)]
fn restrict_permissions(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &std::path::Path) {}
