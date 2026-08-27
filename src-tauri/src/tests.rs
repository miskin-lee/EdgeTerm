use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};

use crate::commands::{
    read_app_data, zmodem_create_file, zmodem_file_info, zmodem_finish_file, zmodem_read_chunk,
    zmodem_write_chunk,
};
use crate::fs_local;
use crate::model::{
    AppData, AuthKind, FileEntry, LineEnding, SavedCommand, SenderFormat, SessionGroup,
    SessionKind, SessionProfile, APP_DATA_APP, APP_DATA_EXTENSION, APP_DATA_FORMAT,
};
use crate::session::{join_remote, sort_entries};
use crate::store::{is_data_file_path, Store};

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
        group_id: None,
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

fn group(name: &str, kind: SessionKind, parent_id: Option<&str>) -> SessionGroup {
    SessionGroup {
        id: String::new(),
        name: name.into(),
        kind,
        parent_id: parent_id.map(str::to_string),
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

fn command(name: &str, text: &str) -> SavedCommand {
    SavedCommand {
        id: String::new(),
        name: name.into(),
        text: text.into(),
        format: SenderFormat::Text,
        ending: LineEnding::Lf,
    }
}

#[test]
fn store_snapshot_never_carries_credentials() {
    let dir = temp_dir("export");
    let store = Store::load_from(dir.join("sessions.json"));

    let mut ssh = profile(SessionKind::Ssh);
    ssh.auth = Some(AuthKind::Password);
    ssh.password = Some("hunter2".into());
    let ssh = store.save(ssh).expect("save ssh");
    let mut key = profile(SessionKind::Ssh);
    key.auth = Some(AuthKind::PublicKey);
    key.private_key_path = Some("/home/me/.ssh/id_ed25519".into());
    key.passphrase = Some("secret".into());
    store.save(key).expect("save key");
    let group = store
        .save_group(group("Prod", SessionKind::Ssh, None))
        .expect("save group");
    store
        .save_sender_command(command("List", "ls"))
        .expect("save command");

    let data = store.snapshot();
    assert_eq!(data.app, APP_DATA_APP);
    assert_eq!(data.format, APP_DATA_FORMAT);
    assert_eq!(data.profiles.len(), 2);
    assert!(data
        .profiles
        .iter()
        .all(|p| p.password.is_none() && p.passphrase.is_none()));
    assert_eq!(data.profiles[0].id, ssh.id);
    assert_eq!(
        data.profiles[1].private_key_path.as_deref(),
        Some("/home/me/.ssh/id_ed25519")
    );
    assert_eq!(data.groups, vec![group]);
    assert_eq!(data.sender_commands.len(), 1);

    let json = serde_json::to_string(&data).expect("serialize");
    assert!(!json.contains("hunter2"));
    assert!(!json.contains("secret"));
    // The local secrets stay usable for reconnects.
    assert_eq!(
        store.get(&ssh.id).expect("get").and_then(|p| p.password),
        Some("hunter2".into())
    );

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn store_import_merges_by_id_and_drops_secrets_and_bad_links() {
    let dir = temp_dir("import");
    let path = dir.join("sessions.json");
    let store = Store::load_from(path.clone());

    let mut local = profile(SessionKind::Ssh);
    local.name = "before".into();
    local.auth = Some(AuthKind::Password);
    local.password = Some("keep-me".into());
    let local = store.save(local).expect("save local");
    let existing_group = store
        .save_group(group("Existing", SessionKind::Ssh, None))
        .expect("save group");
    let existing_command = store
        .save_sender_command(command("Old", "ls"))
        .expect("save command");

    let mut replaced = local.clone();
    replaced.name = "after".into();
    replaced.password = Some("from-file".into());
    replaced.group_id = Some(existing_group.id.clone());
    let mut orphan = profile(SessionKind::Serial);
    orphan.id = "serial-1".into();
    // A serial profile cannot live in an SSH group.
    orphan.group_id = Some(existing_group.id.clone());
    let mut stray = profile(SessionKind::Ssh);
    stray.id = "ssh-2".into();
    stray.group_id = Some("no-such-group".into());
    let mut fresh = profile(SessionKind::Local);
    fresh.passphrase = Some("x".into());

    let mut renamed_command = existing_command.clone();
    renamed_command.name = "Renamed".into();

    let data = AppData {
        app: APP_DATA_APP.into(),
        format: APP_DATA_FORMAT,
        exported_at: None,
        settings: None,
        profiles: vec![replaced, orphan, stray, fresh],
        groups: vec![
            SessionGroup {
                id: "a".into(),
                name: "  A  ".into(),
                kind: SessionKind::Ssh,
                parent_id: Some("b".into()),
            },
            SessionGroup {
                id: "b".into(),
                name: "B".into(),
                kind: SessionKind::Ssh,
                parent_id: Some("a".into()),
            },
            SessionGroup {
                id: "c".into(),
                name: "C".into(),
                kind: SessionKind::Serial,
                parent_id: Some("a".into()),
            },
            SessionGroup {
                id: "d".into(),
                name: "D".into(),
                kind: SessionKind::Ssh,
                parent_id: Some("missing".into()),
            },
            group("   ", SessionKind::Ssh, None),
            // Same id as an existing group of another kind: refused.
            SessionGroup {
                id: existing_group.id.clone(),
                name: "Existing".into(),
                kind: SessionKind::Ftp,
                parent_id: None,
            },
        ],
        sender_commands: vec![renamed_command.clone(), command("New", "pwd")],
    };

    let summary = store.import_data(data).expect("import");
    assert_eq!(summary.profiles, 4);
    assert_eq!(summary.groups, 4);
    assert_eq!(summary.sender_commands, 2);
    assert_eq!(summary.skipped_sender_commands, 0);

    let profiles = store.list();
    assert_eq!(profiles.len(), 4);
    assert!(profiles
        .iter()
        .all(|p| p.password.is_none() && p.passphrase.is_none()));
    let after = profiles
        .iter()
        .find(|p| p.id == local.id)
        .expect("replaced");
    assert_eq!(after.name, "after");
    assert_eq!(after.group_id.as_deref(), Some(existing_group.id.as_str()));
    // Local credentials survive a same-id import; the file's password is ignored.
    assert_eq!(
        store.get(&local.id).expect("get").and_then(|p| p.password),
        Some("keep-me".into())
    );
    assert_eq!(
        profiles
            .iter()
            .find(|p| p.id == "serial-1")
            .unwrap()
            .group_id,
        None
    );
    assert_eq!(
        profiles.iter().find(|p| p.id == "ssh-2").unwrap().group_id,
        None
    );
    assert!(profiles.iter().all(|p| !p.id.is_empty()));

    let groups = store.list_groups();
    // The blank-named group and the kind-changing one were refused.
    assert_eq!(groups.len(), 5);
    let find = |id: &str| groups.iter().find(|g| g.id == id).expect(id);
    assert_eq!(find(&existing_group.id).kind, SessionKind::Ssh);
    assert_eq!(find("a").name, "A");
    // The a ↔ b cycle is broken at one end, "c" cannot hang under another
    // kind, and "d" pointed nowhere.
    let linked: Vec<_> = ["a", "b"]
        .iter()
        .filter(|id| find(id).parent_id.is_some())
        .collect();
    assert_eq!(linked.len(), 1);
    assert_eq!(find("c").parent_id, None);
    assert_eq!(find("d").parent_id, None);

    let commands = store.list_sender_commands();
    assert_eq!(commands.len(), 2);
    assert_eq!(commands[0], renamed_command);
    assert_eq!(commands[1].name, "New");

    // Everything was persisted, and reopening is safe.
    let reloaded = Store::load_from(path);
    assert_eq!(reloaded.list().len(), 4);
    assert_eq!(reloaded.list_groups().len(), 5);
    assert_eq!(reloaded.list_sender_commands().len(), 2);

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn store_import_refuses_foreign_or_newer_files() {
    let dir = temp_dir("import-refuse");
    let store = Store::load_from(dir.join("sessions.json"));
    let mut data = store.snapshot();
    data.app = "Other".into();
    assert!(store.import_data(data.clone()).is_err());
    data.app = APP_DATA_APP.into();
    data.format = APP_DATA_FORMAT + 1;
    assert!(store.import_data(data.clone()).is_err());
    data.format = 0;
    assert!(store.import_data(data).is_err());
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn data_files_are_recognised_by_extension_and_contents() {
    assert_eq!(APP_DATA_EXTENSION, "edgeterm");
    assert!(is_data_file_path(Path::new("backup.edgeterm")));
    assert!(is_data_file_path(Path::new("/tmp/A.EDGETERM")));
    assert!(!is_data_file_path(Path::new("backup.json")));
    assert!(!is_data_file_path(Path::new("edgeterm")));
    assert!(!is_data_file_path(Path::new("backup.edgeterm.json")));

    let dir = temp_dir("data-file");
    let store = Store::load_from(dir.join("sessions.json"));
    let mut ssh = profile(SessionKind::Ssh);
    ssh.auth = Some(AuthKind::Password);
    ssh.password = Some("hunter2".into());
    store.save(ssh).expect("save");
    let valid = serde_json::to_string(&store.snapshot()).expect("serialize");

    // Right contents, wrong name: refused before the file is even read.
    let json = dir.join("backup.json");
    std::fs::write(&json, &valid).expect("write json");
    let error = read_app_data(json.display().to_string()).expect_err("json refused");
    assert!(error.to_string().contains(".edgeterm"), "{error}");

    // Right name, wrong contents.
    let garbage = dir.join("garbage.edgeterm");
    std::fs::write(&garbage, "not json").expect("write garbage");
    assert!(read_app_data(garbage.display().to_string()).is_err());
    let foreign = dir.join("foreign.edgeterm");
    std::fs::write(&foreign, r#"{"app":"Other","format":1}"#).expect("write foreign");
    assert!(read_app_data(foreign.display().to_string()).is_err());
    let missing = dir.join("missing.edgeterm");
    assert!(read_app_data(missing.display().to_string()).is_err());

    // Right name and contents; a password smuggled into the file is dropped.
    let good = dir.join("backup.edgeterm");
    let smuggled = valid.replace("\"password\":null", "\"password\":\"x\"");
    assert_ne!(smuggled, valid, "the snapshot serialises an empty password");
    std::fs::write(&good, smuggled).expect("write");
    let data = read_app_data(good.display().to_string()).expect("read");
    assert_eq!(data.app, APP_DATA_APP);
    assert_eq!(data.profiles.len(), 1);
    assert!(data.profiles[0].password.is_none());

    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn store_merges_and_persists_command_history() {
    let dir = temp_dir("history");
    let path = dir.join("sessions.json");
    let store = Store::load_from(path.clone());

    store.record_command("ls -la", "ssh:db:22").unwrap();
    store.record_command("ls -la", "ssh:db:22").unwrap();
    store.record_command("make test  ", "shell:/bin/zsh").unwrap();
    store.record_command("   ", "shell:/bin/zsh").unwrap();

    let entries = store.list_command_history();
    assert_eq!(entries.len(), 2, "duplicates merge, blank lines are dropped");
    let ls = entries
        .iter()
        .find(|entry| entry.command == "ls -la")
        .expect("merged entry");
    assert_eq!(ls.count, 2);
    assert_eq!(ls.host, "ssh:db:22");
    assert!(
        entries.iter().any(|entry| entry.command == "make test"),
        "trailing whitespace is trimmed before storing"
    );

    let reloaded = Store::load_from(path);
    assert_eq!(reloaded.list_command_history().len(), 2);
    reloaded.clear_command_history().unwrap();
    assert!(reloaded.list_command_history().is_empty());

    let _ = std::fs::remove_dir_all(dir);
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

#[test]
fn store_round_trips_session_groups_and_profile_membership() {
    let dir = temp_dir("groups");
    let path = dir.join("sessions.json");
    let store = Store::load_from(path.clone());

    let prod = store
        .save_group(group("  prod  ", SessionKind::Ssh, None))
        .expect("save group");
    assert!(!prod.id.is_empty());
    // Names are trimmed before they are stored.
    assert_eq!(prod.name, "prod");
    let eu = store
        .save_group(group("eu", SessionKind::Ssh, Some(&prod.id)))
        .expect("save nested group");

    let mut member = profile(SessionKind::Ssh);
    member.group_id = Some(eu.id.clone());
    let member = store.save(member).expect("save profile");
    assert_eq!(member.group_id.as_deref(), Some(eu.id.as_str()));

    // A profile of another kind cannot sit in an SSH group; it falls back to
    // its own kind root rather than being rejected or stranded.
    let mut stray = profile(SessionKind::Serial);
    stray.group_id = Some(eu.id.clone());
    let stray = store.save(stray).expect("save stray profile");
    assert_eq!(stray.group_id, None);

    // Everything survives a reload from disk.
    let reloaded = Store::load_from(path);
    let groups = reloaded.list_groups();
    assert_eq!(groups.len(), 2);
    assert!(groups
        .iter()
        .any(|g| g.id == eu.id && g.parent_id.as_deref() == Some(&*prod.id)));
    let saved = reloaded
        .list()
        .into_iter()
        .find(|p| p.id == member.id)
        .expect("member profile persisted");
    assert_eq!(saved.group_id.as_deref(), Some(eu.id.as_str()));

    // sessions.json itself stays a plain profile array for older builds.
    let raw = std::fs::read_to_string(dir.join("sessions.json")).expect("read sessions.json");
    assert!(raw.trim_start().starts_with('['));
    assert!(dir.join("session_groups.json").exists());

    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn store_rejects_invalid_group_shapes() {
    let dir = temp_dir("groups-invalid");
    let store = Store::load_from(dir.join("sessions.json"));

    assert!(store
        .save_group(group("   ", SessionKind::Ssh, None))
        .is_err());
    assert!(store
        .save_group(group("orphan", SessionKind::Ssh, Some("missing")))
        .is_err());

    let ssh = store
        .save_group(group("ssh", SessionKind::Ssh, None))
        .expect("save ssh group");
    // Groups nest only within one session kind.
    assert!(store
        .save_group(group("ftp", SessionKind::Ftp, Some(&ssh.id)))
        .is_err());

    let child = store
        .save_group(group("child", SessionKind::Ssh, Some(&ssh.id)))
        .expect("save child");
    // No cycles: neither self-parenting nor moving under a descendant.
    let mut looped = ssh.clone();
    looped.parent_id = Some(ssh.id.clone());
    assert!(store.save_group(looped).is_err());
    let mut looped = ssh.clone();
    looped.parent_id = Some(child.id.clone());
    assert!(store.save_group(looped).is_err());
    // A group keeps its kind for life.
    let mut switched = ssh.clone();
    switched.kind = SessionKind::Ftp;
    assert!(store.save_group(switched).is_err());

    // Renaming in place is fine and keeps the id.
    let mut renamed = child.clone();
    renamed.name = "renamed".into();
    let renamed = store.save_group(renamed).expect("rename");
    assert_eq!(renamed.id, child.id);
    assert_eq!(store.list_groups().len(), 2);

    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn deleting_a_group_removes_its_subtree_and_lifts_profiles_to_the_parent() {
    let dir = temp_dir("groups-delete");
    let path = dir.join("sessions.json");
    let store = Store::load_from(path.clone());

    let root = store
        .save_group(group("root", SessionKind::Ssh, None))
        .expect("root");
    let mid = store
        .save_group(group("mid", SessionKind::Ssh, Some(&root.id)))
        .expect("mid");
    let leaf = store
        .save_group(group("leaf", SessionKind::Ssh, Some(&mid.id)))
        .expect("leaf");
    let sibling = store
        .save_group(group("sibling", SessionKind::Ssh, Some(&root.id)))
        .expect("sibling");

    let mut in_mid = profile(SessionKind::Ssh);
    in_mid.group_id = Some(mid.id.clone());
    let in_mid = store.save(in_mid).expect("save in_mid");
    let mut in_leaf = profile(SessionKind::Ssh);
    in_leaf.group_id = Some(leaf.id.clone());
    let in_leaf = store.save(in_leaf).expect("save in_leaf");
    let mut in_sibling = profile(SessionKind::Ssh);
    in_sibling.group_id = Some(sibling.id.clone());
    let in_sibling = store.save(in_sibling).expect("save in_sibling");

    store.delete_group(&mid.id).expect("delete mid");

    let remaining: Vec<String> = store.list_groups().into_iter().map(|g| g.id).collect();
    assert!(remaining.contains(&root.id));
    assert!(remaining.contains(&sibling.id));
    assert!(!remaining.contains(&mid.id));
    assert!(!remaining.contains(&leaf.id));

    let find = |id: &str| {
        store
            .list()
            .into_iter()
            .find(|p| p.id == id)
            .expect("profile still exists")
    };
    // Both the direct member and the nested one move up to mid's parent.
    assert_eq!(find(&in_mid.id).group_id.as_deref(), Some(root.id.as_str()));
    assert_eq!(
        find(&in_leaf.id).group_id.as_deref(),
        Some(root.id.as_str())
    );
    assert_eq!(
        find(&in_sibling.id).group_id.as_deref(),
        Some(sibling.id.as_str())
    );

    // Deleting a top-level group puts its profiles at the kind root, and the
    // result is what a fresh process reads back.
    store.delete_group(&root.id).expect("delete root");
    let reloaded = Store::load_from(path);
    assert!(reloaded.list_groups().is_empty());
    assert!(reloaded.list().iter().all(|p| p.group_id.is_none()));

    // Unknown ids are a no-op rather than an error.
    reloaded.delete_group("nope").expect("delete unknown");

    std::fs::remove_dir_all(dir).ok();
}
