use std::path::PathBuf;

use crate::fs_local;
use crate::model::{AuthKind, FileEntry, SessionKind, SessionProfile};
use crate::session::{join_remote, sort_entries};
use crate::store::Store;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "edgeterm-test-{tag}-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn profile(kind: SessionKind) -> SessionProfile {
    SessionProfile {
        id: String::new(),
        name: "test".into(),
        kind,
        color: None,
        group: None,
        shell: None,
        cwd: None,
        host: None,
        port: None,
        username: None,
        auth: None,
        password: None,
        private_key_path: None,
        passphrase: None,
        port_name: None,
        baud_rate: None,
        data_bits: None,
        stop_bits: None,
        parity: None,
        flow_control: None,
    }
}

fn entry(name: &str, is_dir: bool) -> FileEntry {
    FileEntry {
        name: name.to_string(),
        path: format!("/{name}"),
        is_dir,
        is_symlink: false,
        size: 0,
        modified: None,
        permissions: None,
        owner: None,
        group: None,
    }
}

#[test]
fn join_remote_builds_absolute_paths() {
    assert_eq!(join_remote("/home/lijian", "notes.txt"), "/home/lijian/notes.txt");
    // A trailing slash must not produce a doubled separator.
    assert_eq!(join_remote("/home/lijian/", "notes.txt"), "/home/lijian/notes.txt");
    assert_eq!(join_remote("/", "etc"), "/etc");
    assert_eq!(join_remote("", "etc"), "/etc");
    // An already-absolute name wins over the base.
    assert_eq!(join_remote("/home", "/var/log"), "/var/log");
}

#[test]
fn sort_entries_puts_directories_first_then_folds_case() {
    let mut entries = vec![
        entry("zebra.txt", false),
        entry("Apple", true),
        entry("beta.txt", false),
        entry("charlie", true),
    ];
    sort_entries(&mut entries);

    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["Apple", "charlie", "beta.txt", "zebra.txt"]);
}

#[test]
fn profile_renders_its_address_per_protocol() {
    let mut ssh = profile(SessionKind::Ssh);
    ssh.host = Some("serverx".into());
    ssh.port = Some(9090);
    assert_eq!(ssh.protocol(), "ssh");
    assert_eq!(ssh.address(), "serverx:9090");

    // Port defaults to 22 when unset.
    ssh.port = None;
    assert_eq!(ssh.address(), "serverx:22");

    let mut serial = profile(SessionKind::Serial);
    serial.port_name = Some("/dev/tty.usbserial".into());
    serial.baud_rate = Some(921_600);
    assert_eq!(serial.protocol(), "serial");
    assert_eq!(serial.address(), "/dev/tty.usbserial@921600");

    let mut local = profile(SessionKind::Local);
    local.shell = Some("/bin/zsh".into());
    assert_eq!(local.protocol(), "shell");
    assert_eq!(local.address(), "/bin/zsh");
}

#[test]
fn store_assigns_ids_and_round_trips_profiles() {
    let dir = temp_dir("store");
    let path = dir.join("sessions.json");
    let store = Store::load_from(path.clone());

    let mut p = profile(SessionKind::Ssh);
    p.name = "serverx".into();
    p.host = Some("10.0.0.1".into());
    let saved = store.save(p).expect("save");

    assert!(!saved.id.is_empty(), "an id should be minted on first save");
    assert_eq!(store.list().len(), 1);
    assert_eq!(store.get(&saved.id).map(|p| p.name), Some("serverx".into()));

    // Saving the same id updates in place rather than appending.
    let mut updated = saved.clone();
    updated.name = "serverx-prod".into();
    store.save(updated).expect("update");
    assert_eq!(store.list().len(), 1);
    assert_eq!(store.get(&saved.id).map(|p| p.name), Some("serverx-prod".into()));

    // A fresh store reads back what was persisted.
    let reloaded = Store::load_from(path);
    assert_eq!(reloaded.list().len(), 1);

    store.delete(&saved.id).expect("delete");
    assert!(store.list().is_empty());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn store_never_writes_secrets_to_disk() {
    let dir = temp_dir("secrets");
    let path = dir.join("sessions.json");
    let store = Store::load_from(path.clone());

    let mut p = profile(SessionKind::Ssh);
    p.host = Some("10.0.0.1".into());
    p.auth = Some(AuthKind::Password);
    p.password = Some("hunter2".into());
    p.passphrase = Some("open-sesame".into());
    let saved = store.save(p).expect("save");

    let raw = std::fs::read_to_string(&path).expect("read back");
    assert!(!raw.contains("hunter2"), "password must not reach disk");
    assert!(!raw.contains("open-sesame"), "passphrase must not reach disk");

    // The in-memory copy keeps them for the lifetime of the process.
    assert_eq!(
        store.get(&saved.id).and_then(|p| p.password),
        Some("hunter2".into())
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn store_file_is_owner_readable_only() {
    use std::os::unix::fs::PermissionsExt;

    let dir = temp_dir("perms");
    let path = dir.join("sessions.json");
    let store = Store::load_from(path.clone());
    store.save(profile(SessionKind::Local)).expect("save");

    let mode = std::fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600, "config must not be world-readable");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn local_listing_reports_directories_and_sizes() {
    let dir = temp_dir("fs");
    std::fs::create_dir(dir.join("subdir")).unwrap();
    std::fs::write(dir.join("hello.txt"), b"0123456789").unwrap();

    let listing = fs_local::list(dir.to_str().unwrap()).expect("list");
    let names: Vec<&str> = listing.entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["subdir", "hello.txt"]);

    let file = &listing.entries[1];
    assert!(!file.is_dir);
    assert_eq!(file.size, 10);
    assert!(file.modified.is_some());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn local_parent_walks_up_one_level() {
    assert_eq!(fs_local::parent_of("/home/lijian/notes"), "/home/lijian");
    // The root has no parent to walk to.
    assert_eq!(fs_local::parent_of("/"), "/");
}
