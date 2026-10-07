//! Telnet sessions: a TCP connection speaking the NVT protocol of RFC 854.
//!
//! The protocol layer (`Telnet`) is a pure byte transformer so it can be
//! tested without a socket: it strips and answers option negotiation in the
//! received stream, encodes what the user types, and keeps the local line
//! editor that runs while the server does not echo. One task owns the socket
//! for the session's lifetime, like every other backend.
//!
//! Behaviour follows the BSD `telnet` client, which is what people expect
//! when they "telnet to a port":
//! - Negotiation is only started by us on the telnet port (23). On any other
//!   port the client stays passive — it still answers a server that
//!   negotiates — so probing an HTTP, SMTP or Redis port does not put
//!   `IAC` bytes in front of the first request.
//! - Until the server offers to echo (`WILL ECHO`, which every telnetd sends
//!   before its login prompt), input is edited and echoed locally and sent a
//!   line at a time, ending in CR LF. Once the server echoes, every key goes
//!   out as it is typed.
//!
//! Telnet has no authentication of its own: a device logs the user in by
//! printing `Username:` and `Password:` on the terminal. A profile that holds
//! the answers has them typed for it at those prompts (`AutoLogin`).

use std::time::{Duration, Instant};

use tauri::AppHandle;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc::UnboundedReceiver;

use super::recording::Recorder;
use super::{emit_state, reject_unsupported, OutputPump, SessionCommand};
use crate::error::{AppError, Result};
use crate::model::{SessionKind, SessionProfile};

pub const DEFAULT_PORT: u16 = 23;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
/// How long after connecting a login prompt is still answered. Long enough
/// for a slow device's banner; past it, a "password:" in the output is a
/// command's (`enable`, `su`) and is the user's to answer.
const LOGIN_WINDOW: Duration = Duration::from_secs(60);
/// The end of the output kept for recognising a prompt.
const LOGIN_TAIL: usize = 128;

/// What the server is told the terminal is, the same type an SSH session
/// asks its pty for.
const TERMINAL_TYPE: &[u8] = b"xterm-256color";

const SE: u8 = 240;
const SB: u8 = 250;
const WILL: u8 = 251;
const WONT: u8 = 252;
const DO: u8 = 253;
const DONT: u8 = 254;
const IAC: u8 = 255;

const OPT_BINARY: u8 = 0;
const OPT_ECHO: u8 = 1;
const OPT_SGA: u8 = 3;
const OPT_TTYPE: u8 = 24;
const OPT_NAWS: u8 = 31;

const TTYPE_IS: u8 = 0;
const TTYPE_SEND: u8 = 1;

/// Longest subnegotiation kept; anything longer is a broken peer, and only
/// its first bytes matter for the options this client answers.
const MAX_SUBNEGOTIATION: usize = 256;

/// One side of one option, after RFC 1143's "Q method" without the queue
/// bits: a request we sent is remembered so the peer's agreement is not
/// answered again, which is what keeps two clients from negotiating forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Opt {
    No,
    Yes,
    WantYes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Rx {
    Data,
    /// After a CR in the data stream: an NVT sends a bare CR as CR NUL.
    Cr,
    Iac,
    Verb(u8),
    Sub,
    SubIac,
}

pub struct Telnet {
    rx: Rx,
    /// Options the server performs (it said WILL), indexed by option code.
    remote: [Opt; 256],
    /// Options we perform (we said WILL).
    local: [Opt; 256],
    sub: Vec<u8>,
    cols: u16,
    rows: u16,
    /// The local line editor's pending line, in the session's encoding.
    line: Vec<u8>,
    /// The previous input chunk ended on a CR; a LF opening the next one
    /// belongs to it.
    input_after_cr: bool,
}

/// What one received chunk turned into.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Received {
    /// Terminal data for the screen, with protocol bytes removed.
    pub data: Vec<u8>,
    /// Negotiation answers to send back.
    pub reply: Vec<u8>,
}

/// What one chunk of user input turned into.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Typed {
    /// Bytes for the socket.
    pub send: Vec<u8>,
    /// Local echo for the screen, while the line editor is active.
    pub echo: Vec<u8>,
}

