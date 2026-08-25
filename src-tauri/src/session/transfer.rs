//! Helpers shared by the SFTP and FTP folder transfers: local path safety
//! checks, the metadata-only plan for uploading a local tree, and the
//! throttled progress reporter.
//!
//! Neither backend loads file contents here. Both keep copying bytes through
//! their own fixed 1 MiB buffer one file at a time; this module only decides
//! *which* files and folders take part and where they land.

use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

use tauri::ipc::Channel;

use super::{join_remote, TransferProgress};
use crate::error::{AppError, Result};

const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(50);

/// Joins a remote item name onto a local parent directory, refusing anything
/// that could leave that directory. Remote listings are untrusted input: a
/// server can return `..`, absolute paths, or names containing separators.
pub fn safe_local_child(parent: &Path, name: &str) -> Result<PathBuf> {
    if name.is_empty()
        || name
            .chars()
            .any(|character| matches!(character, '/' | '\\' | '\0'))
    {
        return Err(AppError::new(format!(
            "remote item has an unsafe local filename: {name:?}"
        )));
    }

    let mut components = Path::new(name).components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(_)), None) => Ok(parent.join(name)),
        _ => Err(AppError::new(format!(
            "remote item has an unsafe local filename: {name:?}"
        ))),
    }
}

/// Creates a local directory when it is missing, accepts an existing real
/// directory (so downloads can merge into it), and refuses to write through a
/// symlink or on top of a file.
pub fn ensure_local_directory(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(AppError::new(format!(
            "refusing to download through local symlink: {}",
            path.display()
        ))),
        Ok(metadata) if !metadata.is_dir() => Err(AppError::new(format!(
            "local path is not a folder: {}",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            std::fs::create_dir(path)?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

/// A download may create or replace a regular file, but never a symlink (the
/// write would follow it somewhere else) or a directory.
pub fn validate_local_file_target(path: &Path) -> Result<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err(AppError::new(format!(
            "refusing to replace local symlink: {}",
            path.display()
        ))),
        Ok(metadata) if !metadata.is_file() => Err(AppError::new(format!(
            "local path is not a regular file: {}",
            path.display()
        ))),
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// One regular file inside a folder upload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UploadJob {
    pub local: PathBuf,
    pub remote: String,
    pub size: u64,
}

/// Everything a folder upload needs to know before the first byte is sent.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct UploadPlan {
    /// Remote directories to create, parents before children. The first entry
    /// is the destination root itself.
    pub directories: Vec<String>,
    pub files: Vec<UploadJob>,
    pub total: u64,
}

/// Walks a local folder and maps every regular file and sub-folder onto the
/// remote destination. Symlinked files are uploaded as the file they point
/// at; symlinked directories are skipped so a link back to an ancestor can
/// never turn the walk into an endless loop.
pub fn plan_local_upload(local_root: &Path, remote_root: &str) -> Result<UploadPlan> {
    let root_metadata = std::fs::metadata(local_root)?;
    if !root_metadata.is_dir() {
        return Err(AppError::new(format!(
            "local path is not a folder: {}",
            local_root.display()
        )));
    }

    let mut plan = UploadPlan {
        directories: vec![remote_root.to_string()],
        ..UploadPlan::default()
    };
    let mut pending = vec![(local_root.to_path_buf(), remote_root.to_string())];

    while let Some((local_dir, remote_dir)) = pending.pop() {
        let mut children: Vec<_> =
            std::fs::read_dir(&local_dir)?.collect::<std::io::Result<_>>()?;
        children.sort_by_key(|entry| entry.file_name());

        for child in children {
            let name = child.file_name();
            let Some(name) = name.to_str() else {
                return Err(AppError::new(format!(
                    "local file name is not valid Unicode: {}",
                    child.path().display()
                )));
            };
            if name.contains('/') || name.contains('\\') {
                return Err(AppError::new(format!(
                    "local file name cannot be sent to the server: {name:?}"
                )));
            }

            let link_metadata = child.metadata()?;
            let is_symlink = link_metadata.file_type().is_symlink();
            // `metadata` follows the link so a symlinked file is uploaded as
            // its target; a dangling link is simply skipped.
            let metadata = if is_symlink {
                match std::fs::metadata(child.path()) {
                    Ok(metadata) => metadata,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error.into()),
                }
            } else {
                link_metadata
            };

            let remote_child = join_remote(&remote_dir, name);
            if metadata.is_dir() {
                if is_symlink {
                    continue;
                }
                plan.directories.push(remote_child.clone());
                pending.push((child.path(), remote_child));
            } else if metadata.is_file() {
                plan.total = plan.total.checked_add(metadata.len()).ok_or_else(|| {
                    AppError::new("local folder is too large to report transfer progress")
                })?;
                plan.files.push(UploadJob {
                    local: child.path(),
                    remote: remote_child,
                    size: metadata.len(),
                });
            }
            // Sockets, FIFOs, and devices have no meaningful remote
            // representation and are skipped.
        }
    }

    Ok(plan)
}

/// Emits aggregate progress for a multi-file transfer: 0 at the start, at
/// most one update every 50 ms while copying, and the final byte count at
/// the end.
pub struct ProgressReporter<'a> {
    channel: &'a Channel<TransferProgress>,
    total: u64,
    last_report: Instant,
}

