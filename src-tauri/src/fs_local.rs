use std::fs::{DirEntry, FileType, Metadata};
use std::io;
use std::path::{Path, PathBuf};
use std::time::Duration;

use tauri::ipc::Channel;

use crate::error::{AppError, Result};
use crate::model::{DirListing, FileEntry, LocalCopySummary};
use crate::session::sort_entries;
use crate::session::transfer::{
    ensure_local_directory, safe_local_child, validate_local_file_target, ProgressReporter,
};
use crate::session::TransferProgress;

/// Path of the virtual folder that lists the drives on Windows. It is the
/// parent of every drive root, so going up from `C:\` lands on the same view
/// Explorer calls "This PC" instead of stopping dead. The frontend mirrors
/// this constant as `LOCAL_DRIVES_ROOT`.
pub const THIS_PC: &str = "This PC";

pub fn home() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("/"))
        .to_string_lossy()
        .into_owned()
}

pub fn list(path: &str) -> Result<DirListing> {
    if cfg!(windows) && path == THIS_PC {
        return Ok(DirListing {
            path: THIS_PC.to_string(),
            entries: drives::list(),
        });
    }

    let target = if path.is_empty() {
        PathBuf::from(home())
    } else {
        PathBuf::from(expand_tilde(path))
    };
    let canonical = std::fs::canonicalize(&target)
        .map(strip_verbatim_prefix)
        .unwrap_or(target);

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
    if cfg!(windows) && (path == THIS_PC || is_drive_root(path)) {
        return THIS_PC.to_string();
    }
    Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// `C:`, `C:\`, `C:/` or the verbatim `\\?\C:\` — roots that have no parent
/// directory on Windows.
fn is_drive_root(path: &str) -> bool {
    let path = path.strip_prefix(r"\\?\").unwrap_or(path);
    match path.as_bytes() {
        [letter, b':'] | [letter, b':', b'\\'] | [letter, b':', b'/'] => {
            letter.is_ascii_alphabetic()
        }
        _ => false,
    }
}

/// `canonicalize` on Windows returns extended-length paths (`\\?\C:\Users`,
/// `\\?\UNC\server\share`). Turn them back into the plain form so the path
/// bar shows what the user expects and the parent walk works on drive roots.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    let Some(rest) = text.strip_prefix(r"\\?\") else {
        return path;
    };
    match rest.strip_prefix(r"UNC\") {
        Some(unc) => PathBuf::from(format!(r"\\{unc}")),
        None => PathBuf::from(rest),
    }
}

#[cfg(windows)]
mod drives {
    use std::ptr::null_mut;

    use windows_sys::Win32::Storage::FileSystem::{
        GetDriveTypeW, GetLogicalDrives, GetVolumeInformationW,
    };
    use windows_sys::Win32::System::WindowsProgramming::{
        DRIVE_CDROM, DRIVE_FIXED, DRIVE_NO_ROOT_DIR, DRIVE_RAMDISK, DRIVE_REMOTE,
        DRIVE_REMOVABLE,
    };

    use crate::model::FileEntry;

    /// One folder-like entry per mounted drive letter, in letter order, named
    /// the way Explorer does it: `Data (D:)`, or `Local Disk (C:)` when the
    /// volume has no label.
    pub fn list() -> Vec<FileEntry> {
        let mask = unsafe { GetLogicalDrives() };
        (0..26u32)
            .filter(|bit| mask & (1 << bit) != 0)
            .filter_map(|bit| {
                let letter = (b'A' + bit as u8) as char;
                let root = format!("{letter}:\\");
                let wide = wide(&root);
                let kind = unsafe { GetDriveTypeW(wide.as_ptr()) };
                if kind == DRIVE_NO_ROOT_DIR {
                    return None;
                }
                let label = volume_label(&wide, kind)
                    .filter(|label| !label.is_empty())
                    .unwrap_or_else(|| generic_name(kind).to_string());
                Some(FileEntry {
                    path: root,
                    name: format!("{label} ({letter}:)"),
                    is_dir: true,
                    is_symlink: false,
                    size: 0,
                    modified: None,
                    permissions: None,
                    owner: None,
                    group: None,
                })
            })
            .collect()
    }