impl Telnet {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            rx: Rx::Data,
            remote: [Opt::No; 256],
            local: [Opt::No; 256],
            sub: Vec::new(),
            cols,
            rows,
            line: Vec::new(),
            input_after_cr: false,
        }
    }

    /// The negotiation a client opens with on the telnet port: offer the
    /// window size and terminal type, and ask the server to echo and drop
    /// go-ahead — the character-at-a-time mode every telnetd supports.
    pub fn opening(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        for option in [OPT_NAWS, OPT_TTYPE, OPT_SGA] {
            self.local[option as usize] = Opt::WantYes;
            out.extend_from_slice(&[IAC, WILL, option]);
        }
        for option in [OPT_ECHO, OPT_SGA] {
            self.remote[option as usize] = Opt::WantYes;
            out.extend_from_slice(&[IAC, DO, option]);
        }
        out
    }

    /// Whether the server echoes what is typed; if not, the local line
    /// editor is in charge.
    pub fn remote_echo(&self) -> bool {
        self.remote[OPT_ECHO as usize] == Opt::Yes
    }

    fn remote_binary(&self) -> bool {
        self.remote[OPT_BINARY as usize] == Opt::Yes
    }

    fn local_binary(&self) -> bool {
        self.local[OPT_BINARY as usize] == Opt::Yes
    }

    pub fn receive(&mut self, input: &[u8]) -> Received {
        let mut out = Received::default();
        for &byte in input {
            self.rx = match self.rx {
                Rx::Data | Rx::Cr => {
                    let after_cr = self.rx == Rx::Cr;
                    match byte {
                        IAC => Rx::Iac,
                        // CR NUL is how an NVT spells a bare CR.
                        0 if after_cr && !self.remote_binary() => Rx::Data,
                        b'\r' if !self.remote_binary() => {
                            out.data.push(byte);
                            Rx::Cr
                        }
                        _ => {
                            out.data.push(byte);
                            Rx::Data
                        }
                    }
                }
                Rx::Iac => match byte {
                    IAC => {
                        out.data.push(IAC);
                        Rx::Data
                    }
                    WILL | WONT | DO | DONT => Rx::Verb(byte),
                    SB => {
                        self.sub.clear();
                        Rx::Sub
                    }
                    // NOP, GA, data mark and the rest carry nothing a
                    // terminal shows.
                    _ => Rx::Data,
                },
                Rx::Verb(verb) => {
                    self.negotiate(verb, byte, &mut out.reply);
                    Rx::Data
                }
                Rx::Sub => match byte {
                    IAC => Rx::SubIac,
                    _ => {
                        if self.sub.len() < MAX_SUBNEGOTIATION {
                            self.sub.push(byte);
                        }
                        Rx::Sub
                    }
                },
                Rx::SubIac => match byte {
                    SE => {
                        self.subnegotiation(&mut out.reply);
                        Rx::Data
                    }
                    IAC => {
                        if self.sub.len() < MAX_SUBNEGOTIATION {
                            self.sub.push(IAC);
                        }
                        Rx::Sub
                    }
                    // A peer that forgot SE; take what came as the end.
                    _ => {
                        self.subnegotiation(&mut out.reply);
                        Rx::Data
                    }
                },
            };
        }
        out
    }

    fn negotiate(&mut self, verb: u8, option: u8, reply: &mut Vec<u8>) {
        let index = option as usize;
        match verb {
            WILL => match self.remote[index] {
                Opt::No if matches!(option, OPT_ECHO | OPT_SGA | OPT_BINARY) => {
                    self.remote[index] = Opt::Yes;
                    reply.extend_from_slice(&[IAC, DO, option]);
                }
                Opt::No => reply.extend_from_slice(&[IAC, DONT, option]),
                Opt::WantYes => self.remote[index] = Opt::Yes,
                Opt::Yes => {}
            },
            WONT => match self.remote[index] {
                Opt::Yes => {
                    self.remote[index] = Opt::No;
                    reply.extend_from_slice(&[IAC, DONT, option]);
                }
                Opt::WantYes => self.remote[index] = Opt::No,
                Opt::No => {}
            },
            DO => match self.local[index] {
                Opt::No if matches!(option, OPT_NAWS | OPT_TTYPE | OPT_SGA | OPT_BINARY) => {
                    self.local[index] = Opt::Yes;
                    reply.extend_from_slice(&[IAC, WILL, option]);
                    self.enabled_locally(option, reply);
                }
                Opt::No => reply.extend_from_slice(&[IAC, WONT, option]),
                Opt::WantYes => {
                    self.local[index] = Opt::Yes;
                    self.enabled_locally(option, reply);
                }
                Opt::Yes => {}
            },
            DONT => match self.local[index] {
                Opt::Yes => {
                    self.local[index] = Opt::No;
                    reply.extend_from_slice(&[IAC, WONT, option]);
                }
                Opt::WantYes => self.local[index] = Opt::No,
                Opt::No => {}
            },
            _ => {}
        }
    }

    fn enabled_locally(&self, option: u8, reply: &mut Vec<u8>) {
        if option == OPT_NAWS {
            self.window_size(reply);
        }
    }

    fn subnegotiation(&mut self, reply: &mut Vec<u8>) {
        if self.sub.first() == Some(&OPT_TTYPE)
            && self.sub.get(1) == Some(&TTYPE_SEND)
            && self.local[OPT_TTYPE as usize] == Opt::Yes
        {
            reply.extend_from_slice(&[IAC, SB, OPT_TTYPE, TTYPE_IS]);
            reply.extend_from_slice(TERMINAL_TYPE);
            reply.extend_from_slice(&[IAC, SE]);
        }
    }

    /// `IAC SB NAWS <cols> <rows> IAC SE`, with a 255 in the sizes doubled.
    fn window_size(&self, reply: &mut Vec<u8>) {
        reply.extend_from_slice(&[IAC, SB, OPT_NAWS]);
        for byte in self
            .cols
            .to_be_bytes()
            .into_iter()
            .chain(self.rows.to_be_bytes())
        {
            reply.push(byte);
            if byte == IAC {
                reply.push(IAC);
            }
        }
        reply.extend_from_slice(&[IAC, SE]);
    }

    /// Records the terminal size; returns the report to send when the server
    /// asked for it (NAWS).
    pub fn resize(&mut self, cols: u16, rows: u16) -> Vec<u8> {
        self.cols = cols;
        self.rows = rows;
        let mut out = Vec::new();
        if self.local[OPT_NAWS as usize] == Opt::Yes {
            self.window_size(&mut out);
        }
        out
    }

    /// Keyboard and paste input. While the server echoes, it goes straight
    /// out with Enter sent as CR LF; otherwise it is edited and echoed here
    /// and a whole line goes out when Enter is pressed.
    pub fn typed(&mut self, input: &[u8]) -> Typed {
        let mut out = Typed::default();
        if self.remote_echo() {
            // Whatever the line editor still held was typed before the
            // server took over echoing; it goes first.
            let pending = std::mem::take(&mut self.line);
            self.escape_into(&pending, &mut out.send);
            for &byte in input {
                if byte == b'\n' && self.input_after_cr {
                    self.input_after_cr = false;
                    continue;
                }
                self.input_after_cr = byte == b'\r';
                if byte == b'\r' && !self.local_binary() {
                    out.send.extend_from_slice(b"\r\n");
                } else {
                    self.escape_into(&[byte], &mut out.send);
                }
            }
            return out;
        }

        for (index, &byte) in input.iter().enumerate() {
            if byte == b'\n' && self.input_after_cr {
                self.input_after_cr = false;
                continue;
            }
            self.input_after_cr = byte == b'\r';
            match byte {
                // An escape sequence (arrows, function keys) arrives as one
                // chunk; it is not line editing and goes out whole, after
                // the text typed before it.
                0x1b => {
                    let line = std::mem::take(&mut self.line);
                    self.escape_into(&line, &mut out.send);
                    self.escape_into(&input[index..], &mut out.send);
                    self.input_after_cr = false;
                    return out;
                }
                b'\r' | b'\n' => {
                    let line = std::mem::take(&mut self.line);
                    self.escape_into(&line, &mut out.send);
                    out.send.extend_from_slice(b"\r\n");
                    out.echo.extend_from_slice(b"\r\n");
                }
                0x7f | 0x08 => {
                    if self.pop_char() {
                        out.echo.extend_from_slice(b"\x08 \x08");
                    }
                }
                // ^U: erase the line.
                0x15 => {
                    while self.pop_char() {
                        out.echo.extend_from_slice(b"\x08 \x08");
                    }
                }
                // ^C drops the line and still reaches the server, where it
                // interrupts whatever is running.
                0x03 => {
                    self.line.clear();
                    out.echo.extend_from_slice(b"^C\r\n");
                    out.send.push(0x03);
                }
                b'\t' => {
                    self.line.push(byte);
                    out.echo.push(byte);
                }
                // Other control keys are not line editing either; they go
                // out at once, after the text typed before them.
                0..=0x1f => {
                    let line = std::mem::take(&mut self.line);
                    self.escape_into(&line, &mut out.send);
                    out.send.push(byte);
                }
                _ => {
                    self.line.push(byte);
                    out.echo.push(byte);
                }
            }
        }
        out
    }

    /// Removes the last character of the pending line — a whole UTF-8
    /// sequence for non-ASCII text, a single byte for a legacy encoding's
    /// trailing byte that is not one. Returns whether anything was removed.
    fn pop_char(&mut self) -> bool {
        let Some(&last) = self.line.last() else {
            return false;
        };
        let mut len = 1;
        if last >= 0x80 {
            // Walk back over UTF-8 continuation bytes to the lead byte.
            let start = self
                .line
                .iter()
                .rposition(|&b| b & 0xc0 != 0x80)
                .unwrap_or(0);
            let lead = self.line[start];
            let width = match lead {
                0xc0..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf7 => 4,
                _ => 1,
            };
            if self.line.len() - start == width {
                len = width;
            }
        }
        self.line.truncate(self.line.len() - len);
        true
    }

    /// Binary protocol data (ZMODEM / XMODEM): only the escaping the
    /// protocol requires, IAC doubled and — when binary transmission was not
    /// agreed — a CR followed by NUL so the server does not swallow the byte
    /// after it.
    pub fn binary(&self, data: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(data.len() + data.len() / 64);
        let nvt = !self.local_binary();
        for &byte in data {
            out.push(byte);
            if byte == IAC {
                out.push(IAC);
            } else if byte == b'\r' && nvt {
                out.push(0);
            }
        }
        out
    }

    fn escape_into(&self, data: &[u8], out: &mut Vec<u8>) {
        for &byte in data {
            out.push(byte);
            if byte == IAC {
                out.push(IAC);
            }
        }
    }
}

