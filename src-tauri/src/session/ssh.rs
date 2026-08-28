use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::client::{self, Handle, Msg};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::known_hosts::{
    check_known_hosts_path, known_host_keys_path, learn_known_hosts_path,
};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{Channel, ChannelMsg};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{OpenFlags, StatusCode};
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc::UnboundedReceiver;

use super::transfer::{
    ensure_local_directory, plan_local_upload, safe_local_child, validate_local_file_target,
    ProgressReporter,
};
use super::{
    emit_state, join_remote, sort_entries, OutputPump, SessionCommand, SftpRequest, SftpResponse,
    TransferProgress,
};
use crate::error::{AppError, Result};
use crate::model::{AuthKind, DirListing, FileEntry, HostKeyChange, SessionProfile};

/// How long output may sit in the pump before it is flushed to the UI.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
const TRANSFER_CHUNK_SIZE: usize = 1024 * 1024;
/// How often an SFTP-only session, which has no channel to read from, checks
/// that its transport is still alive so a dropped connection is reported.
const SFTP_HEALTH_INTERVAL: Duration = Duration::from_secs(5);

/// Host key policy: trust on first use, refuse on change.
///
/// An unknown host is recorded in `~/.ssh/known_hosts` and accepted (OpenSSH's
/// `StrictHostKeyChecking=accept-new`). A host whose key no longer matches the
/// recorded one is refused outright.
struct Client {
    host: String,
    port: u16,
}

/// Why the handshake failed. Carrying the host key verdict out of the russh
/// handler lets `connect` report a refused key to the user instead of
/// surfacing russh's terse "Unknown server key".
#[derive(Debug)]
enum HandshakeError {
    Ssh(russh::Error),
    /// `known_hosts` line `line` records a different key of the same
    /// algorithm for this host, so the connection was refused.
    HostKeyChanged {
        known_hosts: PathBuf,
        line: usize,
        key: PublicKey,
    },
}

impl From<russh::Error> for HandshakeError {
    fn from(e: russh::Error) -> Self {
        HandshakeError::Ssh(e)
    }
}

impl client::Handler for Client {
    type Error = HandshakeError;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        match known_hosts_file() {
            Some(path) => {
                verify_host_key(&self.host, self.port, server_public_key, &path).map(|()| true)
            }
            // Without a home directory there is nothing to check against or
            // to record into.
            None => Ok(true),
        }
    }
}

fn known_hosts_file() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh").join("known_hosts"))
}

/// Apply the accept-new policy against the entries in `known_hosts`.
fn verify_host_key(
    host: &str,
    port: u16,
    key: &PublicKey,
    known_hosts: &Path,
) -> std::result::Result<(), HandshakeError> {
    match check_known_hosts_path(host, port, key, known_hosts) {
        Ok(true) => Ok(()),
        Err(russh::keys::Error::KeyChanged { line }) => Err(HandshakeError::HostKeyChanged {
            known_hosts: known_hosts.to_path_buf(),
            line: known_hosts_line_number(known_hosts, line),
            key: key.clone(),
        }),
        // An unknown host, or a known_hosts file that is missing or cannot be
        // parsed: learn and continue.
        Ok(false) | Err(_) => {
            let _ = learn_known_hosts_path(host, port, key, known_hosts);
            Ok(())
        }
    }
}

/// russh numbers the line in `KeyChanged` without counting `#` comment lines,
/// so map its index back to the real line number in the file.
fn known_hosts_line_number(known_hosts: &Path, russh_line: usize) -> usize {
    let Ok(content) = std::fs::read_to_string(known_hosts) else {
        return russh_line;
    };
    content
        .lines()
        .enumerate()
        .filter(|(_, line)| !line.starts_with('#'))
        .nth(russh_line.saturating_sub(1))
        .map(|(index, _)| index + 1)
        .unwrap_or(russh_line)
}

