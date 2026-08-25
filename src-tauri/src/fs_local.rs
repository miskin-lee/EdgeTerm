use std::fs::{DirEntry, FileType, Metadata};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::error::Result;
use crate::model::{DirListing, FileEntry};
use crate::session::sort_entries;

pub fn home() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .to_string_lossy()
        .into_owned()
}

pub fn list(path: &str) -> Result<DirListing> {
    let target = if path.is_empty() {
        PathBuf::from(home())
    } else {
        PathBuf::from(expand_tilde(path))
    };
    let canonical = std::fs::canonicalize(&target).unwrap_or(target);

    let mut entries = list_with_permission_retry(&canonical)?;
    sort_entries(&mut entries);

    Ok(DirListing {
        path: canonical.to_string_lossy().into_owned(),
        entries,
    })
}

/// macOS may return a short-lived EPERM/EACCES while a Files & Folders prompt
/// is being accepted. Retry only those failures so the newly granted access is
/// usable without restarting EdgeTerm. Other platforms do a single attempt.
fn list_with_permission_retry(path: &Path) -> io::Result<Vec<FileEntry>> {
    let mut delays = permission_retry_delays().iter();

    loop {
        let delay = *delays
            .next()
            .expect("permission retry schedule is non-empty");
        if !delay.is_zero() {
            std::thread::sleep(delay);
        }

        match list_once(path) {
            Ok(attempt) if attempt.had_permission_error && !delays.as_slice().is_empty() => {}
            Ok(attempt) => return Ok(attempt.entries),
            Err(error) if is_permission_error(&error) && !delays.as_slice().is_empty() => {}
            Err(error) => return Err(error),
        }
    }
}

struct ListingAttempt {
    entries: Vec<FileEntry>,
    had_permission_error: bool,
}

fn list_once(path: &Path) -> io::Result<ListingAttempt> {
    let mut entries = Vec::new();
    let mut permission_failed_entries = 0;

    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        let mut permission_failed = false;
        let file_type = match entry.file_type() {
            Ok(file_type) => Some(file_type),
            Err(error) => {
                permission_failed |= is_permission_error(&error);
                None
            }
        };
        let metadata = match entry.metadata() {
            Ok(metadata) => Some(metadata),
            Err(error) => {
                permission_failed |= is_permission_error(&error);
                None
            }
        };
        if permission_failed {
            permission_failed_entries += 1;
        }

        // Directory enumeration already proved the item exists. Metadata can
        // still fail during a permission transition or if the item changes
        // concurrently; keep the name visible instead of reporting an empty
        // folder by silently dropping it.
        entries.push(file_entry(entry, file_type, metadata));
    }

    let had_permission_error = !entries.is_empty() && permission_failed_entries == entries.len();
    Ok(ListingAttempt {
        entries,
        had_permission_error,
    })
}

fn file_entry(
    entry: DirEntry,
    file_type: Option<FileType>,
    metadata: Option<Metadata>,
) -> FileEntry {
    file_entry_from_parts(
        entry.path(),
        entry.file_name().to_string_lossy().into_owned(),
        file_type,
        metadata,
    )
}

fn file_entry_from_parts(
    path: PathBuf,
    name: String,
    file_type: Option<FileType>,
    metadata: Option<Metadata>,
) -> FileEntry {
    let is_dir = metadata
        .as_ref()
        .map(Metadata::is_dir)
        .or_else(|| file_type.as_ref().map(FileType::is_dir))
        .unwrap_or(false);
    let is_symlink = file_type
        .as_ref()
        .map(FileType::is_symlink)
        .unwrap_or(false);

    FileEntry {
        path: path.to_string_lossy().into_owned(),
        name,
        is_dir,
        is_symlink,
        size: metadata.as_ref().map(Metadata::len).unwrap_or(0),
        modified: metadata.as_ref().and_then(modified_secs),
        permissions: metadata.as_ref().and_then(permissions),
        owner: None,
        group: None,
    }
}

fn is_permission_error(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::PermissionDenied || error.raw_os_error() == Some(1)
}

#[cfg(target_os = "macos")]
const PERMISSION_RETRY_DELAYS: [Duration; 6] = [
    Duration::ZERO,
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(400),
    Duration::from_millis(800),
];

#[cfg(target_os = "macos")]
fn permission_retry_delays() -> &'static [Duration] {
    &PERMISSION_RETRY_DELAYS
}

#[cfg(not(target_os = "macos"))]
const PERMISSION_RETRY_DELAYS: [Duration; 1] = [Duration::ZERO];

#[cfg(not(target_os = "macos"))]
fn permission_retry_delays() -> &'static [Duration] {
    &PERMISSION_RETRY_DELAYS
}

pub fn parent_of(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Follows symlinks, matching how the local listing classifies entries, so a
/// dropped link to a folder is uploaded as that folder.
pub fn is_directory(path: &str) -> bool {
    std::fs::metadata(expand_tilde(path))
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

pub fn mkdir(path: &str) -> Result<()> {
    std::fs::create_dir(path)?;
    Ok(())
}

pub fn rename(from: &str, to: &str) -> Result<()> {
    std::fs::rename(from, to)?;
    Ok(())
}

pub fn remove(path: &str, is_dir: bool) -> Result<()> {
    if is_dir {
        // Deliberately non-recursive: a mistaken click must never erase a
        // directory tree from the local machine.
        std::fs::remove_dir(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

fn modified_secs(meta: &std::fs::Metadata) -> Option<i64> {
    meta.modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs() as i64)
}

#[cfg(unix)]
fn permissions(meta: &std::fs::Metadata) -> Option<u32> {
    use std::os::unix::fs::PermissionsExt;
    Some(meta.permissions().mode())
}

#[cfg(not(unix))]
fn permissions(_meta: &std::fs::Metadata) -> Option<u32> {
    None
}

fn expand_tilde(path: &str) -> String {
    if path == "~" {
        return home();
    }
    if let Some(rest) = path.strip_prefix("~/") {
        return Path::new(&home()).join(rest).to_string_lossy().into_owned();
    }
    path.to_string()
}

#[cfg(test)]
mod local_tests {
    use super::file_entry_from_parts;
    use std::path::PathBuf;

    #[test]
    fn keeps_enumerated_item_when_metadata_is_temporarily_unavailable() {
        let entry = file_entry_from_parts(
            PathBuf::from("/protected/visible.txt"),
            "visible.txt".to_string(),
            None,
            None,
        );

        assert_eq!(entry.name, "visible.txt");
        assert_eq!(entry.path, "/protected/visible.txt");
        assert_eq!(entry.size, 0);
        assert!(entry.modified.is_none());
        assert!(entry.permissions.is_none());
    }
}
