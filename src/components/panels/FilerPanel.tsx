import type { PhysicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { revealCwdInFiler } from "../../actions";
import * as api from "../../api";
import { IS_MAC, IS_WINDOWS } from "../../platform";
import { chordLabel } from "../../shortcuts";
import { tabTitle, useActiveTab, useStore } from "../../store";
import { ContextMenu, type MenuItem } from "../ContextMenu";
import { DeleteEntryDialog } from "../DeleteEntryDialog";
import { FileIcon } from "../FileIcon";
import { Icon } from "../icons";
import type { FileEntry, ThemeMode } from "../../types";

interface TransferState {
  /**
   * `sync` is a remote file edited locally being sent back after a save;
   * `stage` is the copy a drag out of the window needs on Windows / Linux
   * before the system can take it (macOS downloads on the drop instead,
   * shown as a `download`); `copy` is a drop landing in a local folder.
   */
  kind: "upload" | "download" | "sync" | "stage" | "copy";
  name: string;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  status: "running" | "complete" | "error" | "cancelled";
  /** Whether the footer offers to cancel it; see `beginTransfer`. */
  cancellable: boolean;
}

interface TransferRateSample {
  time: number;
  transferred: number;
}

/** The transfer that can be cancelled right now; see `beginTransfer`. */
interface ActiveTransfer {
  id: string;
  /** Set once a cancel was sent, so the rejection reads as a cancel. */
  cancelled: boolean;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

/** An entry on its way out of the window; `staging` while its copy downloads. */
interface DragOutState {
  path: string;
  name: string;
  /**
   * True while the copy a Windows / Linux drag needs is still downloading,
   * before the system has the drag; a release then cancels it.
   */
  staging: boolean;
}

/** A press on an entry that has not yet travelled far enough to be a drag. */
interface DragPress {
  pointerId: number;
  x: number;
  y: number;
  entry: FileEntry;
}

/** Pointer travel before a press on an entry turns into a drag out. */
const DRAG_OUT_THRESHOLD = 5;

/**
 * Whether a drop on the panel would be uploaded. `reason` carries the message
 * to show when it would not; null means say nothing (this panel's own drag
 * out is passing over the window).
 */
interface DropVerdict {
  accept: boolean;
  reason: string | null;
}

/**
 * Where a drag currently is, in CSS pixels, so it can be compared with the
 * panel's own `getBoundingClientRect()`.
 *
 * Tauri types the position as physical, but only Windows measures it that
 * way: wry reads the client point from `ScreenToClient`. macOS passes
 * AppKit's `draggingLocation` and Linux the widget coordinates of GTK's
 * `drag-motion` straight through, and both of those are already logical
 * points. Dividing them by the device pixel ratio put every drop at half its
 * real position, which on a Retina display is far to the left of the Filer —
 * the panel never saw a drop and nothing was ever uploaded.
 */
const dropPoint = (position: PhysicalPosition): { x: number; y: number } =>
  IS_WINDOWS ? position.toLogical(window.devicePixelRatio) : position;

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
  const filerTarget = useStore((s) => s.filerTarget);
  const revealKey = useStore((s) => chordLabel(s.shortcuts.revealCwd));
  /** The last `filerTarget.token` this panel navigated to. */
  const consumedTarget = useRef(0);
  // Shell and SSH sessions have a working directory to reveal (⌘J); file
  // sessions bring their own pane and serial lines have no shell.
  const canReveal = Boolean(
    tab &&
      (tab.info.kind === "local" || tab.info.kind === "ssh") &&
      tab.state === "connected",
  );

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
  const [dragOver, setDragOver] = useState<DropVerdict | null>(null);
  const [dragOut, setDragOut] = useState<DragOutState | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const remoteIdRef = useRef(remoteId);
  const pathRef = useRef(path);
  const busyRef = useRef(busy);
  const dropFilesRef = useRef<(paths: string[]) => void>(() => {});
  /** Read from the drop handler, which must not act during our own drag. */
  const dragOutRef = useRef<DragOutState | null>(null);
  /**
   * What the last drag out handed to the system. A drop carrying exactly
   * those paths is that drag coming back over this window, and uploading it
   * would send the copy straight back to where it came from. Matching on the
   * paths rather than on "a drag is in flight" keeps a drag whose end was
   * never reported from blocking every later upload.
   */
  const handedOutPaths = useRef<string[]>([]);
  /** Whether the button that started a drag out is still held down. */
  const pointerHeld = useRef(false);
  const dragPress = useRef<DragPress | null>(null);
  const remoteEditRef = useRef<(event: api.RemoteEditEvent) => void>(() => {});
  const transferClearTimer = useRef<number | null>(null);
  const transferRateSamples = useRef<TransferRateSample[]>([]);
  const activeTransfer = useRef<ActiveTransfer | null>(null);

  remoteIdRef.current = remoteId;
  pathRef.current = path;
  busyRef.current = busy;

  /**
   * Shows `kind` starting in the footer. A cancellable transfer (the SFTP
   * and FTP copies) gets the id to pass along; the footer's Cancel button
   * and a released drag reach it through `cancelTransfer`.
   */
  const beginTransfer = (
    kind: TransferState["kind"],
    name: string,
    cancellable = false,
  ): string | undefined => {
    if (transferClearTimer.current !== null) {
      window.clearTimeout(transferClearTimer.current);
      transferClearTimer.current = null;
    }
    activeTransfer.current = cancellable
      ? { id: api.newTransferId(), cancelled: false }
      : null;
    setTransfer({
      kind,
      name,
      transferred: 0,
      total: 0,
      bytesPerSecond: 0,
      status: "running",
      cancellable,
    });
    transferRateSamples.current = [
      { time: performance.now(), transferred: 0 },
    ];
    return activeTransfer.current?.id;
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

  const finishTransfer = (status: "complete" | "error" | "cancelled") => {
    activeTransfer.current = null;
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
      status === "error" ? 3000 : 1800,
    );
  };

  /**
   * Cancels the transfer in the footer. The backend stops within a chunk
   * and the transfer's promise rejects, which `failTransfer` then reads as
   * a cancel rather than a failure.
   */
  const cancelTransfer = () => {
    const active = activeTransfer.current;
    if (!active || active.cancelled) return;
    active.cancelled = true;
    void api.cancelTransfer(active.id);
  };

  /** Ends the transfer a rejection belongs to: cancelled, or failed with `e`. */
  const failTransfer = (e: unknown) => {
    if (activeTransfer.current?.cancelled) {
      finishTransfer("cancelled");
      return;
    }
    setError(String(e));
    finishTransfer("error");
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

  /**
   * A reveal request not yet navigated to, if it is for the session this
   * panel is showing. Claimed on return, so the mount-time load below and
   * the effect watching `filerTarget` never both act on one request.
   */
  const claimTarget = (): string | null => {
    const target = useStore.getState().filerTarget;
    if (!target || target.token === consumedTarget.current) return null;
    consumedTarget.current = target.token;
    const tabId = useStore.getState().activeId;
    return target.sessionId === tabId ? target.path : null;
  };

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        // Revealing with the panel hidden shows it: start at the requested
        // directory rather than loading home first and racing it.
        const start =
          claimTarget() ??
          (remoteId ? await api.sftpHome(remoteId) : await api.localHome());
        if (!cancelled) await load(start);
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [remoteId, load]);

  useEffect(() => {
    const target = claimTarget();
    if (target !== null) void load(target);
  }, [filerTarget, load]);

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
    const transfer = beginTransfer("download", entry.name, true);
    try {
      if (entry.isDir) {
        await api.sftpDownloadDirectory(
          remoteId,
          entry.path,
          target,
          updateTransferProgress,
          transfer,
        );
      } else {
        await api.sftpDownload(
          remoteId,
          entry.path,
          target,
          updateTransferProgress,
          transfer,
        );
      }
      finishTransfer("complete");
    } catch (e) {
      failTransfer(e);
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
        const transfer = beginTransfer("upload", name, true);
        if (isDirectory) {
          await api.sftpUploadDirectory(
            remoteId,
            localPath,
            joinRemote(destination, name),
            updateTransferProgress,
            transfer,
          );
        } else {
          await api.sftpUpload(
            remoteId,
            localPath,
            joinRemote(destination, name),
            updateTransferProgress,
            transfer,
          );
        }
        finishTransfer("complete");
      }
      await load(destination);
    } catch (e) {
      // Reload first: it clears the error line, and what did arrive should
      // show.
      await load(destination);
      failTransfer(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  /**
   * Files dropped on a Filer that is showing local files land in the folder
   * on screen, the way dropping on a file manager works: uploading needs a
   * remote session, and this is the local half of the same gesture.
   */
  const copyPaths = async (sources: string[]) => {
    if (remoteIdRef.current || !path || busyRef.current || sources.length === 0) {
      return;
    }
    const destination = path;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let skipped = 0;
    try {
      for (const source of sources) {
        beginTransfer("copy", localFileName(source));
        const summary = await api.localCopyInto(
          source,
          destination,
          updateTransferProgress,
        );
        if (summary.files === 0 && summary.skipped > 0) skipped += 1;
        finishTransfer("complete");
      }
      await load(destination);
      if (skipped > 0) {
        setError(
          skipped === sources.length
            ? "Already in this folder"
            : `${skipped} of ${sources.length} items were already in this folder`,
        );
      }
    } catch (e) {
      finishTransfer("error");
      await load(destination);
      setError(String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  dropFilesRef.current = (paths) => {
    if (remoteId) void uploadPaths(paths);
    else void copyPaths(paths);
  };

  const updateDragOut = (next: DragOutState | null) => {
    dragOutRef.current = next;
    setDragOut(next);
  };

  /**
   * Whether files dropped on the panel right now would be uploaded, and what
   * to tell the user when they would not. A refusal without a reason is this
   * panel's own drag passing over the window, which says nothing.
   */
  const dropVerdict = (): DropVerdict => {
    if (dragOutRef.current) return { accept: false, reason: null };
    if (!pathRef.current) {
      return { accept: false, reason: "No folder is open yet" };
    }
    // The Windows drive list is a virtual folder: drives can be opened but
    // nothing can be written next to them.
    if (!remoteIdRef.current && pathRef.current === api.LOCAL_DRIVES_ROOT) {
      return { accept: false, reason: "Open a drive to copy files into" };
    }
    if (busyRef.current) {
      return {
        accept: false,
        reason: "Busy — wait for the current transfer to finish",
      };
    }
    return { accept: true, reason: null };
  };

  /**
   * Hands local paths to the system, which carries them until the user drops
   * them on a folder, the desktop or another application. The gesture the
   * drag attaches to is the one still in progress, so this runs while the
   * button is down; the callback lands when it is released.
   */
  const handToSystem = async (entry: FileEntry, paths: string[]) => {
    handedOutPaths.current = paths;
    updateDragOut({ path: entry.path, name: entry.name, staging: false });
    try {
      await api.startFileDrag(paths, (outcome) => {
        updateDragOut(null);
        if (outcome.error) {
          setError(`Could not drag ${entry.name}: ${outcome.error}`);
        }
      });
    } catch (e) {
      updateDragOut(null);
      setError(String(e));
    }
  };

  /**
   * macOS: hands the system a promise of `entry` rather than a copy of it.
   * Nothing is downloaded while the drag is in flight; a target that takes
   * the drop (Finder, the desktop, another application) names the path it
   * wants, and `deliverPromised` downloads straight there. A drag that is
   * cancelled or let go inside the window costs nothing.
   */
  const promiseToSystem = async (sessionId: string, entry: FileEntry) => {
    updateDragOut({ path: entry.path, name: entry.name, staging: false });
    try {
      await api.startPromisedFileDrag(entry.name, entry.isDir, (event) => {
        switch (event.kind) {
          case "write":
            void deliverPromised(
              sessionId,
              entry,
              event.token,
              event.destination,
            );
            break;
          case "ended":
            updateDragOut(null);
            break;
          case "failed":
            updateDragOut(null);
            setError(`Could not drag ${entry.name}: ${event.error}`);
            break;
        }
      });
    } catch (e) {
      updateDragOut(null);
      setError(String(e));
    }
  };

  /**
   * Downloads a promised entry to where the drop target asked for it, then
   * settles the promise so the target shows the file (or the reason there
   * is none). The transfer is the ordinary cancellable download; a cancel
   * is reported to the target like any other failure.
   */
  const deliverPromised = async (
    sessionId: string,
    entry: FileEntry,
    token: string,
    destination: string,
  ) => {
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const transfer = beginTransfer("download", entry.name, true);
    let failure: string | null = null;
    try {
      if (entry.isDir) {
        await api.sftpDownloadDirectory(
          sessionId,
          entry.path,
          destination,
          updateTransferProgress,
          transfer,
        );
      } else {
        await api.sftpDownload(
          sessionId,
          entry.path,
          destination,
          updateTransferProgress,
          transfer,
        );
      }
      finishTransfer("complete");
    } catch (e) {
      failure = activeTransfer.current?.cancelled
        ? `${entry.name}: download cancelled`
        : String(e);
      failTransfer(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
    try {
      await api.finishPromisedFile(token, failure);
    } catch (e) {
      setError(String(e));
    }
  };

  /**
   * Drags `entry` out of the window. A local entry is already a file the
   * system can take. A remote one is promised on macOS (see
   * `promiseToSystem`); Windows and Linux have no way to promise a file the
   * drop target fetches later, so there it is downloaded into the staging
   * folder first, and a large one has to finish while the button is held.
   */
  const beginDragOut = async (entry: FileEntry) => {
    if (busyRef.current || dragOutRef.current || atDrivesRoot) return;
    const sessionId = remoteIdRef.current;
    if (!sessionId) {
      await handToSystem(entry, [entry.path]);
      return;
    }
    if (IS_MAC) {
      await promiseToSystem(sessionId, entry);
      return;
    }

    updateDragOut({ path: entry.path, name: entry.name, staging: true });
    busyRef.current = true;
    setBusy(true);
    setError(null);
    const transfer = beginTransfer("stage", entry.name, true);
    try {
      const staged = await api.dragStagingPath(entry.name);
      if (entry.isDir) {
        await api.sftpDownloadDirectory(
          sessionId,
          entry.path,
          staged,
          updateTransferProgress,
          transfer,
        );
      } else {
        await api.sftpDownload(
          sessionId,
          entry.path,
          staged,
          updateTransferProgress,
          transfer,
        );
      }
      finishTransfer("complete");
      if (pointerHeld.current) {
        await handToSystem(entry, [staged]);
      } else {
        // The release cancels a copy still running (see `release`); this is
        // the copy that finished just before the release was seen.
        updateDragOut(null);
        setError(
          `${entry.name} finished copying after the drag ended; drag it again to drop it`,
        );
      }
    } catch (e) {
      updateDragOut(null);
      failTransfer(e);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const onEntryPointerDown = (
    entry: FileEntry,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0) return;
    pointerHeld.current = true;
    dragPress.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      entry,
    };
    // Without the capture a quick flick leaves the row before the threshold
    // is reached and the drag never starts.
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onEntryPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const press = dragPress.current;
    if (!press || press.pointerId !== event.pointerId) return;
    if (
      Math.abs(event.clientX - press.x) < DRAG_OUT_THRESHOLD &&
      Math.abs(event.clientY - press.y) < DRAG_OUT_THRESHOLD
    ) {
      return;
    }
    dragPress.current = null;
    // The system drag needs the pointer itself; a capture would keep every
    // event inside the webview.
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    void beginDragOut(press.entry);
  };

  // The release may land anywhere — outside the row, outside the window —
  // and staging needs to know whether the gesture is still alive.
  useEffect(() => {
    const release = () => {
      pointerHeld.current = false;
      dragPress.current = null;
      // A drag that ends while its copy is still downloading was never
      // going to drop anything: an accidental few pixels of travel used to
      // download a whole folder that nobody could stop (#45).
      if (dragOutRef.current?.staging) cancelTransfer();
    };
    // A fresh press means any earlier system drag is long over, whether or
    // not its end was ever reported back.
    const press = () => {
      if (dragOutRef.current) updateDragOut(null);
    };
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("pointerup", release);
    window.addEventListener("pointercancel", release);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointerup", release);
      window.removeEventListener("pointercancel", release);
    };
  }, []);

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
        setDragOver(null);
        return;
      }

      const position = dropPoint(payload.position);
      const bounds = panelRef.current?.getBoundingClientRect();
      const isOverPanel = Boolean(
        bounds &&
          position.x >= bounds.left &&
          position.x <= bounds.right &&
          position.y >= bounds.top &&
          position.y <= bounds.bottom,
      );
      if (!isOverPanel) {
        setDragOver(null);
        return;
      }
      const verdict = dropVerdict();

      if (payload.type === "drop") {
        setDragOver(null);
        if (payload.paths.length === 0) return;
        // Our own drag out coming back over the window: dropping it here
        // would upload the copy it was just made from.
        const ours = payload.paths.every((dropped) =>
          handedOutPaths.current.includes(dropped),
        );
        if (ours) return;
        if (verdict.accept) dropFilesRef.current(payload.paths);
        // Never swallow a drop in silence; say why it was not taken.
        else if (verdict.reason) setError(verdict.reason);
        return;
      }

      setDragOver(verdict);
    });
    void unlisten.catch(() => {});
    return () => {
      void unlisten.then((off) => off()).catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (busy) setDragOver(null);
  }, [busy]);

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
    const transfer = beginTransfer("download", entry.name, true);
    try {
      const target = await api.remoteEditPath(remoteId, entry.path, entry.name);
      await api.sftpDownload(
        remoteId,
        entry.path,
        target,
        updateTransferProgress,
        transfer,
      );
      await api.watchRemoteEdit(remoteId, target, entry.path);
      finishTransfer("complete");
      return target;
    } catch (e) {
      failTransfer(e);
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
   * A double-click does what the entry's own Open action does: enter a folder,
   * or hand a file to its application (a remote one as a watched local copy).
   */
  const activate = (entry: FileEntry) => {
    if (entry.isDir) void load(entry.path);
    else if (!busy) void openEntry(entry);
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
    if (openWithApps.length === 0) return { ...other, icon: "link-external" };
    return {
      label: "Open With",
      icon: "link-external",
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
      ? {
          label: "Open",
          icon: "folder-opened",
          action: () => void load(entry.path),
        }
      : {
          label: "Open",
          icon: "go-to-file",
          disabled: busy,
          action: () => void openEntry(entry),
        },
    ...(entry.isDir ? [] : [openWithMenu(entry)]),
    ...(remote
      ? [
          {
            label: "Download…",
            icon: "cloud-download" as const,
            disabled: busy,
            action: () => void download(entry),
          },
        ]
      : []),
    "separator",
    { label: "Copy Path", icon: "copy", action: () => copyText(entry.path) },
    { label: "Copy Name", icon: "tag", action: () => copyText(entry.name) },
    "separator",
    {
      label: "Delete…",
      icon: "trash",
      danger: true,
      disabled: busy || atDrivesRoot,
      action: () => setPendingDelete(entry),
    },
  ];

  /** Menu for the empty part of the list: actions on the current folder. */
  const folderMenu = (): MenuItem[] => [
    {
      label: "New File…",
      icon: "new-file",
      disabled: busy || !path || atDrivesRoot,
      action: () => setCreating({ kind: "file", name: "" }),
    },
    {
      label: "New Folder…",
      icon: "new-folder",
      disabled: busy || !path || atDrivesRoot,
      action: () => setCreating({ kind: "folder", name: "" }),
    },
    ...(remote
      ? [
          "separator" as const,
          {
            label: "Upload Files…",
            icon: "cloud-upload" as const,
            disabled: busy || !path,
            action: () => void upload(),
          },
          {
            label: "Upload Folder…",
            icon: "cloud-upload" as const,
            disabled: busy || !path,
            action: () => void uploadFolder(),
          },
        ]
      : []),
    "separator",
    {
      label: "Copy Folder Path",
      icon: "copy",
      disabled: !path || atDrivesRoot,
      action: () => copyText(path),
    },
    {
      label: "Refresh",
      icon: "refresh",
      disabled: busy,
      action: () => void load(path),
    },
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
    ? TRANSFER_LABELS[transfer.kind][transfer.status]
    : "";

  const remoteTitle = (label: string) =>
    remote ? label : `${label} (connected SSH sessions only)`;
  // The Windows drive list is virtual: drives can be opened but not created,
  // deleted or navigated above.
  const atDrivesRoot = !remoteId && path === api.LOCAL_DRIVES_ROOT;
  const selectedEntry = entries.find((e) => e.path === selected) ?? null;

  return (
    <div
      ref={panelRef}
      className={`panel filer-panel${dragOver ? (dragOver.accept ? " is-drag-over" : dragOver.reason ? " is-drag-blocked" : "") : ""}`}
      style={{ flex: 1 }}
    >
      <div className="panel-header">
        <div className="panel-title is-filer">
          <Icon name="folder" />
          Filer
          <span className="panel-badge">
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
          <Icon name="new-file" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => setCreating({ kind: "folder", name: "" })}
          title="New folder"
          aria-label="New folder"
          disabled={busy || !path || atDrivesRoot}
        >
          <Icon name="new-folder" />
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
          <Icon name="cloud-upload" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => selectedEntry && void download(selectedEntry)}
          title={remoteTitle("Download file or folder")}
          aria-label="Download file or folder"
          disabled={!remote || !selected || busy}
        >
          <Icon name="cloud-download" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => void load(path)}
          title="Refresh"
          aria-label="Refresh"
          disabled={busy}
        >
          <Icon name="refresh" />
        </button>
        <button
          className="panel-action filer-action filer-action-danger"
          onClick={() => selectedEntry && setPendingDelete(selectedEntry)}
          title="Delete"
          aria-label="Delete"
          disabled={!selected || busy || atDrivesRoot}
        >
          <Icon name="trash" />
        </button>
      </div>
      {uploadMenu && (
        <ContextMenu
          x={uploadMenu.x}
          y={uploadMenu.y}
          items={[
            {
              label: "Upload files…",
              icon: "cloud-upload",
              action: () => void upload(),
            },
            {
              label: "Upload folder…",
              icon: "cloud-upload",
              action: () => void uploadFolder(),
            },
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
          <Icon name="arrow-up" />
        </button>
        <button
          className="panel-action filer-action"
          onClick={() => tab && void revealCwdInFiler(tab.info.id)}
          title={revealKey ? `Terminal folder (${revealKey})` : "Terminal folder"}
          aria-label="Terminal folder"
          disabled={busy || !canReveal}
        >
          <Icon name="target" />
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
        className="panel-body filer-list"
        onContextMenu={(event) => openMenu(event, folderMenu())}
        aria-label={
          remote
            ? `${tab?.info.protocol.toUpperCase()} file list. Drop files or folders here to upload, or drag an entry out of the window to download it.`
            : "Local file list. Drop files or folders here to copy them into this folder, or drag an entry out of the window."
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
              className={`row filer-entry is-${kind}${entry.path === selected ? " is-active" : ""}${dragOut?.path === entry.path ? " is-dragging-out" : ""}`}
              onMouseDown={() => setSelected(entry.path)}
              onPointerDown={(event) => onEntryPointerDown(entry, event)}
              onPointerMove={onEntryPointerMove}
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
          location={remote ? (tab ? tabTitle(tab) : "remote") : "local"}
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
              <span className="filer-transfer-value">
                {transfer.status === "error"
                  ? "Failed"
                  : transfer.status === "cancelled"
                    ? "Cancelled"
                    : transferPercent === null
                      ? formatBytes(transfer.transferred)
                      : `${transferPercent}%`}
              </span>
              {transfer.status === "running" && transfer.cancellable && (
                <button
                  className="panel-action filer-action filer-transfer-cancel"
                  onClick={cancelTransfer}
                  title="Cancel"
                  aria-label={`Cancel: ${transfer.name}`}
                >
                  <Icon name="close" />
                </button>
              )}
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
        ) : dragOver?.accept ? (
          <span className="filer-drop-message">
            {remote
              ? "Drop files or folders to upload"
              : "Drop files or folders to copy here"}
          </span>
        ) : dragOver?.reason ? (
          <span className="filer-drop-blocked">{dragOver.reason}</span>
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

/** Footer wording per transfer kind and state; see `TransferState`. */
const TRANSFER_LABELS: Record<
  TransferState["kind"],
  Record<TransferState["status"], string>
> = {
  upload: {
    running: "Uploading",
    complete: "Upload complete",
    error: "Upload failed",
    cancelled: "Upload cancelled",
  },
  download: {
    running: "Downloading",
    complete: "Download complete",
    error: "Download failed",
    cancelled: "Download cancelled",
  },
  sync: {
    running: "Syncing",
    complete: "Synced",
    error: "Sync failed",
    cancelled: "Sync cancelled",
  },
  copy: {
    running: "Copying",
    complete: "Copy complete",
    error: "Copy failed",
    cancelled: "Copy cancelled",
  },
  stage: {
    running: "Preparing to drag",
    complete: "Ready to drop",
    error: "Could not prepare the drag",
    cancelled: "Drag cancelled",
  },
};

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
