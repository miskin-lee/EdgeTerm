use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::client::{self, AuthResult, Handle, KeyboardInteractiveAuthResponse, Msg, Prompt};
use russh::keys::agent::client::{AgentClient, AgentStream};
use russh::keys::known_hosts::{
    check_known_hosts_path, known_host_keys_path, learn_known_hosts_path,
};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKey};
use russh::{Channel, ChannelMsg, MethodKind, MethodSet};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{OpenFlags, StatusCode};
use tauri::AppHandle;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::sync::mpsc::UnboundedReceiver;

use super::auth::{AuthPrompter, Challenge};
use super::transfer::{
    ensure_local_directory, plan_local_upload, safe_local_child, validate_local_file_target,
    ProgressReporter,
};
use super::{
    emit_state, join_remote, sort_entries, OutputPump, SessionCommand, SftpRequest, SftpResponse,
    TransferProgress,
};
use crate::error::{AppError, Result};
use crate::model::{
    AuthKind, AuthPromptField, DirListing, FileEntry, HostKeyChange, SessionProfile,
};

/// How long output may sit in the pump before it is flushed to the UI.
const FLUSH_INTERVAL: Duration = Duration::from_millis(8);
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
const TRANSFER_CHUNK_SIZE: usize = 1024 * 1024;
/// How often an SFTP-only session, which has no channel to read from, checks
/// that its transport is still alive so a dropped connection is reported.
const SFTP_HEALTH_INTERVAL: Duration = Duration::from_secs(5);
/// Most keyboard-interactive rounds one authentication attempt will answer.
/// RFC 4256 puts no limit on them, and a server that keeps asking would
/// otherwise keep the connection — and the user — busy forever.
const MAX_AUTH_ROUNDS: usize = 16;

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
    hops: Hops,
}

/// The jump-host transports a session runs over, first hop first (empty for
/// a direct connection). Every later transport is an SSH session inside a
/// `direct-tcpip` channel of the previous one, and dropping a hop's handle
/// ends its russh session and with it everything tunnelled through it, so
/// the hops live exactly as long as the session they carry and are torn
/// down last hop first.
struct Hops(Vec<Handle<Client>>);

impl Hops {
    async fn disconnect(self) {
        for hop in self.0.into_iter().rev() {
            let _ = hop
                .disconnect(russh::Disconnect::ByApplication, "", "en")
                .await;
        }
    }
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
    hops: Hops,
}

pub enum SftpConnectOutcome {
    Ready(SftpConnection),
    HostKeyChanged(HostKeyChange),
}

/// An authenticated transport together with the jump-host transports it
/// runs over.
struct Transport {
    handle: Handle<Client>,
    hops: Hops,
}

/// An authenticated transport, or the host-key decision that has to be made
/// before one can be established. Shared by the shell and SFTP entry points.
enum HandleOutcome {
    Ready(Transport),
    HostKeyChanged(HostKeyChange),
}

/// One hop of a connection: its transport, or the host-key decision that
/// stopped the chain there.
enum HopOutcome {
    Ready(Handle<Client>),
    HostKeyChanged(HostKeyChange),
}

/// Opens the transport and authenticates, applying the trust-on-first-use host
/// key policy. It stops short of requesting any channel, so both an interactive
/// shell and a bare SFTP subsystem can be layered on top of the same handshake.
///
/// `jumps` are the jump hosts to go through, first hop first (OpenSSH's
/// `ProxyJump`): each is connected in turn, the next one through a
/// `direct-tcpip` channel of the previous, and the profile's own handshake
/// runs through the last. A refused host key anywhere in the chain stops it
/// there and reports that host, so the user can accept it and try again.
async fn connect_handle(
    profile: &SessionProfile,
    jumps: &[SessionProfile],
    prompter: &AuthPrompter<'_>,
) -> Result<HandleOutcome> {
    let mut hops: Vec<Handle<Client>> = Vec::with_capacity(jumps.len());
    for (index, jump) in jumps.iter().enumerate() {
        let via = index.checked_sub(1).map(|previous| Via {
            handle: &hops[previous],
            label: jumps[previous].address(),
        });
        match connect_hop(jump, via.as_ref(), prompter).await? {
            HopOutcome::Ready(handle) => hops.push(handle),
            HopOutcome::HostKeyChanged(change) => {
                return Ok(HandleOutcome::HostKeyChanged(change));
            }
        }
    }
    let via = jumps.last().map(|jump| Via {
        handle: hops.last().expect("one hop per jump host"),
        label: jump.address(),
    });
    match connect_hop(profile, via.as_ref(), prompter).await? {
        HopOutcome::Ready(handle) => Ok(HandleOutcome::Ready(Transport {
            handle,
            hops: Hops(hops),
        })),
        HopOutcome::HostKeyChanged(change) => Ok(HandleOutcome::HostKeyChanged(change)),
    }
}

