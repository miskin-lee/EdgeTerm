import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useState } from "react";

import * as api from "../../api";
import { useActiveTab } from "../../store";
import type { FileEntry } from "../../types";

export function FilerPanel() {
  const tab = useActiveTab();
  const remote = Boolean(tab?.info.supportsSftp && tab?.state === "connected");
  // Null for every non-SFTP session, so switching between local tabs does not
  // count as a source change and reset where the user was browsing.
  const remoteId = remote ? (tab?.info.id ?? null) : null;

  const [path, setPath] = useState("");
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newFolder, setNewFolder] = useState<string | null>(null);

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
    try {
      await api.sftpDownload(remoteId, entry.path, target);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const upload = async () => {
    if (!remoteId) return;
    const picked = await openDialog({ multiple: false });
    if (typeof picked !== "string") return;
    const name = picked.split(/[\\/]/).pop() ?? "upload.bin";
    setBusy(true);
    try {
      await api.sftpUpload(remoteId, picked, joinRemote(path, name));
      await load(path);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
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

  const totalSize = entries.reduce((sum, e) => sum + (e.isDir ? 0 : e.size), 0);

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="panel-header">
        <div className="panel-title">
          <span className="panel-dot" style={{ background: "#39c5cf" }} />
          Filer
          <span className="row-meta">{remote ? "sftp" : "local"}</span>
        </div>
        {remote && (
          <>
            <button
              className="panel-action"
              onClick={() => setNewFolder("")}
              title="New folder"
            >
              ＋
            </button>
            <button className="panel-action" onClick={upload} title="Upload">
              ↥
            </button>
            <button
              className="panel-action"
              onClick={download}
              title="Download"
              disabled={!selected}
            >
              ↧
            </button>
            <button
              className="panel-action"
              onClick={removeSelected}
              title="Delete"
              disabled={!selected}
            >
              🗑
            </button>
          </>
        )}
        <button
          className="panel-action"
          onClick={() => void load(path)}
          title="Refresh"
        >
          ⟳
        </button>
      </div>

      <div className="filer-path">
        <button className="panel-action" onClick={goUp} title="Parent folder">
          ↑
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
        <span className="filer-col-size">Size</span>
        <span className="filer-col-date">Date Modified</span>
      </div>

      <div className="panel-body">
        {error && <div className="panel-empty">{error}</div>}
        {newFolder !== null && (
          <div className="row">
            <span className="filer-icon">📁</span>
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
        {entries.map((entry) => (
          <div
            key={entry.path}
            className={`row${entry.path === selected ? " is-active" : ""}`}
            onMouseDown={() => setSelected(entry.path)}
            onDoubleClick={() => activate(entry)}
            title={entry.path}
          >
            <span className="filer-icon">
              {entry.isDir ? "📁" : entry.isSymlink ? "🔗" : "📄"}
            </span>
            <span className="row-label">{entry.name}</span>
            <span className="filer-col-size row-meta">
              {entry.isDir ? "" : formatSize(entry.size)}
            </span>
            <span className="filer-col-date row-meta">
              {formatDate(entry.modified)}
            </span>
          </div>
        ))}
      </div>

      <div className="filer-footer">
        <span>{entries.length} items</span>
        <span>{formatSize(totalSize)}</span>
        {busy && <span>working…</span>}
      </div>
    </div>
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

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

function formatDate(seconds: number | null): string {
  if (!seconds) return "";
  const d = new Date(seconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
}
