use std::path::PathBuf;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

use crate::commands::{
    zmodem_create_file, zmodem_file_info, zmodem_finish_file, zmodem_read_chunk, zmodem_write_chunk,
};
use crate::fs_local;
use crate::model::{
    AuthKind, FileEntry, LineEnding, SavedCommand, SenderFormat, SessionKind, SessionProfile,
};
use crate::session::{join_remote, sort_entries};
use crate::store::Store;

fn temp_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("edgeterm-test-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).expect("create temp dir");
    dir
}

fn profile(kind: SessionKind) -> SessionProfile {
    SessionProfile {
        id: String::new(),
        name: "test".into(),
        kind,
        color: None,
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
    assert_eq!(
        join_remote("/home/lijian", "notes.txt"),
        "/home/lijian/notes.txt"
    );
    // A trailing slash must not produce a doubled separator.
    assert_eq!(
        join_remote("/home/lijian/", "notes.txt"),
        "/home/lijian/notes.txt"
    );
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

    let mut ftp = profile(SessionKind::Ftp);
    ftp.host = Some("files.example.com".into());
    assert_eq!(ftp.protocol(), "ftp");
    assert_eq!(ftp.address(), "files.example.com:21");
    ftp.port = Some(2121);
    assert_eq!(ftp.address(), "files.example.com:2121");

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
    assert_eq!(
        store.get(&saved.id).expect("get").map(|p| p.name),
        Some("serverx".into())
    );

    // Saving the same id updates in place rather than appending.
    let mut updated = saved.clone();
    updated.name = "serverx-prod".into();
    store.save(updated).expect("update");
    assert_eq!(store.list().len(), 1);
    assert_eq!(
        store.get(&saved.id).expect("get").map(|p| p.name),
        Some("serverx-prod".into())
    );

    // A fresh store reads back what was persisted.
    let reloaded = Store::load_from(path);
    assert_eq!(reloaded.list().len(), 1);

    store.delete(&saved.id).expect("delete");
    assert!(store.list().is_empty());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn store_persists_sender_commands_across_restarts() {
    let dir = temp_dir("sender-commands");
    let path = dir.join("sessions.json");
    let store = Store::load_from(path.clone());

    let saved = store
        .save_sender_command(SavedCommand {
            id: String::new(),
            name: "List files".into(),
            text: "ls -la".into(),
            format: SenderFormat::Text,
            ending: LineEnding::Lf,
        })
        .expect("save sender command");
    assert!(!saved.id.is_empty());

    let mut updated = saved.clone();
    updated.ending = LineEnding::Crlf;
    store
        .save_sender_command(updated.clone())
        .expect("update sender command");
    assert_eq!(store.list_sender_commands(), vec![updated.clone()]);

    let reloaded = Store::load_from(path);
    assert_eq!(reloaded.list_sender_commands(), vec![updated]);
    reloaded
        .delete_sender_command(&saved.id)
        .expect("delete sender command");
    assert!(Store::load_from(dir.join("sessions.json"))
        .list_sender_commands()
        .is_empty());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn store_persists_secrets_separately_for_restart_reconnects() {
    let dir = temp_dir("secrets");
    let path = dir.join("sessions.json");
    let store = Store::load_from(path.clone());

    let mut p = profile(SessionKind::Ssh);
    p.host = Some("10.0.0.1".into());
    p.auth = Some(AuthKind::Password);
    p.password = Some("hunter2".into());
    let saved_password = store.save(p).expect("save password");

    let mut key_profile = profile(SessionKind::Ssh);
    key_profile.name = "key-server".into();
    key_profile.host = Some("10.0.0.2".into());
    key_profile.auth = Some(AuthKind::PublicKey);
    key_profile.passphrase = Some("open-sesame".into());
    let saved_key = store.save(key_profile).expect("save passphrase");

    let raw = std::fs::read_to_string(&path).expect("read profiles");
    assert!(
        !raw.contains("hunter2"),
        "password must not reach sessions.json"
    );
    assert!(
        !raw.contains("open-sesame"),
        "passphrase must not reach sessions.json"
    );
    assert!(
        saved_password.password.is_none(),
        "returned profile is redacted"
    );
    assert!(
        saved_key.passphrase.is_none(),
        "returned profile is redacted"
    );

    // Saving an edit made from the redacted profile list must keep the existing
    // credential instead of accidentally clearing it.
    let mut renamed = saved_password.clone();
    renamed.name = "renamed-server".into();
    store.save(renamed).expect("save redacted edit");

    // A fresh Store instance hydrates the app-local credentials without using
    // the OS credential vault, which models reopening after a restart.
    let reloaded = Store::load_from(path);
    assert_eq!(
        reloaded
            .get(&saved_password.id)
            .expect("read password")
            .and_then(|p| p.password),
        Some("hunter2".into())
    );
    assert_eq!(
        reloaded
            .get(&saved_key.id)
            .expect("read passphrase")
            .and_then(|p| p.passphrase),
        Some("open-sesame".into())
    );

    reloaded
        .delete(&saved_password.id)
        .expect("delete password");
    reloaded.delete(&saved_key.id).expect("delete passphrase");

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn store_persists_ftp_password_separately() {
    let dir = temp_dir("ftp-secrets");
    let path = dir.join("sessions.json");
    let store = Store::load_from(path.clone());

    let mut ftp = profile(SessionKind::Ftp);
    ftp.name = "file-server".into();
    ftp.host = Some("ftp.example.com".into());
    ftp.username = Some("uploader".into());
    ftp.password = Some("ftp-secret".into());
    let saved = store.save(ftp).expect("save ftp profile");

    let raw = std::fs::read_to_string(&path).expect("read profiles");
    assert!(!raw.contains("ftp-secret"));
    assert!(saved.password.is_none());

    let reloaded = Store::load_from(path);
    assert_eq!(
        reloaded
            .get(&saved.id)
            .expect("read ftp password")
            .and_then(|profile| profile.password),
        Some("ftp-secret".into())
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[test]
fn store_files_are_owner_readable_only() {
    use std::os::unix::fs::PermissionsExt;

    let dir = temp_dir("perms");
    let path = dir.join("sessions.json");
    let store = Store::load_from(path.clone());
    let mut saved = profile(SessionKind::Ssh);
    saved.password = Some("private".into());
    store.save(saved).expect("save");
    store
        .save_sender_command(SavedCommand {
            id: String::new(),
            name: "private tag".into(),
            text: "secret command".into(),
            format: SenderFormat::Text,
            ending: LineEnding::Lf,
        })
        .expect("save sender command");

    for file in [
        path,
        dir.join("credentials.json"),
        dir.join("sender_commands.json"),
    ] {
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600, "{} must be private", file.display());
    }

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

#[test]
fn local_file_operations_are_non_recursive() {
    let dir = temp_dir("local-operations");
    let folder = dir.join("folder");
    fs_local::mkdir(folder.to_str().unwrap()).expect("create folder");

    let original = folder.join("original.txt");
    let renamed = folder.join("renamed.txt");
    std::fs::write(&original, b"data").unwrap();
    fs_local::rename(original.to_str().unwrap(), renamed.to_str().unwrap()).expect("rename file");

    assert!(
        fs_local::remove(folder.to_str().unwrap(), true).is_err(),
        "non-empty directories must never be removed recursively"
    );
    fs_local::remove(renamed.to_str().unwrap(), false).expect("remove file");
    fs_local::remove(folder.to_str().unwrap(), true).expect("remove empty folder");

    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test]
async fn zmodem_file_io_uses_bounded_chunks_and_preserves_offsets() {
    const CHUNK_SIZE: usize = 1024 * 1024;

    let dir = temp_dir("zmodem-file-io");
    let path = dir.join("payload.bin");
    let path_string = path.to_string_lossy().into_owned();
    zmodem_create_file(path_string.clone())
        .await
        .expect("create target");

    let first = vec![0x5a; CHUNK_SIZE];
    let second = vec![0xa5; 17];
    zmodem_write_chunk(path_string.clone(), 0, B64.encode(&first))
        .await
        .expect("write first chunk");
    zmodem_write_chunk(path_string.clone(), CHUNK_SIZE as u64, B64.encode(&second))
        .await
        .expect("write second chunk");
    zmodem_finish_file(path_string.clone(), (first.len() + second.len()) as u64)
        .await
        .expect("finish target");

    let info = zmodem_file_info(path_string.clone())
        .await
        .expect("read metadata");
    assert_eq!(info.name, "payload.bin");
    assert_eq!(info.size, (first.len() + second.len()) as u64);

    let encoded = zmodem_read_chunk(path_string.clone(), CHUNK_SIZE as u64, 17)
        .await
        .expect("read second chunk");
    assert_eq!(B64.decode(encoded).unwrap(), second);
    assert!(
        zmodem_read_chunk(path_string.clone(), 0, (CHUNK_SIZE + 1) as u32)
            .await
            .is_err(),
        "reads larger than the fixed application chunk must be rejected"
    );
    assert!(
        zmodem_write_chunk(path_string, 0, B64.encode(vec![0; CHUNK_SIZE + 1]))
            .await
            .is_err(),
        "writes larger than the fixed application chunk must be rejected"
    );

    std::fs::remove_dir_all(&dir).ok();
}