    fn volume_label(root: &[u16], kind: u32) -> Option<String> {
        // Querying removable media spins the drive up and can raise an
        // "insert a disk" prompt, so only volumes that are always present
        // get asked for their label.
        if !matches!(kind, DRIVE_FIXED | DRIVE_REMOTE | DRIVE_RAMDISK) {
            return None;
        }
        let mut label = [0u16; 261];
        let ok = unsafe {
            GetVolumeInformationW(
                root.as_ptr(),
                label.as_mut_ptr(),
                label.len() as u32,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                0,
            )
        };
        if ok == 0 {
            return None;
        }
        let end = label.iter().position(|&c| c == 0).unwrap_or(label.len());
        Some(String::from_utf16_lossy(&label[..end]))
    }

    fn generic_name(kind: u32) -> &'static str {
        match kind {
            DRIVE_FIXED => "Local Disk",
            DRIVE_REMOVABLE => "Removable Disk",
            DRIVE_CDROM => "CD Drive",
            DRIVE_REMOTE => "Network Drive",
            DRIVE_RAMDISK => "RAM Disk",
            _ => "Drive",
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }
}

#[cfg(not(windows))]
mod drives {
    use crate::model::FileEntry;

    /// Only Windows has drive letters; `list` never asks for this elsewhere.
    pub fn list() -> Vec<FileEntry> {
        Vec::new()
    }
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

/// Creates an empty file, failing if the path already exists so a typo in the
/// name can never truncate a real file.
pub fn create_file(path: &str) -> Result<()> {
    std::fs::File::create_new(path)?;
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

/// One regular file of a copy, and where it lands.
struct CopyJob {
    source: PathBuf,
    target: PathBuf,
    size: u64,
}

/// Everything a copy needs to know before the first byte moves.
struct CopyPlan {
    /// Directories to create, parents before children; empty for a single
    /// file. The first entry is the destination root itself.
    directories: Vec<PathBuf>,
    files: Vec<CopyJob>,
    total: u64,
}

/// Copies `source` into the `destination` folder under its own name, the way
/// dropping it on a file manager would: folders are merged rather than
/// replaced, and a file already there is overwritten — the same rules a
/// download into a local folder follows.
///
/// Dropping an item on the folder it already lives in is not an error; those
/// files are counted as skipped, because copying a path onto itself would
/// truncate it.
pub fn copy_into(
    source: &str,
    destination: &str,
    progress: &Channel<TransferProgress>,
) -> Result<LocalCopySummary> {
    let source = PathBuf::from(source);
    let destination = PathBuf::from(destination);
    let name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| AppError::new(format!("{} has no name to copy under", source.display())))?
        .to_owned();
    let target = safe_local_child(&destination, &name)?;

    // A destination inside the source would have the walk descend into the
    // copy it is making.
    if let (Ok(from), Ok(into)) = (
        std::fs::canonicalize(&source),
        std::fs::canonicalize(&destination),
    ) {
        if into.starts_with(&from) {
            return Err(AppError::new(format!(
                "cannot copy {} into itself",
                source.display()
            )));
        }
    }

    run_copy(plan_copy(&source, &target)?, progress)
}

/// Walks `source` and maps every regular file and sub-folder onto `target`.
/// Symlinked files are copied as the file they point at; symlinked
/// directories are skipped, so a link back to an ancestor can never turn the
/// walk into an endless loop. Sockets, FIFOs and devices have nothing to copy.
fn plan_copy(source: &Path, target: &Path) -> Result<CopyPlan> {
    // Follows the link, so dropping a symlink copies what it points at.
    let root = std::fs::metadata(source)?;
    if root.is_file() {
        return Ok(CopyPlan {
            directories: Vec::new(),
            total: root.len(),
            files: vec![CopyJob {
                source: source.to_path_buf(),
                target: target.to_path_buf(),
                size: root.len(),
            }],
        });
    }
    if !root.is_dir() {
        return Err(AppError::new(format!(
            "{} is neither a file nor a folder",
            source.display()
        )));
    }

    let mut plan = CopyPlan {
        directories: vec![target.to_path_buf()],
        files: Vec::new(),
        total: 0,
    };
    let mut pending = vec![(source.to_path_buf(), target.to_path_buf())];
    while let Some((dir, target_dir)) = pending.pop() {
        let mut children: Vec<_> = std::fs::read_dir(&dir)?.collect::<io::Result<_>>()?;
        children.sort_by_key(|child| child.file_name());

        for child in children {
            let target_child = target_dir.join(child.file_name());
            // `DirEntry::metadata` does not follow links; `fs::metadata` does.
            let link = child.metadata()?;
            let is_symlink = link.file_type().is_symlink();
            let metadata = if is_symlink {
                match std::fs::metadata(child.path()) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                }
            } else {
                link
            };

            if metadata.is_dir() {
                if is_symlink {
                    continue;
                }
                plan.directories.push(target_child.clone());
                pending.push((child.path(), target_child));
            } else if metadata.is_file() {
                plan.total = plan
                    .total
                    .checked_add(metadata.len())
                    .ok_or_else(|| AppError::new("folder is too large to report copy progress"))?;
                plan.files.push(CopyJob {
                    source: child.path(),
                    target: target_child,
                    size: metadata.len(),
                });
            }
        }
    }
    Ok(plan)
}

