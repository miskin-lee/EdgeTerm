import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react";

import * as api from "../../api";
import { IS_MAC, IS_WINDOWS } from "../../platform";
import { useActiveTab, useStore } from "../../store";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { DeleteEntryDialog } from "../DeleteEntryDialog";
import { FileIcon } from "../FileIcon";
import type { FileEntry, ThemeMode } from "../../types";

interface TransferState {
  /** `sync` is a remote file edited locally being sent back after a save. */
  kind: "upload" | "download" | "sync";
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

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export function FilerPanel() {
  const tab = useActiveTab();
  const theme = useStore((s) => s.theme);
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
  const [creating, setCreating] = useState<NewEntryDraft | null>(null);
  const [uploadMenu, setUploadMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  // ContextMenu closes itself on any outside mousedown, so by the time the
  // upload button's click fires the menu is already gone; remember whether it
  // was open so the button toggles instead of reopening.
  const uploadMenuWasOpen = useRef(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [pendingDelete, setPendingDelete] = useState<FileEntry | null>(null);
  const [openWithApps, setOpenWithApps] = useState<string[]>(loadOpenWithApps);
  const [transfer, setTransfer] = useState<TransferState | null>(null);
  const [dragOverList, setDragOverList] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const remoteIdRef = useRef(remoteId);
  const pathRef = useRef(path);
  const busyRef = useRef(busy);
  const uploadDroppedFilesRef = useRef<(paths: string[]) => void>(() => {});
  const remoteEditRef = useRef<(event: api.RemoteEditEvent) => void>(() => {});
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

  const closeMenu = useCallback(() => setMenu(null), []);

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

  const download = async (entry: FileEntry) => {
    if (!remoteId) return;
    let target: string | null = null;
    if (entry.isDir) {
      // A folder lands inside the chosen directory under its own name, so an
      // existing folder of that name is merged into rather than replaced.
      const parent = await openDialog({
        directory: true,
        multiple: false,
        title: `Save folder “${entry.name}” into…`,
      });
      if (typeof parent === "string") target = joinLocal(parent, entry.name);
    } else {
      target = await saveDialog({ defaultPath: entry.name });
    }
    if (!target) return;
    setBusy(true);
    setError(null);
    beginTransfer("download", entry.name);
    try {
      if (entry.isDir) {
        await api.sftpDownloadDirectory(
          remoteId,
          entry.path,
          target,
          updateTransferProgress,
        );
      } else {
        await api.sftpDownload(
          remoteId,
          entry.path,
          target,
          updateTransferProgress,
        );
      }
      finishTransfer("complete");
    } catch (e) {
      setError(String(e));
      finishTransfer("error");
    } finally {
      setBusy(false);
    }
  };

  const uploadPaths = async (localPaths: string[]) => {
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
        const isDirectory = await api.localIsDirectory(localPath);
        beginTransfer("upload", name);
        if (isDirectory) {
          await api.sftpUploadDirectory(
            remoteId,
            localPath,
            joinRemote(destination, name),
            updateTransferProgress,
          );
        } else {
          await api.sftpUpload(
            remoteId,
            localPath,
            joinRemote(destination, name),
            updateTransferProgress,
          );
        }
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
    void uploadPaths(paths);
  };

  // Progress of remote files edited locally, whichever tab is active: the
  // footer shows the save going out, and a failure lands in the error line.
  remoteEditRef.current = (event) => {
    if (event.status === "uploading") {
      beginTransfer("sync", event.name);
    } else if (event.status === "synced") {
      finishTransfer("complete");
    } else if (event.status === "kept") {
      setError(`${event.name}: ${event.message ?? "local copy kept"}`);
    } else {
      setError(`Sync ${event.name}: ${event.message ?? "failed"}`);
      finishTransfer("error");
    }
  };

  useEffect(() => {
    const unlisten = api.onRemoteEditState((event) =>
      remoteEditRef.current(event),
    );
    return () => {
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

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
    const picked = await openDialog({ multiple: true });
    await uploadPaths(pickedPaths(picked));
  };

  const uploadFolder = async () => {
    if (!remoteId) return;
    const picked = await openDialog({ directory: true, multiple: true });
    await uploadPaths(pickedPaths(picked));
  };

  const removeEntry = async (entry: FileEntry) => {
    setPendingDelete(null);
    setBusy(true);
    try {
      if (remoteId) await api.sftpRemove(remoteId, entry.path, entry.isDir);
      else await api.localRemove(entry.path, entry.isDir);
      await load(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text).catch((e) => setError(String(e)));
  };

  /**
   * The local path to hand to an application: the entry itself for local
   * sessions, otherwise a copy downloaded into the temp folder that the
   * backend then watches, sending every save back to the server. Null when
   * the download failed (the error is already shown).
   */
  const localCopyOf = async (entry: FileEntry): Promise<string | null> => {
    if (!remoteId) return entry.path;
    setBusy(true);
    setError(null);
    beginTransfer("download", entry.name);
    try {
      const target = await api.remoteEditPath(remoteId, entry.path, entry.name);
      await api.sftpDownload(
        remoteId,
        entry.path,
        target,
        updateTransferProgress,
      );
      await api.watchRemoteEdit(remoteId, target, entry.path);
      finishTransfer("complete");
      return target;
    } catch (e) {
      setError(String(e));
      finishTransfer("error");
      return null;
    } finally {
      setBusy(false);
    }
  };

  /** Opens a file with the default application, or with `app` when given. */
  const openEntry = async (entry: FileEntry, app?: string) => {
    const target = await localCopyOf(entry);
    if (!target) return;
    try {
      await api.openLocalPath(target, app);
      if (app) setOpenWithApps(rememberOpenWithApp(app));
    } catch (e) {
      setError(String(e));
    }
  };

  /**
   * Lets the user pick the application first. Windows has a system chooser
   * that also knows the registered handlers; elsewhere the application is a
   * file to pick (a macOS `.app` bundle, a program on Linux).
   */
  const openEntryWith = async (entry: FileEntry) => {
    if (IS_WINDOWS) {
      const target = await localCopyOf(entry);
      if (!target) return;
      await api.openWithDialog(target).catch((e) => setError(String(e)));
      return;
    }
    const picked = await openDialog({
      title: `Open “${entry.name}” with…`,
      multiple: false,
      directory: false,
      ...(IS_MAC
        ? {
            defaultPath: "/Applications",
            filters: [{ name: "Applications", extensions: ["app"] }],
          }
        : { defaultPath: "/usr/bin" }),
    });
    if (typeof picked === "string") await openEntry(entry, picked);
  };

  const openMenu = (event: MouseEvent, items: MenuItem[]) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  };

  const openWithMenu = (entry: FileEntry): MenuItem => {
    const other = {
      label: openWithApps.length > 0 ? "Other…" : "Open With…",
      disabled: busy,
      action: () => void openEntryWith(entry),
    };
    if (openWithApps.length === 0) return other;
    return {
      label: "Open With",
      children: [
        ...openWithApps.map((app) => ({
          label: appDisplayName(app),
          disabled: busy,
          action: () => void openEntry(entry, app),
        })),
        "separator",
        other,
      ],
    };
  };

  const entryMenu = (entry: FileEntry): MenuItem[] => [
    entry.isDir
      ? { label: "Open", action: () => void load(entry.path) }
      : { label: "Open", disabled: busy, action: () => void openEntry(entry) },
    ...(entry.isDir ? [] : [openWithMenu(entry)]),
    ...(remote
      ? [
          {
            label: "Download…",
            disabled: busy,
            action: () => void download(entry),
          },
        ]
      : []),
    "separator",
    { label: "Copy Path", action: () => copyText(entry.path) },
    { label: "Copy Name", action: () => copyText(entry.name) },
    "separator",
    {
      label: "Delete…",
      danger: true,
      disabled: busy || atDrivesRoot,
      action: () => setPendingDelete(entry),
    },
  ];

  /** Menu for the empty part of the list: actions on the current folder. */
  const folderMenu = (): MenuItem[] => [
    {
      label: "New File…",
      disabled: busy || !path || atDrivesRoot,
      action: () => setCreating({ kind: "file", name: "" }),
    },
    {
      label: "New Folder…",
      disabled: busy || !path || atDrivesRoot,
      action: () => setCreating({ kind: "folder", name: "" }),
    },
    ...(remote
      ? [
          "separator" as const,
          {
            label: "Upload Files…",
            disabled: busy || !path,
            action: () => void upload(),
          },
          {
            label: "Upload Folder…",
            disabled: busy || !path,
            action: () => void uploadFolder(),
          },
        ]
      : []),
    "separator",
    {
      label: "Copy Folder Path",
      disabled: !path || atDrivesRoot,
      action: () => copyText(path),
    },
    { label: "Refresh", disabled: busy, action: () => void load(path) },
  ];

  const commitNewEntry = async () => {
    const draft = creating;
    setCreating(null);
    const name = draft?.name.trim();
    if (!draft || !name || !path || atDrivesRoot) return;
    const label = draft.kind === "folder" ? "folder" : "file";
    if (name === "." || name === ".." || /[\\/]/.test(name)) {
      setError(`"${name}" is not a valid ${label} name`);
      return;
    }
    if (entries.some((entry) => entry.name === name)) {
      setError(`"${name}" already exists in this folder`);
      return;
    }
    try {
      if (remoteId) {
        const target = joinRemote(path, name);
        if (draft.kind === "folder") await api.sftpMkdir(remoteId, target);
        else await api.sftpCreateFile(remoteId, target);
      } else {
        const target = joinLocal(path, name);
        if (draft.kind === "folder") await api.localMkdir(target);
        else await api.localCreateFile(target);
      }
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
      ? transfer.kind === "sync"
        ? "Synced"
        : `${transfer.kind === "upload" ? "Upload" : "Download"} complete`
      : transfer.status === "error"
        ? transfer.kind === "sync"
          ? "Sync failed"
          : `${transfer.kind === "upload" ? "Upload" : "Download"} failed`
        : transfer.kind === "sync"
          ? "Syncing"
          : transfer.kind === "upload"
            ? "Uploading"
            : "Downloading"
    : "";

  const remoteTitle = (label: string) =>
    remote ? label : `${label} (connected SSH sessions only)`;
  // The Windows drive list is virtual: drives can be opened but not created,
  // deleted or navigated above.
  const atDrivesRoot = !remoteId && path === api.LOCAL_DRIVES_ROOT;
  const selectedEntry = entries.find((e) => e.path === selected) ?? null;

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

      {/* Upload and download stay visible on local sessions, just disabled. */}
      <div className="filer-toolbar" role="toolbar" aria-label="File actions">
        <button
          className="panel-action filer-action"
          onClick={() => setCreating({ kind: "file", name: "" })}
          title="New file"
          aria-label="New file"
          disabled={busy || !path || atDrivesRoot}
        >
          <FilerActionIcon name="new-file" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => setCreating({ kind: "folder", name: "" })}
          title="New folder"
          aria-label="New folder"
          disabled={busy || !path || atDrivesRoot}
        >
          <FilerActionIcon name="new-folder" />
        </button>
        <button
          className={`panel-action filer-action${uploadMenu ? " is-open" : ""}`}
          onMouseDown={() => {
            uploadMenuWasOpen.current = uploadMenu !== null;
          }}
          onClick={(event) => {
            if (uploadMenuWasOpen.current) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setUploadMenu({ x: rect.left, y: rect.bottom + 2 });
          }}
          title={remoteTitle("Upload files or folders")}
          aria-label="Upload files or folders"
          aria-haspopup="menu"
          aria-expanded={uploadMenu !== null}
          disabled={!remote || busy || !path}
        >
          <FilerActionIcon name="upload" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => selectedEntry && void download(selectedEntry)}
          title={remoteTitle("Download file or folder")}
          aria-label="Download file or folder"
          disabled={!remote || !selected || busy}
        >
          <FilerActionIcon name="download" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => void load(path)}
          title="Refresh"
          aria-label="Refresh"
          disabled={busy}
        >
          <FilerActionIcon name="refresh" />
        </button>
        <button
          className="panel-action filer-action filer-action-danger"
          onClick={() => selectedEntry && setPendingDelete(selectedEntry)}
          title="Delete"
          aria-label="Delete"
          disabled={!selected || busy || atDrivesRoot}
        >
          <FilerActionIcon name="delete" />
        </button>
      </div>
      {uploadMenu && (
        <ContextMenu
          x={uploadMenu.x}
          y={uploadMenu.y}
          items={[
            { label: "Upload files…", action: () => void upload() },
            { label: "Upload folder…", action: () => void uploadFolder() },
          ]}
          onClose={() => setUploadMenu(null)}
        />
      )}

      <div className="filer-path">
        <button
          className="panel-action filer-action"
          onClick={goUp}
          title="Parent folder"
          aria-label="Parent folder"
          disabled={busy || atDrivesRoot}
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
        onContextMenu={(event) => openMenu(event, folderMenu())}
        aria-label={
          remote
            ? `${tab?.info.protocol.toUpperCase()} file list. Drop files or folders here to upload.`
            : "Local file list"
        }
      >
        {error && <div className="panel-empty">{error}</div>}
        {creating !== null && (
          <div className="row filer-new-entry">
            <FilerEntryIcon
              name={creating.name}
              isDir={creating.kind === "folder"}
              theme={theme}
            />
            <input
              autoFocus
              value={creating.name}
              placeholder={
                creating.kind === "folder" ? "New folder name" : "New file name"
              }
              onChange={(event) =>
                setCreating({ ...creating, name: event.target.value })
              }
              onBlur={commitNewEntry}
              onKeyDown={(event) => {
                if (event.key === "Enter") void commitNewEntry();
                if (event.key === "Escape") setCreating(null);
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
              onContextMenu={(event) => {
                setSelected(entry.path);
                openMenu(event, entryMenu(entry));
              }}
              title={entryTitle(entry)}
            >
              <FilerEntryIcon
                name={entry.name}
                isDir={entry.isDir}
                theme={theme}
              />
              <span className="row-label">{entry.name}</span>
              <span className="filer-col-date row-meta">
                {formatDate(entry.modified)}
              </span>
            </div>
          );
        })}
      </div>

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={closeMenu}
        />
      )}
      {pendingDelete && (
        <DeleteEntryDialog
          entry={pendingDelete}
          location={remote ? (tab?.info.name ?? "remote") : "local"}
          onConfirm={() => void removeEntry(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}

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
          <span className="filer-drop-message">Drop files or folders to upload</span>
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

/** An entry being named inline at the top of the list before it exists. */
type NewEntryDraft = { kind: "file" | "folder"; name: string };

function FilerEntryIcon({
  name,
  isDir,
  theme,
}: {
  name: string;
  isDir: boolean;
  theme: ThemeMode;
}) {
  return (
    <span className="filer-icon">
      <FileIcon name={name} isDir={isDir} theme={theme} />
    </span>
  );
}

type FilerActionIconName =
  | "new-file"
  | "new-folder"
  | "upload"
  | "download"
  | "delete"
  | "refresh"
  | "parent-folder";

function FilerActionIcon({ name }: { name: FilerActionIconName }) {
  const paths: Record<FilerActionIconName, React.ReactNode> = {
    "new-file": (
      <>
        <path d="M13.5 3.5H7.25A1.75 1.75 0 0 0 5.5 5.25v13.5A1.75 1.75 0 0 0 7.25 20.5h9.5a1.75 1.75 0 0 0 1.75-1.75V8.5l-5-5Z" />
        <path d="M13.5 3.5v5h5" />
        <path d="M12 11.5v5M9.5 14h5" />
      </>
    ),
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

/** Applications the user has opened files with, most recent first. */
const OPEN_WITH_KEY = "edgeterm.filerOpenWith";
const OPEN_WITH_LIMIT = 6;

function loadOpenWithApps(): string[] {
  try {
    const parsed: unknown = JSON.parse(
      localStorage.getItem(OPEN_WITH_KEY) ?? "[]",
    );
    return Array.isArray(parsed)
      ? parsed.filter((app): app is string => typeof app === "string")
      : [];
  } catch {
    return [];
  }
}

function rememberOpenWithApp(app: string): string[] {
  const apps = [app, ...loadOpenWithApps().filter((known) => known !== app)];
  const kept = apps.slice(0, OPEN_WITH_LIMIT);
  try {
    localStorage.setItem(OPEN_WITH_KEY, JSON.stringify(kept));
  } catch {
    // Storage full or unavailable: the menu still works for this session.
  }
  return kept;
}

/** `/Applications/Visual Studio Code.app` → `Visual Studio Code`. */
function appDisplayName(app: string): string {
  const base = localFileName(app);
  return base.replace(/\.(app|exe)$/i, "");
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

function joinLocal(base: string, name: string): string {
  const separator = base.includes("\\") && !base.includes("/") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${name}`;
}

function pickedPaths(picked: string | string[] | null): string[] {
  if (Array.isArray(picked)) return picked;
  return typeof picked === "string" ? [picked] : [];
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