/// Record `key` as the only key for `host:port`, dropping every entry the
/// file held for it. Accepting a changed key means the user decided the
/// address now belongs to a different server, so its other recorded keys are
/// stale too: this is `ssh-keygen -R` followed by a fresh first contact.
fn replace_host_key(host: &str, port: u16, key: &PublicKey, known_hosts: &Path) -> Result<()> {
    let stale: HashSet<usize> = known_host_keys_path(host, port, known_hosts)
        .map_err(|e| AppError::new(format!("cannot read {}: {e}", known_hosts.display())))?
        .into_iter()
        .map(|(line, _)| line)
        .collect();
    if !stale.is_empty() {
        let content = std::fs::read_to_string(known_hosts)?;
        // Walk the file the way russh numbers it: comment lines do not count.
        let mut index = 0;
        let mut kept = String::with_capacity(content.len());
        for line in content.split_inclusive('\n') {
            if !line.starts_with('#') {
                index += 1;
                if stale.contains(&index) {
                    continue;
                }
            }
            kept.push_str(line);
        }
        std::fs::write(known_hosts, kept)?;
    }
    learn_known_hosts_path(host, port, key, known_hosts)
        .map_err(|e| AppError::new(format!("cannot update {}: {e}", known_hosts.display())))
}

/// Accept the key a host presented after it was refused as changed:
/// `public_key` is the OpenSSH public key line from the reported
/// `HostKeyChange`, and it replaces the host's `known_hosts` entries.
pub fn accept_host_key(host: &str, port: u16, public_key: &str) -> Result<()> {
    let key = PublicKey::from_openssh(public_key)
        .map_err(|e| AppError::new(format!("invalid host key: {e}")))?;
    let known_hosts = known_hosts_file()
        .ok_or_else(|| AppError::new("cannot locate ~/.ssh/known_hosts: no home directory"))?;
    replace_host_key(host, port, &key, &known_hosts)
}

/// Describe a refused host key for the frontend, which shows it to the user
/// and offers to accept the new key.
fn describe_host_key_change(
    host: &str,
    port: u16,
    known_hosts: &Path,
    line: usize,
    key: &PublicKey,
) -> Result<HostKeyChange> {
    let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
    let public_key = key
        .to_openssh()
        .map_err(|e| AppError::new(format!("cannot encode host key: {e}")))?;
    Ok(HostKeyChange {
        message: format!(
            "host key for {host}:{port} has changed: the server now presents {fingerprint}, \
             which does not match {} line {line}",
            known_hosts.display()
        ),
        host: host.to_string(),
        port,
        key_type: key.algorithm().to_string(),
        fingerprint,
        public_key,
        known_hosts: known_hosts.display().to_string(),
        line,
    })
}

pub struct SshConnection {
    handle: Arc<Handle<Client>>,
    channel: Channel<Msg>,
}

pub enum ConnectOutcome {
    Ready(SshConnection),
    /// The handshake was refused because the host's key changed; nothing was
    /// opened. The user may accept the key and connect again.
    HostKeyChanged(HostKeyChange),
}

/// An SSH transport that carries only the SFTP subsystem: a file-transfer
/// session with no shell channel or PTY. See `spawn_sftp`.
pub struct SftpConnection {
    handle: Arc<Handle<Client>>,
}

pub enum SftpConnectOutcome {
    Ready(SftpConnection),
    HostKeyChanged(HostKeyChange),
}

/// An authenticated transport, or the host-key decision that has to be made
/// before one can be established. Shared by the shell and SFTP entry points.
enum HandleOutcome {
    Ready(Handle<Client>),
    HostKeyChanged(HostKeyChange),
}

/// Opens the transport and authenticates, applying the trust-on-first-use host
/// key policy. It stops short of requesting any channel, so both an interactive
/// shell and a bare SFTP subsystem can be layered on top of the same handshake.
async fn connect_handle(profile: &SessionProfile) -> Result<HandleOutcome> {
    let host = profile
        .host
        .clone()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| AppError::new("session is missing a host"))?;
    let port = profile.port.unwrap_or(22);
    let username = profile
        .username
        .clone()
        .filter(|u| !u.is_empty())
        .ok_or_else(|| AppError::new("session is missing a username"))?;

    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });

    let mut handle = match client::connect(
        config,
        (host.as_str(), port),
        Client {
            host: host.clone(),
            port,
        },
    )
    .await
    {
        Ok(handle) => handle,
        Err(HandshakeError::HostKeyChanged {
            known_hosts,
            line,
            key,
        }) => {
            return Ok(HandleOutcome::HostKeyChanged(describe_host_key_change(
                &host,
                port,
                &known_hosts,
                line,
                &key,
            )?));
        }
        Err(HandshakeError::Ssh(e)) => {
            return Err(AppError::new(format!("cannot reach {host}:{port}: {e}")));
        }
    };

    authenticate(&mut handle, profile, &username).await?;
    Ok(HandleOutcome::Ready(handle))
}

