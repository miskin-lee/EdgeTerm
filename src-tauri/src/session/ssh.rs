use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::client::{self, Handle, Msg};
use russh::keys::{PrivateKeyWithHashAlg, PublicKey};
use russh::{Channel, ChannelMsg};
use russh_sftp::client::SftpSession;
use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc::UnboundedReceiver;

use super::{
    emit_state, join_remote, sort_entries, OutputPump, SessionCommand, SftpRequest, SftpResponse,
    TransferProgress,
};
use crate::error::{AppError, Result};
use crate::model::{AuthKind, DirListing, FileEntry, SessionProfile};

/// How long output may sit in the pump before it is flushed to the UI.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
const TRANSFER_CHUNK_SIZE: usize = 64 * 1024;

/// Host key policy: trust on first use, refuse on change.
///
/// An unknown host is recorded in `~/.ssh/known_hosts` and accepted (OpenSSH's
/// `StrictHostKeyChecking=accept-new`). A host whose key no longer matches the
/// recorded one is refused outright.
struct Client {
    host: String,
    port: u16,
}

impl client::Handler for Client {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKey,
    ) -> std::result::Result<bool, Self::Error> {
        match russh::keys::check_known_hosts(&self.host, self.port, server_public_key) {
            Ok(true) => Ok(true),
            Ok(false) => {
                let _ = russh::keys::known_hosts::learn_known_hosts(
                    &self.host,
                    self.port,
                    server_public_key,
                );
                Ok(true)
            }
            Err(russh::keys::Error::KeyChanged { .. }) => Ok(false),
            // No known_hosts file yet, or it could not be parsed: learn and continue.
            Err(_) => {
                let _ = russh::keys::known_hosts::learn_known_hosts(
                    &self.host,
                    self.port,
                    server_public_key,
                );
                Ok(true)
            }
        }
    }
}

pub struct SshConnection {
    handle: Arc<Handle<Client>>,
    channel: Channel<Msg>,
}

pub async fn connect(profile: &SessionProfile) -> Result<SshConnection> {
    let host = profile
        .host
        .clone()
        .filter(|h| !h.is_empty())
        .ok_or_else(|| AppError::new("ssh session is missing a host"))?;
    let port = profile.port.unwrap_or(22);
    let username = profile
        .username
        .clone()
        .filter(|u| !u.is_empty())
        .ok_or_else(|| AppError::new("ssh session is missing a username"))?;

    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 3,
        nodelay: true,
        ..Default::default()
    });

    let mut handle = client::connect(
        config,
        (host.as_str(), port),
        Client {
            host: host.clone(),
            port,
        },
    )
    .await
    .map_err(|e| AppError::new(format!("cannot reach {host}:{port}: {e}")))?;

    authenticate(&mut handle, profile, &username).await?;

    let handle = Arc::new(handle);
    let channel = handle.channel_open_session().await?;
    channel
        .request_pty(true, "xterm-256color", 80, 24, 0, 0, &[])
        .await?;
    // Servers may ignore environment requests, but those that accept them let
    // modern CLI applications select their 24-bit color output automatically.
    let _ = channel.set_env(false, "COLORTERM", "truecolor").await;
    let _ = channel.set_env(false, "TERM_PROGRAM", "EdgeTerm").await;
    channel.request_shell(true).await?;

    Ok(SshConnection { handle, channel })
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
    let mut agent = russh::keys::agent::client::AgentClient::connect_env()
        .await
        .map_err(|e| AppError::new(format!("cannot reach the ssh agent: {e}")))?;
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
        emit_state(
            &app,
            &id,
            "closed",
            exit_status.map(|c| format!("exit status {c}")),
        );
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
        SftpRequest::Upload {
            local,
            remote,
            progress,
        } => {
            upload_file(&sftp, &local, &remote, &progress).await?;
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
    let mut source = sftp.open(remote).await?;
    let mut target = tokio::fs::File::create(local).await?;
    let mut buffer = vec![0; TRANSFER_CHUNK_SIZE];
    let mut transferred = 0;
    let mut last_report = Instant::now();

    report_transfer_progress(progress, transferred, total);
    loop {
        let count = source.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        target.write_all(&buffer[..count]).await?;
        transferred += count as u64;
        if last_report.elapsed() >= TRANSFER_PROGRESS_INTERVAL {
            report_transfer_progress(progress, transferred, total);
            last_report = Instant::now();
        }
    }

    target.flush().await?;
    source.close().await?;
    report_transfer_progress(progress, transferred, total);
    Ok(())
}

async fn upload_file(
    sftp: &SftpSession,
    local: &str,
    remote: &str,
    progress: &tauri::ipc::Channel<TransferProgress>,
) -> Result<()> {
    let total = tokio::fs::metadata(local).await?.len();
    let mut source = tokio::fs::File::open(local).await?;
    let mut target = sftp.create(remote).await?;
    let mut buffer = vec![0; TRANSFER_CHUNK_SIZE];
    let mut transferred = 0;
    let mut last_report = Instant::now();

    report_transfer_progress(progress, transferred, total);
    loop {
        let count = source.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        target.write_all(&buffer[..count]).await?;
        transferred += count as u64;
        if last_report.elapsed() >= TRANSFER_PROGRESS_INTERVAL {
            report_transfer_progress(progress, transferred, total);
            last_report = Instant::now();
        }
    }

    target.shutdown().await?;
    report_transfer_progress(progress, transferred, total);
    Ok(())
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
