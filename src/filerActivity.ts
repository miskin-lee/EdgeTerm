import { useSyncExternalStore } from "react";

import * as api from "./api";
import { useStore } from "./store";

export interface FilerTransferState {
  // Sync is an editor save sent back to the server; stage is the temporary
  // download needed by a Windows/Linux drag out; copy is a local file drop.
  kind: "upload" | "download" | "sync" | "stage" | "copy";
  name: string;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  status: "running" | "complete" | "error" | "cancelled";
  cancellable: boolean;
}

interface ActivityState {
  working: boolean;
  error: string | null;
  transfer: FilerTransferState | null;
}

const EMPTY: ActivityState = { working: false, error: null, transfer: null };
const activities = new Map<string, FilerActivity>();
const syncs = new Map<string, FilerTransfer>();

/** One Filer source: an SSH session id, or "" for the local filesystem. */
export class FilerActivity {
  private state = EMPTY;
  private listeners = new Set<() => void>();
  private current: FilerTransfer | null = null;
  private clearTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private workSerial = 0;

  constructor(readonly source: string) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(patch: Partial<ActivityState>) {
    if (this.disposed) return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  setError = (error: string | null) => this.update({ error });

  /** Only the latest directory request may finish the current busy state. */
  beginWork() {
    const serial = ++this.workSerial;
    const current = () => !this.disposed && serial === this.workSerial;
    this.update({ working: true });
    return {
      current,
      finish: () => {
        if (current()) this.update({ working: false });
      },
    };
  }

  beginTransfer(
    kind: FilerTransferState["kind"],
    name: string,
    cancellable = false,
  ) {
    const transfer = new FilerTransfer(
      this,
      cancellable ? api.newTransferId() : undefined,
    );
    if (
      this.disposed ||
      (this.source && !useStore.getState().tabs.some(
        (tab) => tab.info.id === this.source && tab.state === "connected",
      ))
    ) return transfer;
    this.stopTimer();
    this.current = transfer;
    this.update({
      transfer: {
        kind,
        name,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
        status: "running",
        cancellable,
      },
    });
    return transfer;
  }

  owns(transfer: FilerTransfer) {
    return !this.disposed && this.current === transfer;
  }
  running(transfer: FilerTransfer) {
    return this.owns(transfer) && this.state.transfer?.status === "running";
  }
  progress(
    transfer: FilerTransfer,
    progress: api.TransferProgress,
    bytesPerSecond: number,
  ) {
    if (!this.running(transfer) || !this.state.transfer) return;
    this.update({
      transfer: { ...this.state.transfer, ...progress, bytesPerSecond },
    });
  }
  finish(
    transfer: FilerTransfer,
    status: FilerTransferState["status"],
    error?: string,
  ) {
    if (!this.owns(transfer) || !this.state.transfer) return;
    const current = this.state.transfer;
    this.update({
      ...(error === undefined ? {} : { error }),
      transfer: {
        ...current,
        status,
        transferred:
          status === "complete" && current.total > 0
            ? current.total
            : current.transferred,
      },
    });
    this.stopTimer();
    this.clearTimer = setTimeout(
      () => {
        this.clearTimer = null;
        if (this.owns(transfer)) this.update({ transfer: null });
      },
      status === "error" ? 3000 : 1800,
    );
  }
  cancelTransfer = () => this.current?.cancel();

  /** Disconnect/close invalidates every pending callback, even if IPC never returns. */
  clear(dispose = false) {
    this.workSerial += 1;
    this.current?.cancel();
    this.current = null;
    this.stopTimer();
    if (this.state.working || this.state.error || this.state.transfer) {
      this.update(EMPTY);
    }
    this.disposed = dispose;
  }
  private stopTimer() {
    if (this.clearTimer !== null) clearTimeout(this.clearTimer);
    this.clearTimer = null;
  }
}

/** Callbacks belong to one transfer, so late output cannot update its replacement. */
export class FilerTransfer {
  cancelled = false;
  private samples = [{ time: performance.now(), transferred: 0 }];
  private started = false;

  constructor(
    private activity: FilerActivity,
    private transferId?: string,
  ) {}

