import * as api from "./api";
import { useStore } from "./store";
import { TerminalController } from "./terminal";
import {
  disposeController,
  getController,
  setController,
} from "./terminalRegistry";
import type { SessionProfile } from "./types";

function newSessionId(): string {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return `s-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * Returns the terminal for a session, creating it if needed. Wiring lives here
 * rather than in the React component so a terminal can exist before anything
 * renders.
 */
export function ensureController(id: string): TerminalController {
  const existing = getController(id);
  if (existing) return existing;

  const controller = new TerminalController(id, {
    onData: (data) => void api.writeSession(id, data).catch(() => undefined),
    onResize: (cols, rows) => {
      useStore.getState().setSize(id, cols, rows);
      void api.resizeSession(id, cols, rows).catch(() => undefined);
    },
    onCursorMove: (line, column) =>
      useStore.getState().setCursor(id, line, column),
  });
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
  ensureController(id);

  try {
    const info = await api.openSession(profile, id);
    store.addTab(info);
    store.setStatus(`Connected to ${info.name}`);
    return id;
  } catch (e) {
    disposeController(id);
    const message = String(e);
    store.setError(message);
    store.setStatus(`Failed: ${message}`);
    return null;
  }
}
