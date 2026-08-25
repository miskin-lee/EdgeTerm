export type SessionKind = "local" | "ssh" | "ftp" | "serial";
export type AuthKind = "password" | "publicKey" | "agent";

export type ThemeMode = "dark" | "light";

export interface SessionProfile {
  id: string;
  name: string;
  kind: SessionKind;
  color?: string | null;

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
