import * as api from "./api";
import { commandHistory } from "./history";
import { IS_WINDOWS } from "./platform";
import { tabTitle, useStore, type HostKeyPrompt, type Tab } from "./store";
import { TerminalController } from "./terminal";
import {
  disposeController,
  getController,
  setController,
} from "./terminalRegistry";
import { isFileSession, type SessionInfo, type SessionProfile } from "./types";

/** Line written into a terminal when its session ends, however it ended. */
export const SESSION_CLOSED_NOTICE = "\r\n\x1b[33m[session closed]\x1b[0m\r\n";

function newSessionId(): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `s-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function pendingSessionInfo(
  id: string,
  profile: SessionProfile,
): SessionInfo {
  const name =
    profile.name || profile.host || profile.portName || "session";

  let protocol: string;
  let address: string;
  if (profile.kind === "ssh") {
    protocol = "ssh";
    address = `${profile.host || "localhost"}:${profile.port ?? 22}`;
  } else if (profile.kind === "sftp") {
    protocol = "sftp";
    address = `${profile.host || "localhost"}:${profile.port ?? 22}`;
  } else if (profile.kind === "ftp") {
    protocol = "ftp";
    address = `${profile.host || "localhost"}:${profile.port ?? 21}`;
  } else if (profile.kind === "serial") {
    protocol = "serial";
    address = `${profile.portName || "-"}@${profile.baudRate ?? 115_200}`;
  } else {
    protocol = "shell";
    address = profile.shell || "default shell";
  }

  return {
    id,
    profileId: profile.id || null,
    name,
    kind: profile.kind,
    protocol,
    address,
    color: profile.color ?? null,
    supportsRemoteFiles: profile.kind === "ssh" || isFileSession(profile.kind),
  };
}

/** Tabs whose open_session call has not replied yet; see `connectSession`. */
const pendingConnects = new Set<string>();

/**
 * The history bucket a session's commands belong to, so suggestions can
 * prefer commands seen on the same host. Resolved per call because the tab's
 * info is refined once the backend connects.
 */
function historyHost(id: string): string {
  const tab = useStore.getState().tabs.find((item) => item.info.id === id);
  return tab ? `${tab.info.protocol}:${tab.info.address}` : "";
}

/**
 * Returns the terminal for a session, creating it if needed. Wiring lives here
 * rather than in the React component so a terminal can exist before anything
 * renders.
 */
export function ensureController(id: string): TerminalController {
  const existing = getController(id);
  if (existing) return existing;

  const controller = new TerminalController(
    id,
    {
      onData: (data) => void api.writeSession(id, data).catch(() => undefined),
      onCommand: (command) => commandHistory.record(command, historyHost(id)),
      suggest: (input) => commandHistory.suggest(input, historyHost(id)),
      onResize: (cols, rows) => {
        useStore.getState().setSize(id, cols, rows);
        void api.resizeSession(id, cols, rows).catch(() => undefined);
      },
      onStatus: (message, error = false) => {
        const store = useStore.getState();
        store.setStatus(message);
        if (error) store.setError(message, id);
        else if (store.errorSessionId === id) store.setError(null);
      },
    },
    useStore.getState().bufferFontSize,
    useStore.getState().terminalScrollback,
    useStore.getState().theme,
  );
  controller.setSuggestions(useStore.getState().suggestionsEnabled);
  setController(id, controller);
  return controller;
}

/**
 * Opens a session. The id is minted here and the terminal is created *before*
 * the backend connects, so output emitted during login (an SSH banner, a
 * shell's first prompt) always has somewhere to land.
 */
export async function openSession(
  profile: SessionProfile,
): Promise<string | null> {
  const id = newSessionId();
  useStore
    .getState()
    .addTab(pendingSessionInfo(id, profile), profile, "connecting");
  if (!isFileSession(profile.kind)) ensureController(id);
  return connectSession(id, profile);
}

/**
 * Disconnects a tab's session but keeps the tab, its terminal and its
 * scrollback, so `reconnectSession` can bring it back in place. The backend
 * does not echo a "closed" state for a close it was asked for (see
 * `emit_state` in session/mod.rs), so the tab is marked here.
 */
export async function disconnectSession(id: string): Promise<void> {
  const tab = useStore.getState().tabs.find((item) => item.info.id === id);
  // The backend reports "connected" as soon as the session task starts,
  // which can land before open_session's own reply. Closing in that window
  // would let the late reply mark the tab connected again over a session
  // that is already gone, so wait for the connect to settle first.
  if (!tab || tab.state !== "connected" || pendingConnects.has(id)) return;

  let failure: string | null = null;
  await api.closeSession(id).catch((e) => {
    failure = String(e);
  });

  const store = useStore.getState();
  const current = store.tabs.find((item) => item.info.id === id);
  // The tab may have been closed meanwhile, or the session may have ended on
  // its own while the close was in flight; either way there is nothing left
  // to mark.
  if (!current || current.state !== "connected") return;

  store.applyState(id, "closed", failure ?? "Disconnected");
  // The backend stays silent for a close it was asked for, so echo the same
  // notice into the terminal that a peer-initiated close gets (see App.tsx).
  getController(id)?.writeText(SESSION_CLOSED_NOTICE);
  if (failure) store.setError(failure, id);
  else store.setStatus(`Disconnected from ${tabTitle(current)}`);
}

/**
 * Reconnects a tab whose session ended — by `disconnectSession`, a failed
 * connection, or the peer going away — reusing its terminal so the earlier
 * output stays in the scrollback. Resolves like `openSession`.
 */
export function reconnectSession(id: string): Promise<string | null> {
  const tab = useStore.getState().tabs.find((item) => item.info.id === id);
  if (!tab || (tab.state !== "closed" && tab.state !== "error")) {
    return Promise.resolve(null);
  }
  return connectSession(id, tab.profile);
}

/**
 * The one-button behaviour of a tab's power toggle: a live session is
 * disconnected, an ended one is reconnected, and a session still connecting
 * is left alone.
 */
export function toggleSessionConnection(id: string): void {
  const tab = useStore.getState().tabs.find((item) => item.info.id === id);
  if (!tab) return;
  if (tab.state === "connected") void disconnectSession(id);
  else if (tab.state !== "connecting") void reconnectSession(id);
}

/**
 * Connects the backend session behind an existing tab. Resolves to the tab id
 * once the tab has something to show — a live session, or a changed host key
 * waiting on the user — and to null when the connection failed or the tab
 * was closed meanwhile.
 */
async function connectSession(
  id: string,
  profile: SessionProfile,
): Promise<string | null> {
  const store = useStore.getState();
  const pending = store.tabs.find((item) => item.info.id === id);
  const label = pending
    ? tabTitle(pending)
    : profile.name || profile.host || profile.portName || "session";

  store.setStatus(`Connecting to ${label}…`);
  store.setError(null);
  store.applyState(id, "connecting");

  pendingConnects.add(id);
  try {
    const outcome = await api.openSession(profile, id);

    // The user may close the optimistic tab while SSH is still negotiating.
    // In that case close the newly-created backend session immediately.
    const connectedStore = useStore.getState();
    const tab = connectedStore.tabs.find((item) => item.info.id === id);
    if (!tab) {
      if (outcome.status === "connected") {
        await api.closeSession(id).catch(() => undefined);
      }
      return null;
    }

    if (outcome.status === "hostKeyChanged") {
      // Nothing was opened. Park the tab on the refusal and let the user
      // decide in the host key dialog, which reconnects on accept.
      const { change } = outcome;
      failSession(id, change.message);
      connectedStore.setHostKeyPrompt({ sessionId: id, profile, change });
      return id;
    }

    const { info } = outcome;
    connectedStore.updateTabInfo(id, info);
    connectedStore.applyState(id, "connected");
    connectedStore.setStatus(
      `Connected to ${tabTitle({ info, ordinal: tab.ordinal })}`,
    );

    // The pane was fitted while the backend was still connecting, so its
    // first resize command could not be delivered. Re-send the current size.
    if (!isFileSession(info.kind)) {
      void api.resizeSession(id, tab.cols, tab.rows).catch(() => undefined);
    }
    return id;
  } catch (e) {
    const message = String(e);
    if (useStore.getState().tabs.some((tab) => tab.info.id === id)) {
      failSession(id, message);
    } else {
      disposeController(id);
    }
    return null;
  } finally {
    pendingConnects.delete(id);
  }
}

/** Marks a tab's connection as failed and echoes why into its terminal. */
function failSession(id: string, message: string): void {
  const store = useStore.getState();
  store.applyState(id, "error", message);
  store.setError(message, id);
  store.setStatus(`Failed: ${message}`);
  const terminalMessage = message.replace(/[\x00-\x1f\x7f]/g, " ");
  getController(id)?.writeText(
    `\r\n\x1b[31m[connection failed: ${terminalMessage}]\x1b[0m\r\n`,
  );
}

/**
 * Accepts the key a host now presents — replacing every known_hosts entry for
 * it — and reconnects the tab that was refused. Rejects when known_hosts could
 * not be updated; a failure of the reconnect itself shows on the tab.
 */
export async function acceptHostKey(prompt: HostKeyPrompt): Promise<void> {
  await api.acceptHostKey(prompt.change);
  const store = useStore.getState();
  store.setHostKeyPrompt(null);
  if (!store.tabs.some((tab) => tab.info.id === prompt.sessionId)) return;
  getController(prompt.sessionId)?.writeText(
    `\r\n[accepted new host key ${prompt.change.fingerprint}; reconnecting]\r\n`,
  );
  void connectSession(prompt.sessionId, prompt.profile);
}

// --- Filer: reveal the shell's working directory ----------------------------

let localHostname: Promise<string> | null = null;

function firstLabel(host: string): string {
  return host.toLowerCase().split(".")[0];
}

/**
 * Whether an OSC 7 host names this machine. A remote shell the user ssh'd
 * into by hand from a local tab reports its own host, and that directory
 * must not be looked for in the local Filer.
 */
async function isThisHost(host: string): Promise<boolean> {
  if (host === "" || host === "localhost") return true;
  localHostname ??= api.localHostname().catch(() => "");
  const mine = await localHostname;
  return mine !== "" && firstLabel(host) === firstLabel(mine);
}

/** `/C:/Users/me` from a Windows shell's OSC 7 URL → `C:\Users\me`. */
function localPathFromUrlPath(path: string): string {
  if (!IS_WINDOWS) return path;
  const drive = /^\/([A-Za-z]:)(\/.*)?$/.exec(path);
  if (!drive) return path;
  return `${drive[1]}${(drive[2] ?? "/").replace(/\//g, "\\")}`;
}

/**
 * Where the tab's shell is right now. An SSH shell's own OSC report wins
 * (exact even inside sudo or a nested shell), then the server is asked
 * (`session_cwd`; Linux hosts). A local shell is asked through the OS
 * first — exact, and needing no shell setup — with its OSC report as the
 * fallback where the OS cannot be asked (Windows).
 */
async function shellCwd(tab: Tab): Promise<string> {
  const id = tab.info.id;
  const reported = getController(id)?.reportedCwd ?? null;
  if (tab.info.kind === "ssh") {
    if (reported) return reported.path;
    return api.sessionCwd(id);
  }
  try {
    return await api.sessionCwd(id);
  } catch (error) {
    if (reported && (await isThisHost(reported.host))) {
      return localPathFromUrlPath(reported.path);
    }
    throw error;
  }
}

/**
 * Points the Filer at the directory the session's shell is in — ⌘J /
 * Ctrl+Shift+J, the terminal's context menu and the Filer's locate button
 * all land here. One query per request; nothing follows the shell around.
 */
export async function revealCwdInFiler(id: string): Promise<void> {
  const store = useStore.getState();
  const tab = store.tabs.find((item) => item.info.id === id);
  if (!tab) return;
  if (tab.info.kind !== "local" && tab.info.kind !== "ssh") {
    store.setStatus(
      "Filer: only shell and SSH sessions have a working directory",
    );
    return;
  }
  if (tab.state !== "connected") {
    store.setStatus("Filer: the session is not connected");
    return;
  }
  try {
    const path = await shellCwd(tab);
    useStore.getState().revealInFiler(id, path);
    useStore.getState().setStatus(`Filer: ${path}`);
  } catch (error) {
    useStore.getState().setError(`Filer: ${String(error)}`, id);
  }
}
