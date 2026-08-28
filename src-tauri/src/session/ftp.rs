use std::convert::TryFrom;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime};

use suppaftp::list::File as FtpFile;
use suppaftp::types::FileType;
use suppaftp::{FtpError, FtpStream, Mode, Status};
use tauri::AppHandle;
use tokio::sync::mpsc::UnboundedReceiver;

use super::transfer::{
    ensure_local_directory, plan_local_upload, safe_local_child, validate_local_file_target,
    ProgressReporter,
};
use super::{
    emit_state, join_remote, sort_entries, SessionCommand, SftpRequest, SftpResponse,
    TransferProgress,
};
use crate::error::{err, AppError, Result};
use crate::model::{DirListing, FileEntry, SessionProfile};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IO_TIMEOUT: Duration = Duration::from_secs(60);
const TRANSFER_PROGRESS_INTERVAL: Duration = Duration::from_millis(50);
const TRANSFER_CHUNK_SIZE: usize = 1024 * 1024;
const ENCODING_UNKNOWN: u8 = 0;
const ENCODING_UTF8: u8 = 1;
const ENCODING_GBK: u8 = 2;

pub struct FtpConnection {
    stream: FtpStream,
    home: String,
    decode_listings: Arc<AtomicBool>,
    /// Cleared once the server refuses MLSD as unknown or unimplemented, so
    /// later listings go straight to LIST instead of paying a passive data
    /// connection and a command round trip for a guaranteed failure.
    mlsd_supported: bool,
}

impl FtpConnection {
    fn listing_command<T>(&mut self, command: impl FnOnce(&mut FtpStream) -> T) -> T {
        self.decode_listings.store(true, Ordering::Release);
        let result = command(&mut self.stream);
        self.decode_listings.store(false, Ordering::Release);
        result
    }
}

/// Establishes a standard, passive-mode FTP connection. It runs on a blocking
/// worker before the session owner thread is started so DNS, the welcome
/// response, and authentication never block Tauri's async runtime.
pub fn connect(profile: &SessionProfile) -> Result<FtpConnection> {
    let host = profile
        .host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .ok_or_else(|| AppError::new("ftp session is missing a host"))?
        .to_string();
    let port = profile.port.unwrap_or(21);
    let username = profile
        .username
        .as_deref()
        .map(str::trim)
        .filter(|username| !username.is_empty())
        .unwrap_or("anonymous")
        .to_string();
    let password = profile
        .password
        .clone()
        .filter(|password| !password.is_empty())
        .unwrap_or_else(|| {
            if username.eq_ignore_ascii_case("anonymous") {
                "anonymous@".to_string()
            } else {
                String::new()
            }
        });

    let remote_control = connect_control(&host, port)?;
    let remote_control_peer = remote_control.peer_addr()?;
    let use_extended_passive = remote_control_peer.is_ipv6();
    let server_encoding = Arc::new(AtomicU8::new(ENCODING_UNKNOWN));
    let control = control_encoding_proxy(remote_control, server_encoding.clone())?;
    let decode_listings = Arc::new(AtomicBool::new(false));
    let data_decode_listings = decode_listings.clone();
    let data_server_encoding = server_encoding.clone();
    let mut stream = FtpStream::connect_with_stream(control)
        .map_err(|error| {
            AppError::new(format!(
                "ftp server did not send a welcome response: {error}"
            ))
        })?
        .passive_stream_builder(move |advertised_address| {
            connect_data(
                passive_data_address(remote_control_peer, advertised_address),
                data_decode_listings.load(Ordering::Acquire),
                data_server_encoding.clone(),
            )
        });
    if use_extended_passive {
        stream.set_mode(Mode::ExtendedPassive);
    }
    // Many servers behind NAT advertise an unroutable private address in PASV.
    // SuppaFTP's workaround normally replaces it with the control peer, but
    // the encoding proxy makes that peer 127.0.0.1. The passive stream builder
    // above therefore restores the original FTP server IP while retaining the
    // data port selected by PASV/EPSV.
    stream.set_passive_nat_workaround(true);
    stream.login(&username, &password).map_err(|error| {
        AppError::new(format!("ftp authentication failed for {username}: {error}"))
    })?;
    stream.transfer_type(FileType::Binary).map_err(|error| {
        AppError::new(format!("ftp server refused binary transfer mode: {error}"))
    })?;
    let home = stream.pwd().map_err(|error| {
        AppError::new(format!(
            "ftp server did not report a working directory: {error}"
        ))
    })?;

    Ok(FtpConnection {
        stream,
        home,
        decode_listings,
        mlsd_supported: true,
    })
}

