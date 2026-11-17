import type { TerminalController } from "./terminal";
import type { TmuxLayout } from "./tmuxProtocol";
import type { SessionState } from "./types";

export interface TmuxWindow {
  id: string;
  name: string;
  layout: TmuxLayout;
  fullLayout: TmuxLayout;
  activePane: string;
}

export interface TmuxSnapshot {
  windows: TmuxWindow[];
  activeWindow: string;
  activePane: string;
  connected: boolean;
  error: string | null;
}

/** A small shell-facing interface; protocol and xterm stay in the lazy bundle. */
export interface TmuxSessionBridge {
  snapshot(): TmuxSnapshot | null;
  subscribe(listener: () => void): () => void;
  receive(bytes: Uint8Array): void;
  write(text: string): Promise<void>;
  writePane(id: string, text: string): Promise<void>;
  activeController(): TerminalController | undefined;
  stateChanged(state: SessionState): void;
  selectWindow(id: string): void;
  selectPane(id: string): void;
  newWindow(): Promise<void>;
  split(side: "right" | "down"): Promise<void>;
  resizeWindow(id: string, cols: number, rows: number): void;
  resizePane(id: string, direction: "row" | "column", delta: number): void;
  closePane(id?: string): Promise<void>;
  detach(): Promise<void>;
  cwd(): Promise<string>;
  paneControllerId(id: string): string;
  dispose(): void;
}

const sessions = new Map<string, TmuxSessionBridge>();
const listeners = new Set<() => void>();
export const getTmux = (id: string) => sessions.get(id);
export function setTmux(id: string, session: TmuxSessionBridge) {
  sessions.set(id, session);
  for (const listener of listeners) listener();
}
export function deleteTmux(id: string) {
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  session?.dispose();
  for (const listener of listeners) listener();
}
export function subscribeTmux(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
