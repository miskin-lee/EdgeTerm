import * as api from "./api";
import { commandHistory } from "./history";
import { useStore, type HostKeyPrompt } from "./store";
import { TerminalController } from "./terminal";
import {
  disposeController,
  getController,
  setController,
} from "./terminalRegistry";
import type { SessionInfo, SessionProfile } from "./types";

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
    supportsRemoteFiles: profile.kind === "ssh" || profile.kind === "ftp",
  };
}

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
  useStore.getState().addTab(pendingSessionInfo(id, profile), "connecting");
  if (profile.kind !== "ftp") ensureController(id);
  return connectSession(id, profile);
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
  const label = profile.name || profile.host || profile.portName || "session";

  store.setStatus(`Connecting to ${label}…`);
  store.setError(null);
  store.applyState(id, "connecting");

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
    connectedStore.setStatus(`Connected to ${info.name}`);

    // The pane was fitted while the backend was still connecting, so its
    // first resize command could not be delivered. Re-send the current size.
    if (info.kind !== "ftp") {
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