fn connect_control(host: &str, port: u16) -> Result<TcpStream> {
    let addresses: Vec<SocketAddr> = (host, port).to_socket_addrs()?.collect();
    if addresses.is_empty() {
        return Err(AppError::new(format!(
            "ftp host {host} did not resolve to an address"
        )));
    }

    let mut last_error = None;
    for address in addresses {
        match TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            Ok(stream) => {
                configure_socket(&stream)?;
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(AppError::new(format!(
        "cannot connect to ftp server {host}:{port}: {}",
        last_error
            .map(|error| error.to_string())
            .unwrap_or_else(|| "unknown connection error".to_string())
    )))
}

fn connect_data(
    address: SocketAddr,
    decode_listing: bool,
    server_encoding: Arc<AtomicU8>,
) -> std::result::Result<TcpStream, FtpError> {
    let stream =
        TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).map_err(FtpError::ConnectionError)?;
    configure_socket(&stream).map_err(FtpError::ConnectionError)?;
    if !decode_listing {
        return Ok(stream);
    }

    listing_decode_proxy(stream, server_encoding).map_err(FtpError::ConnectionError)
}

fn passive_data_address(control_peer: SocketAddr, advertised_address: SocketAddr) -> SocketAddr {
    SocketAddr::new(control_peer.ip(), advertised_address.port())
}

/// Translates control replies and path-bearing commands without changing the
/// public SuppaFTP API. The encoding remains unknown while traffic is ASCII.
/// Seeing valid non-ASCII UTF-8 selects UTF-8; invalid UTF-8 selects GBK.
fn control_encoding_proxy(
    remote: TcpStream,
    server_encoding: Arc<AtomicU8>,
) -> std::io::Result<TcpStream> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let client = TcpStream::connect(listener.local_addr()?)?;
    let (proxy, _) = listener.accept()?;
    configure_socket(&client)?;

    // The application-side client retains its command timeout. Proxy workers
    // may stay idle for the whole session and therefore must not inherit it.
    remote.set_read_timeout(None)?;
    proxy.set_read_timeout(None)?;

    let proxy_reader = proxy.try_clone()?;
    let mut proxy_writer = proxy;
    let mut remote_writer = remote.try_clone()?;
    let remote_encoding = server_encoding.clone();

    std::thread::Builder::new()
        .name("edgeterm-ftp-control-out".to_string())
        .spawn(move || {
            let mut reader = BufReader::new(proxy_reader);
            loop {
                let mut line = Vec::new();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let encoded = encode_control_bytes(&line, &server_encoding);
                        if remote_writer.write_all(&encoded).is_err()
                            || remote_writer.flush().is_err()
                        {
                            break;
                        }
                    }
                }
            }
            let _ = remote_writer.shutdown(Shutdown::Write);
        })?;

    std::thread::Builder::new()
        .name("edgeterm-ftp-control-in".to_string())
        .spawn(move || {
            let mut reader = BufReader::new(remote);
            loop {
                let mut line = Vec::new();
                match reader.read_until(b'\n', &mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        let decoded = decode_protocol_bytes(&line, &remote_encoding);
                        if proxy_writer.write_all(&decoded).is_err()
                            || proxy_writer.flush().is_err()
                        {
                            break;
                        }
                    }
                }
            }
            let _ = proxy_writer.shutdown(Shutdown::Write);
        })?;

    Ok(client)
}