pub async fn connect(profile: &SessionProfile) -> Result<ConnectOutcome> {
    let handle = match connect_handle(profile).await? {
        HandleOutcome::Ready(handle) => Arc::new(handle),
        HandleOutcome::HostKeyChanged(change) => {
            return Ok(ConnectOutcome::HostKeyChanged(change));
        }
    };

    let channel = handle.channel_open_session().await?;
    channel
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await?;
    // Servers may ignore environment requests, but those that accept them let
    // modern CLI applications select their 24-bit color output automatically.
    let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
    let _ = channel.set_env(false, "TERM_PROGRAM", "EdgeTerm").await;
    channel.request_shell(true).await?;

    Ok(ConnectOutcome::Ready(SshConnection { handle, channel }))
}

/// Opens an SFTP-only session: the same SSH handshake and authentication as a
/// shell session, but no channel is requested up front. The SFTP subsystem is
/// opened lazily on the first file request, exactly as it is for a shell
/// session's Filer.
pub async fn connect_sftp(profile: &SessionProfile) -> Result<SftpConnectOutcome> {
    match connect_handle(profile).await? {
        HandleOutcome::Ready(handle) => Ok(SftpConnectOutcome::Ready(SftpConnection {
            handle: Arc::new(handle),
        })),
        HandleOutcome::HostKeyChanged(change) => Ok(SftpConnectOutcome::HostKeyChanged(change)),
    }
}

async fn authenticate(
    handle: &mut Handle<Client>,
    profile: &SessionProfile,
    username: &str,
) -> Result<()> {
    let auth = profile.auth.unwrap_or_default();
    let result = match auth {
        AuthKind::Password => {
            let password = profile.password.clone().unwrap_or_default();
            handle.authenticate_password(username, password).await?
        }
        AuthKind::PublicKey => {
            let path = profile
                .private_key_path
                .clone()
                .filter(|p| !p.is_empty())
                .ok_or_else(|| AppError::new("public-key auth needs a private key path"))?;
            let path = expand_tilde(&path);
            let passphrase = profile.passphrase.as_deref().filter(|p| !p.is_empty());
            let key = russh::keys::load_secret_key(&path, passphrase)
                .map_err(|e| AppError::new(format!("cannot load {path}: {e}")))?;
            // Modern servers reject SHA-1 RSA signatures; ask the server which
            // hash it accepts before signing.
            let hash = handle.best_supported_rsa_hash().await?.flatten();
            handle
                .authenticate_publickey(username, PrivateKeyWithHashAlg::new(Arc::new(key), hash))
                .await?
        }
        AuthKind::Agent => return authenticate_agent(handle, username).await,
    };

    if result.success() {
        Ok(())
    } else {
        Err(AppError::new(format!(
            "authentication failed for {username} ({})",
            match auth {
                AuthKind::Password => "password",
                AuthKind::PublicKey => "public key",
                AuthKind::Agent => "agent",
            }
        )))
    }
}

async fn authenticate_agent(handle: &mut Handle<Client>, username: &str) -> Result<()> {
    let mut agent = connect_agent().await?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::new(format!("the ssh agent has no usable identities: {e}")))?;
    if identities.is_empty() {
        return Err(AppError::new("the ssh agent holds no identities"));
    }

    let hash = handle.best_supported_rsa_hash().await?.flatten();
    for identity in identities {
        let key = match &identity {
            russh::keys::agent::AgentIdentity::PublicKey { key, .. } => key.clone(),
            russh::keys::agent::AgentIdentity::Certificate { certificate, .. } => {
                match PublicKey::try_from(certificate.public_key().clone()) {
                    Ok(k) => k,
                    Err(_) => continue,
                }
            }
        };
        let result = handle
            .authenticate_publickey_with(username, key, hash, &mut agent)
            .await
            .map_err(|e| AppError::new(format!("agent authentication failed: {e}")))?;
        if result.success() {
            return Ok(());
        }
    }
    Err(AppError::new(format!(
        "no identity in the ssh agent was accepted for {username}"
    )))
}

type DynamicAgentClient = AgentClient<Box<dyn AgentStream + Send + Unpin>>;

#[cfg(unix)]
async fn connect_agent() -> Result<DynamicAgentClient> {
    AgentClient::connect_env()
        .await
        .map(AgentClient::dynamic)
        .map_err(|e| AppError::new(format!("cannot reach the ssh agent: {e}")))
}