fn run_copy(plan: CopyPlan, progress: &Channel<TransferProgress>) -> Result<LocalCopySummary> {
    let mut reporter = ProgressReporter::begin(progress, plan.total);
    for directory in &plan.directories {
        ensure_local_directory(directory)?;
    }

    let mut summary = LocalCopySummary::default();
    let mut copied = 0u64;
    for job in &plan.files {
        if same_path(&job.source, &job.target) {
            summary.skipped += 1;
        } else {
            validate_local_file_target(&job.target)?;
            // `fs::copy` streams through the OS (a clone on APFS, a reflink
            // on Btrfs) and carries the permission bits over, so nothing here
            // holds a file in memory. Progress is per file, which is as fine
            // as a local copy needs.
            std::fs::copy(&job.source, &job.target)?;
            summary.files += 1;
        }
        copied += job.size;
        reporter.update(copied);
    }
    reporter.finish(copied);
    Ok(summary)
}

/// Whether two paths name the same existing file. A target that does not
/// exist yet cannot be canonicalized, and is by definition not the source.
fn same_path(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// Root of the copies staged for a drag out of the Filer; one folder per
/// drag, mirroring `remote_edit`'s layout under the same `EdgeTerm` temp
/// directory.
fn drag_root() -> PathBuf {
    std::env::temp_dir().join("EdgeTerm").join("drag")
}

/// Removes what earlier runs staged. A drop target copies the file itself and
/// may still be reading it when the drag session ends, so a staged copy is
/// never deleted while the application runs; the next launch clears them all.
pub fn clean_drag_staging() {
    if let Err(error) = std::fs::remove_dir_all(drag_root()) {
        if error.kind() != io::ErrorKind::NotFound {
            eprintln!("EdgeTerm: could not clear the drag staging folder: {error}");
        }
    }
}

/// Where a remote entry is downloaded to before it is handed to the system
/// drag. Its own folder per drag, so equal names from different sessions or
/// directories cannot collide and the dropped copy keeps the remote name.
pub fn drag_staging_path(name: &str) -> Result<PathBuf> {
    let dir = drag_root().join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir)?;
    safe_local_child(&dir, name)
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
    use super::{file_entry_from_parts, is_drive_root, strip_verbatim_prefix};
    use std::path::PathBuf;

    #[test]
    fn recognises_drive_roots_in_every_spelling() {
        for root in ["C:", "C:\\", "c:/", "\\\\?\\D:\\"] {
            assert!(is_drive_root(root), "{root}");
        }
        for not_root in ["C:\\Users", "/", "/home", "This PC", "\\\\server\\share", "1:"] {
            assert!(!is_drive_root(not_root), "{not_root}");
        }
    }

    #[test]
    fn strips_extended_length_prefixes_from_canonical_paths() {
        let plain = |text: &str| strip_verbatim_prefix(PathBuf::from(text));
        assert_eq!(plain("\\\\?\\C:\\Users\\me"), PathBuf::from("C:\\Users\\me"));
        assert_eq!(
            plain("\\\\?\\UNC\\nas\\share"),
            PathBuf::from("\\\\nas\\share")
        );
        assert_eq!(plain("/Users/me"), PathBuf::from("/Users/me"));
    }

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