/// The jump host a hop is opened through: the transport to tunnel over and
/// its `host:port` for error messages.
struct Via<'a> {
    handle: &'a Handle<Client>,
    label: String,
}

/// Opens one SSH transport and authenticates on it — directly, or inside a
/// `direct-tcpip` channel of `via` when the host sits behind a jump host.
/// The host-key policy and the credentials are the profile's own either way:
/// the handshake is end to end and the jump host only ever carries
/// ciphertext, so no key or password has to exist on it.
async fn connect_hop(
    profile: &SessionProfile,
    via: Option<&Via<'_>>,
    prompter: &AuthPrompter<'_>,
) -> Result<HopOutcome> {
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
    let handler = Client {
        host: host.clone(),
        port,
    };

    let connected = match via {
        None => client::connect(config, (host.as_str(), port), handler).await,
        Some(via) => {
            // What OpenSSH's `-W host:port` asks the jump host for: a plain
            // TCP connection from it to the target, which then carries the
            // target's own SSH handshake.
            let tunnel = via
                .handle
                .channel_open_direct_tcpip(host.as_str(), u32::from(port), "127.0.0.1", 0)
                .await
                .map_err(|e| {
                    AppError::new(format!(
                        "jump host {} cannot reach {host}:{port}: {e}",
                        via.label
                    ))
                })?;
            client::connect_stream(config, tunnel.into_stream(), handler).await
        }
    };

    let mut handle = match connected {
        Ok(handle) => handle,
        Err(HandshakeError::HostKeyChanged {
            known_hosts,
            line,
            key,
        }) => {
            return Ok(HopOutcome::HostKeyChanged(describe_host_key_change(
                &host,
                port,
                &known_hosts,
                line,
                &key,
            )?));
        }
        Err(HandshakeError::Ssh(e)) => {
            return Err(AppError::new(match via {
                None => format!("cannot reach {host}:{port}: {e}"),
                Some(via) => format!("cannot reach {host}:{port} via {}: {e}", via.label),
            }));
        }
    };

    authenticate(
        &mut handle,
        profile,
        &username,
        &format!("{host}:{port}"),
        prompter,
    )
    .await?;
    Ok(HopOutcome::Ready(handle))
}

pub async fn connect(
    profile: &SessionProfile,
    jumps: &[SessionProfile],
    prompter: &AuthPrompter<'_>,
) -> Result<ConnectOutcome> {
    let Transport { handle, hops } = match connect_handle(profile, jumps, prompter).await? {
        HandleOutcome::Ready(transport) => transport,
        HandleOutcome::HostKeyChanged(change) => {
            return Ok(ConnectOutcome::HostKeyChanged(change));
        }
    };
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

    Ok(ConnectOutcome::Ready(SshConnection {
        handle,
        channel,
        hops,
    }))
}

/// Opens an SFTP-only session: the same SSH handshake and authentication as a
/// shell session, but no channel is requested up front. The SFTP subsystem is
/// opened lazily on the first file request, exactly as it is for a shell
/// session's Filer.
pub async fn connect_sftp(
    profile: &SessionProfile,
    jumps: &[SessionProfile],
    prompter: &AuthPrompter<'_>,
) -> Result<SftpConnectOutcome> {
    match connect_handle(profile, jumps, prompter).await? {
        HandleOutcome::Ready(Transport { handle, hops }) => {
            Ok(SftpConnectOutcome::Ready(SftpConnection {
                handle: Arc::new(handle),
                hops,
            }))
        }
        HandleOutcome::HostKeyChanged(change) => Ok(SftpConnectOutcome::HostKeyChanged(change)),
    }
}