impl Telnet {
    /// A line the session types for the user (`AutoLogin`): escaped like
    /// typed input and ended the way Enter is, straight to the socket — past
    /// the local line editor and its echo, so a password never reaches the
    /// screen.
    pub fn line(&self, text: &[u8]) -> Vec<u8> {
        let mut out = Vec::with_capacity(text.len() + 2);
        self.escape_into(text, &mut out);
        if self.local_binary() {
            out.push(b'\r');
        } else {
            out.extend_from_slice(b"\r\n");
        }
        out
    }
}

/// What a login prompt asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LoginPrompt {
    Username,
    Password,
}

/// What `AutoLogin` types in answer to a prompt, in the session's encoding.
#[derive(Debug, PartialEq, Eq)]
pub enum LoginAnswer {
    Username(Vec<u8>),
    Password(Vec<u8>),
}

/// Types a profile's username and password at the device's login prompts
/// (issue #89). A prompt is recognised only as the last, unfinished line of
/// the output — `Username:`, `login:`, `Password:` and the like — and each
/// answer goes out at most once: a prompt that comes back means the answer
/// was wrong, and a wrong password sent again only counts toward a lockout.
/// It stops for good once the password is sent (or the username, for a
/// profile without one), or `LOGIN_WINDOW` after connecting.
pub struct AutoLogin {
    username: Option<Vec<u8>>,
    password: Option<Vec<u8>>,
    username_sent: bool,
    done: bool,
    deadline: Instant,
    /// The output's unfinished last line, escape sequences included.
    tail: Vec<u8>,
}

