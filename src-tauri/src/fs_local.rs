use std::path::{Path, PathBuf};

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

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&canonical)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let symlink = entry
            .file_type()
            .map(|t| t.is_symlink())
            .unwrap_or(false);
        entries.push(FileEntry {
            path: entry.path().to_string_lossy().into_owned(),
            name,
            is_dir: meta.is_dir(),
            is_symlink: symlink,
            size: meta.len(),
            modified: modified_secs(&meta),
            permissions: permissions(&meta),
            owner: None,
            group: None,
        });
    }
    sort_entries(&mut entries);

    Ok(DirListing {
        path: canonical.to_string_lossy().into_owned(),
        entries,
    })
}

pub fn parent_of(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
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