/// Authenticates one hop. The profile's own method goes first; a server that
/// answers it with "not enough, continue with keyboard-interactive" — the
/// shape every SSH MFA deployment takes, whether the second factor is a TOTP
/// code, a push, or a menu — is then followed through `keyboard_interactive`,
/// which asks the user for each round.
///
/// `address` is the `host:port` being authenticated against, which is a jump
/// host for every hop but the last, so the user can see who is asking.
async fn authenticate<H: client::Handler>(
    handle: &mut Handle<H>,
    profile: &SessionProfile,
    username: &str,
    address: &str,
    prompter: &AuthPrompter<'_>,
) -> Result<()> {
    // Every SSH client opens with the "none" method: it is how the server is
    // asked which methods it will accept, and a server that requires no
    // authentication at all answers it with success instead of a method list.
    // A router whose root password was never set is exactly that case
    // (issue #37) — dropbear lets "none" through for a blank password but
    // refuses the empty password that would be sent below, so a device every
    // other client walks into was the one EdgeTerm could not log in to.
    if matches!(
        handle.authenticate_none(username).await?,
        AuthResult::Success
    ) {
        return Ok(());
    }

    let auth = profile.auth.unwrap_or_default();
    let password = profile
        .password
        .clone()
        .filter(|password| !password.is_empty());
    let result = match auth {
        AuthKind::Password => {
            handle
                .authenticate_password(username, password.clone().unwrap_or_default())
                .await?
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
        AuthKind::Agent => authenticate_agent(handle, username).await?,
    };

    let AuthResult::Failure {
        remaining_methods,
        partial_success,
    } = result
    else {
        return Ok(());
    };

    if remaining_methods.contains(&MethodKind::KeyboardInteractive) {
        // Only the profile's own password answers the server's password
        // question; see `saved_answer`.
        let saved = password.filter(|_| matches!(auth, AuthKind::Password));
        return keyboard_interactive(handle, username, address, prompter, saved).await;
    }
    Err(auth_failure(
        auth,
        username,
        partial_success,
        &remaining_methods,
    ))
}

/// Why authentication stopped, when no method is left that EdgeTerm can run.
fn auth_failure(
    auth: AuthKind,
    username: &str,
    partial_success: bool,
    remaining_methods: &MethodSet,
) -> AppError {
    let method = match auth {
        AuthKind::Password => "password",
        AuthKind::PublicKey => "public key",
        AuthKind::Agent => "agent",
    };
    if partial_success {
        // The credential was accepted; the account simply needs another
        // factor, and the server offers no way to supply it here.
        let remaining = remaining_methods
            .iter()
            .map(|method| <&str>::from(method))
            .collect::<Vec<_>>()
            .join(", ");
        return AppError::new(format!(
            "the {method} was accepted for {username}, but the server requires another \
             authentication factor and offers only: {remaining}"
        ));
    }
    AppError::new(match auth {
        AuthKind::Agent => format!("no identity in the ssh agent was accepted for {username}"),
        _ => format!("authentication failed for {username} ({method})"),
    })
}

/// Runs SSH's `keyboard-interactive` method (RFC 4256) to its end: the server
/// asks questions in rounds, each round is answered, and the server finally
/// accepts or refuses. Providers split a password, a one-time code, a push
/// confirmation and a menu choice over separate rounds, so the loop keeps
/// going until the server stops asking.
async fn keyboard_interactive<H: client::Handler>(
    handle: &mut Handle<H>,
    username: &str,
    address: &str,
    prompter: &AuthPrompter<'_>,
    mut saved_password: Option<String>,
) -> Result<()> {
    let mut reply = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await?;
    // A round with nothing to answer only carries text ("a push was sent").
    // Keep it for the next round that does ask, so the user still reads it.
    let mut carried = String::new();
    for _ in 0..MAX_AUTH_ROUNDS {
        let (name, instructions, prompts) = match reply {
            KeyboardInteractiveAuthResponse::Success => return Ok(()),
            KeyboardInteractiveAuthResponse::Failure { .. } => {
                return Err(AppError::new(format!(
                    "the server rejected the verification response for {username}"
                )));
            }
            KeyboardInteractiveAuthResponse::InfoRequest {
                name,
                instructions,
                prompts,
            } => (name, instructions, prompts),
        };

        let answers = if prompts.is_empty() {
            carried = text_block(&[&carried, &name, &instructions]);
            Vec::new()
        } else if let Some(password) = saved_answer(&prompts, &mut saved_password) {
            vec![password]
        } else {
            let challenge = Challenge {
                address: address.to_string(),
                username: username.to_string(),
                name,
                instructions: text_block(&[&carried, &instructions]),
                prompts: prompts
                    .iter()
                    .map(|prompt| AuthPromptField {
                        prompt: prompt.prompt.clone(),
                        echo: prompt.echo,
                    })
                    .collect(),
            };
            carried.clear();
            match prompter.ask(challenge).await? {
                Some(answers) => answers,
                None => {
                    return Err(AppError::new(format!(
                        "authentication for {username} was cancelled"
                    )));
                }
            }
        };
        reply = handle
            .authenticate_keyboard_interactive_respond(answers)
            .await?;
    }
    Err(AppError::new(format!(
        "the server asked {username} for more than {MAX_AUTH_ROUNDS} rounds of verification"
    )))
}

/// The saved password, but only where the server is asking for exactly that:
/// a single hidden answer to a question that names a password. A one-time
/// code, a push confirmation or a menu choice is not in the profile, and the
/// account password must never be sent in answer to one.
fn saved_answer(prompts: &[Prompt], saved: &mut Option<String>) -> Option<String> {
    let [only] = prompts else { return None };
    if only.echo || !only.prompt.to_lowercase().contains("password") {
        return None;
    }
    saved.take()
}

/// Joins the parts a server supplies as one block of text, dropping the empty
/// ones — most servers leave both the name and the instructions blank.
fn text_block(parts: &[&str]) -> String {
    parts
        .iter()
        .map(|part| part.trim())
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// Offers the agent's identities in turn. A key the server accepts outright
/// ends the loop, and so does one it accepts pending another factor: that is
/// the identity the session continues with.
async fn authenticate_agent<H: client::Handler>(
    handle: &mut Handle<H>,
    username: &str,
) -> Result<AuthResult> {
    let mut agent = connect_agent().await?;
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| AppError::new(format!("the ssh agent has no usable identities: {e}")))?;
    if identities.is_empty() {
        return Err(AppError::new("the ssh agent holds no identities"));
    }

    let hash = handle.best_supported_rsa_hash().await?.flatten();
    let mut last = AuthResult::Failure {
        remaining_methods: MethodSet::empty(),
        partial_success: false,
    };
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
        match result {
            AuthResult::Success => return Ok(result),
            AuthResult::Failure {
                partial_success: true,
                ..
            } => return Ok(result),
            AuthResult::Failure { .. } => last = result,
        }
    }
    Ok(last)
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
        let SshConnection {
            handle,
            channel,
            hops,
        } = conn;
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
                        Some(SessionCommand::QueryCwd { reply }) => {
                            // Its own exec channel, off the session loop, so
                            // the shell channel is neither written to nor
                            // held up.
                            let handle = handle.clone();
                            tauri::async_runtime::spawn(async move {
                                let _ = reply.send(remote_cwd(handle).await);
                            });
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
        let _ = handle
            .disconnect(russh::Disconnect::ByApplication, "", "en")
            .await;
        hops.disconnect().await;
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
        let SftpConnection { handle, hops } = conn;
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
                        Some(other) => super::reject_unsupported(other, crate::model::SessionKind::Sftp),
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
        hops.disconnect().await;
    });
}