  /** Marks the IPC copy as started and supplies its cancellation id. */
  start() {
    this.check();
    this.started = true;
    return this.transferId;
  }

  get active() {
    const source = this.activity.source;
    const connected = !source ||
      useStore.getState().tabs.some(
        (tab) => tab.info.id === source && tab.state === "connected",
      );
    return !this.cancelled && this.activity.owns(this) && connected;
  }
  check = () => {
    if (!this.active) {
      throw new Error("transfer cancelled");
    }
  };
  progress = (progress: api.TransferProgress) => {
    const now = performance.now();
    const samples = this.samples;
    const latest = samples[samples.length - 1];
    if (progress.transferred < latest.transferred) {
      samples.splice(0, samples.length, {
        time: now, transferred: progress.transferred,
      });
    } else if (
      progress.transferred !== latest.transferred || now - latest.time >= 250
    ) {
      samples.push({ time: now, transferred: progress.transferred });
    }
    while (samples.length > 2 && samples[1].time <= now - 1000) samples.shift();
    const elapsedSeconds = (now - samples[0].time) / 1000;
    const rate = elapsedSeconds > 0
      ? Math.max(
          0,
          (progress.transferred - samples[0].transferred) / elapsedSeconds,
        )
      : 0;
    this.activity.progress(this, progress, rate);
  };
  complete = () => {
    this.check();
    this.activity.finish(this, "complete");
  };
  fail = (error: unknown) => {
    if (!this.cancelled) this.activity.finish(this, "error", String(error));
  };
  cancel = () => {
    if (this.cancelled || !this.activity.running(this)) return;
    this.cancelled = true;
    if (this.started && this.transferId) {
      void api.cancelTransfer(this.transferId).catch(() => {});
    }
    // Do not wait for a stalled network read before removing the running UI.
    this.activity.finish(this, "cancelled");
  };
}

export const filerActivity = (source: string) => {
  let activity = activities.get(source);
  if (!activity) {
    activity = new FilerActivity(source);
    activities.set(source, activity);
  }
  return activity;
};

export function useFilerActivity(source: string) {
  const activity = filerActivity(source);
  const state = useSyncExternalStore(activity.subscribe, activity.getSnapshot);
  const busy = state.working || (
    state.transfer?.status === "running" && state.transfer.kind !== "sync"
  );
  return { activity, ...state, busy };
}

// The panel may be hidden or moved to another dock. Its transfers and cleanup
// still belong to the session and must outlive the React component.
useStore.subscribe((state) => {
  const tabs = new Map(state.tabs.map((tab) => [tab.info.id, tab]));
  for (const [source, activity] of activities) {
    if (!source) continue;
    const tab = tabs.get(source);
    if (!tab || tab.state !== "connected") activity.clear(!tab);
    if (!tab) activities.delete(source);
  }
  for (const key of syncs.keys()) {
    const transfer = syncs.get(key)!;
    if (!transfer.active) syncs.delete(key);
  }
});

export const remoteEditActivity = (event: api.RemoteEditEvent) => {
  const connected = useStore.getState().tabs.some(
    (tab) => tab.info.id === event.sessionId && tab.state === "connected",
  );
  if (!connected) return;
  const activity = filerActivity(event.sessionId);
  const key = `${event.sessionId}:${event.remotePath}`;
  if (event.status === "uploading") {
    const current = activity.getSnapshot().transfer;
    // An automatic save must not replace the Cancel button of a manual copy.
    if (current?.status === "running" && current.kind !== "sync") return;
    syncs.set(key, activity.beginTransfer("sync", event.name));
  } else {
    const transfer = syncs.get(key);
    syncs.delete(key);
    if (event.status === "synced") {
      if (transfer && activity.owns(transfer)) transfer.complete();
    } else {
      const error = `${event.name}: ${event.message ?? (event.status === "kept" ? "local copy kept" : "sync failed")}`;
      if (transfer && activity.owns(transfer)) transfer.fail(error);
      else activity.setError(error);
    }
  }
};

// Keep receiving completions while the Filer is hidden, too.
void api.onRemoteEditState(remoteEditActivity).catch(() => {});
