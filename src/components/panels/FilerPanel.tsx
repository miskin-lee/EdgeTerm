import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";

import * as api from "../../api";
import { useActiveTab } from "../../store";
import type { FileEntry } from "../../types";

interface TransferState {
  kind: "upload" | "download";
  name: string;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  status: "running" | "complete" | "error";
}

interface TransferRateSample {
  time: number;
  transferred: number;
}

export function FilerPanel() {
  const tab = useActiveTab();
  const remote = Boolean(
    tab?.info.kind === "ssh" &&
      tab.info.supportsRemoteFiles &&
      tab.state === "connected",
  );
  // Null for every session without remote files, so switching between local tabs does not
  // count as a source change and reset where the user was browsing.
  const remoteId = remote ? (tab?.info.id ?? null) : null;

  const [path, setPath] = useState("");
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [dragOverList, setDragOverList] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const remoteIdRef = useRef(remoteId);
  const pathRef = useRef(path);
  const busyRef = useRef(busy);
  const uploadDroppedFilesRef = useRef<(paths: string[]) => void>(() => {});
  const transferClearTimer = useRef<number | null>(null);
  const transferRateSamples = useRef<TransferRateSample[]>([]);

  remoteIdRef.current = remoteId;
  pathRef.current = path;
  busyRef.current = busy;

  const beginTransfer = (kind: TransferState["kind"], name: string) => {
    if (transferClearTimer.current !== null) {
      window.clearTimeout(transferClearTimer.current);
      transferClearTimer.current = null;
    }
    setTransfer({
      kind,
      name,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      status: "running",
    });
    transferRateSamples.current = [
      { time: performance.now(), transferred: 0 },
    ];
  };

  const updateTransferProgress = (progress: api.TransferProgress) => {
    const now = performance.now();
    const samples = transferRateSamples.current;
    const latest = samples[samples.length - 1];
    if (!latest || progress.transferred < latest.transferred) {
      samples.splice(0, samples.length, {
        time: now,
        transferred: progress.transferred,
      });
    } else if (
      progress.transferred !== latest.transferred ||
      now - latest.time >= 250
    ) {
      samples.push({ time: now, transferred: progress.transferred });
    }

    const cutoff = now - 1000;
    while (samples.length > 2 && samples[1].time <= cutoff) {
      samples.shift();
    }
    const oldest = samples[0];
    const elapsedSeconds = oldest ? (now - oldest.time) / 1000 : 0;
    const bytesPerSecond =
      oldest && elapsedSeconds > 0
        ? Math.max(
            0,
            (progress.transferred - oldest.transferred) / elapsedSeconds,
          )
        : 0;

    setTransfer((current) =>
      current
        ? {
            ...current,
            transferred: progress.transferred,
            total: progress.total,
            bytesPerSecond,
          }
        : current,
    );
  };

  const finishTransfer = (status: "complete" | "error") => {
    setTransfer((current) =>
      current
        ? {
            ...current,
            transferred:
              status === "complete" && current.total > 0
                ? current.total
                : current.transferred,
            status,
          }
        : current,
    );
    transferClearTimer.current = window.setTimeout(
      () => {
        setTransfer(null);
        transferClearTimer.current = null;
      },
      status === "complete" ? 1800 : 3000,
    );
  };

  const load = useCallback(
    async (target: string) => {
      setBusy(true);
      setError(null);
      try {
        const listing = remoteId
          ? await api.sftpList(remoteId, target)
          : await api.localList(target);
        setPath(listing.path);
        setDraft(listing.path);
        setEntries(listing.entries);
        setSelected(null);
      } catch (e) {
        setError(String(e));
      } finally {
        setBusy(false);
      }
    },
    [remoteId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const home = remoteId
          ? await api.sftpHome(remoteId)
          : await api.localHome();
        if (!cancelled) await load(home);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [remoteId, load]);

  useEffect(
    () => () => {
      if (transferClearTimer.current !== null) {
        window.clearTimeout(transferClearTimer.current);
      }
    },
    [],
  );

  const goUp = async () => {
    if (!path) return;
    const parent = remoteId ? remoteParent(path) : await api.localParent(path);
    await load(parent);
  };

  const activate = (entry: FileEntry) => {
    if (entry.isDir) void load(entry.path);
    else setSelected(entry.path);
  };

  const download = async () => {
    const entry = entries.find((e) => e.path === selected);
    if (!entry || !remoteId) return;
    const target = await saveDialog({ defaultPath: entry.name });
    if (!target) return;
    setBusy(true);
    setError(null);
    beginTransfer("download", entry.name);
    try {
      await api.sftpDownload(
        remoteId,
        entry.path,
        target,
        updateTransferProgress,
      );
      finishTransfer("complete");
    } catch (e) {
      setError(String(e));
      finishTransfer("error");
    } finally {
      setBusy(false);
    }
  };

  const uploadFiles = async (localPaths: string[]) => {
    if (!remoteId || !path || busyRef.current || localPaths.length === 0) {
      return;
    }
    const destination = path;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      for (const localPath of localPaths) {
        const name = localFileName(localPath);
        beginTransfer("upload", name);
        await api.sftpUpload(
          remoteId,
          localPath,
          joinRemote(destination, name),
          updateTransferProgress,
        );
        finishTransfer("complete");
      }
      await load(destination);
    } catch (e) {
      finishTransfer("error");
      await load(destination);
      setError(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  uploadDroppedFilesRef.current = (paths) => {
    void uploadFiles(paths);
  };

  useEffect(() => {
    const unlisten = getCurrentWebview().onDragDropEvent(({ payload }) => {
      if (payload.type === "leave") {
        setDragOverList(false);
        return;
      }

      const position = payload.position.toLogical(window.devicePixelRatio);
      const bounds = listRef.current?.getBoundingClientRect();
      const isOverList = Boolean(
        bounds &&
          position.x >= bounds.left &&
          position.x <= bounds.right &&
          position.y >= bounds.top &&
          position.y <= bounds.bottom,
      );
      const canUpload = Boolean(
        remoteIdRef.current &&
          pathRef.current &&
          !busyRef.current &&
          isOverList,
      );

      if (payload.type === "drop") {
        setDragOverList(false);
        if (canUpload && payload.paths.length > 0) {
          uploadDroppedFilesRef.current(payload.paths);
        }
        return;
      }

      setDragOverList(canUpload);
    });
    void unlisten.catch(() => {});
    return () => {
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!remote || busy) setDragOverList(false);
  }, [remote, busy]);

  const upload = async () => {
    if (!remoteId) return;
    const picked = await openDialog({ multiple: false });
    if (typeof picked !== "string") return;
    await uploadFiles([picked]);
  };

  const removeSelected = async () => {
    const entry = entries.find((e) => e.path === selected);
    if (!entry || !remoteId) return;
    setBusy(true);
    try {
      await api.sftpRemove(remoteId, entry.path, entry.isDir);
      await load(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const commitNewFolder = async () => {
    const name = newFolder?.trim();
    setNewFolder(null);
    if (!name || !remoteId) return;
    try {
      await api.sftpMkdir(remoteId, joinRemote(path, name));
      await load(path);
    } catch (e) {
      setError(String(e));
    }
  };

  const transferPercent = transfer
    ? transfer.status === "complete"
      ? 100
      : transfer.total > 0
        ? Math.min(
            100,
            Math.round((transfer.transferred / transfer.total) * 100),
          )
        : null
    : null;
  const transferLabel = transfer
    ? transfer.status === "complete"
      ? `${transfer.kind === "upload" ? "Upload" : "Download"} complete`
      : transfer.status === "error"
        ? `${transfer.kind === "upload" ? "Upload" : "Download"} failed`
        : transfer.kind === "upload"
          ? "Uploading"
          : "Downloading"
    : "";

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-dot" style={{ background: "#39c5cf" }} />
          Filer
          <span className="row-meta">
            {remote ? tab?.info.protocol : "local"}
          </span>
        </div>
      </div>

      <div
        className={`filer-toolbar${remote ? " is-remote" : ""}`}
        role="toolbar"
        aria-label="File actions"
      >
        {remote && (
          <>
            <button
              className="panel-action filer-action"
              onClick={() => setNewFolder("")}
              title="New folder"
              aria-label="New folder"
              disabled={busy}
            >
              <FilerActionIcon name="new-folder" />
            </button>
            <button
              className="panel-action filer-action"
              onClick={upload}
              title="Upload"
              aria-label="Upload"
              disabled={busy || !path}
            >
              <FilerActionIcon name="upload" />
            </button>
            <button
              className="panel-action filer-action"
              onClick={download}
              title="Download"
              aria-label="Download"
              disabled={!selected || busy}
            >
              <FilerActionIcon name="download" />
            </button>
          </>
        )}
        <button
          className="panel-action filer-action"
          onClick={() => void load(path)}
          title="Refresh"
          aria-label="Refresh"
          disabled={busy}
        >
          <FilerActionIcon name="refresh" />
        </button>
        {remote && (
          <button
            className="panel-action filer-action filer-action-danger"
            onClick={removeSelected}
            title="Delete"
            aria-label="Delete"
            disabled={!selected || busy}
          >
            <FilerActionIcon name="delete" />
          </button>
        )}
      </div>

      <div className="filer-path">
        <button
          className="panel-action filer-action"
          onClick={goUp}
          title="Parent folder"
          aria-label="Parent folder"
          disabled={busy}
        >
          <FilerActionIcon name="parent-folder" />
        </button>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void load(draft);
            if (event.key === "Escape") setDraft(path);
          }}
        />
      </div>

      <div className="filer-columns">
        <span className="filer-col-name">Name</span>
        <span className="filer-col-date">Modified</span>
      </div>

      <div
        ref={listRef}
        className={`panel-body filer-list${dragOverList ? " is-drag-over" : ""}`}
        aria-label={
          remote
            ? `${tab?.info.protocol.toUpperCase()} file list. Drop files here to upload.`
            : "Local file list"
        }
      >
        {error && <div className="panel-empty">{error}</div>}
        {newFolder !== null && (
          <div className="row filer-new-folder">
            <span className="filer-icon is-directory">
              <FilerEntryIcon kind="directory" />
            </span>
            <input
              autoFocus
              value={newFolder}
              placeholder="New folder name"
              onChange={(event) => setNewFolder(event.target.value)}
              onBlur={commitNewFolder}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitNewFolder();
                if (event.key === "Escape") setNewFolder(null);
              }}
            />
          </div>
        )}
        {entries.map((entry) => {
          const kind = entryKind(entry);
          return (
            <div
              key={entry.path}
              className={`row filer-entry is-${kind}${entry.path === selected ? " is-active" : ""}`}
              onMouseDown={() => setSelected(entry.path)}
              onDoubleClick={() => activate(entry)}
              title={entryTitle(entry)}
            >
              <span className={`filer-icon is-${kind}`}>
                <FilerEntryIcon kind={kind} />
              </span>
              <span className="filer-entry-main">
                <span className="row-label">{entry.name}</span>
                <span className="filer-entry-details">
                  <span className="filer-entry-kind">
                    {entryKindLabel(kind)}
                  </span>
                  {!entry.isDir && (
                    <span className="filer-entry-size">
                      {formatBytes(entry.size)}
                    </span>
                  )}
                </span>
              </span>
              <span className="filer-col-date row-meta">
                {formatDate(entry.modified)}
              </span>
            </div>
          );
        })}
      </div>

      <div className={`filer-footer${transfer ? " has-transfer" : ""}`}>
        {transfer ? (
          <div
            className={`filer-transfer is-${transfer.status}`}
            role="progressbar"
            aria-label={`${transferLabel}: ${transfer.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={transferPercent ?? undefined}
            aria-valuetext={
              transfer.total > 0
                ? `${formatBytes(transfer.transferred)} of ${formatBytes(transfer.total)} at ${formatBytes(transfer.bytesPerSecond)} per second`
                : `${formatBytes(transfer.transferred)} at ${formatBytes(transfer.bytesPerSecond)} per second`
            }
          >
            <div className="filer-transfer-label">
              <span className="filer-transfer-name" title={transfer.name}>
                {transferLabel}: {transfer.name}
              </span>
              <span
                className="filer-transfer-value"
              >
                {transfer.status === "error"
                  ? "Failed"
                  : transferPercent === null
                    ? formatBytes(transfer.transferred)
                    : `${transferPercent}%`}
              </span>
            </div>
            <div
              className={`filer-transfer-track${transferPercent === null && transfer.status === "running" ? " is-indeterminate" : ""}`}
            >
              <span
                className="filer-transfer-bar"
                style={
                  transferPercent === null
                    ? undefined
                    : { width: `${transferPercent}%` }
                }
              />
            </div>
            <div className="filer-transfer-meta">
              <span>
                {formatBytes(transfer.transferred)}
                {transfer.total > 0 && ` / ${formatBytes(transfer.total)}`}
              </span>
              <span title="Transfer speed">
                {formatBytes(transfer.bytesPerSecond)}/s
              </span>
            </div>
          </div>
        ) : dragOverList ? (
          <span className="filer-drop-message">Drop files to upload</span>
        ) : (
          <>
            <span>{formatEntrySummary(entries)}</span>
            {busy && <span>working…</span>}
          </>
        )}
      </div>
    </div>
  );
}

type FilerEntryKind = "directory" | "file" | "symlink";

function FilerEntryIcon({ kind }: { kind: FilerEntryKind }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {kind === "directory" ? (
        <path d="M2.25 5.25h5l1.6 1.8h8.9v8.7a1.5 1.5 0 0 1-1.5 1.5H3.75a1.5 1.5 0 0 1-1.5-1.5V5.25Z" />
      ) : kind === "symlink" ? (
        <>
          <path d="M6.9 12.7 5.6 14a2.55 2.55 0 1 1-3.6-3.6l2.65-2.65a2.55 2.55 0 0 1 3.6 0" />
          <path d="m13.1 7.3 1.3-1.3a2.55 2.55 0 1 1 3.6 3.6l-2.65 2.65a2.55 2.55 0 0 1-3.6 0" />
          <path d="m7.25 12.75 5.5-5.5" />
        </>
      ) : (
        <>
          <path d="M4 2.25h7.25L16 7v10.75H4V2.25Z" />
          <path d="M11.25 2.25V7H16M7 10.25h6M7 13.25h6" />
        </>
      )}
    </svg>
  );
}

type FilerActionIconName =
  | "new-folder"
  | "upload"
  | "download"
  | "delete"
  | "refresh"
  | "parent-folder";

function FilerActionIcon({ name }: { name: FilerActionIconName }) {
  const paths: Record<FilerActionIconName, React.ReactNode> = {
    "new-folder": (
      <>
        <path d="M3.5 6.5h6l2 2h9v9.75a1.75 1.75 0 0 1-1.75 1.75H5.25a1.75 1.75 0 0 1-1.75-1.75V6.5Z" />
        <path d="M15 11.5v5M12.5 14h5" />
      </>
    ),
    upload: (
      <>
        <path d="M12 15V4.5M8 8.5l4-4 4 4" />
        <path d="M5 14.5v3.75A1.75 1.75 0 0 0 6.75 20h10.5A1.75 1.75 0 0 0 19 18.25V14.5" />
      </>
    ),
    download: (
      <>
        <path d="M12 4v10.5M8 10.5l4 4 4-4" />
        <path d="M5 14.5v3.75A1.75 1.75 0 0 0 6.75 20h10.5A1.75 1.75 0 0 0 19 18.25V14.5" />
      </>
    ),
    delete: (
      <>
        <path d="M4.5 7h15M9 7V4.5h6V7M6.5 7l.75 12.5h9.5L17.5 7" />
        <path d="M10 10.5v5.5M14 10.5v5.5" />
      </>
    ),
    refresh: (
      <>
        <path d="M19.25 8A8 8 0 1 0 20 13" />
        <path d="M19.25 3.5V8h-4.5" />
      </>
    ),
    "parent-folder": <path d="m7 14 5-5 5 5" />,
  };

  return (
    <svg
      className="filer-action-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name]}
    </svg>
  );
}

function remoteParent(path: string): string {
  if (path === "/" || !path.includes("/")) return "/";
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

function joinRemote(base: string, name: string): string {
  if (base.endsWith("/")) return `${base}${name}`;
  return `${base}/${name}`;
}

function localFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? "upload.bin";
}

function entryKind(entry: FileEntry): FilerEntryKind {
  if (entry.isSymlink) return "symlink";
  return entry.isDir ? "directory" : "file";
}

function entryKindLabel(kind: FilerEntryKind): string {
  if (kind === "directory") return "Folder";
  if (kind === "symlink") return "Link";
  return "File";
}

function entryTitle(entry: FileEntry): string {
  const kind = entryKind(entry);
  const attributes = [entryKindLabel(kind)];
  if (!entry.isDir) attributes.push(formatBytes(entry.size));
  if (entry.permissions !== null) {
    attributes.push(
      `Mode ${(entry.permissions & 0o7777).toString(8).padStart(4, "0")}`,
    );
  }
  if (entry.owner) {
    attributes.push(entry.group ? `${entry.owner}:${entry.group}` : entry.owner);
  }
  return `${entry.path}\n${attributes.join(" · ")}`;
}

function formatEntrySummary(entries: FileEntry[]): string {
  let folders = 0;
  let files = 0;
  let links = 0;
  for (const entry of entries) {
    const kind = entryKind(entry);
    if (kind === "directory") folders += 1;
    else if (kind === "symlink") links += 1;
    else files += 1;
  }

  const parts = [
    folders > 0 ? `${folders} ${folders === 1 ? "folder" : "folders"}` : "",
    files > 0 ? `${files} ${files === 1 ? "file" : "files"}` : "",
    links > 0 ? `${links} ${links === 1 ? "link" : "links"}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "0 items";
}

function formatDate(seconds: number | null): string {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index++) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}
