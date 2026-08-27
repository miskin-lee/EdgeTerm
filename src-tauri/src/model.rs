use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Local,
    Ssh,
    Ftp,
    Serial,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AuthKind {
    Password,
    PublicKey,
    Agent,
}

impl Default for AuthKind {
    fn default() -> Self {
        AuthKind::Password
    }
}

/// A saved connection. One profile can be opened many times; each open produces
/// a separate live session with its own id.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionProfile {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub kind: SessionKind,
    /// Tab / tree dot colour, as a CSS colour string.
    #[serde(default)]
    pub color: Option<String>,
    /// Session panel group holding this profile; `None` lists it directly
    /// under its kind's top-level heading.
    #[serde(default)]
    pub group_id: Option<String>,

    // --- local ---
    #[serde(default)]
    pub shell: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,

    // --- ssh / ftp ---
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub auth: Option<AuthKind>,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,

    // --- serial ---
    #[serde(default)]
    pub port_name: Option<String>,
    #[serde(default)]
    pub baud_rate: Option<u32>,
    #[serde(default)]
    pub data_bits: Option<u8>,
    #[serde(default)]
    pub stop_bits: Option<u8>,
    /// `none` | `odd` | `even`
    #[serde(default)]
    pub parity: Option<String>,
    /// `none` | `software` | `hardware`
    #[serde(default)]
    pub flow_control: Option<String>,
}

impl SessionProfile {
    /// The `ssh > host:port` style descriptor shown in the address bar.
    pub fn address(&self) -> String {
        match self.kind {
            SessionKind::Local => self
                .shell
                .clone()
                .unwrap_or_else(|| default_shell().to_string()),
            SessionKind::Ssh => format!(
                "{}:{}",
                self.host.as_deref().unwrap_or("localhost"),
                self.port.unwrap_or(22)
            ),
            SessionKind::Ftp => format!(
                "{}:{}",
                self.host.as_deref().unwrap_or("localhost"),
                self.port.unwrap_or(21)
            ),
            SessionKind::Serial => format!(
                "{}@{}",
                self.port_name.as_deref().unwrap_or("-"),
                self.baud_rate.unwrap_or(115_200)
            ),
        }
    }

    pub fn protocol(&self) -> &'static str {
        match self.kind {
            SessionKind::Local => "shell",
            SessionKind::Ssh => "ssh",
            SessionKind::Ftp => "ftp",
            SessionKind::Serial => "serial",
        }
    }
}

/// A user-defined folder in the Session panel. Groups belong to one session
/// kind and may nest under another group of the same kind.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub kind: SessionKind,
    /// Enclosing group, or `None` for a group directly under the kind heading.
    #[serde(default)]
    pub parent_id: Option<String>,
}

/// A live session, as the frontend sees it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub profile_id: Option<String>,
    pub name: String,
    pub kind: SessionKind,
    pub protocol: String,
    pub address: String,
    pub color: Option<String>,
    /// Whether the Filer pane can browse this session's remote filesystem.
    pub supports_remote_files: bool,
}

/// An SSH host whose key no longer matches the one recorded for it in
/// `known_hosts`. The frontend shows this to the user, who may accept the new
/// key (see `accept_host_key`) and reconnect.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyChange {
    pub host: String,
    pub port: u16,
    /// Algorithm name of the key the server presented, e.g. `ssh-ed25519`.
    pub key_type: String,
    /// `SHA256:…` fingerprint of that key, for the user to verify.
    pub fingerprint: String,
    /// The presented key as an OpenSSH public key line; accepting records
    /// exactly this key, not whatever the server sends next time.
    pub public_key: String,
    /// Path of the `known_hosts` file holding the conflicting entry.
    pub known_hosts: String,
    /// Line of the conflicting entry in that file.
    pub line: usize,
    /// One-line explanation for the terminal and status bar.
    pub message: String,
}

/// What `open_session` produced: a live session, or a decision the user has
/// to make before one can be opened.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum OpenSessionOutcome {
    Connected { info: SessionInfo },
    HostKeyChanged { change: HostKeyChange },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SenderFormat {
    Text,
    Hex,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LineEnding {
    None,
    Lf,
    Crlf,
}

/// One remembered shell command, used for inline suggestions while typing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandHistoryEntry {
    pub command: String,
    /// `protocol:address` of the session the command ran in, so suggestions
    /// can prefer commands seen on the same host.
    pub host: String,
    pub count: u32,
    /// Unix milliseconds of the most recent use.
    pub last_used: i64,
}

/// Where a saved Sender command is listed. The Sender shows the union of
/// `Global`, the active tab's session kind, its group chain and its profile;
/// a scope only decides what is listed, never where a command may be sent.
/// A command scoped to a profile or group belongs to it and is deleted with
/// it (`Store::delete` / `Store::delete_group`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum CommandScope {
    Global,
    Kind { kind: SessionKind },
    Group { id: String },
    Profile { id: String },
}

impl Default for CommandScope {
    fn default() -> Self {
        CommandScope::Global
    }
}

/// A reusable command shown as a tag in the Sender pane.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCommand {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub text: String,
    pub format: SenderFormat,
    pub ending: LineEnding,
    /// Missing in files written before scopes existed: those tags are global.
    #[serde(default)]
    pub scope: CommandScope,
}

/// Marker every exported data file carries, so a stray JSON file is refused
/// before anything is merged.
pub const APP_DATA_APP: &str = "EdgeTerm";
/// Layout version of the export file. Bump it when a change would make an
/// older build misread a newer file; builds refuse files newer than they know.
/// 1: initial layout. 2: Sender commands carry a `scope`.
pub const APP_DATA_FORMAT: u32 = 2;
/// File extension (without the dot) every data file carries. Export appends
/// it and import refuses anything else, so a data file is recognisable before
/// it is opened; the contents are still plain JSON.
pub const APP_DATA_EXTENSION: &str = "edgeterm";

/// One export / import file: the frontend's settings, saved sessions with
/// their groups, and Sender tags. Session passwords and key passphrases are
/// never part of it — see `Store::snapshot` and `Store::import_data`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppData {
    pub app: String,
    pub format: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exported_at: Option<String>,
    /// Frontend preferences (theme, fonts, panels…); opaque to the backend.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings: Option<serde_json::Value>,
    #[serde(default)]
    pub profiles: Vec<SessionProfile>,
    #[serde(default)]
    pub groups: Vec<SessionGroup>,
    #[serde(default)]
    pub sender_commands: Vec<SavedCommand>,
}

/// How many entries an export wrote or an import merged.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSummary {
    pub profiles: usize,
    pub groups: usize,
    pub sender_commands: usize,
    /// Sender tags an import left out because the library was already full.
    pub skipped_sender_commands: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_symlink: bool,
    pub size: u64,
    /// Unix seconds.
    pub modified: Option<i64>,
    pub permissions: Option<u32>,
    pub owner: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

/// Metadata needed to offer a local file through ZMODEM. The file contents
/// travel through separate bounded chunk commands so large files are never
/// materialized in one IPC message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZmodemFileInfo {
    pub name: String,
    pub size: u64,
    /// Unix seconds.
    pub modified: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortDesc {
    pub port_name: String,
    pub port_type: String,
    pub description: Option<String>,
}

pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "powershell.exe".to_string())
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string())
    }
}
