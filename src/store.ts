import { create } from "zustand";

import * as api from "./api";
import type { GutterMode } from "./terminal";
import { disposeController } from "./terminalRegistry";
import type { SessionInfo, SessionProfile, SessionState } from "./types";

export interface Tab {
  info: SessionInfo;
  state: SessionState;
  message?: string;
  cols: number;
  rows: number;
  cursorLine: number;
  cursorColumn: number;
}

export type PanelName = "filer" | "sessions" | "sender";

interface AppStore {
  profiles: SessionProfile[];
  tabs: Tab[];
  activeId: string | null;
  gutterMode: GutterMode;
  panels: Record<PanelName, boolean>;
  status: string;
  error: string | null;

  loadProfiles: () => Promise<void>;
  upsertProfile: (profile: SessionProfile) => Promise<SessionProfile>;
  removeProfile: (id: string) => Promise<void>;

  addTab: (info: SessionInfo, state?: SessionState) => void;
  updateTabInfo: (id: string, info: SessionInfo) => void;
  closeTab: (id: string) => Promise<void>;
  setActive: (id: string) => void;
  activateAdjacentTab: (direction: -1 | 1) => void;

  applyState: (id: string, state: SessionState, message?: string) => void;
  setSize: (id: string, cols: number, rows: number) => void;
  setCursor: (id: string, line: number, column: number) => void;

  togglePanel: (panel: PanelName) => void;
  setGutterMode: (mode: GutterMode) => void;
  setStatus: (status: string) => void;
  setError: (error: string | null) => void;
}

const patchTab = (tabs: Tab[], id: string, patch: Partial<Tab>): Tab[] =>
  tabs.map((tab) => (tab.info.id === id ? { ...tab, ...patch } : tab));

export const useStore = create<AppStore>((set, get) => ({
  profiles: [],
  tabs: [],
  activeId: null,
  gutterMode: "both",
  panels: {
    filer: true,
    sessions: true,
    sender: true,
  },
  status: "Ready",
  error: null,

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

  addTab(info, state = "connected") {
    const tab: Tab = {
      info,
      state,
      cols: 80,
      rows: 24,
      cursorLine: 1,
      cursorColumn: 1,
    };
    set({ tabs: [...get().tabs, tab], activeId: info.id });
  },

  updateTabInfo(id, info) {
    set({
      tabs: get().tabs.map((tab) =>
        tab.info.id === id ? { ...tab, info } : tab,
      ),
    });
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

  activateAdjacentTab(direction) {
    const { tabs, activeId } = get();
    if (tabs.length === 0) return;

    const activeIndex = tabs.findIndex((tab) => tab.info.id === activeId);
    const startIndex = activeIndex === -1 ? (direction > 0 ? -1 : 0) : activeIndex;
    const nextIndex = (startIndex + direction + tabs.length) % tabs.length;
    set({ activeId: tabs[nextIndex].info.id });
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
}));

export const useActiveTab = (): Tab | undefined =>
  useStore((s) => s.tabs.find((tab) => tab.info.id === s.activeId));