impl<'a> ProgressReporter<'a> {
    pub fn begin(channel: &'a Channel<TransferProgress>, total: u64) -> Self {
        let _ = channel.send(TransferProgress {
            transferred: 0,
            total,
        });
        Self {
            channel,
            total,
            last_report: Instant::now(),
        }
    }

    pub fn update(&mut self, transferred: u64) {
        if self.last_report.elapsed() < TRANSFER_PROGRESS_INTERVAL {
            return;
        }
        let _ = self.channel.send(TransferProgress {
            transferred,
            total: self.total,
        });
        self.last_report = Instant::now();
    }

    pub fn finish(self, transferred: u64) {
        let _ = self.channel.send(TransferProgress {
            transferred,
            total: self.total,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ensure_local_directory, plan_local_upload, safe_local_child, validate_local_file_target,
    };
    use std::path::{Path, PathBuf};

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("edgeterm-transfer-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    #[test]
    fn folder_download_keeps_remote_names_inside_the_local_root() {
        let root = Path::new("download-root");
        assert_eq!(
            safe_local_child(root, "中文目录").unwrap(),
            root.join("中文目录")
        );
        for unsafe_name in ["", ".", "..", "../escape", "/absolute", "a/b", "a\\b"] {
            assert!(
                safe_local_child(root, unsafe_name).is_err(),
                "{unsafe_name:?} must not escape the selected download folder"
            );
        }
    }

    #[test]
    fn local_targets_reject_symlinks_and_type_mismatches() {
        let dir = temp_dir("targets");
        let file = dir.join("file.txt");
        std::fs::write(&file, b"x").unwrap();
        let folder = dir.join("folder");
        std::fs::create_dir(&folder).unwrap();

        assert!(validate_local_file_target(&file).is_ok());
        assert!(validate_local_file_target(&dir.join("missing")).is_ok());
        assert!(validate_local_file_target(&folder).is_err());

        assert!(ensure_local_directory(&folder).is_ok());
        assert!(ensure_local_directory(&file).is_err());
        let created = dir.join("created");
        assert!(ensure_local_directory(&created).is_ok());
        assert!(created.is_dir());

        #[cfg(unix)]
        {
            let link = dir.join("link");
            std::os::unix::fs::symlink(&folder, &link).unwrap();
            assert!(ensure_local_directory(&link).is_err());
            assert!(validate_local_file_target(&link).is_err());
        }

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn upload_plan_mirrors_the_local_tree_onto_the_remote_root() {
        let dir = temp_dir("plan");
        let source = dir.join("project");
        std::fs::create_dir_all(source.join("src/nested")).unwrap();
        std::fs::create_dir_all(source.join("empty")).unwrap();
        std::fs::write(source.join("README.md"), b"hello").unwrap();
        std::fs::write(source.join("src/main.rs"), vec![0; 300]).unwrap();
        std::fs::write(source.join("src/nested/deep.txt"), b"abc").unwrap();

        let plan = plan_local_upload(&source, "/srv/project").unwrap();

        assert_eq!(plan.total, 5 + 300 + 3);
        assert_eq!(plan.directories[0], "/srv/project");
        for directory in [
            "/srv/project/src",
            "/srv/project/src/nested",
            "/srv/project/empty",
        ] {
            let position = plan
                .directories
                .iter()
                .position(|path| path == directory)
                .unwrap_or_else(|| panic!("{directory} missing from plan"));
            if let Some(parent) = Path::new(directory).parent() {
                let parent = parent.to_string_lossy();
                let parent_position = plan
                    .directories
                    .iter()
                    .position(|path| path == parent.as_ref())
                    .expect("parent is planned");
                assert!(parent_position < position, "parents are created first");
            }
        }

        let mut remotes: Vec<_> = plan.files.iter().map(|job| job.remote.as_str()).collect();
        remotes.sort();
        assert_eq!(
            remotes,
            [
                "/srv/project/README.md",
                "/srv/project/src/main.rs",
                "/srv/project/src/nested/deep.txt",
            ]
        );
        let main = plan
            .files
            .iter()
            .find(|job| job.remote == "/srv/project/src/main.rs")
            .unwrap();
        assert_eq!(main.local, source.join("src/main.rs"));
        assert_eq!(main.size, 300);

        assert!(plan_local_upload(&source.join("README.md"), "/srv/x").is_err());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn upload_plan_follows_file_links_but_skips_directory_links() {
        let dir = temp_dir("links");
        let source = dir.join("tree");
        std::fs::create_dir_all(source.join("real")).unwrap();
        std::fs::write(source.join("real/data.bin"), vec![1; 10]).unwrap();
        std::os::unix::fs::symlink(source.join("real/data.bin"), source.join("alias.bin")).unwrap();
        std::os::unix::fs::symlink(&source, source.join("loop")).unwrap();
        std::os::unix::fs::symlink(source.join("missing"), source.join("dangling")).unwrap();

        let plan = plan_local_upload(&source, "/up").unwrap();

        assert_eq!(plan.directories, ["/up", "/up/real"]);
        let mut remotes: Vec<_> = plan.files.iter().map(|job| job.remote.as_str()).collect();
        remotes.sort();
        assert_eq!(remotes, ["/up/alias.bin", "/up/real/data.bin"]);
        assert_eq!(plan.total, 20);

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
