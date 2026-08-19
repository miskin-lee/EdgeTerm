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

export const PANEL_FONT_SIZE = { min: 9, max: 18, default: 12 } as const;
export const BUFFER_FONT_SIZE = { min: 8, max: 32, default: 13 } as const;
const DEFAULT_PANELS: Record<PanelName, boolean> = {
  filer: true,
  sessions: true,
  sender: true,
};

const PANEL_FONT_SIZE_KEY = "edgeterm.panelFontSize";
const BUFFER_FONT_SIZE_KEY = "edgeterm.bufferFontSize";
const GUTTER_MODE_KEY = "edgeterm.gutterMode";
const PANELS_KEY = "edgeterm.panels";

const loadPanels = (): Record<PanelName, boolean> => {
  try {
    const stored = localStorage.getItem(PANELS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<Record<PanelName, unknown>>;
      return {
        filer:
          typeof parsed.filer === "boolean"
            ? parsed.filer
            : DEFAULT_PANELS.filer,
        sessions:
          typeof parsed.sessions === "boolean"
            ? parsed.sessions
            : DEFAULT_PANELS.sessions,
        sender:
          typeof parsed.sender === "boolean"
            ? parsed.sender
            : DEFAULT_PANELS.sender,
      };
    }
  } catch {
    // Use the defaults when storage is unavailable or malformed.
  }
  return { ...DEFAULT_PANELS };
};

const loadGutterMode = (): GutterMode => {
  try {
    const stored = localStorage.getItem(GUTTER_MODE_KEY);
    if (
      stored === "both" ||
      stored === "line" ||
      stored === "time" ||
      stored === "off"
    ) {
      return stored;
    }
  } catch {
    // Use the default when storage is unavailable.
  }
  return "both";
};

const normalizeFontSize = (
  value: number,
  range: { min: number; max: number; default: number },
) => {
  if (!Number.isFinite(value)) return range.default;
  return Math.min(range.max, Math.max(range.min, Math.round(value)));
};

const loadFontSize = (
  key: string,
  range: { min: number; max: number; default: number },
) => {
  try {
    const stored = localStorage.getItem(key);
    return stored === null
      ? range.default
      : normalizeFontSize(Number(stored), range);
  } catch {
    return range.default;
  }
};

const saveFontSize = (key: string, value: number) => {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // Font settings still work for this run when storage is unavailable.
  }
};

interface AppStore {
  profiles: SessionProfile[];
  tabs: Tab[];
  activeId: string | null;
  gutterMode: GutterMode;
  panelFontSize: number;
  bufferFontSize: number;
  panels: Record<PanelName, boolean>;
  status: string;
  error: string | null;
  errorSessionId: string | null;

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
  setPanelFontSize: (size: number) => void;
  setBufferFontSize: (size: number) => void;
  resetSettings: () => void;
  setStatus: (status: string) => void;
  setError: (error: string | null, sessionId?: string) => void;
}

const patchTab = (tabs: Tab[], id: string, patch: Partial<Tab>): Tab[] =>
  tabs.map((tab) => (tab.info.id === id ? { ...tab, ...patch } : tab));

export const useStore = create<AppStore>((set, get) => ({
  profiles: [],
  tabs: [],
  activeId: null,
  gutterMode: loadGutterMode(),
  panelFontSize: loadFontSize(PANEL_FONT_SIZE_KEY, PANEL_FONT_SIZE),
  bufferFontSize: loadFontSize(BUFFER_FONT_SIZE_KEY, BUFFER_FONT_SIZE),
  panels: loadPanels(),
  status: "Ready",
  error: null,
  errorSessionId: null,

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
    const current = get();
    const remaining = current.tabs.filter((tab) => tab.info.id !== id);
    const wasActive = current.activeId === id;
    const clearsSessionError = current.errorSessionId === id;
    set({
      tabs: remaining,
      activeId: wasActive
        ? (remaining[remaining.length - 1]?.info.id ?? null)
        : current.activeId,
      status: clearsSessionError ? "Ready" : current.status,
      error: clearsSessionError ? null : current.error,
      errorSessionId: clearsSessionError ? null : current.errorSessionId,
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
    const nextPanels = { ...panels, [panel]: !panels[panel] };
    set({ panels: nextPanels });
    try {
      localStorage.setItem(PANELS_KEY, JSON.stringify(nextPanels));
    } catch {
      // The setting still applies for this run when storage is unavailable.
    }
  },

  setGutterMode(mode) {
    set({ gutterMode: mode });
    try {
      localStorage.setItem(GUTTER_MODE_KEY, mode);
    } catch {
      // The setting still applies for this run when storage is unavailable.
    }
  },

  setPanelFontSize(size) {
    const panelFontSize = normalizeFontSize(size, PANEL_FONT_SIZE);
    set({ panelFontSize });
    saveFontSize(PANEL_FONT_SIZE_KEY, panelFontSize);
  },

  setBufferFontSize(size) {
    const bufferFontSize = normalizeFontSize(size, BUFFER_FONT_SIZE);
    set({ bufferFontSize });
    saveFontSize(BUFFER_FONT_SIZE_KEY, bufferFontSize);
  },

  resetSettings() {
    set({
      panels: { ...DEFAULT_PANELS },
      gutterMode: "both",
      panelFontSize: PANEL_FONT_SIZE.default,
      bufferFontSize: BUFFER_FONT_SIZE.default,
    });
    try {
      localStorage.removeItem(PANELS_KEY);
      localStorage.removeItem(GUTTER_MODE_KEY);
      localStorage.removeItem(PANEL_FONT_SIZE_KEY);
      localStorage.removeItem(BUFFER_FONT_SIZE_KEY);
    } catch {
      // The defaults still apply for this run when storage is unavailable.
    }
  },

  setStatus(status) {
    set({ status });
  },

  setError(error, sessionId) {
    set({ error, errorSessionId: error ? (sessionId ?? null) : null });
  },
}));

export const useActiveTab = (): Tab | undefined =>
  useStore((s) => s.tabs.find((tab) => tab.info.id === s.activeId));
