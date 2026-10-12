import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import * as api from "../api";
import {
  loadFileSort,
  saveFileSort,
  sortFileEntries,
  sortIndicator,
  toggleFileSort,
  type FileSort,
  type SortKey,
} from "../fileSort";
import {
  dropAction,
  type DraggedEntry,
  type DropTarget,
  type PaneSide,
} from "../paneDrop";
import { FileIcon } from "./FileIcon";
import { Icon } from "./icons";
import { useStore, type Tab } from "../store";
import type { FileEntry } from "../types";

/** Pointer travel before a press on a row turns into a drag. */
const DRAG_THRESHOLD = 5;

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

/**
 * The pointer-drag wiring a browser pane gets from its FtpPane. The gesture
 * lives on the rows: a press captures the pointer, and once it travels far
 * enough the entry is dragged, with the drop read from whatever sits under
 * the pointer at release.
 */
interface PaneDnd {
  onItemPointerDown: (entry: FileEntry, event: ReactPointerEvent) => void;
  onItemPointerMove: (event: ReactPointerEvent) => void;
  onItemPointerUp: (event: ReactPointerEvent) => void;
  endDrag: () => void;
  /** The row being dragged, so it can dim; null when there is none. */
  draggingPath: string | null;
  /** The folder or pane the pointer is over, for highlighting. */
  hover: { side: PaneSide; dir: string } | null;
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
  side: PaneSide;
  dnd: PaneDnd;
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
  // The entry a pointer drag is carrying, plus the press that may become
  // one. Refs are what the gesture handlers read; the states re-render the
  // rows so the dragged one can dim and the target can highlight.
  const draggedRef = useRef<DraggedEntry | null>(null);
  const [dragging, setDragging] = useState<DraggedEntry | null>(null);
  const dragPressRef = useRef<{
    side: PaneSide;
    entry: FileEntry;
    pointerId: number;
    x: number;
    y: number;
  } | null>(null);
  const [dropHover, setDropHover] = useState<{
    side: PaneSide;
    dir: string;
  } | null>(null);

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

  /**
   * The entries a landing folder holds, for the conflict checks. The pane in
   * view already has them in hand; a folder row's are fetched.
   */
  const entriesAt = async (
    side: PaneSide,
    dir: string,
  ): Promise<FileEntry[]> => {
    if (side === "remote") {
      if (dir === remotePath) return remoteEntries;
      return (await api.sftpList(sessionId, dir)).entries;
    }
    if (dir === localPath) return localEntries;
    return (await api.localList(dir)).entries;
  };

  /**
   * The gate every landing shares: same-name checks with the target pane's
   * wording. False means stop — an error was shown or the user declined.
   * `moves` refuses a folder onto a same-named folder outright: a rename
   * cannot merge the way an uploaded directory walk can.
   */
  const mayLand = (
    side: PaneSide,
    incoming: FileEntry,
    existing: FileEntry | undefined,
    moves: boolean,
  ): boolean => {
    const setError = side === "remote" ? setRemoteError : setLocalError;
    if (!existing) return true;
    if (side === "local" && existing.isSymlink) {
      setError(`Refusing to replace local symlink “${incoming.name}”.`);
      return false;
    }
    if (existing.isDir !== incoming.isDir) {
      setError(
        incoming.isDir
          ? `A ${side} file named “${incoming.name}” already exists.`
          : `A ${side} folder named “${incoming.name}” already exists.`,
      );
      return false;
    }
    if (moves && incoming.isDir) {
      setError(`A ${side} folder named “${incoming.name}” already exists.`);
      return false;
    }
    const prompt = incoming.isDir
      ? `Merge into ${side} folder “${incoming.name}”? Existing files with the same names will be replaced.`
      : `Replace ${side} file “${incoming.name}”?`;
    return window.confirm(prompt);
  };