#[cfg(windows)]
async fn connect_agent() -> Result<DynamicAgentClient> {
    // Windows OpenSSH exposes its agent through this named pipe. Respect an
    // explicit SSH_AUTH_SOCK first so compatible third-party agents can
    // override it, then fall back to PuTTY's Pageant transport.
    let pipe =
        std::env::var_os("SSH_AUTH_SOCK").unwrap_or_else(|| r"\\.\pipe\openssh-ssh-agent".into());
    let named_pipe_error = match AgentClient::connect_named_pipe(&pipe).await {
        Ok(agent) => return Ok(agent.dynamic()),
        Err(error) => error,
    };

    match AgentClient::connect_pageant().await {
        Ok(agent) => Ok(agent.dynamic()),
        Err(pageant_error) => Err(AppError::new(format!(
            "cannot reach a Windows SSH agent (OpenSSH: {named_pipe_error}; Pageant: {pageant_error})"
        ))),
    }
}

/// Drives one SSH shell session: pumps channel output to the UI and applies
/// commands coming back from it.
pub fn spawn(
    app: AppHandle,
    id: String,
    conn: SshConnection,
    mut rx: UnboundedReceiver<SessionCommand>,
) {
    tauri::async_runtime::spawn(async move {
        let SshConnection { handle, channel } = conn;
        let (mut reader, writer) = channel.split();
        let mut pump = OutputPump::new(app.clone(), id.clone());
        let mut sftp: Option<Arc<SftpSession>> = None;
        let mut exit_status: Option<u32> = None;
        // Set when the frontend asked for the close; see `emit_state`.
        let mut close_requested = false;

        emit_state(&app, &id, "connected", None);

        loop {
            tokio::select! {
                msg = reader.wait() => {
                    match msg {
                        Some(ChannelMsg::Data { data }) => pump.push(&data),
                        Some(ChannelMsg::ExtendedData { data, .. }) => pump.push(&data),
                        Some(ChannelMsg::ExitStatus { exit_status: code }) => exit_status = Some(code),
                        Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                        Some(_) => {}
                    }
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(SessionCommand::Write(data)) => {
                            if writer.data_bytes(data).await.is_err() {
                                break;
                            }
                        }
                        Some(SessionCommand::WriteConfirmed { data, reply }) => {
                            let result = writer.data_bytes(data).await.map_err(AppError::from);
                            let failed = result.is_err();
                            let _ = reply.send(result);
                            if failed {
                                break;
                            }
                        }
                        Some(SessionCommand::Resize { cols, rows }) => {
                            let _ = writer.window_change(cols as u32, rows as u32, 0, 0).await;
                        }
                        Some(SessionCommand::Sftp { request, reply }) => {
                            match ensure_sftp(&handle, &mut sftp).await {
                                Ok(session) => {
                                    // Run off the session loop so a large transfer
                                    // never stalls terminal output.
                                    tauri::async_runtime::spawn(async move {
                                        let _ = reply.send(run_sftp(session, request).await);
                                    });
                                }
                                Err(e) => {
                                    let _ = reply.send(Err(e));
                                }
                            }
                        }
                        Some(SessionCommand::Close) | None => {
                            close_requested = true;
                            let _ = writer.eof().await;
                            let _ = writer.close().await;
                            break;
                        }
                    }
                }
                _ = tokio::time::sleep(FLUSH_INTERVAL), if !pump.is_empty() => pump.flush(),
            }
        }

        pump.flush();
        if !close_requested {
            emit_state(
                &app,
                &id,
                "closed",
                exit_status.map(|c| format!("exit status {c}")),
            );
        }
    });
}

