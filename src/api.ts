import { Channel, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  AppData,
  DataSummary,
  DirListing,
  HostKeyChange,
  OpenSessionOutcome,
  SavedCommand,
  SerialPortDesc,
  SessionGroup,
  SessionInfo,
  SessionProfile,
} from "./types";

export interface OutputEvent {
  id: string;
  /** base64-encoded raw bytes */
  data: string;
}

export interface StateEvent {
  id: string;
  state: string;
  message: string | null;
}

export interface TransferProgress {
  transferred: number;
  total: number;
}

export interface ZmodemFileInfo {
  name: string;
  size: number;
  /** Unix seconds. */
  modified: number | null;
}

// --- profiles ---------------------------------------------------------------

export const listProfiles = () => invoke<SessionProfile[]>("list_profiles");

export const saveProfile = (profile: SessionProfile) =>
  invoke<SessionProfile>("save_profile", { profile });

/** Deletes a profile with its credentials and the Sender commands scoped to it. */
export const deleteProfile = (id: string) =>
  invoke<void>("delete_profile", { id });

// --- session groups ---------------------------------------------------------

export const listSessionGroups = () =>
  invoke<SessionGroup[]>("list_session_groups");

export const saveSessionGroup = (group: SessionGroup) =>
  invoke<SessionGroup>("save_session_group", { group });

/**
 * Deletes a group and its subgroups; profiles inside move to the deleted
 * group's parent, so callers must reload profiles afterwards.
 */
export const deleteSessionGroup = (id: string) =>
  invoke<void>("delete_session_group", { id });

// --- sender commands -------------------------------------------------------

export const listSenderCommands = () =>
  invoke<SavedCommand[]>("list_sender_commands");

export const saveSenderCommand = (command: SavedCommand) =>
  invoke<SavedCommand>("save_sender_command", { command });

export const deleteSenderCommand = (id: string) =>
  invoke<void>("delete_sender_command", { id });

// --- data export / import ---------------------------------------------------

/** Writes sessions, groups, Sender tags and `settings` to `path` (no secrets). */
export const exportAppData = (
  path: string,
  settings: unknown,
  exportedAt: string,
) => invoke<DataSummary>("export_app_data", { path, settings, exportedAt });

/** Parses a data file for preview; credentials in it are dropped by the backend. */
export const readAppData = (path: string) =>
  invoke<AppData>("read_app_data", { path });

/** Merges a file from `readAppData` into the saved data (same id replaces). */
export const importAppData = (data: AppData) =>
  invoke<DataSummary>("import_app_data", { data });

// --- command history ---------------------------------------------------------

export interface CommandHistoryEntry {
  command: string;
  /** `protocol:address` of the session the command ran in. */
  host: string;
  count: number;
  /** Unix milliseconds of the most recent use. */
  lastUsed: number;
}

export const listCommandHistory = () =>
  invoke<CommandHistoryEntry[]>("list_command_history");

export const recordCommand = (command: string, host: string) =>
  invoke<void>("record_command", { command, host });

export const clearCommandHistory = () =>
  invoke<void>("clear_command_history");

// --- sessions ---------------------------------------------------------------

export const openSession = (profile: SessionProfile, sessionId: string) =>
  invoke<OpenSessionOutcome>("open_session", { profile, sessionId });

/** Records the key from a reported change as the host's only known key. */
export const acceptHostKey = (change: HostKeyChange) =>
  invoke<void>("accept_host_key", {
    host: change.host,
    port: change.port,
    publicKey: change.publicKey,
  });

export const closeSession = (id: string) => invoke<void>("close_session", { id });

export const listSessions = () => invoke<SessionInfo[]>("list_sessions");

export const writeSession = (id: string, data: string) =>
  invoke<void>("write_session", { id, data });

export const writeSessionBinary = (id: string, base64: string) =>
  invoke<void>("write_session_binary", { id, data: base64 });

export const resizeSession = (id: string, cols: number, rows: number) =>
  invoke<void>("resize_session", { id, cols, rows });

// --- ZMODEM local file streaming -------------------------------------------

export const zmodemFileInfo = (path: string) =>
  invoke<ZmodemFileInfo>("zmodem_file_info", { path });

export const zmodemReadChunk = (
  path: string,
  offset: number,
  length: number,
) => invoke<string>("zmodem_read_chunk", { path, offset, length });

export const zmodemCreateFile = (path: string) =>
  invoke<void>("zmodem_create_file", { path });

export const zmodemWriteChunk = (
  path: string,
  offset: number,
  bytes: Uint8Array,
) =>
  invoke<void>("zmodem_write_chunk", {
    path,
    offset,
    data: bytesToBase64(bytes),
  });

export const zmodemFinishFile = (path: string, size: number) =>
  invoke<void>("zmodem_finish_file", { path, size });

// --- remote filesystem ------------------------------------------------------

export const sftpHome = (id: string) => invoke<string>("sftp_home", { id });

export const sftpList = (id: string, path: string) =>
  invoke<DirListing>("sftp_list", { id, path });

export const sftpCanonicalize = (id: string, path: string) =>
  invoke<string>("sftp_canonicalize", { id, path });

export const sftpMkdir = (id: string, path: string) =>
  invoke<void>("sftp_mkdir", { id, path });

export const sftpCreateFile = (id: string, path: string) =>
  invoke<void>("sftp_create_file", { id, path });

export const sftpRemove = (id: string, path: string, isDir: boolean) =>
  invoke<void>("sftp_remove", { id, path, isDir });

