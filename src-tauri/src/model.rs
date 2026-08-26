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