/// Drives an SFTP-only session. There is no shell channel to pump, so the loop
/// serves file requests off the SFTP subsystem and periodically checks that the
/// transport is still up. Like the other file backends it does not announce
/// "connected" itself — the frontend records that when `open_session` returns,
/// after the manager has the command handle, so the file pane's first request
/// cannot race the insertion (see `emit_state`).
pub fn spawn_sftp(
    app: AppHandle,
    id: String,
    conn: SftpConnection,
    mut rx: UnboundedReceiver<SessionCommand>,
) {
    tauri::async_runtime::spawn(async move {
        let handle = conn.handle;
        let mut sftp: Option<Arc<SftpSession>> = None;
        // Set when the frontend asked for the close; see `emit_state`.
        let mut close_requested = false;

        loop {
            tokio::select! {
                cmd = rx.recv() => {
                    match cmd {
                        Some(SessionCommand::Sftp { request, reply }) => {
                            match ensure_sftp(&handle, &mut sftp).await {
                                Ok(session) => {
                                    // Run off the session loop so a large
                                    // transfer never stalls the next request.
                                    tauri::async_runtime::spawn(async move {
                                        let _ = reply.send(run_sftp(session, request).await);
                                    });
                                }
                                Err(e) => {
                                    let _ = reply.send(Err(e));
                                }
                            }
                        }
                        Some(SessionCommand::Close) | None => {
                            close_requested = true;
                            break;
                        }
                        // A file-only session has no terminal, so keyboard
                        // input and resize map to nothing and binary terminal
                        // data is rejected, matching the other file backends.
                        Some(other) => super::reject_sftp(other, crate::model::SessionKind::Sftp),
                    }
                }
                _ = tokio::time::sleep(SFTP_HEALTH_INTERVAL) => {
                    if handle.is_closed() {
                        break;
                    }
                }
            }
        }

        if !close_requested {
            emit_state(&app, &id, "closed", None);
        }
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
    });
}

async fn ensure_sftp(
    handle: &Handle<Client>,
    slot: &mut Option<Arc<SftpSession>>,
) -> Result<Arc<SftpSession>> {
    if let Some(existing) = slot {
        return Ok(existing.clone());
    }
    let channel = handle.channel_open_session().await?;
    channel.request_subsystem(true, "sftp").await?;
    let session = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| AppError::new(format!("the server refused the sftp subsystem: {e}")))?;
    let session = Arc::new(session);
    *slot = Some(session.clone());
    Ok(session)
}

