export type SessionKind = "local" | "ssh" | "ftp" | "sftp" | "serial";
export type AuthKind = "password" | "publicKey" | "agent";

/**
 * File-transfer sessions with no interactive terminal: they open the dual-pane
 * file manager instead of an xterm, and are skipped by the Sender, search, and
 * terminal-only wiring. FTP speaks its own protocol; SFTP rides an SSH
 * transport but is likewise browse-and-transfer only.
 */
export function isFileSession(kind: SessionKind): boolean {
  return kind === "ftp" || kind === "sftp";
}

/** Sessions that ride an SSH transport, and so can be or use a jump host. */
export function isSshTransport(kind: SessionKind): boolean {
  return kind === "ssh" || kind === "sftp";
}

export type ThemeMode = "dark" | "light";

export interface SessionProfile {
  id: string;
  name: string;
  kind: SessionKind;
  color?: string | null;
  /**
   * Session panel group holding this profile; null / undefined lists it
   * directly under its kind's top-level heading.
   */
  groupId?: string | null;

  // terminal text (local / ssh / serial)
  /**
   * Character encoding of the terminal byte stream, a WHATWG label such as
   * "gbk"; null / unknown means UTF-8. See encodings.ts.
   */
  encoding?: string | null;
  /**
   * Locale handed to the shell as LANG — set on a local shell, requested
   * from an SSH server. Null means automatic (see session/locale.rs).
   */
  locale?: string | null;

  // local
  shell?: string | null;
  cwd?: string | null;

  // ssh / ftp
  host?: string | null;
  port?: number | null;
  username?: string | null;
  auth?: AuthKind | null;
  password?: string | null;
  privateKeyPath?: string | null;
  passphrase?: string | null;
  /**
   * Saved SSH / SFTP profile to tunnel through (ProxyJump), for a host that
   * is only reachable from that session's network. The jump profile may
   * itself name a jump host, giving a chain.
   */
  jumpProfileId?: string | null;

  // serial
  portName?: string | null;
  baudRate?: number | null;
  dataBits?: number | null;
  stopBits?: number | null;
  parity?: string | null;
  flowControl?: string | null;
}

/**
 * A user-defined folder in the Session panel. Groups belong to one session
 * kind and may nest under another group of the same kind.
 */
export interface SessionGroup {
  id: string;
  name: string;
  kind: SessionKind;
  /** Enclosing group, or null for a group directly under the kind heading. */
  parentId: string | null;
}

export interface SessionInfo {
  id: string;
  profileId: string | null;
  name: string;
  kind: SessionKind;
  protocol: string;
  address: string;
  color: string | null;
  supportsRemoteFiles: boolean;
}

/** An SSH host whose key no longer matches the one recorded in known_hosts. */
export interface HostKeyChange {
  host: string;
  port: number;
  /** Algorithm of the presented key, e.g. "ssh-ed25519". */
  keyType: string;
  /** SHA256 fingerprint of the presented key, for the user to verify. */
  fingerprint: string;
  /** The presented key as an OpenSSH public key line; this exact key is recorded on accept. */
  publicKey: string;
  /** known_hosts file and line holding the conflicting entry. */
  knownHosts: string;
  line: number;
  /** One-line explanation for the terminal and status bar. */
  message: string;
}

/** One question in a server's keyboard-interactive challenge. */
export interface AuthPromptField {
  /** The server's wording, e.g. "Verification code:". */
  prompt: string;
  /** Whether what the user types may be shown; false for secrets. */
  echo: boolean;
}

/**
 * A round of questions an SSH server asked while authenticating (RFC 4256's
 * keyboard-interactive, the usual carrier for MFA). The answers go back to
 * `answerAuthPrompt` under the same id and are never saved.
 */
export interface AuthPrompt {
  id: string;
  /** The session being opened, so the dialog can name its tab. */
  sessionId: string;
  /** host:port of the hop asking; a jump host has challenges of its own. */
  address: string;
  username: string;
  /** Server-supplied title for the round; usually empty. */
  name: string;
  /** Server-supplied text shown above the questions; usually empty. */
  instructions: string;
  prompts: AuthPromptField[];
}

/** What open_session produced: a live session, or a decision for the user. */
export type OpenSessionOutcome =
  | { status: "connected"; info: SessionInfo }
  | { status: "hostKeyChanged"; change: HostKeyChange };

export interface FileEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
  size: number;
  modified: number | null;
  permissions: number | null;
  owner: string | null;
  group: string | null;
}

export interface DirListing {
  path: string;
  entries: FileEntry[];
}

export interface SerialPortDesc {
  portName: string;
  portType: string;
  description: string | null;
}

export type SessionState = "connecting" | "connected" | "closed" | "error";

export type SenderFormat = "text" | "hex";
export type LineEnding = "none" | "lf" | "crlf";

/**
 * Where a saved Sender command is listed: everywhere, for one session kind,
 * for a Session panel group (and everything nested in it), or for one saved
 * session. See `senderScope.ts` for how a tab's chain of scopes is resolved.
 */
export type CommandScope =
  | { type: "global" }
  | { type: "kind"; kind: SessionKind }
  | { type: "group"; id: string }
  | { type: "profile"; id: string };

export interface SavedCommand {
  id: string;
  name: string;
  text: string;
  format: SenderFormat;
  ending: LineEnding;
  scope: CommandScope;
}

/**
 * One export / import file (Session → Export / Import Data…). `settings` is
 * the frontend's own `AppSettings`, carried through the backend untouched;
 * passwords and passphrases are never part of a data file.
 */
export interface AppData {
  app: string;
  format: number;
  exportedAt?: string | null;
  settings?: unknown;
  profiles: SessionProfile[];
  groups: SessionGroup[];
  senderCommands: SavedCommand[];
}

/** How many entries an export wrote or an import merged. */
export interface DataSummary {
  profiles: number;
  groups: number;
  senderCommands: number;
  /** Sender tags an import left out because the library was already full. */
  skippedSenderCommands: number;
}

/** Colours used for session dots, mirroring WindTerm's per-session markers. */
export const SESSION_COLORS = [
  "#4ea1f3",
  "#3fb950",
  "#e3b341",
  "#f85149",
  "#bc8cff",
  "#39c5cf",
  "#ff7b72",
  "#a5d6ff",
  "#f0883e",
  "#db61a2",
  "#7ee787",
  "#6e8cff",
  "#2db89a",
  "#f0c36e",
  "#e56bce",
  "#d2a8ff",
];

export function randomSessionColor(): string {
  return SESSION_COLORS[Math.floor(Math.random() * SESSION_COLORS.length)];
}

export function colorForSession(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return SESSION_COLORS[hash % SESSION_COLORS.length];
}
