import { create } from "zustand";

import * as api from "./api";
import type { GutterMode } from "./terminal";
import { disposeController } from "./terminalRegistry";
import type {
  OutlineItem,
  SessionInfo,
  SessionProfile,
  SessionState,
} from "./types";

export interface Tab {
  info: SessionInfo;
  state: SessionState;
  message?: string;
  cols: number;
  rows: number;
  cursorLine: number;
  cursorColumn: number;
  outline: OutlineItem[];
}

export type PanelName = "explorer" | "filer" | "sessions" | "outline" | "sender";

interface AppStore {
  profiles: SessionProfile[];
  tabs: Tab[];
  activeId: string | null;
  gutterMode: GutterMode;
  panels: Record<PanelName, boolean>;
  status: string;
  error: string | null;
  log: string[];

  loadProfiles: () => Promise<void>;
  upsertProfile: (profile: SessionProfile) => Promise<SessionProfile>;
  removeProfile: (id: string) => Promise<void>;

  addTab: (info: SessionInfo) => void;
  closeTab: (id: string) => Promise<void>;
  setActive: (id: string) => void;

  applyState: (id: string, state: SessionState, message?: string) => void;
  setSize: (id: string, cols: number, rows: number) => void;
  setCursor: (id: string, line: number, column: number) => void;
  setOutline: (id: string, outline: OutlineItem[]) => void;

  togglePanel: (panel: PanelName) => void;
  setGutterMode: (mode: GutterMode) => void;
  setStatus: (status: string) => void;
  setError: (error: string | null) => void;
  appendLog: (line: string) => void;
}

const patchTab = (tabs: Tab[], id: string, patch: Partial<Tab>): Tab[] =>
  tabs.map((tab) => (tab.info.id === id ? { ...tab, ...patch } : tab));

export const useStore = create<AppStore>((set, get) => ({
  profiles: [],
  tabs: [],
  activeId: null,
  gutterMode: "both",
  panels: {
    explorer: true,
    filer: true,
    sessions: true,
    outline: true,
    sender: true,
  },
  status: "Ready",
  error: null,
  log: [],

  async loadProfiles() {
    set({ profiles: await api.listProfiles() });
  },

  async upsertProfile(profile) {
    const saved = await api.saveProfile(profile);
    const profiles = get().profiles;
    const index = profiles.findIndex((p) => p.id === saved.id);
    set({
      profiles:
        index === -1
          ? [...profiles, saved]
          : profiles.map((p) => (p.id === saved.id ? saved : p)),
    });
    return saved;
  },

  async removeProfile(id) {
    await api.deleteProfile(id);
    set({ profiles: get().profiles.filter((p) => p.id !== id) });
  },

  addTab(info) {
    const tab: Tab = {
      info,
      state: "connected",
      cols: 80,
      rows: 24,
      cursorLine: 1,
      cursorColumn: 1,
      outline: [],
    };
    set({ tabs: [...get().tabs, tab], activeId: info.id });
  },

  async closeTab(id) {
    await api.closeSession(id).catch(() => undefined);
    disposeController(id);
    const remaining = get().tabs.filter((tab) => tab.info.id !== id);
    const wasActive = get().activeId === id;
    set({
      tabs: remaining,
      activeId: wasActive
        ? (remaining[remaining.length - 1]?.info.id ?? null)
        : get().activeId,
    });
  },

  setActive(id) {
    set({ activeId: id });
  },

  applyState(id, state, message) {
    set({ tabs: patchTab(get().tabs, id, { state, message }) });
  },

  setSize(id, cols, rows) {
    set({ tabs: patchTab(get().tabs, id, { cols, rows }) });
  },

  setCursor(id, cursorLine, cursorColumn) {
    set({ tabs: patchTab(get().tabs, id, { cursorLine, cursorColumn }) });
  },

  setOutline(id, outline) {
    set({ tabs: patchTab(get().tabs, id, { outline }) });
  },

  togglePanel(panel) {
    const panels = get().panels;
    set({ panels: { ...panels, [panel]: !panels[panel] } });
  },

  setGutterMode(mode) {
    set({ gutterMode: mode });
  },

  setStatus(status) {
    set({ status });
  },

  setError(error) {
    set({ error });
  },

  appendLog(line) {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    set({ log: [...get().log.slice(-299), `[${stamp}] ${line}`] });
  },
}));

export const useActiveTab = (): Tab | undefined =>
  useStore((s) => s.tabs.find((tab) => tab.info.id === s.activeId));