impl AutoLogin {
    /// `None` when the profile has nothing to type.
    pub fn new(profile: &SessionProfile, now: Instant) -> Option<Self> {
        let encoding = super::encoding::terminal_encoding(profile);
        let encode = |text: &Option<String>| {
            text.as_deref()
                .filter(|text| !text.is_empty())
                .map(|text| super::encoding::encode_input(encoding, text))
        };
        let username = encode(&profile.username.as_ref().map(|u| u.trim().to_string()));
        let password = encode(&profile.password);
        if username.is_none() && password.is_none() {
            return None;
        }
        Some(Self {
            username,
            password,
            username_sent: false,
            done: false,
            deadline: now + LOGIN_WINDOW,
            tail: Vec::new(),
        })
    }

    /// Reads a chunk of terminal output; returns what to type when it ends
    /// on a login prompt this session has an answer for.
    pub fn output(&mut self, data: &[u8], now: Instant) -> Option<LoginAnswer> {
        if self.done {
            return None;
        }
        if now >= self.deadline {
            self.finish();
            return None;
        }
        match data.iter().rposition(|&b| b == b'\n' || b == b'\r') {
            Some(end) => self.tail = data[end + 1..].to_vec(),
            None => self.tail.extend_from_slice(data),
        }
        if self.tail.len() > LOGIN_TAIL {
            self.tail.drain(..self.tail.len() - LOGIN_TAIL);
        }
        let prompt = login_prompt(&self.tail)?;
        self.tail.clear();
        match prompt {
            LoginPrompt::Username => {
                let Some(username) = self.username.clone() else {
                    // The user types it; the password may still be ours.
                    return None;
                };
                if self.username_sent {
                    self.finish();
                    return None;
                }
                self.username_sent = true;
                if self.password.is_none() {
                    self.finish();
                }
                Some(LoginAnswer::Username(username))
            }
            LoginPrompt::Password => {
                let password = self.password.take();
                self.finish();
                password.map(LoginAnswer::Password)
            }
        }
    }