/// How long the server gets to answer a working-directory query; `grep`
/// over `/proc/*/environ` takes milliseconds, so this only bounds a stuck
/// login shell.
const REMOTE_CWD_TIMEOUT: Duration = Duration::from_secs(5);

/// Asks the server for the working directory of the shell's foreground job
/// (see `session::cwd`) over a fresh exec channel of the same connection.
async fn remote_cwd(handle: Arc<Handle<Client>>) -> Result<String> {
    let query = async {
        let mut channel = handle.channel_open_session().await?;
        // `sh` takes the script on stdin, so the user's login shell — which
        // sshd runs the command line through, and which may be csh or fish
        // — never has to parse POSIX syntax.
        channel.exec(true, "sh").await?;
        channel
            .data_bytes(super::cwd::REMOTE_CWD_SCRIPT.as_bytes().to_vec())
            .await?;
        channel.eof().await?;
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();
        let mut status = None;
        // OpenSSH sends exit-status before eof and close, but not every
        // server keeps that order; close (or a dropped channel) is the end.
        while let Some(msg) = channel.wait().await {
            match msg {
                ChannelMsg::Data { data } => stdout.extend_from_slice(&data),
                ChannelMsg::ExtendedData { data, .. } => stderr.extend_from_slice(&data),
                ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
                ChannelMsg::Close => break,
                _ => {}
            }
        }
        Ok::<_, AppError>((stdout, stderr, status))
    };
    let (stdout, stderr, status) = tokio::time::timeout(REMOTE_CWD_TIMEOUT, query)
        .await
        .map_err(|_| {
            AppError::new(format!(
                "the server did not answer the working-directory query within {}s",
                REMOTE_CWD_TIMEOUT.as_secs()
            ))
        })??;
    super::cwd::parse_remote_cwd(
        &String::from_utf8_lossy(&stdout),
        &String::from_utf8_lossy(&stderr),
        status,
    )
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
        auth_failure, authenticate, connect, connect_sftp, copy_in_chunks, ensure_sftp,
        replace_host_key, run_sftp, saved_answer, verify_host_key, AuthPrompter, ConnectOutcome,
        Handle, HandshakeError, Prompt, SftpConnectOutcome, SftpRequest, SftpResponse,
        TRANSFER_CHUNK_SIZE,
    };
    use crate::model::{AuthKind, AuthPromptField, SessionKind, SessionProfile};
    use crate::session::auth::CannedAnswers;
    use parking_lot::Mutex;
    use russh::client;
    use russh::keys::ssh_key::private::Ed25519Keypair;
    use russh::keys::ssh_key::LineEnding;
    use russh::keys::PrivateKey;
    use russh::server::{Auth, Response};
    use russh::{ChannelMsg, MethodKind, MethodSet};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::net::TcpListener;

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

    /// `user@host:port` from the environment variable `var`, as a profile
    /// authenticating with the private key named by `EDGETERM_TEST_KEY`.
    fn profile_from_env(var: &str) -> SessionProfile {
        let spec = std::env::var(var).unwrap_or_else(|_| panic!("{var} must be user@host:port"));
        let (user, address) = spec.split_once('@').expect("user@host:port");
        let (host, port) = address.rsplit_once(':').expect("user@host:port");
        let mut profile = crate::tests::profile(SessionKind::Ssh);
        profile.name = var.to_string();
        profile.host = Some(host.to_string());
        profile.port = Some(port.parse().expect("numeric port"));
        profile.username = Some(user.to_string());
        profile.auth = Some(AuthKind::PublicKey);
        profile.private_key_path = Some(
            std::env::var("EDGETERM_TEST_KEY").expect("EDGETERM_TEST_KEY names a private key"),
        );
        profile
    }

    /// End-to-end check of a tunnelled connection against real servers, so
    /// it is ignored by default. Run it with
    /// `EDGETERM_TEST_JUMP=user@host:port EDGETERM_TEST_TARGET=user@host:port
    /// EDGETERM_TEST_KEY=/path/to/key cargo test -- --ignored jump_host`.
    /// The target must be reachable from the jump host and both must accept
    /// the key. HOME is pointed at a scratch directory so the developer's
    /// own known_hosts is never touched.
    #[tokio::test]
    #[ignore]
    async fn shell_and_sftp_open_through_a_jump_host() {
        let jump = profile_from_env("EDGETERM_TEST_JUMP");
        let target = profile_from_env("EDGETERM_TEST_TARGET");
        let scratch = KnownHosts::new();
        let home = scratch.path().parent().expect("scratch dir").to_path_buf();
        std::fs::create_dir_all(home.join(".ssh")).expect("create .ssh");
        std::env::set_var("HOME", &home);
        // Both hops authenticate with a key; a server that asked anything
        // else would cancel rather than hang this test.
        let user = Mutex::new(CannedAnswers::default());
        let prompter = AuthPrompter::canned(&user);

        // A shell through the tunnel: what the shell prints comes back. The
        // marker is computed so the echoed command line cannot match it.
        let mut conn = match connect(&target, std::slice::from_ref(&jump), &prompter)
            .await
            .expect("connect through the jump host")
        {
            ConnectOutcome::Ready(conn) => conn,
            ConnectOutcome::HostKeyChanged(change) => panic!("{}", change.message),
        };
        conn.channel
            .data(&b"echo edgeterm-$((40+2)); exit\n"[..])
            .await
            .expect("send command");
        let mut output = Vec::new();
        let seen = tokio::time::timeout(Duration::from_secs(20), async {
            loop {
                match conn.channel.wait().await {
                    Some(ChannelMsg::Data { data }) => {
                        output.extend_from_slice(&data);
                        if output.windows(11).any(|w| w == b"edgeterm-42") {
                            break true;
                        }
                    }
                    Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break false,
                    Some(_) => {}
                }
            }
        })
        .await
        .expect("shell output within the timeout");
        assert!(
            seen,
            "marker missing from {}",
            String::from_utf8_lossy(&output)
        );
        conn.hops.disconnect().await;

        // SFTP through the same kind of tunnel.
        let sftp = match connect_sftp(&target, std::slice::from_ref(&jump), &prompter)
            .await
            .expect("sftp through the jump host")
        {
            SftpConnectOutcome::Ready(conn) => conn,
            SftpConnectOutcome::HostKeyChanged(change) => panic!("{}", change.message),
        };
        let mut slot = None;
        let session = ensure_sftp(&sftp.handle, &mut slot)
            .await
            .expect("sftp subsystem");
        match run_sftp(session, SftpRequest::List { path: "/".into() })
            .await
            .expect("list /")
        {
            SftpResponse::Listing(listing) => assert!(!listing.entries.is_empty()),
            other => panic!("unexpected response: {other:?}"),
        }
        sftp.hops.disconnect().await;

        // Both hops went through the host key policy: each was learned.
        let known_hosts = std::fs::read_to_string(home.join(".ssh").join("known_hosts"))
            .expect("known_hosts was written");
        for hop in [&jump, &target] {
            let entry = format!("[{}]:{}", hop.host.as_deref().unwrap(), hop.port.unwrap());
            assert!(
                known_hosts.contains(&entry),
                "{entry} missing from {known_hosts}"
            );
        }

        // A target the jump host cannot reach is reported as such.
        let mut unreachable = target.clone();
        unreachable.port = Some(1);
        let error = connect(&unreachable, std::slice::from_ref(&jump), &prompter)
            .await
            .err()
            .expect("port 1 is closed");
        assert!(error.to_string().contains("jump host"), "{error}");
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

    // --- keyboard-interactive authentication ---------------------------------

    /// A throwaway ed25519 key. The seed only has to be constant, not secret:
    /// these keys never leave the test process.
    fn test_key(seed: u8) -> PrivateKey {
        PrivateKey::from(Ed25519Keypair::from_seed(&[seed; 32]))
    }

    /// A private key file inside a private temporary directory that is
    /// removed again on drop, since a profile names its key by path.
    struct SecretKeyFile(PathBuf);

    impl SecretKeyFile {
        fn new(key: &PrivateKey) -> Self {
            let dir = std::env::temp_dir().join(format!("edgeterm-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).expect("create temp dir");
            let path = dir.join("id_ed25519");
            let encoded = key.to_openssh(LineEnding::LF).expect("encode key");
            std::fs::write(&path, encoded.as_bytes()).expect("write key");
            SecretKeyFile(path)
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().into_owned()
        }
    }

    impl Drop for SecretKeyFile {
        fn drop(&mut self) {
            if let Some(dir) = self.0.parent() {
                let _ = std::fs::remove_dir_all(dir);
            }
        }
    }

    /// One keyboard-interactive round the test server runs: what it asks, and
    /// the answers it accepts.
    #[derive(Clone, Copy)]
    struct Round {
        instructions: &'static str,
        prompts: &'static [(&'static str, bool)],
        expected: &'static [&'static str],
    }

    /// How the test server answers the client's first authentication method.
    #[derive(Clone, Copy)]
    enum FirstReply {
        /// The credential is good, but the account needs the listed methods too.
        Partial(&'static [MethodKind]),
        /// The credential is refused; these methods are suggested instead.
        Refused(&'static [MethodKind]),
    }

    impl FirstReply {
        fn auth(self) -> Auth {
            let (methods, partial_success) = match self {
                FirstReply::Partial(methods) => (methods, true),
                FirstReply::Refused(methods) => (methods, false),
            };
            Auth::Reject {
                proceed_with_methods: Some(MethodSet::from(methods)),
                partial_success,
            }
        }
    }

    /// An SSH server that scripts one authentication exchange: it answers the
    /// client's first method, then runs the keyboard-interactive rounds and
    /// records every answer it received.
    #[derive(Clone)]
    struct AuthServer {
        first: FirstReply,
        rounds: &'static [Round],
        /// Whether the "none" method is granted, the way a device that has no
        /// password set does.
        open: bool,
        /// The next round to ask.
        next: usize,
        answers: Arc<Mutex<Vec<Vec<String>>>>,
    }

    impl AuthServer {
        fn new(first: FirstReply, rounds: &'static [Round]) -> Self {
            Self {
                first,
                rounds,
                open: false,
                next: 0,
                answers: Arc::new(Mutex::new(Vec::new())),
            }
        }

        /// A server that asks for no authentication at all.
        fn open() -> Self {
            Self {
                open: true,
                ..Self::new(FirstReply::Refused(&[MethodKind::Password]), &[])
            }
        }
    }

    impl russh::server::Handler for AuthServer {
        type Error = russh::Error;

        async fn auth_none(&mut self, _user: &str) -> std::result::Result<Auth, Self::Error> {
            if self.open {
                return Ok(Auth::Accept);
            }
            Ok(Auth::reject())
        }

        async fn auth_publickey(
            &mut self,
            _user: &str,
            _key: &PublicKey,
        ) -> std::result::Result<Auth, Self::Error> {
            Ok(self.first.auth())
        }

        async fn auth_password(
            &mut self,
            _user: &str,
            password: &str,
        ) -> std::result::Result<Auth, Self::Error> {
            self.answers.lock().push(vec![password.to_string()]);
            Ok(self.first.auth())
        }

        async fn auth_keyboard_interactive<'a>(
            &'a mut self,
            _user: &str,
            _submethods: &str,
            response: Option<Response<'a>>,
        ) -> std::result::Result<Auth, Self::Error> {
            if let Some(response) = response {
                let answers: Vec<String> = response
                    .map(|value| String::from_utf8_lossy(&value).into_owned())
                    .collect();
                let answered = self.rounds[self.next - 1];
                if !answers
                    .iter()
                    .map(String::as_str)
                    .eq(answered.expected.iter().copied())
                {
                    return Ok(Auth::reject());
                }
                self.answers.lock().push(answers);
            }
            let Some(round) = self.rounds.get(self.next) else {
                return Ok(Auth::Accept);
            };
            self.next += 1;
            Ok(Auth::Partial {
                name: "".into(),
                instructions: round.instructions.into(),
                prompts: round
                    .prompts
                    .iter()
                    .map(|(prompt, echo)| ((*prompt).into(), *echo))
                    .collect::<Vec<_>>()
                    .into(),
            })
        }
    }

    /// The host key policy has its own tests above; these run against a
    /// throwaway server whose key nothing has ever recorded.
    struct AcceptAnyKey;

    impl client::Handler for AcceptAnyKey {
        type Error = russh::Error;

        async fn check_server_key(
            &mut self,
            _key: &PublicKey,
        ) -> std::result::Result<bool, Self::Error> {
            Ok(true)
        }
    }

    /// Runs `server` on a loopback port for one connection and hands back a
    /// client transport that has finished the handshake but not authenticated.
    async fn handshake(server: AuthServer) -> Handle<AcceptAnyKey> {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let address = listener.local_addr().expect("local address");
        let config = Arc::new(russh::server::Config {
            keys: vec![test_key(1)],
            auth_rejection_time: Duration::ZERO,
            ..Default::default()
        });
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let session = russh::server::run_stream(config, stream, server)
                .await
                .expect("serve the connection");
            let _ = session.await;
        });
        client::connect(Arc::new(client::Config::default()), address, AcceptAnyKey)
            .await
            .expect("handshake")
    }

    fn public_key_profile(key: &SecretKeyFile) -> SessionProfile {
        let mut profile = crate::tests::profile(SessionKind::Ssh);
        profile.auth = Some(AuthKind::PublicKey);
        profile.private_key_path = Some(key.path());
        profile
    }

    /// The JumpServer/KoKo shape from issue #34: the key is accepted, the
    /// server then asks for a one-time code, and the login has to continue
    /// instead of failing as "public key rejected".
    #[tokio::test]
    async fn a_public_key_that_needs_a_verification_code_finishes_the_login() {
        const ROUNDS: &[Round] = &[
            Round {
                instructions: "",
                prompts: &[("Verification code: ", false)],
                expected: &["424242"],
            },
            // Providers also send rounds that ask nothing and only carry text.
            Round {
                instructions: "Approve the push on your phone.",
                prompts: &[],
                expected: &[],
            },
        ];
        let server = AuthServer::new(
            FirstReply::Partial(&[MethodKind::KeyboardInteractive]),
            ROUNDS,
        );
        let answers = server.answers.clone();
        let mut handle = handshake(server).await;

        let key = SecretKeyFile::new(&test_key(2));
        let user = Mutex::new(CannedAnswers::new([vec!["424242".to_string()]]));
        authenticate(
            &mut handle,
            &public_key_profile(&key),
            "alice",
            "mfa.example:22",
            &AuthPrompter::canned(&user),
        )
        .await
        .expect("the second factor completes the login");

        assert_eq!(
            *answers.lock(),
            vec![vec!["424242".to_string()], Vec::<String>::new()]
        );
        let user = user.lock();
        assert_eq!(
            user.asked().len(),
            1,
            "only the round that asks something reaches the user"
        );
        let asked = &user.asked()[0];
        assert_eq!(asked.address, "mfa.example:22");
        assert_eq!(asked.username, "alice");
        assert_eq!(
            asked.prompts,
            [AuthPromptField {
                prompt: "Verification code: ".into(),
                echo: false,
            }]
        );
    }

    /// A device that was never given a root password — an OpenWrt/dropbear
    /// router as it comes out of a flash (issue #37) — grants the "none"
    /// method. The login goes through on that alone: no credential is sent
    /// and the user is not asked for one.
    #[tokio::test]
    async fn a_server_that_asks_for_nothing_logs_straight_in() {
        let server = AuthServer::open();
        let answers = server.answers.clone();
        let mut handle = handshake(server).await;

        // The default profile: password authentication with nothing saved.
        let mut profile = crate::tests::profile(SessionKind::Ssh);
        profile.auth = Some(AuthKind::Password);

        let user = Mutex::new(CannedAnswers::default());
        authenticate(
            &mut handle,
            &profile,
            "root",
            "192.168.1.1:22",
            &AuthPrompter::canned(&user),
        )
        .await
        .expect("a server that asks for nothing lets the session in");

        assert!(
            answers.lock().is_empty(),
            "no password is sent to a server that already let the session in"
        );
        assert!(
            user.lock().asked().is_empty(),
            "nothing is asked of the user"
        );
    }

    /// A key the server simply refuses is still reported as a refused key,
    /// and nothing is asked of the user.
    #[tokio::test]
    async fn a_refused_public_key_is_reported_as_a_refused_key() {
        let mut handle = handshake(AuthServer::new(
            FirstReply::Refused(&[MethodKind::PublicKey]),
            &[],
        ))
        .await;

        let key = SecretKeyFile::new(&test_key(2));
        let user = Mutex::new(CannedAnswers::default());
        let error = authenticate(
            &mut handle,
            &public_key_profile(&key),
            "alice",
            "mfa.example:22",
            &AuthPrompter::canned(&user),
        )
        .await
        .expect_err("the server refuses the key");

        assert_eq!(
            error.to_string(),
            "authentication failed for alice (public key)"
        );
        assert!(user.lock().asked().is_empty());
    }

    /// An accepted credential whose account still needs a factor EdgeTerm
    /// cannot run says so, rather than blaming the credential. russh's own
    /// test server cannot set the partial-success flag, so the wording is
    /// checked here rather than over a connection.
    #[test]
    fn an_accepted_credential_awaiting_another_factor_is_not_blamed() {
        let remaining = MethodSet::from(&[MethodKind::Password][..]);

        assert_eq!(
            auth_failure(AuthKind::PublicKey, "alice", true, &remaining).to_string(),
            concat!(
                "the public key was accepted for alice, but the server requires ",
                "another authentication factor and offers only: password"
            )
        );
        assert_eq!(
            auth_failure(AuthKind::PublicKey, "alice", false, &remaining).to_string(),
            "authentication failed for alice (public key)"
        );
        assert_eq!(
            auth_failure(AuthKind::Agent, "alice", false, &remaining).to_string(),
            "no identity in the ssh agent was accepted for alice"
        );
    }

    /// Servers that turn the password itself into a keyboard-interactive
    /// round get the saved password without troubling the user; the code that
    /// follows it is nowhere in the profile, so that one is asked for.
    #[tokio::test]
    async fn a_password_round_is_answered_from_the_profile_but_a_code_is_not() {
        const ROUNDS: &[Round] = &[
            Round {
                instructions: "",
                prompts: &[("Password: ", false)],
                expected: &["hunter2"],
            },
            Round {
                instructions: "",
                prompts: &[("Verification code: ", false)],
                expected: &["424242"],
            },
        ];
        let server = AuthServer::new(
            FirstReply::Refused(&[MethodKind::KeyboardInteractive]),
            ROUNDS,
        );
        let answers = server.answers.clone();
        let mut handle = handshake(server).await;

        let mut profile = crate::tests::profile(SessionKind::Ssh);
        profile.auth = Some(AuthKind::Password);
        profile.password = Some("hunter2".into());

        let user = Mutex::new(CannedAnswers::new([vec!["424242".to_string()]]));
        authenticate(
            &mut handle,
            &profile,
            "alice",
            "mfa.example:22",
            &AuthPrompter::canned(&user),
        )
        .await
        .expect("password plus code completes the login");

        assert_eq!(
            *answers.lock(),
            vec![
                // The `password` method the server does not run,
                vec!["hunter2".to_string()],
                // then the same password as the first interactive round,
                vec!["hunter2".to_string()],
                // and the code, which only the user could supply.
                vec!["424242".to_string()],
            ]
        );
        let user = user.lock();
        assert_eq!(user.asked().len(), 1);
        assert_eq!(user.asked()[0].prompts[0].prompt, "Verification code: ");
    }

    #[test]
    fn the_saved_password_answers_only_a_password_question() {
        let hidden = |prompt: &str| Prompt {
            prompt: prompt.to_string(),
            echo: false,
        };
        let mut saved = Some("hunter2".to_string());

        assert_eq!(
            saved_answer(&[hidden("Verification code: ")], &mut saved),
            None
        );
        assert_eq!(
            saved_answer(&[hidden("Password: "), hidden("Code: ")], &mut saved),
            None,
            "a round that asks for more than a password is the user's to answer"
        );
        assert_eq!(
            saved_answer(
                &[Prompt {
                    prompt: "Password: ".into(),
                    echo: true
                }],
                &mut saved
            ),
            None,
            "a question whose answer is echoed is not asking for a secret"
        );

        assert_eq!(
            saved_answer(&[hidden("Password: ")], &mut saved),
            Some("hunter2".to_string())
        );
        assert_eq!(
            saved_answer(&[hidden("Password: ")], &mut saved),
            None,
            "the saved password is offered once; a second refusal is the user's to answer"
        );
    }
}
