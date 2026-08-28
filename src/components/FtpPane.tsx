import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import * as api from "../api";
import { FileIcon } from "./FileIcon";
import { useStore, type Tab } from "../store";
import type { FileEntry } from "../types";

interface Props {
  tab: Tab;
  active: boolean;
}

interface TransferState {
  direction: "upload" | "download";
  name: string;
  transferred: number;
  total: number;
  status: "running" | "complete" | "error";
  message?: string;
}

interface FileBrowserProps {
  title: string;
  subtitle: string;
  path: string;
  draft: string;
  entries: FileEntry[];
  selected: string | null;
  loading: boolean;
  error: string | null;
  actions?: ReactNode;
  onDraftChange: (value: string) => void;
  onOpenPath: (path: string) => void;
  onHome: () => void;
  onParent: () => void;
  onRefresh: () => void;
  onSelect: (path: string) => void;
  onActivate: (entry: FileEntry) => void;
}

export function FtpPane({ tab, active }: Props) {
  const sessionId = tab.info.id;
  // The pane serves both FTP and SFTP file sessions; only the labels differ.
  const protocolLabel = tab.info.kind === "sftp" ? "SFTP" : "FTP";

  const [remoteHome, setRemoteHome] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [remoteDraft, setRemoteDraft] = useState("");
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([]);
  const [remoteSelected, setRemoteSelected] = useState<string | null>(null);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);

  const [localHome, setLocalHome] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [localDraft, setLocalDraft] = useState("");
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [localSelected, setLocalSelected] = useState<string | null>(null);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const localRequest = useRef(0);

  const [transferring, setTransferring] = useState(false);
  const [transfer, setTransfer] = useState<TransferState | null>(null);

  const loadRemote = useCallback(
    async (target: string) => {
      setRemoteLoading(true);
      setRemoteError(null);
      try {
        const listing = await api.sftpList(sessionId, target);
        setRemotePath(listing.path);
        setRemoteDraft(listing.path);
        setRemoteEntries(listing.entries);
        setRemoteSelected(null);
      } catch (error) {
        setRemoteError(friendlyFtpError(error));
      } finally {
        setRemoteLoading(false);
      }
    },
    [sessionId],
  );

  const loadLocal = useCallback(async (target: string) => {
    const request = ++localRequest.current;
    setLocalLoading(true);
    setLocalError(null);
    try {
      const listing = await api.localList(target);
      if (request !== localRequest.current) return;
      setLocalPath(listing.path);
      setLocalDraft(listing.path);
      setLocalEntries(listing.entries);
      setLocalSelected(null);
    } catch (error) {
      if (request !== localRequest.current) return;
      setLocalError(String(error));
    } finally {
      if (request === localRequest.current) setLocalLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab.state !== "connected") return;
    let cancelled = false;

    void (async () => {
      try {
        const [ftpHome, machineHome] = await Promise.all([
          api.sftpHome(sessionId),
          api.localHome(),
        ]);
        if (cancelled) return;
        setRemoteHome(ftpHome);
        setLocalHome(machineHome);
        await Promise.all([loadRemote(ftpHome), loadLocal(machineHome)]);
      } catch (error) {
        if (!cancelled) setRemoteError(friendlyFtpError(error));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadLocal, loadRemote, sessionId, tab.state]);

  const selectedRemote = remoteEntries.find(
    (entry) => entry.path === remoteSelected,
  );
  const selectedLocal = localEntries.find(
    (entry) => entry.path === localSelected,
  );

  const updateProgress = (progress: api.TransferProgress) => {
    setTransfer((current) =>
      current
        ? {
            ...current,
            transferred: progress.transferred,
            total: progress.total,
          }
        : current,
    );
  };

  const upload = async () => {
    if (!selectedLocal || !remotePath || transferring) {
      return;
    }

    const existingRemote = remoteEntries.find(
      (entry) => entry.name === selectedLocal.name,
    );
    if (existingRemote && existingRemote.isDir !== selectedLocal.isDir) {
      setRemoteError(
        selectedLocal.isDir
          ? `A remote file named “${selectedLocal.name}” already exists.`
          : `A remote folder named “${selectedLocal.name}” already exists.`,
      );
      return;
    }
    if (existingRemote) {
      const prompt = selectedLocal.isDir
        ? `Merge into remote folder “${selectedLocal.name}”? Existing files with the same names will be replaced.`
        : `Replace remote file “${selectedLocal.name}”?`;
      if (!window.confirm(prompt)) return;
    }

    setRemoteError(null);
    setTransferring(true);
    setTransfer({
      direction: "upload",
      name: selectedLocal.name,
      transferred: 0,
      total: selectedLocal.isDir ? 0 : selectedLocal.size,
      status: "running",
    });
    try {
      const destination = joinRemote(remotePath, selectedLocal.name);
      if (selectedLocal.isDir) {
        await api.sftpUploadDirectory(
          sessionId,
          selectedLocal.path,
          destination,
          updateProgress,
        );
      } else {
        await api.sftpUpload(
          sessionId,
          selectedLocal.path,
          destination,
          updateProgress,
        );
      }
      setTransfer((current) =>
        current ? { ...current, status: "complete" } : current,
      );
      await loadRemote(remotePath);
    } catch (error) {
      setTransfer((current) =>
        current
          ? { ...current, status: "error", message: String(error) }
          : current,
      );
    } finally {
      setTransferring(false);
    }
  };

  const download = async () => {
    if (!selectedRemote || !localPath || transferring) {
      return;
    }

    const existingLocal = localEntries.find(
      (entry) => entry.name === selectedRemote.name,
    );
    if (existingLocal?.isSymlink) {
      setLocalError(`Refusing to replace local symlink “${selectedRemote.name}”.`);
      return;
    }
    if (existingLocal && existingLocal.isDir !== selectedRemote.isDir) {
      setLocalError(
        selectedRemote.isDir
          ? `A local file named “${selectedRemote.name}” already exists.`
          : `A local folder named “${selectedRemote.name}” already exists.`,
      );
      return;
    }
    if (existingLocal) {
      const prompt = selectedRemote.isDir
        ? `Merge into local folder “${selectedRemote.name}”? Existing files with the same names will be replaced.`
        : `Replace local file “${selectedRemote.name}”?`;
      if (!window.confirm(prompt)) return;
    }

    setLocalError(null);
    setTransferring(true);
    setTransfer({
      direction: "download",
      name: selectedRemote.name,
      transferred: 0,
      total: selectedRemote.isDir ? 0 : selectedRemote.size,
      status: "running",
    });
    try {
      const destination = joinLocal(localPath, selectedRemote.name);
      if (selectedRemote.isDir) {
        await api.sftpDownloadDirectory(
          sessionId,
          selectedRemote.path,
          destination,
          updateProgress,
        );
      } else {
        await api.sftpDownload(
          sessionId,
          selectedRemote.path,
          destination,
          updateProgress,
        );
      }
      setTransfer((current) =>
        current ? { ...current, status: "complete" } : current,
      );
      await loadLocal(localPath);
    } catch (error) {
      setTransfer((current) =>
        current
          ? { ...current, status: "error", message: String(error) }
          : current,
      );
    } finally {
      setTransferring(false);
    }
  };

  const createRemoteFolder = async () => {
    if (!remotePath || transferring) return;
    const name = window.prompt("New remote folder name")?.trim();
    if (!name) return;
    setRemoteError(null);
    try {
      await api.sftpMkdir(sessionId, joinRemote(remotePath, name));
      await loadRemote(remotePath);
    } catch (error) {
      setRemoteError(friendlyFtpError(error));
    }
  };

  const renameRemote = async () => {
    if (!selectedRemote || transferring) return;
    const name = window.prompt("Rename remote item", selectedRemote.name)?.trim();
    if (!name || name === selectedRemote.name) return;
    setRemoteError(null);
    try {
      await api.sftpRename(
        sessionId,
        selectedRemote.path,
        joinRemote(remotePath, name),
      );
      await loadRemote(remotePath);
    } catch (error) {
      setRemoteError(friendlyFtpError(error));
    }
  };

  const removeRemote = async () => {
    if (!selectedRemote || transferring) return;
    if (!window.confirm(`Delete remote ${selectedRemote.name}?`)) return;
    setRemoteError(null);
    try {
      await api.sftpRemove(
        sessionId,
        selectedRemote.path,
        selectedRemote.isDir,
      );
      await loadRemote(remotePath);
    } catch (error) {
      setRemoteError(friendlyFtpError(error));
    }
  };

  const createLocalFolder = async () => {
    if (!localPath || transferring) return;
    const name = window.prompt("New local folder name")?.trim();
    if (!name) return;
    setLocalError(null);
    try {
      await api.localMkdir(joinLocal(localPath, name));
      await loadLocal(localPath);
    } catch (error) {
      setLocalError(String(error));
    }
  };

  const renameLocal = async () => {
    if (!selectedLocal || transferring) return;
    const name = window.prompt("Rename local item", selectedLocal.name)?.trim();
    if (!name || name === selectedLocal.name) return;
    setLocalError(null);
    try {
      await api.localRename(
        selectedLocal.path,
        joinLocal(localPath, name),
      );
      await loadLocal(localPath);
    } catch (error) {
      setLocalError(String(error));
    }
  };

  const removeLocal = async () => {
    if (!selectedLocal || transferring) return;
    const type = selectedLocal.isDir ? "empty local folder" : "local file";
    if (!window.confirm(`Delete ${type} “${selectedLocal.name}”?`)) return;
    setLocalError(null);
    try {
      await api.localRemove(
        selectedLocal.path,
        selectedLocal.isDir,
      );
      await loadLocal(localPath);
    } catch (error) {
      setLocalError(String(error));
    }
  };

  const transferPercent = transfer
    ? transfer.status === "complete"
      ? 100
      : transfer.total > 0
        ? Math.min(100, (transfer.transferred / transfer.total) * 100)
        : null
    : null;

  return (
    <div className={`ftp-workspace${active ? "" : " is-hidden"}`}>
      {tab.state !== "connected" ? (
        <div className={`ftp-session-state is-${tab.state}`}>
          <strong>
            {tab.state === "connecting"
              ? `Connecting to ${protocolLabel}…`
              : `${protocolLabel} unavailable`}
          </strong>
          <span>{tab.message ?? tab.info.address}</span>
        </div>
      ) : (
        <>
          <div className="ftp-dual-pane">
            <FileBrowser
              title={`${protocolLabel} Server`}
              subtitle={tab.info.address}
              path={remotePath}
              draft={remoteDraft}
              entries={remoteEntries}
              selected={remoteSelected}
              loading={remoteLoading}
              error={remoteError}
              onDraftChange={setRemoteDraft}
              onOpenPath={(path) => void loadRemote(path)}
              onHome={() => void loadRemote(remoteHome)}
              onParent={() => void loadRemote(remoteParent(remotePath))}
              onRefresh={() => void loadRemote(remotePath || remoteHome)}
              onSelect={setRemoteSelected}
              onActivate={(entry) => {
                if (entry.isDir) void loadRemote(entry.path);
              }}
              actions={
                <>
                  <ToolButton
                    label="New remote folder"
                    onClick={() => void createRemoteFolder()}
                    disabled={remoteLoading || transferring}
                  >
                    ＋
                  </ToolButton>
                  <ToolButton
                    label="Rename remote item"
                    onClick={() => void renameRemote()}
                    disabled={!selectedRemote || remoteLoading || transferring}
                  >
                    ✎
                  </ToolButton>
                  <ToolButton
                    label="Delete remote item"
                    onClick={() => void removeRemote()}
                    disabled={!selectedRemote || remoteLoading || transferring}
                    danger
                  >
                    ✕
                  </ToolButton>
                </>
              }
            />

            <div className="ftp-transfer-rail" aria-label="File transfer actions">
              <button
                className="ftp-transfer-button"
                onClick={() => void upload()}
                disabled={!selectedLocal || transferring}
                title="Upload selected local file or folder"
              >
                <span>←</span>
                Upload
              </button>
              <button
                className="ftp-transfer-button"
                onClick={() => void download()}
                disabled={!selectedRemote || transferring}
                title={`Download selected ${protocolLabel} file or folder`}
              >
                Download
                <span>→</span>
              </button>
            </div>

            <FileBrowser
              title="Local Computer"
              subtitle="This device"
              path={localPath}
              draft={localDraft}
              entries={localEntries}
              selected={localSelected}
              loading={localLoading}
              error={localError}
              onDraftChange={setLocalDraft}
              onOpenPath={(path) => void loadLocal(path)}
              onHome={() => void loadLocal(localHome)}
              onParent={() => {
                void api.localParent(localPath).then(loadLocal);
              }}
              onRefresh={() => void loadLocal(localPath || localHome)}
              onSelect={setLocalSelected}
              onActivate={(entry) => {
                if (entry.isDir) void loadLocal(entry.path);
              }}
              actions={
                <>
                  <ToolButton
                    label="New local folder"
                    onClick={() => void createLocalFolder()}
                    disabled={localLoading || transferring}
                  >
                    ＋
                  </ToolButton>
                  <ToolButton
                    label="Rename local item"
                    onClick={() => void renameLocal()}
                    disabled={!selectedLocal || localLoading || transferring}
                  >
                    ✎
                  </ToolButton>
                  <ToolButton
                    label="Delete local item"
                    onClick={() => void removeLocal()}
                    disabled={!selectedLocal || localLoading || transferring}
                    danger
                  >
                    ✕
                  </ToolButton>
                </>
              }
            />
          </div>

          <div className={`ftp-transfer-status${transfer ? " has-transfer" : ""}`}>
            {transfer ? (
              <>
                <div className="ftp-transfer-summary">
                  <span>
                    {transfer.status === "complete"
                      ? "Complete"
                      : transfer.status === "error"
                        ? "Failed"
                        : transfer.direction === "upload"
                          ? "Uploading"
                          : "Downloading"}
                    : {transfer.name}
                  </span>
                  <span>
                    {formatBytes(transfer.transferred)}
                    {transfer.total > 0 ? ` / ${formatBytes(transfer.total)}` : ""}
                  </span>
                </div>
                <div className="ftp-transfer-progress">
                  <span
                    className={transferPercent === null ? "is-indeterminate" : ""}
                    style={
                      transferPercent === null
                        ? undefined
                        : { width: `${transferPercent}%` }
                    }
                  />
                </div>
                {transfer.message && (
                  <div className="ftp-transfer-error">{transfer.message}</div>
                )}
              </>
            ) : (
              <span>{`Select a local file or folder to upload, or a ${protocolLabel} file or folder to download.`}</span>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function FileBrowser({
  title,
  subtitle,
  path,
  draft,
  entries,
  selected,
  loading,
  error,
  actions,
  onDraftChange,
  onOpenPath,
  onHome,
  onParent,
  onRefresh,
  onSelect,
  onActivate,
}: FileBrowserProps) {
  const theme = useStore((s) => s.theme);
  return (
    <section className="ftp-file-browser">
      <div className="ftp-browser-header">
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <div className="ftp-browser-actions">
          <ToolButton label="Home" onClick={onHome} disabled={loading}>
            ⌂
          </ToolButton>
          <ToolButton label="Parent folder" onClick={onParent} disabled={loading || !path}>
            ↑
          </ToolButton>
          <ToolButton label="Refresh" onClick={onRefresh} disabled={loading}>
            ↻
          </ToolButton>
          {actions}
        </div>
      </div>

      <div className="ftp-browser-path">
        <input
          value={draft}
          aria-label={`${title} path`}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") onOpenPath(draft);
            if (event.key === "Escape") onDraftChange(path);
          }}
        />
      </div>

      <div className="ftp-browser-columns">
        <span>Name</span>
        <span>Size</span>
        <span>Modified</span>
      </div>

      <div className="ftp-browser-list" role="listbox" aria-label={`${title} files`}>
        {error && <div className="ftp-browser-message is-error">{error}</div>}
        {!error && loading && <div className="ftp-browser-message">Loading…</div>}
        {!error && !loading && entries.length === 0 && (
          <div className="ftp-browser-message">This folder is empty.</div>
        )}
        {!error &&
          entries.map((entry) => (
            <div
              key={entry.path}
              className={`ftp-file-row${selected === entry.path ? " is-selected" : ""}${entry.isDir ? " is-directory" : ""}`}
              role="option"
              aria-selected={selected === entry.path}
              onClick={() => onSelect(entry.path)}
              onDoubleClick={() => onActivate(entry)}
              title={entry.path}
            >
              <span className="ftp-file-name">
                <span className="ftp-file-icon" aria-hidden="true">
                  <FileIcon name={entry.name} isDir={entry.isDir} theme={theme} />
                </span>
                <span>{entry.name}</span>
              </span>
              <span>{entry.isDir ? "—" : formatBytes(entry.size)}</span>
              <span>{formatDate(entry.modified)}</span>
            </div>
          ))}
      </div>
      <div className="ftp-browser-footer">
        <span>{entries.length} items</span>
        <span>{loading ? "Loading…" : path}</span>
      </div>
    </section>
  );
}

function ToolButton({
  label,
  children,
  onClick,
  disabled,
  danger = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      className={`ftp-tool-button${danger ? " is-danger" : ""}`}
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

function remoteParent(path: string): string {
  if (!path || path === "/") return "/";
  const trimmed = path.replace(/\/+$/, "");
  const slash = trimmed.lastIndexOf("/");
  return slash <= 0 ? "/" : trimmed.slice(0, slash);
}

function joinRemote(base: string, name: string): string {
  return base === "/" ? `/${name}` : `${base.replace(/\/+$/, "")}/${name}`;
}

function joinLocal(base: string, name: string): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return bytes === 0 ? "0 B" : "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

function formatDate(seconds: number | null): string {
  if (seconds == null) return "—";
  return new Date(seconds * 1000).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function friendlyFtpError(error: unknown): string {
  const message = String(error);
  if (message.includes("Response contains an invalid syntax")) {
    return "The FTP server returned a legacy or non-UTF-8 directory listing. Reconnect after updating EdgeTerm and try again.";
  }
  return message;
}