    fn finish(&mut self) {
        self.done = true;
        self.username = None;
        self.password = None;
        self.tail = Vec::new();
    }
}

/// The login prompt `line` ends on, if it is one: a label ending in a colon,
/// with nothing but spaces after it, whose last word names a user or a
/// password.
fn login_prompt(line: &[u8]) -> Option<LoginPrompt> {
    let text = String::from_utf8_lossy(&strip_escapes(line)).to_lowercase();
    let label = text.trim_end().strip_suffix(':')?.trim_end();
    let ends_with_word = |word: &str| {
        label.strip_suffix(word).is_some_and(|before| {
            !before
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric())
        })
    };
    if ends_with_word("password") {
        Some(LoginPrompt::Password)
    } else if ["login", "username", "user name", "user"]
        .iter()
        .any(|word| ends_with_word(word))
    {
        Some(LoginPrompt::Username)
    } else {
        None
    }
}

/// `line` without its escape sequences (colours, cursor moves), which some
/// devices wrap their prompts in.
fn strip_escapes(line: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(line.len());
    let mut bytes = line.iter().copied();
    while let Some(byte) = bytes.next() {
        if byte != 0x1b {
            if byte >= 0x20 || byte == b'\t' {
                out.push(byte);
            }
            continue;
        }
        match bytes.next() {
            // CSI: parameters and intermediates up to a final byte.
            Some(b'[') => {
                for byte in bytes.by_ref() {
                    if (0x40..=0x7e).contains(&byte) {
                        break;
                    }
                }
            }
            // OSC: up to BEL or ST.
            Some(b']') => {
                let mut escape = false;
                for byte in bytes.by_ref() {
                    if byte == 0x07 || (escape && byte == b'\\') {
                        break;
                    }
                    escape = byte == 0x1b;
                }
            }
            _ => {}
        }
    }
    out
}

/// The host as typed, with the brackets of an IPv6 literal removed.
fn bare_host(host: &str) -> &str {
    let host = host.trim();
    host.strip_prefix('[')
        .and_then(|h| h.strip_suffix(']'))
        .unwrap_or(host)
}

pub async fn connect(profile: &SessionProfile) -> Result<TcpStream> {
    let host = profile
        .host
        .as_deref()
        .map(bare_host)
        .filter(|h| !h.is_empty())
        .ok_or_else(|| AppError::new("telnet session is missing a host"))?;
    let port = profile.port.unwrap_or(DEFAULT_PORT);
    let stream = tokio::time::timeout(CONNECT_TIMEOUT, TcpStream::connect((host, port)))
        .await
        .map_err(|_| AppError::new(format!("connecting to {host}:{port} timed out")))?
        .map_err(|e| AppError::new(format!("cannot connect to {host}:{port}: {e}")))?;
    let _ = stream.set_nodelay(true);
    Ok(stream)
}

