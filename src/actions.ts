import * as api from "./api";
import { useStore } from "./store";
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
      onResize: (cols, rows) => {
        useStore.getState().setSize(id, cols, rows);
        void api.resizeSession(id, cols, rows).catch(() => undefined);
      },
      onCursorMove: (line, column) =>
        useStore.getState().setCursor(id, line, column),
      onStatus: (message, error = false) => {
        const store = useStore.getState();
        store.setStatus(message);
        if (error) store.setError(message, id);
        else if (store.errorSessionId === id) store.setError(null);
      },
    },
    useStore.getState().bufferFontSize,
  );
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
  const store = useStore.getState();
  const id = newSessionId();
  const label = profile.name || profile.host || profile.portName || "session";

  store.setStatus(`Connecting to ${label}…`);
  store.setError(null);
  store.addTab(pendingSessionInfo(id, profile), "connecting");
  if (profile.kind !== "ftp") ensureController(id);

  try {
    const info = await api.openSession(profile, id);

    // The user may close the optimistic tab while SSH is still negotiating.
    // In that case close the newly-created backend session immediately.
    const connectedStore = useStore.getState();
    const tab = connectedStore.tabs.find((item) => item.info.id === id);
    if (!tab) {
      await api.closeSession(id).catch(() => undefined);
      return null;
    }

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
    const failedStore = useStore.getState();
    if (failedStore.tabs.some((tab) => tab.info.id === id)) {
      const terminalMessage = message.replace(/[\x00-\x1f\x7f]/g, " ");
      failedStore.applyState(id, "error", message);
      failedStore.setError(message, id);
      failedStore.setStatus(`Failed: ${message}`);
      getController(id)?.writeText(
        `\r\n\x1b[31m[connection failed: ${terminalMessage}]\x1b[0m\r\n`,
      );
    } else {
      disposeController(id);
    }
    return null;
  }
}
