import { create } from "zustand";

import * as api from "./api";
import { commandHistory } from "./history";
import type { GutterMode } from "./terminal";
import { disposeController, getController } from "./terminalRegistry";
import type {
  HostKeyChange,
  SessionGroup,
  SessionInfo,
  SessionProfile,
  SessionState,
  ThemeMode,
} from "./types";

export interface Tab {
  info: SessionInfo;
  /**
   * The profile the tab was opened with, secrets included, so the session
   * can be reconnected in place. Kept in memory only.
   */
  profile: SessionProfile;
  state: SessionState;
  message?: string;
  cols: number;
  rows: number;
}

/** A refused SSH host key, kept until the user accepts it or gives up. */
export interface HostKeyPrompt {
  sessionId: string;
  /** The profile to reconnect with, secrets included. */
  profile: SessionProfile;
  change: HostKeyChange;
}

export type PanelName = "filer" | "sessions" | "sender";

export const PANEL_FONT_SIZE = { min: 9, max: 18, default: 12 } as const;
export const BUFFER_FONT_SIZE = { min: 8, max: 32, default: 13 } as const;
export const TERMINAL_SCROLLBACK = {
  min: 0,
  max: 1_000_000,
  default: 20_000,
} as const;
const DEFAULT_PANELS: Record<PanelName, boolean> = {
  filer: true,
  sessions: true,
  sender: true,
};

const PANEL_FONT_SIZE_KEY = "edgeterm.panelFontSize";
const BUFFER_FONT_SIZE_KEY = "edgeterm.bufferFontSize";
const TERMINAL_SCROLLBACK_KEY = "edgeterm.terminalScrollback";
const GUTTER_MODE_KEY = "edgeterm.gutterMode";
const PANELS_KEY = "edgeterm.panels";
const THEME_KEY = "edgeterm.theme";
const SUGGESTIONS_KEY = "edgeterm.suggestions";

// Opt-in: command capture and the completion popup stay off until the user
// enables them in the Edit menu.
const loadSuggestionsEnabled = (): boolean => {
  try {
    return localStorage.getItem(SUGGESTIONS_KEY) === "on";
  } catch {
    return false;
  }
};

// The parse* helpers validate a stored or imported value and return null for
// anything unknown, so both localStorage and a data file get the same checks.
const parseTheme = (value: unknown): ThemeMode | null =>
  value === "dark" || value === "light" ? value : null;

const parseGutterMode = (value: unknown): GutterMode | null =>
  value === "both" || value === "line" || value === "time" || value === "off"
    ? value
    : null;

/** Fills fields missing from `value` with `base`; null if it is no object. */
const parsePanels = (
  value: unknown,
  base: Record<PanelName, boolean>,
): Record<PanelName, boolean> | null => {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<Record<PanelName, unknown>>;
  return {
    filer: typeof parsed.filer === "boolean" ? parsed.filer : base.filer,
    sessions:
      typeof parsed.sessions === "boolean" ? parsed.sessions : base.sessions,
    sender: typeof parsed.sender === "boolean" ? parsed.sender : base.sender,
  };
};

export const loadTheme = (): ThemeMode => {
  try {
    return parseTheme(localStorage.getItem(THEME_KEY)) ?? "dark";
  } catch {
    // Use the default when storage is unavailable.
    return "dark";
  }
};

const loadPanels = (): Record<PanelName, boolean> => {
  try {
    const stored = localStorage.getItem(PANELS_KEY);
    if (stored) {
      const panels = parsePanels(JSON.parse(stored), DEFAULT_PANELS);
      if (panels) return panels;
    }
  } catch {
    // Use the defaults when storage is unavailable or malformed.
  }
  return { ...DEFAULT_PANELS };
};

const savePanels = (panels: Record<PanelName, boolean>) => {
  try {
    localStorage.setItem(PANELS_KEY, JSON.stringify(panels));
  } catch {
    // The setting still applies for this run when storage is unavailable.
  }
};

