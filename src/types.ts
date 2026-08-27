export type SessionKind = "local" | "ssh" | "ftp" | "serial";
export type AuthKind = "password" | "publicKey" | "agent";

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

export interface SavedCommand {
  id: string;
  name: string;
  text: string;
  format: SenderFormat;
  ending: LineEnding;
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