export const sftpRename = (id: string, from: string, to: string) =>
  invoke<void>("sftp_rename", { id, from, to });

export const sftpDownload = (
  id: string,
  remote: string,
  local: string,
  onProgress: (progress: TransferProgress) => void,
) => {
  const progress = new Channel<TransferProgress>();
  progress.onmessage = onProgress;
  return invoke<void>("sftp_download", {
    id,
    remote,
    local,
    onProgress: progress,
  });
};

export const sftpDownloadDirectory = (
  id: string,
  remote: string,
  local: string,
  onProgress: (progress: TransferProgress) => void,
) => {
  const progress = new Channel<TransferProgress>();
  progress.onmessage = onProgress;
  return invoke<void>("sftp_download_directory", {
    id,
    remote,
    local,
    onProgress: progress,
  });
};

export const sftpUpload = (
  id: string,
  local: string,
  remote: string,
  onProgress: (progress: TransferProgress) => void,
) => {
  const progress = new Channel<TransferProgress>();
  progress.onmessage = onProgress;
  return invoke<void>("sftp_upload", {
    id,
    local,
    remote,
    onProgress: progress,
  });
};

export const sftpUploadDirectory = (
  id: string,
  local: string,
  remote: string,
  onProgress: (progress: TransferProgress) => void,
) => {
  const progress = new Channel<TransferProgress>();
  progress.onmessage = onProgress;
  return invoke<void>("sftp_upload_directory", {
    id,
    local,
    remote,
    onProgress: progress,
  });
};

// --- local filesystem -------------------------------------------------------

export const localHome = () => invoke<string>("local_home");

/**
 * Path of the Windows drive list the local browser reaches by going up from a
 * drive root. Mirrors `fs_local::THIS_PC`; nothing can be created or deleted
 * there.
 */
export const LOCAL_DRIVES_ROOT = "This PC";

export const localList = (path: string) =>
  invoke<DirListing>("local_list", { path });

export const localParent = (path: string) =>
  invoke<string>("local_parent", { path });

export const localIsDirectory = (path: string) =>
  invoke<boolean>("local_is_directory", { path });

export const localMkdir = (path: string) =>
  invoke<void>("local_mkdir", { path });

export const localCreateFile = (path: string) =>
  invoke<void>("local_create_file", { path });

export const localRename = (from: string, to: string) =>
  invoke<void>("local_rename", { from, to });

export const localRemove = (path: string, isDir: boolean) =>
  invoke<void>("local_remove", { path, isDir });

/** Opens a local file with the default application, or with `app` if given. */
export const openLocalPath = (path: string, app?: string) =>
  invoke<void>("open_local_path", { path, with: app ?? null });

/** Windows only: the system "Open with" chooser for a local file. */
export const openWithDialog = (path: string) =>
  invoke<void>("open_with_dialog", { path });

// --- remote files edited locally -------------------------------------------

/**
 * Where a remote file opened in a local application is downloaded to. While
 * the file is being watched this is the same path again, so reopening it
 * refreshes the copy the editor already has.
 */
export const remoteEditPath = (id: string, remote: string, name: string) =>
  invoke<string>("remote_edit_path", { id, remote, name });

/**
 * From now on, every change to `local` is uploaded back to `remote`. Call it
 * right after the download so the fresh copy is the baseline.
 */
export const watchRemoteEdit = (id: string, local: string, remote: string) =>
  invoke<void>("watch_remote_edit", { id, local, remote });

/** Stops watching every file opened from a session; for a tab closed for good. */
export const stopRemoteEdits = (id: string) =>
  invoke<void>("stop_remote_edits", { id });

export interface RemoteEditEvent {
  sessionId: string;
  remotePath: string;
  name: string;
  /** `kept`: the watch ended with unsent changes; the copy stays on disk. */
  status: "uploading" | "synced" | "error" | "kept";
  message: string | null;
}

export const onRemoteEditState = (
  handler: (event: RemoteEditEvent) => void,
): Promise<UnlistenFn> =>
  listen<RemoteEditEvent>("remote-edit:state", (e) => handler(e.payload));

// --- serial -----------------------------------------------------------------

export const listSerialPorts = () =>
  invoke<SerialPortDesc[]>("list_serial_ports");

// --- events -----------------------------------------------------------------

export const onSessionOutput = (
  handler: (event: OutputEvent) => void,
): Promise<UnlistenFn> =>
  listen<OutputEvent>("session:output", (e) => handler(e.payload));

export const onSessionState = (
  handler: (event: StateEvent) => void,
): Promise<UnlistenFn> =>
  listen<StateEvent>("session:state", (e) => handler(e.payload));

/**
 * Fired by the Rust menu handler when the user hits ⌘Q / Quit on macOS;
 * the frontend owns the confirm-and-exit flow (see App.tsx).
 */
export const onQuitRequested = (handler: () => void): Promise<UnlistenFn> =>
  listen("app:quit-requested", () => handler());

// --- window chrome (Windows) ------------------------------------------------

export type WindowControlAction = "minimize" | "toggle-maximize";

/**
 * Minimize / maximize / restore the main window. On Windows this takes the
 * same `WM_SYSCOMMAND` route as native caption buttons, which keeps the DWM
 * grow / shrink animation (`window.toggleMaximize()` does not); elsewhere it
 * forwards to the window (see `window_control` in lib.rs).
 */
export const windowControl = (action: WindowControlAction): Promise<void> =>
  invoke("window_control", { action });

// --- encoding helpers -------------------------------------------------------

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