async fn run_sftp(sftp: Arc<SftpSession>, request: SftpRequest) -> Result<SftpResponse> {
    match request {
        SftpRequest::Home => Ok(SftpResponse::Path(sftp.canonicalize(".").await?)),
        SftpRequest::Canonicalize { path } => {
            Ok(SftpResponse::Path(sftp.canonicalize(path).await?))
        }
        SftpRequest::List { path } => {
            let base = match sftp.canonicalize(path.clone()).await {
                Ok(p) => p,
                Err(_) => path,
            };
            let mut entries = Vec::new();
            for entry in sftp.read_dir(base.clone()).await? {
                let meta = entry.metadata();
                let name = entry.file_name();
                entries.push(FileEntry {
                    path: join_remote(&base, &name),
                    name,
                    is_dir: entry.file_type().is_dir(),
                    is_symlink: meta.is_symlink(),
                    size: meta.size.unwrap_or(0),
                    modified: meta.mtime.map(|t| t as i64),
                    permissions: meta.permissions,
                    owner: meta.user.clone(),
                    group: meta.group.clone(),
                });
            }
            sort_entries(&mut entries);
            Ok(SftpResponse::Listing(DirListing {
                path: base,
                entries,
            }))
        }
        SftpRequest::Mkdir { path } => {
            sftp.create_dir(path).await?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::CreateFile { path } => {
            // EXCLUDE makes the server reject the open when the path exists,
            // so a typo in the name can never truncate a real file.
            let mut file = sftp
                .open_with_flags(
                    path,
                    OpenFlags::CREATE | OpenFlags::WRITE | OpenFlags::EXCLUDE,
                )
                .await?;
            file.shutdown().await?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::Remove { path, is_dir } => {
            if is_dir {
                sftp.remove_dir(path).await?;
            } else {
                sftp.remove_file(path).await?;
            }
            Ok(SftpResponse::Done)
        }
        SftpRequest::Rename { from, to } => {
            sftp.rename(from, to).await?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::Download {
            remote,
            local,
            progress,
        } => {
            download_file(&sftp, &remote, &local, &progress).await?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::DownloadDirectory {
            remote,
            local,
            progress,
        } => {
            download_directory(&sftp, &remote, &local, &progress).await?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::Upload {
            local,
            remote,
            progress,
        } => {
            upload_file(&sftp, &local, &remote, &progress).await?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::UploadDirectory {
            local,
            remote,
            progress,
        } => {
            upload_directory(&sftp, &local, &remote, &progress).await?;
            Ok(SftpResponse::Done)
        }
    }
}

async fn download_file(
    sftp: &SftpSession,
    remote: &str,
    local: &str,
    progress: &tauri::ipc::Channel<TransferProgress>,
) -> Result<()> {
    let total = sftp.metadata(remote).await?.size.unwrap_or(0);
    let mut last_report = Instant::now();

    report_transfer_progress(progress, 0, total);
    let transferred = copy_remote_file(sftp, remote, Path::new(local), |transferred| {
        if last_report.elapsed() >= TRANSFER_PROGRESS_INTERVAL {
            report_transfer_progress(progress, transferred, total);
            last_report = Instant::now();
        }
    })
    .await?;
    report_transfer_progress(progress, transferred, total);
    Ok(())
}

struct SftpDownloadJob {
    remote: String,
    local: PathBuf,
}

async fn download_directory(
    sftp: &SftpSession,
    remote: &str,
    local: &str,
    progress: &tauri::ipc::Channel<TransferProgress>,
) -> Result<()> {
    let local_root = PathBuf::from(local);
    let mut pending = vec![(remote.to_string(), local_root.clone())];
    let mut directories = vec![local_root];
    let mut files = Vec::new();
    let mut total = 0_u64;

    // Metadata-only plan first so progress covers the whole tree. Contents
    // are still copied one file at a time through the fixed 1 MiB buffer.
    while let Some((remote_dir, local_dir)) = pending.pop() {
        for entry in sftp.read_dir(remote_dir.clone()).await? {
            let name = entry.file_name();
            if matches!(name.as_str(), "." | "..") {
                continue;
            }
            let local_child = safe_local_child(&local_dir, &name)?;
            let remote_child = join_remote(&remote_dir, &name);
            let mut file_type = entry.file_type();
            let mut size = entry.metadata().size.unwrap_or(0);
            if file_type.is_symlink() {
                // Follow links to files; skip dangling links and links to
                // directories, which could loop back into an ancestor.
                match sftp.metadata(remote_child.clone()).await {
                    Ok(target) => {
                        file_type = target.file_type();
                        size = target.size.unwrap_or(0);
                    }
                    Err(SftpError::Status(status))
                        if status.status_code == StatusCode::NoSuchFile =>
                    {
                        continue
                    }
                    Err(error) => return Err(error.into()),
                }
                if file_type.is_dir() {
                    continue;
                }
            }

            if file_type.is_dir() {
                directories.push(local_child.clone());
                pending.push((remote_child, local_child));
            } else {
                total = total.checked_add(size).ok_or_else(|| {
                    AppError::new("remote folder is too large to report transfer progress")
                })?;
                files.push(SftpDownloadJob {
                    remote: remote_child,
                    local: local_child,
                });
            }
        }
    }

    let files = tokio::task::spawn_blocking(move || -> Result<Vec<SftpDownloadJob>> {
        for directory in &directories {
            ensure_local_directory(directory)?;
        }
        for file in &files {
            validate_local_file_target(&file.local)?;
        }
        Ok(files)
    })
    .await
    .map_err(|error| AppError::new(format!("local folder preparation failed: {error}")))??;

    let mut reporter = ProgressReporter::begin(progress, total);
    let mut transferred = 0_u64;
    for file in files {
        let completed_before_file = transferred;
        let copied = copy_remote_file(sftp, &file.remote, &file.local, |file_transferred| {
            reporter.update(completed_before_file.saturating_add(file_transferred));
        })
        .await?;
        transferred = transferred.saturating_add(copied);
    }
    reporter.finish(transferred);
    Ok(())
}

async fn copy_remote_file<F>(
    sftp: &SftpSession,
    remote: &str,
    local: &Path,
    on_chunk: F,
) -> Result<u64>
where
    F: FnMut(u64),
{
    let mut source = sftp.open(remote).await?;
    let mut target = tokio::fs::File::create(local).await?;
    let transferred = copy_in_chunks(&mut source, &mut target, on_chunk).await?;
    target.flush().await?;
    source.close().await?;
    Ok(transferred)
}

async fn upload_file(
    sftp: &SftpSession,
    local: &str,
    remote: &str,
    progress: &tauri::ipc::Channel<TransferProgress>,
) -> Result<()> {
    let metadata = tokio::fs::metadata(local).await?;
    if !metadata.is_file() {
        return Err(AppError::new("only regular files can be uploaded"));
    }
    let total = metadata.len();
    let mut last_report = Instant::now();

    report_transfer_progress(progress, 0, total);
    let transferred = copy_local_file(sftp, Path::new(local), remote, |transferred| {
        if last_report.elapsed() >= TRANSFER_PROGRESS_INTERVAL {
            report_transfer_progress(progress, transferred, total);
            last_report = Instant::now();
        }
    })
    .await?;
    report_transfer_progress(progress, transferred, total);
    Ok(())
}

async fn upload_directory(
    sftp: &SftpSession,
    local: &str,
    remote: &str,
    progress: &tauri::ipc::Channel<TransferProgress>,
) -> Result<()> {
    let local_root = PathBuf::from(local);
    let remote_root = remote.to_string();
    let plan = tokio::task::spawn_blocking(move || plan_local_upload(&local_root, &remote_root))
        .await
        .map_err(|error| AppError::new(format!("local folder scan failed: {error}")))??;

    for directory in &plan.directories {
        ensure_remote_directory(sftp, directory).await?;
    }

    let mut reporter = ProgressReporter::begin(progress, plan.total);
    let mut transferred = 0_u64;
    for file in plan.files {
        let completed_before_file = transferred;
        let copied = copy_local_file(sftp, &file.local, &file.remote, |file_transferred| {
            reporter.update(completed_before_file.saturating_add(file_transferred));
        })
        .await?;
        transferred = transferred.saturating_add(copied);
    }
    reporter.finish(transferred);
    Ok(())
}

/// Accepts an existing remote directory so an upload can merge into it, and
/// refuses to write a tree through anything that is not a directory.
async fn ensure_remote_directory(sftp: &SftpSession, path: &str) -> Result<()> {
    match sftp.metadata(path.to_string()).await {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(()),
        Ok(_) => Err(AppError::new(format!(
            "remote path is not a folder: {path}"
        ))),
        Err(SftpError::Status(status)) if status.status_code == StatusCode::NoSuchFile => {
            sftp.create_dir(path.to_string()).await?;
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

async fn copy_local_file<F>(
    sftp: &SftpSession,
    local: &Path,
    remote: &str,
    on_chunk: F,
) -> Result<u64>
where
    F: FnMut(u64),
{
    let mut source = tokio::fs::File::open(local).await?;
    let mut target = sftp.create(remote).await?;
    let transferred = copy_in_chunks(&mut source, &mut target, on_chunk).await?;
    target.shutdown().await?;
    Ok(transferred)
}

/// Streams bytes through a fixed-size buffer so transfer memory usage is
/// independent of the file size.
async fn copy_in_chunks<R, W, F>(
    source: &mut R,
    target: &mut W,
    mut on_chunk: F,
) -> std::io::Result<u64>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
    F: FnMut(u64),
{
    let mut buffer = vec![0; TRANSFER_CHUNK_SIZE];
    let mut transferred = 0;

    loop {
        let count = source.read(&mut buffer).await?;
        if count == 0 {
            return Ok(transferred);
        }

        target.write_all(&buffer[..count]).await?;
        transferred += count as u64;
        on_chunk(transferred);
    }
}

fn report_transfer_progress(
    progress: &tauri::ipc::Channel<TransferProgress>,
    transferred: u64,
    total: u64,
) {
    let _ = progress.send(TransferProgress { transferred, total });
}

fn expand_tilde(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    path.to_string()
}

#[cfg(test)]
mod tests {
    use std::path::{Path, PathBuf};

    use russh::keys::PublicKey;

    use super::{
        copy_in_chunks, replace_host_key, verify_host_key, HandshakeError, TRANSFER_CHUNK_SIZE,
    };

    const HOST: &str = "192.0.2.10";
    const ED25519_A: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIcCiNIPQD3zMS3LgYoVYM8VShLj/4dvS3+yBaPqfGSr";
    const ED25519_B: &str =
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFqCv2Sfw6yBfnn1kVkrFEMG076iC8w+NlmGZFBs70qQ";
    const ECDSA_A: &str = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBN1WvqLHKYqgraIJhxCF5Wyfs5ByZSzklDNaeFRli6QJLB9MWfaa4AXNL6rX9oOgLyz/Ylv+J6q9M/fpDZmuSkU=";

    fn key(openssh: &str) -> PublicKey {
        PublicKey::from_openssh(openssh).expect("valid test key")
    }

    /// A known_hosts path inside a private temporary directory that is
    /// removed again on drop.
    struct KnownHosts(PathBuf);

    impl KnownHosts {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("edgeterm-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            KnownHosts(dir.join("known_hosts"))
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn write(&self, content: &str) {
            std::fs::write(&self.0, content).expect("write known_hosts");
        }

        fn read(&self) -> String {
            std::fs::read_to_string(&self.0).unwrap_or_default()
        }

        /// The recorded entries. russh may start a freshly created file with
        /// a blank line, which OpenSSH ignores, so blank lines are dropped.
        fn entries(&self) -> Vec<String> {
            self.read()
                .lines()
                .filter(|line| !line.is_empty())
                .map(str::to_owned)
                .collect()
        }
    }

    impl Drop for KnownHosts {
        fn drop(&mut self) {
            if let Some(dir) = self.0.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    #[test]
    fn unknown_host_is_learned_and_then_recognised() {
        let file = KnownHosts::new();

        verify_host_key(HOST, 22, &key(ED25519_A), file.path()).expect("first contact is accepted");
        assert_eq!(file.entries(), [format!("{HOST} {ED25519_A}")]);

        verify_host_key(HOST, 22, &key(ED25519_A), file.path()).expect("known key is accepted");
        assert_eq!(file.entries().len(), 1, "a known key is not recorded twice");
    }

    #[test]
    fn changed_key_of_the_same_algorithm_is_refused() {
        let file = KnownHosts::new();
        // The comment and blank line make sure the reported line number is
        // the real one in the file, not russh's index over entry lines.
        let before = format!("# leading comment\n\n{HOST} {ED25519_A}\n");
        file.write(&before);

        let err = verify_host_key(HOST, 22, &key(ED25519_B), file.path())
            .expect_err("a different key of the same algorithm is a change");
        match err {
            HandshakeError::HostKeyChanged {
                known_hosts,
                line,
                key: presented,
            } => {
                assert_eq!(known_hosts, file.path());
                assert_eq!(line, 3);
                assert_eq!(presented, key(ED25519_B));
            }
            other => panic!("unexpected error: {other:?}"),
        }
        assert_eq!(file.read(), before, "a refused key is never recorded");
    }

    #[test]
    fn new_algorithm_for_a_known_host_is_learned() {
        let file = KnownHosts::new();
        file.write(&format!("{HOST} {ECDSA_A}\n"));

        verify_host_key(HOST, 22, &key(ED25519_A), file.path())
            .expect("a key of another algorithm is not a change");
        assert_eq!(
            file.entries(),
            [format!("{HOST} {ECDSA_A}"), format!("{HOST} {ED25519_A}")]
        );
    }

    #[test]
    fn accepting_a_changed_key_replaces_every_entry_for_the_host() {
        let file = KnownHosts::new();
        file.write(&format!(
            "# comment\nother.example {ED25519_B}\n{HOST} {ECDSA_A}\n\n{HOST} {ED25519_A}\n"
        ));

        replace_host_key(HOST, 22, &key(ED25519_B), file.path()).expect("replace");
        assert_eq!(
            file.entries(),
            [
                "# comment".to_string(),
                format!("other.example {ED25519_B}"),
                format!("{HOST} {ED25519_B}"),
            ]
        );
        verify_host_key(HOST, 22, &key(ED25519_B), file.path())
            .expect("the accepted key is now the known one");
    }

    #[test]
    fn non_default_port_is_recorded_in_bracket_form() {
        let file = KnownHosts::new();

        verify_host_key(HOST, 2222, &key(ED25519_A), file.path()).expect("first contact");
        assert_eq!(file.entries(), [format!("[{HOST}]:2222 {ED25519_A}")]);

        // The same host on the default port is a different entry, not a change.
        verify_host_key(HOST, 22, &key(ED25519_B), file.path()).expect("other port is unrelated");
        assert_eq!(file.entries().len(), 2);
    }

    #[tokio::test]
    async fn copy_in_chunks_streams_large_inputs_with_a_bounded_buffer() {
        let payload = vec![0x5a; TRANSFER_CHUNK_SIZE * 3 + 17];
        let mut source = payload.as_slice();
        let mut target = Vec::new();
        let mut checkpoints = Vec::new();

        let transferred = copy_in_chunks(&mut source, &mut target, |total| {
            checkpoints.push(total);
        })
        .await
        .expect("copy succeeds");

        assert_eq!(transferred, payload.len() as u64);
        assert_eq!(target, payload);
        assert_eq!(checkpoints.len(), 4);
        assert!(
            checkpoints
                .windows(2)
                .all(|pair| pair[1] - pair[0] <= TRANSFER_CHUNK_SIZE as u64),
            "no transfer step may exceed the fixed-size buffer"
        );
    }
}