  const runUpload = async (incoming: FileEntry, destDir: string) => {
    if (transferring || !destDir) return;
    let existing: FileEntry | undefined;
    try {
      existing = (await entriesAt("remote", destDir)).find(
        (entry) => entry.name === incoming.name,
      );
    } catch (error) {
      setRemoteError(friendlyFtpError(error));
      return;
    }
    if (!mayLand("remote", incoming, existing, false)) return;

    setRemoteError(null);
    setTransferring(true);
    setTransfer({
      direction: "upload",
      name: incoming.name,
      transferred: 0,
      total: incoming.isDir ? 0 : incoming.size,
      status: "running",
    });
    try {
      const destination = joinRemote(destDir, incoming.name);
      if (incoming.isDir) {
        await api.sftpUploadDirectory(
          sessionId,
          incoming.path,
          destination,
          updateProgress,
        );
      } else {
        await api.sftpUpload(sessionId, incoming.path, destination, updateProgress);
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

  const runDownload = async (incoming: FileEntry, destDir: string) => {
    if (transferring || !destDir) return;
    let existing: FileEntry | undefined;
    try {
      existing = (await entriesAt("local", destDir)).find(
        (entry) => entry.name === incoming.name,
      );
    } catch (error) {
      setLocalError(String(error));
      return;
    }
    if (!mayLand("local", incoming, existing, false)) return;

    setLocalError(null);
    setTransferring(true);
    setTransfer({
      direction: "download",
      name: incoming.name,
      transferred: 0,
      total: incoming.isDir ? 0 : incoming.size,
      status: "running",
    });
    try {
      const destination = joinLocal(destDir, incoming.name);
      if (incoming.isDir) {
        await api.sftpDownloadDirectory(
          sessionId,
          incoming.path,
          destination,
          updateProgress,
        );
      } else {
        await api.sftpDownload(sessionId, incoming.path, destination, updateProgress);
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

  /** A drop inside one pane: a rename into the target folder. */
  const runMove = async (source: DraggedEntry, target: DropTarget) => {
    const incoming = source.entry;
    const setError = source.side === "remote" ? setRemoteError : setLocalError;
    let existing: FileEntry | undefined;
    try {
      existing = (await entriesAt(source.side, target.dir)).find(
        (entry) => entry.name === incoming.name && entry.path !== incoming.path,
      );
    } catch (error) {
      setError(
        source.side === "remote" ? friendlyFtpError(error) : String(error),
      );
      return;
    }
    if (!mayLand(source.side, incoming, existing, true)) return;

    setError(null);
    try {
      if (source.side === "remote") {
        await api.sftpRename(
          sessionId,
          incoming.path,
          joinRemote(target.dir, incoming.name),
        );
        await loadRemote(remotePath);
      } else {
        await api.localRename(
          incoming.path,
          joinLocal(target.dir, incoming.name),
        );
        await loadLocal(localPath);
      }
    } catch (error) {
      setError(
        source.side === "remote" ? friendlyFtpError(error) : String(error),
      );
    }
  };

  const upload = () => {
    if (selectedLocal) void runUpload(selectedLocal, remotePath);
  };

  const download = () => {
    if (selectedRemote) void runDownload(selectedRemote, localPath);
  };

  /**
   * Reads the drop target under a point from the panes' data attributes: a
   * folder row names its own folder, the list behind it names the pane's
   * directory, and a file row has neither so the list still answers for it.
   */
  const targetAt = (x: number, y: number): DropTarget | null => {
    const element = document
      .elementFromPoint(x, y)
      ?.closest("[data-drop-side]");
    const side = element?.getAttribute("data-drop-side");
    const dir = element?.getAttribute("data-drop-dir");
    if ((side !== "local" && side !== "remote") || !dir) return null;
    return { side, dir };
  };

  const beginPress = (side: PaneSide, entry: FileEntry, event: ReactPointerEvent) => {
    if (event.button !== 0 || transferring) return;
    dragPressRef.current = {
      side,
      entry,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    };
    // Without the capture a quick flick leaves the row before the threshold
    // is reached and the drag never starts.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const dragMove = (event: ReactPointerEvent) => {
    const press = dragPressRef.current;
    if (!press || press.pointerId !== event.pointerId) return;
    if (!draggedRef.current) {
      if (
        Math.abs(event.clientX - press.x) < DRAG_THRESHOLD &&
        Math.abs(event.clientY - press.y) < DRAG_THRESHOLD
      ) {
        return;
      }
      const source = { side: press.side, entry: press.entry };
      draggedRef.current = source;
      setDragging(source);
    }
    const hover = targetAt(event.clientX, event.clientY);
    setDropHover((current) =>
      current?.side === hover?.side && current?.dir === hover?.dir
        ? current
        : hover,
    );
  };

  const endDragState = () => {
    dragPressRef.current = null;
    draggedRef.current = null;
    setDragging(null);
    setDropHover(null);
  };

  /** The release: whatever sits under the pointer takes the drop. */
  const dragRelease = (event: ReactPointerEvent) => {
    const source = draggedRef.current;
    const target = source ? targetAt(event.clientX, event.clientY) : null;
    const action =
      source && target && !transferring ? dropAction(source, target) : null;
    endDragState();
    if (!source || !target || !action) return;
    if (action.kind === "move") {
      void runMove(source, target);
    } else if (action.kind === "upload") {
      void runUpload(source.entry, target.dir);
    } else {
      void runDownload(source.entry, target.dir);
    }
  };

  // Escape is the only way out of a drag that stays inside the window.
  useEffect(() => {
    if (!dragging) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") endDragState();
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [dragging]);

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
          <div className={`ftp-dual-pane${dragging ? " is-dragging" : ""}`}>
            <FileBrowser
              title={`${protocolLabel} Server`}
              subtitle={tab.info.address}
              side="remote"
              dnd={{
                onItemPointerDown: (entry, event) =>
                  beginPress("remote", entry, event),
                onItemPointerMove: dragMove,
                onItemPointerUp: dragRelease,
                endDrag: endDragState,
                draggingPath: dragging?.entry.path ?? null,
                hover: dropHover,
              }}
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
                    <Icon name="new-folder" />
                  </ToolButton>
                  <ToolButton
                    label="Rename remote item"
                    onClick={() => void renameRemote()}
                    disabled={!selectedRemote || remoteLoading || transferring}
                  >
                    <Icon name="edit" />
                  </ToolButton>
                  <ToolButton
                    label="Delete remote item"
                    onClick={() => void removeRemote()}
                    disabled={!selectedRemote || remoteLoading || transferring}
                    danger
                  >
                    <Icon name="trash" />
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
              side="local"
              dnd={{
                onItemPointerDown: (entry, event) =>
                  beginPress("local", entry, event),
                onItemPointerMove: dragMove,
                onItemPointerUp: dragRelease,
                endDrag: endDragState,
                draggingPath: dragging?.entry.path ?? null,
                hover: dropHover,
              }}
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
                    <Icon name="new-folder" />
                  </ToolButton>
                  <ToolButton
                    label="Rename local item"
                    onClick={() => void renameLocal()}
                    disabled={!selectedLocal || localLoading || transferring}
                  >
                    <Icon name="edit" />
                  </ToolButton>
                  <ToolButton
                    label="Delete local item"
                    onClick={() => void removeLocal()}
                    disabled={!selectedLocal || localLoading || transferring}
                    danger
                  >
                    <Icon name="trash" />
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
  side,
  dnd,
  onDraftChange,
  onOpenPath,
  onHome,
  onParent,
  onRefresh,
  onSelect,
  onActivate,
}: FileBrowserProps) {
  const theme = useStore((s) => s.theme);
  const [sort, setSort] = useState<FileSort>(loadFileSort);
  const sortedEntries = useMemo(
    () => sortFileEntries(entries, sort),
    [entries, sort],
  );

  /** Re-sorts the list for a clicked column caption and remembers the choice. */
  const sortBy = (key: SortKey) => {
    setSort((current) => {
      const next = toggleFileSort(current, key);
      saveFileSort(next);
      return next;
    });
  };

  return (
    <section className="ftp-file-browser">
      <div className="ftp-browser-header">
        <div>
          <strong>{title}</strong>
          <span>{subtitle}</span>
        </div>
        <div className="ftp-browser-actions">
          <ToolButton label="Home" onClick={onHome} disabled={loading}>
            <Icon name="home" />
          </ToolButton>
          <ToolButton label="Parent folder" onClick={onParent} disabled={loading || !path}>
            <Icon name="arrow-up" />
          </ToolButton>
          <ToolButton label="Refresh" onClick={onRefresh} disabled={loading}>
            <Icon name="refresh" />
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
        <button
          type="button"
          className={sort.key === "name" ? "is-sorted" : undefined}
          onClick={() => sortBy("name")}
          aria-label="Sort by name"
        >
          Name{sortIndicator(sort, "name")}
        </button>
        <button
          type="button"
          className={sort.key === "size" ? "is-sorted" : undefined}
          onClick={() => sortBy("size")}
          aria-label="Sort by size"
        >
          Size{sortIndicator(sort, "size")}
        </button>
        <button
          type="button"
          className={sort.key === "modified" ? "is-sorted" : undefined}
          onClick={() => sortBy("modified")}
          aria-label="Sort by last modified"
        >
          Modified{sortIndicator(sort, "modified")}
        </button>
      </div>

      <div
        className={`ftp-browser-list${dnd.hover != null && dnd.hover.side === side && dnd.hover.dir === path ? " is-drop-target" : ""}`}
        data-drop-side={side}
        data-drop-dir={path}
        role="listbox"
        aria-label={`${title} files`}
      >
        {error && <div className="ftp-browser-message is-error">{error}</div>}
        {!error && loading && <div className="ftp-browser-message">Loading…</div>}
        {!error && !loading && entries.length === 0 && (
          <div className="ftp-browser-message">This folder is empty.</div>
        )}
        {!error &&
          sortedEntries.map((entry) => (
            <div
              key={entry.path}
              className={`ftp-file-row${selected === entry.path ? " is-selected" : ""}${entry.isDir ? " is-directory" : ""}${dnd.draggingPath === entry.path ? " is-drag-source" : ""}${dnd.hover != null && dnd.hover.side === side && dnd.hover.dir === entry.path ? " is-drop-target" : ""}`}
              role="option"
              aria-selected={selected === entry.path}
              data-drop-side={entry.isDir ? side : undefined}
              data-drop-dir={entry.isDir ? entry.path : undefined}
              onPointerDown={(event) => dnd.onItemPointerDown(entry, event)}
              onPointerMove={dnd.onItemPointerMove}
              onPointerUp={dnd.onItemPointerUp}
              onPointerCancel={dnd.endDrag}
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