/// Runs the session on a connected socket. `recorder` is the session's
/// recording, when the profile asked for one.
pub fn spawn(
    app: AppHandle,
    id: String,
    stream: TcpStream,
    port: u16,
    mut rx: UnboundedReceiver<SessionCommand>,
    recorder: Option<Recorder>,
    mut login: Option<AutoLogin>,
) {
    tauri::async_runtime::spawn(async move {
        let (mut reader, mut writer) = stream.into_split();
        let mut pump = OutputPump::new(app.clone(), id.clone(), recorder);
        let mut telnet = Telnet::new(80, 24);
        let mut buf = vec![0u8; 16 * 1024];
        // Set when the frontend asked for the close; see `emit_state`.
        let mut close_requested = false;

        emit_state(&app, &id, "connected", None);

        if port == DEFAULT_PORT {
            let opening = telnet.opening();
            if writer.write_all(&opening).await.is_err() {
                emit_state(&app, &id, "closed", None);
                return;
            }
        }

        loop {
            tokio::select! {
                read = reader.read(&mut buf) => {
                    let n = match read {
                        Ok(0) | Err(_) => break,
                        Ok(n) => n,
                    };
                    let received = telnet.receive(&buf[..n]);
                    if !received.reply.is_empty()
                        && writer.write_all(&received.reply).await.is_err()
                    {
                        break;
                    }
                    pump.push(&received.data);
                    let answer = login
                        .as_mut()
                        .and_then(|login| login.output(&received.data, Instant::now()));
                    if let Some(answer) = answer {
                        let local_echo = !telnet.remote_echo();
                        let text = match answer {
                            LoginAnswer::Username(text) => {
                                // A server that echoes shows the name itself.
                                if local_echo {
                                    pump.push(&text);
                                }
                                text
                            }
                            LoginAnswer::Password(text) => text,
                        };
                        if local_echo {
                            pump.push(b"\r\n");
                        }
                        if writer.write_all(&telnet.line(&text)).await.is_err() {
                            break;
                        }
                    }
                    pump.flush();
                }
                cmd = rx.recv() => {
                    match cmd {
                        Some(SessionCommand::Write(data)) => {
                            let typed = telnet.typed(&data);
                            if !typed.echo.is_empty() {
                                pump.push(&typed.echo);
                                pump.flush();
                            }
                            if !typed.send.is_empty()
                                && writer.write_all(&typed.send).await.is_err()
                            {
                                break;
                            }
                        }
                        Some(SessionCommand::WriteConfirmed { data, reply }) => {
                            let result = writer
                                .write_all(&telnet.binary(&data))
                                .await
                                .map_err(AppError::from);
                            let failed = result.is_err();
                            let _ = reply.send(result);
                            if failed {
                                break;
                            }
                        }
                        Some(SessionCommand::Resize { cols, rows }) => {
                            let report = telnet.resize(cols, rows);
                            if !report.is_empty() && writer.write_all(&report).await.is_err() {
                                break;
                            }
                        }
                        Some(SessionCommand::Close) | None => {
                            close_requested = true;
                            break;
                        }
                        Some(other) => reject_unsupported(other, SessionKind::Telnet),
                    }
                }
            }
        }

        pump.flush();
        let _ = writer.shutdown().await;
        if !close_requested {
            emit_state(&app, &id, "closed", None);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login_profile(username: Option<&str>, password: Option<&str>) -> SessionProfile {
        let mut profile = crate::tests::profile(SessionKind::Telnet);
        profile.username = username.map(str::to_string);
        profile.password = password.map(str::to_string);
        profile
    }

    #[test]
    fn login_prompts_are_recognised_only_at_the_end_of_the_output() {
        for prompt in [
            "Username:",
            "\x1b[1mUsername: \x1b[0m",
            "login: ",
            "switch01 login:",
            "User Name:",
            "user:",
        ] {
            assert_eq!(
                login_prompt(prompt.as_bytes()),
                Some(LoginPrompt::Username),
                "{prompt:?}"
            );
        }
        for prompt in ["Password:", "Password: ", "Enter password:"] {
            assert_eq!(
                login_prompt(prompt.as_bytes()),
                Some(LoginPrompt::Password),
                "{prompt:?}"
            );
        }
        for line in [
            "Last login: Tue Oct  6",
            "Login incorrect",
            "superuser:",
            "Password changed",
            "router#",
            "",
        ] {
            assert_eq!(login_prompt(line.as_bytes()), None, "{line:?}");
        }
    }

    #[test]
    fn auto_login_types_each_answer_once_at_its_prompt() {
        let now = Instant::now();
        let mut login =
            AutoLogin::new(&login_profile(Some(" admin "), Some("s3cret")), now).expect("set up");

        assert_eq!(login.output(b"Welcome to the switch\r\n", now), None);
        // A prompt split over two reads is still a prompt.
        assert_eq!(login.output(b"\r\nUser", now), None);
        assert_eq!(
            login.output(b"name: ", now),
            Some(LoginAnswer::Username(b"admin".to_vec()))
        );
        assert_eq!(
            login.output(b"admin\r\nPassword: ", now),
            Some(LoginAnswer::Password(b"s3cret".to_vec()))
        );
        // Refused: the prompts come back and are the user's to answer.
        assert_eq!(
            login.output(b"\r\nLogin incorrect\r\nUsername: ", now),
            None
        );
        assert_eq!(login.output(b"\r\nPassword: ", now), None);
    }

    #[test]
    fn a_username_prompt_that_returns_before_the_password_stops_auto_login() {
        let now = Instant::now();
        let mut login =
            AutoLogin::new(&login_profile(Some("admin"), Some("s3cret")), now).expect("set up");
        assert!(login.output(b"login: ", now).is_some());
        assert_eq!(login.output(b"\r\nBad user\r\nlogin: ", now), None);
        assert_eq!(login.output(b"\r\nPassword: ", now), None);
    }

    #[test]
    fn auto_login_answers_what_the_profile_holds_and_nothing_late() {
        let now = Instant::now();
        assert!(AutoLogin::new(&login_profile(None, Some("")), now).is_none());

        // A line password only (Cisco `line vty` without a username): the
        // username prompt, if any, is left to the user.
        let mut login = AutoLogin::new(&login_profile(None, Some("s3cret")), now).expect("set up");
        assert_eq!(login.output(b"Username: ", now), None);
        assert_eq!(
            login.output(b"admin\r\nPassword: ", now),
            Some(LoginAnswer::Password(b"s3cret".to_vec()))
        );

        // A username only: done once it is typed.
        let mut login = AutoLogin::new(&login_profile(Some("admin"), None), now).expect("set up");
        assert!(login.output(b"login: ", now).is_some());
        assert_eq!(login.output(b"\r\nPassword: ", now), None);

        // Past the window, `enable`'s password prompt is not the login's.
        let mut login =
            AutoLogin::new(&login_profile(Some("admin"), Some("s3cret")), now).expect("set up");
        assert_eq!(login.output(b"Password: ", now + LOGIN_WINDOW), None);
    }

    #[test]
    fn auto_login_lines_are_escaped_and_end_like_enter() {
        let t = Telnet::new(80, 24);
        assert_eq!(t.line(b"a\xffb"), b"a\xff\xffb\r\n");

        let mut profile = login_profile(Some("管理员"), None);
        profile.encoding = Some("gbk".into());
        let mut login = AutoLogin::new(&profile, Instant::now()).expect("set up");
        assert_eq!(
            login.output(b"login: ", Instant::now()),
            Some(LoginAnswer::Username(vec![
                0xb9, 0xdc, 0xc0, 0xed, 0xd4, 0xb1
            ]))
        );
    }

    #[test]
    fn plain_data_passes_through_and_iac_iac_is_one_byte() {
        let mut t = Telnet::new(80, 24);
        let r = t.receive(b"hello\r\nworld\xff\xff!");
        assert_eq!(r.data, b"hello\r\nworld\xff!");
        assert!(r.reply.is_empty());
    }

    #[test]
    fn cr_nul_becomes_cr_even_across_chunks() {
        let mut t = Telnet::new(80, 24);
        let mut data = t.receive(b"a\r").data;
        data.extend(t.receive(b"\0b").data);
        assert_eq!(data, b"a\rb");
    }

    #[test]
    fn negotiation_split_across_reads_is_stripped_and_answered() {
        let mut t = Telnet::new(80, 24);
        let first = t.receive(&[b'x', IAC]);
        let second = t.receive(&[WILL]);
        let third = t.receive(&[OPT_ECHO, b'y']);
        assert_eq!(first.data, b"x");
        assert!(second.data.is_empty() && second.reply.is_empty());
        assert_eq!(third.data, b"y");
        assert_eq!(third.reply, vec![IAC, DO, OPT_ECHO]);
        assert!(t.remote_echo());
    }

    #[test]
    fn unsupported_options_are_refused_once() {
        let mut t = Telnet::new(80, 24);
        let r = t.receive(&[IAC, DO, 39, IAC, WILL, 36]);
        assert_eq!(r.reply, vec![IAC, WONT, 39, IAC, DONT, 36]);
    }

    #[test]
    fn agreement_to_our_own_request_is_not_answered_again() {
        let mut t = Telnet::new(100, 30);
        let opening = t.opening();
        assert!(opening.windows(3).any(|w| w == [IAC, WILL, OPT_NAWS]));
        assert!(opening.windows(3).any(|w| w == [IAC, DO, OPT_ECHO]));

        let r = t.receive(&[IAC, WILL, OPT_ECHO, IAC, DO, OPT_NAWS]);
        // No DO ECHO / WILL NAWS echoed back, only the window size.
        assert_eq!(r.reply, vec![IAC, SB, OPT_NAWS, 0, 100, 0, 30, IAC, SE]);
        assert!(t.remote_echo());
    }

    #[test]
    fn repeated_requests_do_not_loop() {
        let mut t = Telnet::new(80, 24);
        assert_eq!(
            t.receive(&[IAC, WILL, OPT_SGA]).reply,
            vec![IAC, DO, OPT_SGA]
        );
        assert!(t.receive(&[IAC, WILL, OPT_SGA]).reply.is_empty());
        assert_eq!(
            t.receive(&[IAC, WONT, OPT_SGA]).reply,
            vec![IAC, DONT, OPT_SGA]
        );
        assert!(t.receive(&[IAC, WONT, OPT_SGA]).reply.is_empty());
    }

    #[test]
    fn window_size_is_reported_with_255_doubled_and_on_resize() {
        let mut t = Telnet::new(80, 24);
        assert!(
            t.resize(120, 40).is_empty(),
            "nothing before the server asks"
        );
        let r = t.receive(&[IAC, DO, OPT_NAWS]);
        assert_eq!(
            r.reply,
            vec![IAC, WILL, OPT_NAWS, IAC, SB, OPT_NAWS, 0, 120, 0, 40, IAC, SE]
        );
        assert_eq!(
            t.resize(255, 50),
            vec![IAC, SB, OPT_NAWS, 0, 255, 255, 0, 50, IAC, SE]
        );
    }

    #[test]
    fn terminal_type_is_sent_when_asked() {
        let mut t = Telnet::new(80, 24);
        t.receive(&[IAC, DO, OPT_TTYPE]);
        let r = t.receive(&[IAC, SB, OPT_TTYPE, TTYPE_SEND, IAC, SE]);
        let mut expected = vec![IAC, SB, OPT_TTYPE, TTYPE_IS];
        expected.extend_from_slice(TERMINAL_TYPE);
        expected.extend_from_slice(&[IAC, SE]);
        assert_eq!(r.reply, expected);
    }

    #[test]
    fn subnegotiation_bytes_never_reach_the_screen() {
        let mut t = Telnet::new(80, 24);
        let r = t.receive(&[b'a', IAC, SB, 99, 1, 2, IAC, IAC, 3, IAC, SE, b'b']);
        assert_eq!(r.data, b"ab");
    }

    #[test]
    fn line_mode_echoes_locally_and_sends_on_enter() {
        let mut t = Telnet::new(80, 24);
        let typed = t.typed(b"GET /x");
        assert!(typed.send.is_empty());
        assert_eq!(typed.echo, b"GET /x");

        let typed = t.typed(b"\x7fy\r");
        assert_eq!(typed.echo, b"\x08 \x08y\r\n");
        assert_eq!(typed.send, b"GET /y\r\n");
    }

    #[test]
    fn line_mode_backspace_removes_a_whole_utf8_character() {
        let mut t = Telnet::new(80, 24);
        t.typed("ab你".as_bytes());
        let typed = t.typed(b"\x7f\r");
        assert_eq!(typed.send, b"ab\r\n");
    }

    #[test]
    fn line_mode_sends_escape_sequences_whole() {
        let mut t = Telnet::new(80, 24);
        t.typed(b"ab");
        let typed = t.typed(b"\x1b[A");
        assert_eq!(typed.send, b"ab\x1b[A");
        assert!(typed.echo.is_empty());
        assert!(t.typed(b"c").send.is_empty(), "editing resumes afterwards");
    }

    #[test]
    fn pasted_crlf_is_one_line_break() {
        let mut t = Telnet::new(80, 24);
        assert_eq!(t.typed(b"one\r").send, b"one\r\n");
        assert_eq!(t.typed(b"\ntwo\r\n").send, b"two\r\n");
    }

    #[test]
    fn character_mode_sends_each_key_with_enter_as_crlf() {
        let mut t = Telnet::new(80, 24);
        t.typed(b"us");
        t.receive(&[IAC, WILL, OPT_ECHO]);
        let typed = t.typed(b"er\r\x1b[A\xff");
        assert!(typed.echo.is_empty());
        assert_eq!(typed.send, b"user\r\n\x1b[A\xff\xff");
    }

    #[test]
    fn binary_writes_escape_iac_and_cr() {
        let mut t = Telnet::new(80, 24);
        assert_eq!(
            t.binary(&[1, IAC, b'\r', 2]),
            vec![1, IAC, IAC, b'\r', 0, 2]
        );
        t.receive(&[IAC, DO, OPT_BINARY]);
        assert_eq!(t.binary(&[IAC, b'\r']), vec![IAC, IAC, b'\r']);
    }

    #[test]
    fn ipv6_brackets_are_removed() {
        assert_eq!(bare_host(" [::1] "), "::1");
        assert_eq!(bare_host("router.lan"), "router.lan");
    }

    #[tokio::test]
    async fn connects_to_a_listening_port() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let mut profile = crate::tests::profile(SessionKind::Telnet);
        profile.host = Some("127.0.0.1".into());
        profile.port = Some(port);
        let accept = tokio::spawn(async move { listener.accept().await.map(|_| ()) });
        connect(&profile).await.expect("connect");
        accept.await.unwrap().expect("accepted");
    }
}