/// SuppaFTP 6.2.1 tolerates invalid UTF-8, but its lossy conversion has already
/// discarded the original filename bytes before the application sees them.
/// Route directory data through a loopback socket so valid UTF-8 stays intact
/// while legacy Chinese listings are converted from GBK to UTF-8. This proxy
/// is enabled only for MLSD/LIST/NLST; RETR/STOR remain byte-for-byte binary.
fn listing_decode_proxy(
    mut remote: TcpStream,
    server_encoding: Arc<AtomicU8>,
) -> std::io::Result<TcpStream> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let client = TcpStream::connect(listener.local_addr()?)?;
    let (mut proxy, _) = listener.accept()?;
    configure_socket(&client)?;
    configure_socket(&proxy)?;

    std::thread::Builder::new()
        .name("edgeterm-ftp-list-decode".to_string())
        .spawn(move || {
            let mut raw = Vec::new();
            if remote.read_to_end(&mut raw).is_ok() {
                let decoded = decode_protocol_bytes(&raw, &server_encoding);
                let _ = proxy.write_all(&decoded);
                let _ = proxy.flush();
            }
            let _ = proxy.shutdown(Shutdown::Write);
        })?;

    Ok(client)
}

fn decode_protocol_bytes(raw: &[u8], server_encoding: &AtomicU8) -> Vec<u8> {
    match server_encoding.load(Ordering::Acquire) {
        ENCODING_GBK => return encoding_rs::GBK.decode(raw).0.into_owned().into_bytes(),
        ENCODING_UTF8 => return String::from_utf8_lossy(raw).into_owned().into_bytes(),
        _ => {}
    }

    if std::str::from_utf8(raw).is_ok() {
        if raw.iter().any(|byte| !byte.is_ascii()) {
            let _ = server_encoding.compare_exchange(
                ENCODING_UNKNOWN,
                ENCODING_UTF8,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
        }
        raw.to_vec()
    } else {
        server_encoding.store(ENCODING_GBK, Ordering::Release);
        encoding_rs::GBK.decode(raw).0.into_owned().into_bytes()
    }
}

fn encode_control_bytes(utf8: &[u8], server_encoding: &AtomicU8) -> Vec<u8> {
    if server_encoding.load(Ordering::Acquire) != ENCODING_GBK {
        return utf8.to_vec();
    }
    let text = String::from_utf8_lossy(utf8);
    encoding_rs::GBK.encode(&text).0.into_owned()
}

fn configure_socket(stream: &TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(IO_TIMEOUT))?;
    stream.set_write_timeout(Some(IO_TIMEOUT))?;
    stream.set_nodelay(true)?;
    Ok(())
}

/// FTP has no interactive terminal. The single owner thread serializes all
/// control-channel and data-channel commands for the dedicated FTP file pane.
pub fn spawn(
    app: AppHandle,
    id: String,
    mut connection: FtpConnection,
    mut rx: UnboundedReceiver<SessionCommand>,
) -> Result<()> {
    std::thread::Builder::new()
        .name(format!("edgeterm-ftp-{id}"))
        .spawn(move || {
            // `open_session` marks the optimistic tab connected only after the
            // manager has inserted its command handle. Emitting that state
            // from this immediately-started thread would let Filer race the
            // insertion and fail its first Home request.
            let mut close_requested = false;
            while let Some(command) = rx.blocking_recv() {
                match command {
                    SessionCommand::Sftp { request, reply } => {
                        let _ = reply.send(run_ftp(&mut connection, request));
                    }
                    SessionCommand::Close => {
                        close_requested = true;
                        break;
                    }
                    // Standard FTP is a file protocol, not an interactive
                    // terminal, so keyboard input and resize events do not map
                    // to protocol commands.
                    SessionCommand::Write(_) | SessionCommand::Resize { .. } => {}
                    other @ SessionCommand::WriteConfirmed { .. } => {
                        super::reject_sftp(other, crate::model::SessionKind::Ftp);
                    }
                }
            }

            let _ = connection.stream.quit();
            // The frontend already knows about a close it asked for; see
            // `emit_state`. The channel closing without a Close command means
            // the whole manager is gone, and nobody is listening either.
            if !close_requested {
                emit_state(&app, &id, "closed", None);
            }
        })
        .map_err(err)?;
    Ok(())
}