const loadGutterMode = (): GutterMode => {
  try {
    return parseGutterMode(localStorage.getItem(GUTTER_MODE_KEY)) ?? "both";
  } catch {
    // Use the default when storage is unavailable.
    return "both";
  }
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

const normalizeScrollback = (value: number) => {
  if (!Number.isFinite(value)) return TERMINAL_SCROLLBACK.default;
  return Math.min(
    TERMINAL_SCROLLBACK.max,
    Math.max(TERMINAL_SCROLLBACK.min, Math.round(value)),
  );
};

const loadScrollback = () => {
  try {
    const stored = localStorage.getItem(TERMINAL_SCROLLBACK_KEY);
    return stored === null
      ? TERMINAL_SCROLLBACK.default
      : normalizeScrollback(Number(stored));
  } catch {
    return TERMINAL_SCROLLBACK.default;
  }
};

const saveScrollback = (value: number) => {
  try {
    localStorage.setItem(TERMINAL_SCROLLBACK_KEY, String(value));
  } catch {
    // The setting still works for this run when storage is unavailable.
  }
};

/**
 * The preferences a data export carries (Session → Export Data…). Everything
 * here lives in localStorage; saved sessions and Sender tags come from the
 * backend instead.
 */
export interface AppSettings {
  panels: Record<PanelName, boolean>;
  gutterMode: GutterMode;
  theme: ThemeMode;
  panelFontSize: number;
  bufferFontSize: number;
  terminalScrollback: number;
  suggestionsEnabled: boolean;
}

interface AppStore {
  profiles: SessionProfile[];
  /** User-defined folders of the Session panel; see `SessionGroup`. */
  groups: SessionGroup[];
  tabs: Tab[];
  activeId: string | null;
  gutterMode: GutterMode;
  theme: ThemeMode;
  panelFontSize: number;
  bufferFontSize: number;
  terminalScrollback: number;
  /** Command history recording + fish-style inline suggestions. */
  suggestionsEnabled: boolean;
  panels: Record<PanelName, boolean>;
  status: string;
  error: string | null;
  errorSessionId: string | null;
  /**
   * A refused SSH host key awaiting the user's decision. It lives in the
   * store so the dialog is shown from App no matter which UI started the
   * connection.
   */
  hostKeyPrompt: HostKeyPrompt | null;
  /**
   * Id of a live tab whose close is waiting for the user's confirmation.
   * Kept in the store so every close entry point (tab ✕, menu, ⌘W) funnels
   * into the one dialog rendered by App.
   */
  closePrompt: string | null;
  /**
   * Bumped whenever saved Sender tags change outside the Sender panel (a data
   * import, a deleted profile or group moving their scoped commands), so the
   * panel reloads its library.
   */
  senderLibraryVersion: number;

  /** Fetches saved profiles and their groups together. */
  loadProfiles: () => Promise<void>;
  upsertProfile: (profile: SessionProfile) => Promise<SessionProfile>;
  /** Deletes a saved profile with everything that belongs to it. */
  removeProfile: (id: string) => Promise<void>;
  /** Moves a saved profile into a group (null = its kind's root). */
  moveProfileToGroup: (id: string, groupId: string | null) => Promise<void>;

  upsertGroup: (group: SessionGroup) => Promise<SessionGroup>;
  /**
   * Deletes a group with everything in it (subgroups, their sessions and
   * scoped Sender commands); profiles are reloaded to drop the removed ones.
   */
  removeGroup: (id: string) => Promise<void>;

  addTab: (info: SessionInfo, profile: SessionProfile, state?: SessionState) => void;
  updateTabInfo: (id: string, info: SessionInfo) => void;
  closeTab: (id: string) => Promise<void>;
  /**
   * Closes a tab, asking first while its session is still connecting or
   * connected. Tabs that already ended (closed / error) have nothing left to
   * lose and close immediately.
   */
  requestCloseTab: (id: string) => void;
  setClosePrompt: (id: string | null) => void;
  setActive: (id: string) => void;
  activateAdjacentTab: (direction: -1 | 1) => void;

  applyState: (id: string, state: SessionState, message?: string) => void;
  setSize: (id: string, cols: number, rows: number) => void;

  togglePanel: (panel: PanelName) => void;
  setGutterMode: (mode: GutterMode) => void;
  setTheme: (theme: ThemeMode) => void;
  setPanelFontSize: (size: number) => void;
  setBufferFontSize: (size: number) => void;
  setTerminalScrollback: (rows: number) => void;
  setSuggestionsEnabled: (enabled: boolean) => void;
  resetSettings: () => void;
  /** The preferences a data export carries; see `applySettings`. */
  exportSettings: () => AppSettings;
  /**
   * Applies settings from a data import. Unknown or malformed fields are
   * ignored; fields the file does not mention keep their current value.
   */
  applySettings: (settings: unknown) => void;
  bumpSenderLibrary: () => void;
  setStatus: (status: string) => void;
  setError: (error: string | null, sessionId?: string) => void;
  setHostKeyPrompt: (prompt: HostKeyPrompt | null) => void;
}

const patchTab = (tabs: Tab[], id: string, patch: Partial<Tab>): Tab[] =>
  tabs.map((tab) => (tab.info.id === id ? { ...tab, ...patch } : tab));

export const useStore = create<AppStore>((set, get) => ({
  profiles: [],
  groups: [],
  tabs: [],
  activeId: null,
  gutterMode: loadGutterMode(),
  theme: loadTheme(),
  panelFontSize: loadFontSize(PANEL_FONT_SIZE_KEY, PANEL_FONT_SIZE),
  bufferFontSize: loadFontSize(BUFFER_FONT_SIZE_KEY, BUFFER_FONT_SIZE),
  terminalScrollback: loadScrollback(),
  suggestionsEnabled: loadSuggestionsEnabled(),
  panels: loadPanels(),
  status: "Ready",
  error: null,
  errorSessionId: null,
  hostKeyPrompt: null,
  closePrompt: null,
  senderLibraryVersion: 0,

  async loadProfiles() {
    const [profiles, groups] = await Promise.all([
      api.listProfiles(),
      api.listSessionGroups(),
    ]);
    set({ profiles, groups });
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
    // Sender commands scoped to the profile went with it.
    get().bumpSenderLibrary();
  },

  async moveProfileToGroup(id, groupId) {
    const profile = get().profiles.find((p) => p.id === id);
    if (!profile || (profile.groupId ?? null) === groupId) return;
    await get().upsertProfile({ ...profile, groupId });
  },

  async upsertGroup(group) {
    const saved = await api.saveSessionGroup(group);
    const groups = get().groups;
    const index = groups.findIndex((g) => g.id === saved.id);
    set({
      groups:
        index === -1
          ? [...groups, saved]
          : groups.map((g) => (g.id === saved.id ? saved : g)),
    });
    return saved;
  },

  async removeGroup(id) {
    await api.deleteSessionGroup(id);
    await get().loadProfiles();
    // Sender commands scoped to the subtree moved up a level in the backend.
    get().bumpSenderLibrary();
  },

  addTab(info, profile, state = "connected") {
    const tab: Tab = {
      info,
      profile,
      state,
      cols: 80,
      rows: 24,
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
      hostKeyPrompt:
        current.hostKeyPrompt?.sessionId === id ? null : current.hostKeyPrompt,
      closePrompt: current.closePrompt === id ? null : current.closePrompt,
    });
  },

  requestCloseTab(id) {
    const tab = get().tabs.find((item) => item.info.id === id);
    if (!tab) return;
    if (tab.state === "closed" || tab.state === "error") {
      void get().closeTab(id);
      return;
    }
    set({ closePrompt: id });
  },

  setClosePrompt(id) {
    set({ closePrompt: id });
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
    // An ended session has nothing to type into; lock its terminal until a
    // reconnect brings it back.
    getController(id)?.setLocked(state === "closed" || state === "error");
  },

  setSize(id, cols, rows) {
    set({ tabs: patchTab(get().tabs, id, { cols, rows }) });
  },

  togglePanel(panel) {
    const panels = get().panels;
    const nextPanels = { ...panels, [panel]: !panels[panel] };
    set({ panels: nextPanels });
    savePanels(nextPanels);
  },

  setGutterMode(mode) {
    set({ gutterMode: mode });
    try {
      localStorage.setItem(GUTTER_MODE_KEY, mode);
    } catch {
      // The setting still applies for this run when storage is unavailable.
    }
  },

  setTheme(theme) {
    set({ theme });
    try {
      localStorage.setItem(THEME_KEY, theme);
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

  setTerminalScrollback(rows) {
    const terminalScrollback = normalizeScrollback(rows);
    set({ terminalScrollback });
    saveScrollback(terminalScrollback);
  },

  setSuggestionsEnabled(enabled) {
    set({ suggestionsEnabled: enabled });
    // The history is only fetched once someone opts in (load() is a no-op on
    // repeat calls).
    if (enabled) commandHistory.load();
    try {
      localStorage.setItem(SUGGESTIONS_KEY, enabled ? "on" : "off");
    } catch {
      // The setting still applies for this run when storage is unavailable.
    }
  },

  resetSettings() {
    set({
      panels: { ...DEFAULT_PANELS },
      gutterMode: "both",
      theme: "dark",
      panelFontSize: PANEL_FONT_SIZE.default,
      bufferFontSize: BUFFER_FONT_SIZE.default,
      terminalScrollback: TERMINAL_SCROLLBACK.default,
      suggestionsEnabled: false,
    });
    try {
      localStorage.removeItem(PANELS_KEY);
      localStorage.removeItem(GUTTER_MODE_KEY);
      localStorage.removeItem(THEME_KEY);
      localStorage.removeItem(PANEL_FONT_SIZE_KEY);
      localStorage.removeItem(BUFFER_FONT_SIZE_KEY);
      localStorage.removeItem(TERMINAL_SCROLLBACK_KEY);
      localStorage.removeItem(SUGGESTIONS_KEY);
    } catch {
      // The defaults still apply for this run when storage is unavailable.
    }
  },

  exportSettings() {
    const state = get();
    return {
      panels: { ...state.panels },
      gutterMode: state.gutterMode,
      theme: state.theme,
      panelFontSize: state.panelFontSize,
      bufferFontSize: state.bufferFontSize,
      terminalScrollback: state.terminalScrollback,
      suggestionsEnabled: state.suggestionsEnabled,
    };
  },

  applySettings(settings) {
    if (!settings || typeof settings !== "object") return;
    const values = settings as Partial<Record<keyof AppSettings, unknown>>;
    const state = get();
    // Each setter validates and persists the way the menus do, so a partial
    // or hand-edited file can only ever change the fields it names.
    const theme = parseTheme(values.theme);
    if (theme) state.setTheme(theme);
    const gutterMode = parseGutterMode(values.gutterMode);
    if (gutterMode) state.setGutterMode(gutterMode);
    const panels = parsePanels(values.panels, state.panels);
    if (panels) {
      set({ panels });
      savePanels(panels);
    }
    if (typeof values.panelFontSize === "number") {
      state.setPanelFontSize(values.panelFontSize);
    }
    if (typeof values.bufferFontSize === "number") {
      state.setBufferFontSize(values.bufferFontSize);
    }
    if (typeof values.terminalScrollback === "number") {
      state.setTerminalScrollback(values.terminalScrollback);
    }
    if (typeof values.suggestionsEnabled === "boolean") {
      state.setSuggestionsEnabled(values.suggestionsEnabled);
    }
  },

  bumpSenderLibrary() {
    set({ senderLibraryVersion: get().senderLibraryVersion + 1 });
  },

  setStatus(status) {
    set({ status });
  },

  setError(error, sessionId) {
    set({ error, errorSessionId: error ? (sessionId ?? null) : null });
  },

  setHostKeyPrompt(prompt) {
    set({ hostKeyPrompt: prompt });
  },
}));

export const useActiveTab = (): Tab | undefined =>
  useStore((s) => s.tabs.find((tab) => tab.info.id === s.activeId));