fn run_ftp(connection: &mut FtpConnection, request: SftpRequest) -> Result<SftpResponse> {
    match request {
        SftpRequest::Home => Ok(SftpResponse::Path(connection.home.clone())),
        SftpRequest::Canonicalize { path } => Ok(SftpResponse::Path(canonicalize(
            &mut connection.stream,
            &path,
        )?)),
        SftpRequest::List { path } => list_directory(connection, &path).map(SftpResponse::Listing),
        SftpRequest::Mkdir { path } => {
            connection.stream.mkdir(path)?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::Remove { path, is_dir } => {
            if is_dir {
                connection.stream.rmdir(path)?;
            } else {
                connection.stream.rm(path)?;
            }
            Ok(SftpResponse::Done)
        }
        SftpRequest::Rename { from, to } => {
            connection.stream.rename(from, to)?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::Download {
            remote,
            local,
            progress,
        } => {
            download_file(&mut connection.stream, &remote, &local, &progress)?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::DownloadDirectory {
            remote,
            local,
            progress,
        } => {
            download_directory(connection, &remote, &local, &progress)?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::Upload {
            local,
            remote,
            progress,
        } => {
            upload_file(&mut connection.stream, &local, &remote, &progress)?;
            Ok(SftpResponse::Done)
        }
        SftpRequest::UploadDirectory {
            local,
            remote,
            progress,
        } => {
            upload_directory(connection, &local, &remote, &progress)?;
            Ok(SftpResponse::Done)
        }
    }
}

fn canonicalize(ftp: &mut FtpStream, path: &str) -> Result<String> {
    let original = ftp.pwd()?;
    ftp.cwd(if path.is_empty() { "." } else { path })?;
    let resolved = ftp.pwd();
    let restore = ftp.cwd(&original);
    match (resolved, restore) {
        (Ok(path), Ok(())) => Ok(path),
        (Err(error), _) | (_, Err(error)) => Err(error.into()),
    }
}

fn list_directory(connection: &mut FtpConnection, path: &str) -> Result<DirListing> {
    connection
        .stream
        .cwd(if path.is_empty() { "." } else { path })?;
    let base = connection.stream.pwd()?;

    let mlsd_entries = if connection.mlsd_supported {
        match connection.listing_command(|ftp| ftp.mlsd(None)) {
            Ok(lines) => parse_listing(&base, &lines, FtpFile::from_mlsx_line),
            Err(error) => {
                if mlsd_unsupported(&error) {
                    connection.mlsd_supported = false;
                }
                None
            }
        }
    } else {
        None
    };
    let list_entries = if mlsd_entries.is_none() {
        connection
            .listing_command(|ftp| ftp.list(None))
            .ok()
            .and_then(|lines| parse_listing(&base, &lines, |line| FtpFile::try_from(line)))
    } else {
        None
    };
    let entries = match mlsd_entries.or(list_entries) {
        Some(entries) => entries,
        None => list_names(connection, &base)?,
    };

    let mut entries = entries;
    sort_entries(&mut entries);
    Ok(DirListing {
        path: base,
        entries,
    })
}

/// A 500 / 502 reply means the server does not implement MLSD at all (vsftpd,
/// for one, answers `500 Unknown command`). Anything else — a dropped data
/// connection, a timeout, a per-directory refusal — may be transient, so the
/// next listing tries MLSD again.
fn mlsd_unsupported(error: &FtpError) -> bool {
    matches!(
        error,
        FtpError::UnexpectedResponse(response)
            if matches!(
                response.status,
                Status::BadCommand | Status::NotImplemented | Status::CommandNotImplemented
            )
    )
}

fn parse_listing<F>(base: &str, lines: &[String], mut parse: F) -> Option<Vec<FileEntry>>
where
    F: FnMut(&str) -> std::result::Result<FtpFile, suppaftp::list::ParseError>,
{
    let relevant: Vec<&str> = lines
        .iter()
        .map(String::as_str)
        .filter(|line| {
            let lower = line.to_ascii_lowercase();
            !lower.starts_with("total ")
                && !lower.contains("type=cdir;")
                && !lower.contains("type=pdir;")
        })
        .collect();

    let mut entries = Vec::with_capacity(relevant.len());
    for line in relevant {
        let file = parse(line).ok()?;
        if let Some(entry) = entry_from_file(base, &file) {
            entries.push(entry);
        }
    }
    Some(entries)
}

fn entry_from_file(base: &str, file: &FtpFile) -> Option<FileEntry> {
    let name = file.name();
    if name.is_empty() || matches!(name, "." | "..") {
        return None;
    }

    Some(FileEntry {
        name: name.to_string(),
        path: join_remote(base, name),
        is_dir: file.is_directory(),
        is_symlink: file.is_symlink(),
        size: file.size() as u64,
        modified: system_time_to_unix(file.modified()),
        // LIST/MLSD permissions are optional and server-specific. SuppaFTP's
        // parser fills defaults when facts are absent, so reporting them here
        // would make guessed permissions look authoritative.
        permissions: None,
        owner: file.uid().map(|uid| uid.to_string()),
        group: file.gid().map(|gid| gid.to_string()),
    })
}

/// Last-resort listing for servers without MLSD and with a nonstandard LIST
/// format. NLST supplies names; CWD probes distinguish directories from files.
fn list_names(connection: &mut FtpConnection, base: &str) -> Result<Vec<FileEntry>> {
    let names = connection.listing_command(|ftp| ftp.nlst(None))?;
    let mut entries = Vec::with_capacity(names.len());
    for raw_name in names {
        let trimmed = raw_name.trim_end_matches('/');
        let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
        if name.is_empty() || matches!(name, "." | "..") {
            continue;
        }
        let path = if trimmed.starts_with('/') {
            trimmed.to_string()
        } else {
            join_remote(base, name)
        };
        let is_dir = connection.stream.cwd(&path).is_ok();
        if is_dir {
            connection.stream.cwd(base)?;
        }
        let size = if is_dir {
            0
        } else {
            connection.stream.size(&path).unwrap_or(0) as u64
        };
        let modified = connection
            .stream
            .mdtm(&path)
            .ok()
            .map(|value| value.and_utc().timestamp());
        entries.push(FileEntry {
            name: name.to_string(),
            path,
            is_dir,
            is_symlink: false,
            size,
            modified,
            permissions: None,
            owner: None,
            group: None,
        });
    }
    Ok(entries)
}

fn system_time_to_unix(time: SystemTime) -> Option<i64> {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_secs()).ok())
}

fn download_file(
    ftp: &mut FtpStream,
    remote: &str,
    local: &str,
    progress: &tauri::ipc::Channel<TransferProgress>,
) -> Result<()> {
    let total = ftp.size(remote).unwrap_or(0) as u64;
    let mut last_report = Instant::now();

    report_transfer_progress(progress, 0, total);
    let transferred = copy_remote_file(ftp, remote, Path::new(local), |transferred| {
        if last_report.elapsed() >= TRANSFER_PROGRESS_INTERVAL {
            report_transfer_progress(progress, transferred, total);
            last_report = Instant::now();
        }
    })?;
    report_transfer_progress(progress, transferred, total);
    Ok(())
}

struct FtpDownloadJob {
    remote: String,
    local: PathBuf,
}

fn download_directory(
    connection: &mut FtpConnection,
    remote: &str,
    local: &str,
    progress: &tauri::ipc::Channel<TransferProgress>,
) -> Result<()> {
    let local_root = PathBuf::from(local);
    let mut pending = vec![(remote.to_string(), local_root.clone())];
    let mut directories = vec![local_root];
    let mut files = Vec::new();
    let mut total = 0_u64;

    // Build a metadata-only plan first so progress covers the whole tree. File
    // contents are still copied one at a time through the fixed 1 MiB buffer.
    while let Some((remote_dir, local_dir)) = pending.pop() {
        let listing = list_directory(connection, &remote_dir)?;
        for entry in listing.entries {
            let local_child = safe_local_child(&local_dir, &entry.name)?;
            if entry.is_dir && !entry.is_symlink {
                directories.push(local_child.clone());
                pending.push((entry.path, local_child));
                continue;
            }
            // LIST/MLSD report a symlink without the type of its target. RETR
            // on a linked directory would abort the whole download, so probe
            // with CWD and skip directory links; following them could loop
            // back into an ancestor forever.
            if entry.is_symlink && is_remote_directory(&mut connection.stream, &entry.path) {
                continue;
            }
            total = total.checked_add(entry.size).ok_or_else(|| {
                AppError::new("FTP folder is too large to report transfer progress")
            })?;
            files.push(FtpDownloadJob {
                remote: entry.path,
                local: local_child,
            });
        }
    }

    for directory in &directories {
        ensure_local_directory(directory)?;
    }
    for file in &files {
        validate_local_file_target(&file.local)?;
    }

    let mut reporter = ProgressReporter::begin(progress, total);
    let mut transferred = 0_u64;
    for file in files {
        let completed_before_file = transferred;
        let copied = copy_remote_file(
            &mut connection.stream,
            &file.remote,
            &file.local,
            |file_transferred| {
                reporter.update(completed_before_file.saturating_add(file_transferred));
            },
        )?;
        transferred = transferred.saturating_add(copied);
    }
    reporter.finish(transferred);
    Ok(())
}

fn is_remote_directory(ftp: &mut FtpStream, path: &str) -> bool {
    let Ok(original) = ftp.pwd() else {
        return false;
    };
    if ftp.cwd(path).is_err() {
        return false;
    }
    let _ = ftp.cwd(&original);
    true
}

fn copy_remote_file<F>(ftp: &mut FtpStream, remote: &str, local: &Path, on_chunk: F) -> Result<u64>
where
    F: FnMut(u64),
{
    validate_local_file_target(local)?;
    let mut source = ftp.retr_as_stream(remote)?;
    let mut target = std::fs::File::create(local)?;
    let copied = copy_in_chunks(&mut source, &mut target, on_chunk);
    let finalized = ftp.finalize_retr_stream(source);

    let transferred = copied?;
    finalized?;
    target.flush()?;
    Ok(transferred)
}

fn upload_file(
    ftp: &mut FtpStream,
    local: &str,
    remote: &str,
    progress: &tauri::ipc::Channel<TransferProgress>,
) -> Result<()> {
    let metadata = std::fs::metadata(local)?;
    if !metadata.is_file() {
        return Err(AppError::new("only regular files can be uploaded"));
    }
    let total = metadata.len();
    let mut last_report = Instant::now();

    report_transfer_progress(progress, 0, total);
    let transferred = copy_local_file(ftp, Path::new(local), remote, |transferred| {
        if last_report.elapsed() >= TRANSFER_PROGRESS_INTERVAL {
            report_transfer_progress(progress, transferred, total);
            last_report = Instant::now();
        }
    })?;
    report_transfer_progress(progress, transferred, total);
    Ok(())
}

fn upload_directory(
    connection: &mut FtpConnection,
    local: &str,
    remote: &str,
    progress: &tauri::ipc::Channel<TransferProgress>,
) -> Result<()> {
    // Same shape as the download: a metadata-only plan first so progress
    // covers the whole tree, then one file at a time through the fixed buffer.
    let plan = plan_local_upload(Path::new(local), remote)?;
    for directory in &plan.directories {
        ensure_remote_directory(&mut connection.stream, directory)?;
    }

    let mut reporter = ProgressReporter::begin(progress, plan.total);
    let mut transferred = 0_u64;
    for file in plan.files {
        let completed_before_file = transferred;
        let copied = copy_local_file(
            &mut connection.stream,
            &file.local,
            &file.remote,
            |file_transferred| {
                reporter.update(completed_before_file.saturating_add(file_transferred));
            },
        )?;
        transferred = transferred.saturating_add(copied);
    }
    reporter.finish(transferred);
    Ok(())
}

/// MKD fails when the folder already exists, which is expected when merging
/// into a remote tree, so an existing directory is accepted after a CWD probe.
fn ensure_remote_directory(ftp: &mut FtpStream, path: &str) -> Result<()> {
    match ftp.mkdir(path) {
        Ok(()) => Ok(()),
        Err(_) if is_remote_directory(ftp, path) => Ok(()),
        Err(error) => Err(AppError::new(format!(
            "cannot create remote folder {path}: {error}"
        ))),
    }
}

fn copy_local_file<F>(ftp: &mut FtpStream, local: &Path, remote: &str, on_chunk: F) -> Result<u64>
where
    F: FnMut(u64),
{
    let mut source = std::fs::File::open(local)?;
    let mut target = ftp.put_with_stream(remote)?;
    let copied = copy_in_chunks(&mut source, &mut target, on_chunk);
    let flushed = target.flush();
    let finalized = ftp.finalize_put_stream(target);

    let transferred = copied?;
    flushed?;
    finalized?;
    Ok(transferred)
}

fn copy_in_chunks<R, W, F>(source: &mut R, target: &mut W, mut on_chunk: F) -> std::io::Result<u64>
where
    R: Read,
    W: Write,
    F: FnMut(u64),
{
    let mut buffer = vec![0; TRANSFER_CHUNK_SIZE];
    let mut transferred = 0;
    loop {
        let count = source.read(&mut buffer)?;
        if count == 0 {
            return Ok(transferred);
        }
        target.write_all(&buffer[..count])?;
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

#[cfg(test)]
mod tests {
    use super::{
        control_encoding_proxy, copy_in_chunks, decode_protocol_bytes, encode_control_bytes,
        entry_from_file, mlsd_unsupported, parse_listing, passive_data_address, ENCODING_GBK,
        ENCODING_UNKNOWN, TRANSFER_CHUNK_SIZE,
    };
    use std::sync::atomic::{AtomicU8, Ordering};
    use std::sync::Arc;
    use std::{io::BufRead, io::BufReader, io::Write, net::TcpListener, net::TcpStream};
    use suppaftp::list::File as FtpFile;
    use suppaftp::types::Response;
    use suppaftp::{FtpError, Status};

    #[test]
    fn parses_mlsd_entries_into_remote_listing() {
        let lines = vec![
            "type=cdir;modify=20260812120000; .".to_string(),
            "type=dir;modify=20260810112233; projects".to_string(),
            "type=file;size=42;modify=20260811123456; notes.txt".to_string(),
        ];
        let entries = parse_listing("/home/test", &lines, FtpFile::from_mlsx_line)
            .expect("valid MLSD listing");

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].path, "/home/test/projects");
        assert!(entries[0].is_dir);
        assert_eq!(entries[1].path, "/home/test/notes.txt");
        assert_eq!(entries[1].size, 42);
    }

    #[test]
    fn parses_posix_ftp_list_entry() {
        let file = FtpFile::try_from("-rw-r--r-- 1 1000 1000 8192 Nov 5 2018 archive file.txt")
            .expect("POSIX LIST entry");
        let entry = entry_from_file("/pub", &file).expect("visible file");

        assert_eq!(entry.name, "archive file.txt");
        assert_eq!(entry.path, "/pub/archive file.txt");
        assert_eq!(entry.size, 8192);
        assert!(!entry.is_dir);
    }

    #[test]
    fn directory_decoder_preserves_utf8_and_converts_gbk() {
        let utf8_encoding = AtomicU8::new(ENCODING_UNKNOWN);
        let utf8 = "资料/测试.txt".as_bytes();
        assert_eq!(decode_protocol_bytes(utf8, &utf8_encoding), utf8);

        // GBK bytes for “资料/测试.txt”.
        let gbk_encoding = AtomicU8::new(ENCODING_UNKNOWN);
        let gbk = b"\xd7\xca\xc1\xcf/\xb2\xe2\xca\xd4.txt";
        assert_eq!(
            String::from_utf8(decode_protocol_bytes(gbk, &gbk_encoding)).unwrap(),
            "资料/测试.txt"
        );
        assert_eq!(gbk_encoding.load(Ordering::Acquire), ENCODING_GBK);
        assert_eq!(
            encode_control_bytes("CWD 资料\r\n".as_bytes(), &gbk_encoding),
            b"CWD \xd7\xca\xc1\xcf\r\n"
        );
    }

    #[test]
    fn control_proxy_decodes_replies_and_encodes_commands() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket.write_all(b"220 ready\r\n").unwrap();
            socket
                .write_all(b"257 \"/\xd7\xca\xc1\xcf\" is current directory\r\n")
                .unwrap();
            let mut command = Vec::new();
            BufReader::new(socket)
                .read_until(b'\n', &mut command)
                .unwrap();
            command
        });

        let encoding = Arc::new(AtomicU8::new(ENCODING_UNKNOWN));
        let remote = TcpStream::connect(address).unwrap();
        let mut client = control_encoding_proxy(remote, encoding.clone()).unwrap();
        let mut reader = BufReader::new(client.try_clone().unwrap());
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert_eq!(line, "220 ready\r\n");
        line.clear();
        reader.read_line(&mut line).unwrap();
        assert_eq!(line, "257 \"/资料\" is current directory\r\n");
        assert_eq!(encoding.load(Ordering::Acquire), ENCODING_GBK);

        client.write_all("CWD 资料\r\n".as_bytes()).unwrap();
        client.flush().unwrap();
        assert_eq!(server.join().unwrap(), b"CWD \xd7\xca\xc1\xcf\r\n");
    }

    #[test]
    fn passive_data_connection_uses_the_real_control_host() {
        let control_peer = "203.0.113.9:21".parse().unwrap();
        let proxy_peer = "127.0.0.1:49152".parse().unwrap();
        assert_eq!(
            passive_data_address(control_peer, proxy_peer),
            "203.0.113.9:49152".parse().unwrap()
        );
    }

    #[test]
    fn copy_in_chunks_streams_large_inputs_with_a_bounded_buffer() {
        let payload = vec![0x5a; TRANSFER_CHUNK_SIZE * 3 + 17];
        let mut source = payload.as_slice();
        let mut target = Vec::new();
        let mut checkpoints = Vec::new();

        let transferred = copy_in_chunks(&mut source, &mut target, |total| {
            checkpoints.push(total);
        })
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

    #[test]
    fn mlsd_refusal_is_remembered_but_transient_failures_are_not() {
        let refused = |status: Status| {
            FtpError::UnexpectedResponse(Response::new(status, b"500 Unknown command.".to_vec()))
        };
        assert!(mlsd_unsupported(&refused(Status::BadCommand)));
        assert!(mlsd_unsupported(&refused(Status::NotImplemented)));
        assert!(mlsd_unsupported(&refused(Status::CommandNotImplemented)));

        // A per-directory refusal or a broken data connection must not
        // disable MLSD for the rest of the session.
        assert!(!mlsd_unsupported(&refused(Status::FileUnavailable)));
        assert!(!mlsd_unsupported(&FtpError::ConnectionError(
            std::io::Error::new(std::io::ErrorKind::TimedOut, "data connection timed out")
        )));
    }
}
