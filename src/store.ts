import { create } from "zustand";

import * as api from "./api";
import { commandHistory } from "./history";
import {
  adjacentPane,
  leaf,
  removePane as removePaneFromLayout,
  resizeSplit,
  splitPane as splitPaneInLayout,
  type LayoutNode,
  type Side,
} from "./layout";
import { IS_MAC } from "./platform";
import {
  DEFAULT_SHORTCUTS,
  defaultShortcuts,
  parseShortcuts,
  setActiveShortcuts,
  shortcutOverrides,
  type ShortcutBindings,
} from "./shortcuts";
import type { CursorStyle, GutterMode, RightClickAction } from "./terminal";
import { disposeController, getController } from "./terminalRegistry";
import type {
  AuthPrompt,
  HostKeyChange,
  SessionGroup,
  SessionInfo,
  SessionProfile,
  SessionState,
  ThemeMode,
} from "./types";

/** What a tab's activity treatment stands for; see `Tab.activityKind`. */
export type ActivityKind = "command" | "ai";

export interface Tab {
  info: SessionInfo;
  /**
   * The profile the tab was opened with, secrets included, so the session
   * can be reconnected in place. Kept in memory only.
   */
  profile: SessionProfile;
  /**
   * The number shown on the tab and bound to ⌘N / Alt+N. Fixed when the tab
   * opens (the lowest one no open tab holds) and kept for its lifetime, so
   * reordering or closing other tabs never renumbers it.
   */
  number: number;
  /**
   * Which open tab of the same session this is: 0 for the first, shown under
   * the bare name, then 1, 2, … shown as "name (1)", "name (2)". Like
   * `number` it is fixed when the tab opens (the lowest one no open tab of
   * the session holds) and never changes afterwards.
   */
  ordinal: number;
  state: SessionState;
  /**
   * Lifecycle of the command most recently submitted to this terminal.
   * `complete` is an unread notification: selecting the tab acknowledges it.
   */
  commandActivity: "idle" | "running" | "complete";
  /**
   * What that activity is about: the submitted command, or one turn of an
   * agentic CLI (Claude Code, Codex) that holds the terminal for a whole
   * session and is only worth reporting while the assistant works.
   */
  activityKind: ActivityKind;
  message?: string;
  cols: number;
  rows: number;
  /** The pane whose strip shows this tab; see `AppStore.panes`. */
  paneId: string;
}

/**
 * One region of the terminal area, with its own tab strip — VS Code's
 * editor group. The tree that lays the panes out is `AppStore.layout`.
 */
export interface Pane {
  id: string;
  /** The tab the pane shows; null only while the workspace has no tab. */
  activeTabId: string | null;
}

/** Where a tab being dragged would land if it were released now. */
export type DropTarget =
  | { paneId: string; zone: "strip"; index: number }
  | { paneId: string; zone: "center" | Side };

/**
 * What makes two tabs "the same session" for `Tab.ordinal`: the profile when
 * there is one, else the name (ad-hoc connections have no profile).
 */
const sessionKey = (info: SessionInfo): string => info.profileId ?? info.name;

/** The name a tab is shown under: its session's name plus its ordinal. */
export const tabTitle = (tab: Pick<Tab, "info" | "ordinal">): string =>
  tab.ordinal ? `${tab.info.name} (${tab.ordinal})` : tab.info.name;

/** A refused SSH host key, kept until the user accepts it or gives up. */
export interface HostKeyPrompt {
  sessionId: string;
  /** The profile to reconnect with, secrets included. */
  profile: SessionProfile;
  change: HostKeyChange;
}

export type PanelName = "filer" | "sessions" | "sender";

export const PANEL_FONT_SIZE = { min: 9, max: 18, default: 12 } as const;
export const BUFFER_FONT_SIZE = { min: 8, max: 32, default: 14 } as const;
export const TERMINAL_SCROLLBACK = {
  min: 0,
  max: 1_000_000,
  default: 20_000,
} as const;
// A fresh install shows only the session list; the Filer and Sender stay
// hidden until the user opens them from the View menu.
const DEFAULT_PANELS: Record<PanelName, boolean> = {
  filer: false,
  sessions: true,
  sender: false,
};

const PANEL_FONT_SIZE_KEY = "edgeterm.panelFontSize";
const BUFFER_FONT_SIZE_KEY = "edgeterm.bufferFontSize";
const PANEL_FONT_FAMILY_KEY = "edgeterm.panelFontFamily";
const BUFFER_FONT_FAMILY_KEY = "edgeterm.bufferFontFamily";
const TERMINAL_SCROLLBACK_KEY = "edgeterm.terminalScrollback";
const GUTTER_MODE_KEY = "edgeterm.gutterMode";
const PANELS_KEY = "edgeterm.panels";
const THEME_KEY = "edgeterm.theme";
const SUGGESTIONS_KEY = "edgeterm.suggestions";
const RIGHT_CLICK_KEY = "edgeterm.rightClick";
const SHORTCUTS_KEY = "edgeterm.shortcuts";
const CURSOR_STYLE_KEY = "edgeterm.cursorStyle";
const CURSOR_BLINK_KEY = "edgeterm.cursorBlink";

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

const parseRightClickAction = (value: unknown): RightClickAction | null =>
  value === "menu" || value === "copyPaste" ? value : null;

/**
 * The context menu is the behavior everywhere unless a Windows / Linux user
 * asks for the console convention in Edit → Right Click. macOS terminals
 * have no such convention, so the value is pinned there: a stored or
 * imported `copyPaste` never applies and the menu doesn't offer it.
 */
const loadRightClickAction = (): RightClickAction => {
  if (IS_MAC) return "menu";
  try {
    return (
      parseRightClickAction(localStorage.getItem(RIGHT_CLICK_KEY)) ?? "menu"
    );
  } catch {
    // Use the default when storage is unavailable.
    return "menu";
  }
};

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

/**
 * A font family is stored as the bare family name, empty meaning "whatever
 * the platform default stack picks". Only the name is kept: the fallbacks
 * come from `fonts.ts`, which is the single place that knows them.
 */
const normalizeFontFamily = (value: unknown): string =>
  typeof value === "string" ? value.trim().slice(0, 100) : "";

const loadFontFamily = (key: string): string => {
  try {
    return normalizeFontFamily(localStorage.getItem(key));
  } catch {
    return "";
  }
};

const saveFontFamily = (key: string, value: string) => {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
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

const parseCursorStyle = (value: unknown): CursorStyle | null =>
  value === "block" || value === "underline" || value === "bar" ? value : null;

const loadCursorStyle = (): CursorStyle => {
  try {
    return parseCursorStyle(localStorage.getItem(CURSOR_STYLE_KEY)) ?? "block";
  } catch {
    return "block";
  }
};

// Stored as "on" / "off" like the other switches; absent means blinking, the
// default every session had before the setting existed.
const loadCursorBlink = (): boolean => {
  try {
    return localStorage.getItem(CURSOR_BLINK_KEY) !== "off";
  } catch {
    return true;
  }
};

const saveSetting = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // The setting still applies for this run when storage is unavailable.
  }
};

/**
 * Keyboard bindings are stored as the difference from this platform's
 * defaults, so a command the user never touched follows a later release's
 * default instead of being pinned to the one it shipped with.
 */
const loadShortcuts = (): ShortcutBindings => {
  try {
    const stored = localStorage.getItem(SHORTCUTS_KEY);
    if (stored) {
      const bindings = parseShortcuts(JSON.parse(stored), DEFAULT_SHORTCUTS);
      if (bindings) return bindings;
    }
  } catch {
    // Use the defaults when storage is unavailable or malformed.
  }
  return defaultShortcuts();
};

const saveShortcuts = (bindings: ShortcutBindings) => {
  try {
    const overrides = shortcutOverrides(bindings);
    if (Object.keys(overrides).length === 0) {
      localStorage.removeItem(SHORTCUTS_KEY);
    } else {
      localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(overrides));
    }
  } catch {
    // The bindings still apply for this run when storage is unavailable.
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
  /** Interface font family; empty means the platform default stack. */
  panelFontFamily: string;
  /** Terminal font family; empty means the platform default stack. */
  bufferFontFamily: string;
  terminalScrollback: number;
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  suggestionsEnabled: boolean;
  /** Windows / Linux only; macOS always opens the menu. */
  rightClickAction: RightClickAction;
  /** Only the key bindings that differ from the platform defaults. */
  shortcuts: Partial<ShortcutBindings>;
}

interface AppStore {
  profiles: SessionProfile[];
  /** User-defined folders of the Session panel; see `SessionGroup`. */
  groups: SessionGroup[];
  tabs: Tab[];
  /** The focused tab: the active tab of the active pane. */
  activeId: string | null;
  /**
   * The panes the terminal area is split into and the tree that lays them
   * out (see layout.ts). There is always at least one pane; a pane whose
   * last tab leaves folds away unless it is the only one.
   */
  panes: Pane[];
  layout: LayoutNode;
  activePaneId: string;
  /** A tab being dragged between strips, and where it would land. */
  draggingTabId: string | null;
  dropTarget: DropTarget | null;
  gutterMode: GutterMode;
  theme: ThemeMode;
  panelFontSize: number;
  bufferFontSize: number;
  panelFontFamily: string;
  bufferFontFamily: string;
  terminalScrollback: number;
  /** The terminal cursor's shape and whether it blinks. */
  cursorStyle: CursorStyle;
  cursorBlink: boolean;
  /** Command history recording + fish-style inline suggestions. */
  suggestionsEnabled: boolean;
  /** What a right click in the terminal does; see `RightClickAction`. */
  rightClickAction: RightClickAction;
  /** The chord each app command answers; see `shortcuts.ts`. */
  shortcuts: ShortcutBindings;
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
   * Verification challenges from servers still authenticating a session (an
   * MFA code, a push confirmation). Each is a round the connection is
   * blocked on, so they queue: the oldest is shown and the rest wait.
   */
  authPrompts: AuthPrompt[];
  /**
   * Ids of live tabs whose close is waiting for the user's confirmation.
   * Kept in the store so every close entry point (tab ✕, menu, ⌘W, the
   * strip's close-others commands) funnels into the one dialog rendered by
   * App.
   */
  closePrompt: string[] | null;
  /**
   * A directory the Filer was asked to show (⌘J / "Reveal Working Directory
   * in Filer"). `token` tells a repeat request for the same path apart from
   * the last one; `sessionId` lets the panel drop a request that resolved
   * after the user had switched to another tab.
   */
  filerTarget: { sessionId: string; path: string; token: number } | null;
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

  /** Opens a tab in the active pane and focuses it. */
  addTab: (info: SessionInfo, profile: SessionProfile, state?: SessionState) => void;
  updateTabInfo: (id: string, info: SessionInfo) => void;
  closeTab: (id: string) => Promise<void>;
  /**
   * Closes a tab, asking first while its session is still connecting or
   * connected. Tabs that already ended (closed / error) have nothing left to
   * lose and close immediately.
   */
  requestCloseTab: (id: string) => void;
  /** `requestCloseTab` for several tabs, behind a single confirmation. */
  requestCloseTabs: (ids: string[]) => void;
  setClosePrompt: (ids: string[] | null) => void;
  /** Shows a tab in its pane and focuses it, making that pane the active one. */
  setActive: (id: string) => void;
  /** Focuses a pane: the tab it shows becomes the active tab. */
  setActivePane: (paneId: string) => void;
  /** Steps through the active pane's tabs. */
  activateAdjacentTab: (direction: -1 | 1) => void;
  /** Steps through the panes in reading order. */
  activateAdjacentPane: (direction: -1 | 1) => void;
  /**
   * Moves a tab to `index` counted over the other tabs of its pane, i.e. its
   * final position in the strip. Out-of-range indexes clamp to the ends.
   */
  moveTab: (id: string, index: number) => void;
  /**
   * Moves a tab into another pane, at `index` in that strip, and focuses it
   * there. The pane it leaves folds away when that was its last tab.
   */
  moveTabToPane: (id: string, paneId: string, index: number) => void;
  /**
   * Opens a new pane beside `paneId`, on the given side, and makes it the
   * active one; with `tabId` that tab moves into it, otherwise the pane is
   * empty until the caller opens a session in it. Returns the pane the
   * caller should now use: the new one, or `paneId` itself when the split
   * would only have moved a lone tab out of its own pane and folded that
   * pane away again.
   */
  splitPane: (paneId: string, side: Side, tabId?: string) => string;
  /** Drags a boundary between panes; the arguments are `resizeSplit`'s. */
  resizeLayout: (
    path: number[],
    index: number,
    delta: number,
    minSize: number,
  ) => void;
  /** Publishes a tab drag so every strip and pane can draw its part of it. */
  setTabDrag: (draggingTabId: string | null, dropTarget?: DropTarget | null) => void;

  applyState: (id: string, state: SessionState, message?: string) => void;
  /** Records a command, or an agentic CLI's turn, starting in a terminal. */
  markCommandStarted: (id: string, kind?: ActivityKind) => void;
  /** Leaves an unread completion on a background tab until it is selected. */
  markCommandCompleted: (id: string, kind?: ActivityKind) => void;
  /** Clears activity when a submitted write failed before reaching the shell. */
  clearCommandActivity: (id: string) => void;
  setSize: (id: string, cols: number, rows: number) => void;

  togglePanel: (panel: PanelName) => void;
  setGutterMode: (mode: GutterMode) => void;
  setTheme: (theme: ThemeMode) => void;
  setPanelFontSize: (size: number) => void;
  setBufferFontSize: (size: number) => void;
  setPanelFontFamily: (family: string) => void;
  setBufferFontFamily: (family: string) => void;
  setTerminalScrollback: (rows: number) => void;
  setCursorStyle: (style: CursorStyle) => void;
  setCursorBlink: (blink: boolean) => void;
  setSuggestionsEnabled: (enabled: boolean) => void;
  setRightClickAction: (action: RightClickAction) => void;
  setShortcuts: (bindings: ShortcutBindings) => void;
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
  addAuthPrompt: (prompt: AuthPrompt) => void;
  /** Drops a challenge the dialog has just answered. */
  clearAuthPrompt: (id: string) => void;
  /** Points the Filer at `path` for `sessionId`, showing the panel if hidden. */
  revealInFiler: (sessionId: string, path: string) => void;
}

const patchTab = (tabs: Tab[], id: string, patch: Partial<Tab>): Tab[] =>
  tabs.map((tab) => (tab.info.id === id ? { ...tab, ...patch } : tab));

/** Selecting a tab acknowledges only its unread completion notification. */
const acknowledgeTab = (tabs: Tab[], id: string | null): Tab[] =>
  id === null
    ? tabs
    : tabs.map((tab) =>
        tab.info.id === id && tab.commandActivity === "complete"
          ? { ...tab, commandActivity: "idle" }
          : tab,
      );

// The key matchers are not React and cannot subscribe, so the table in force
// is pushed into `shortcuts.ts` here and again from `setShortcuts`.
const initialShortcuts = loadShortcuts();
setActiveShortcuts(initialShortcuts);

let paneCounter = 0;
const newPaneId = (): string => `pane-${++paneCounter}`;
const ROOT_PANE_ID = newPaneId();

const patchPane = (panes: Pane[], id: string, patch: Partial<Pane>): Pane[] =>
  panes.map((pane) => (pane.id === id ? { ...pane, ...patch } : pane));

/**
 * Puts a tab into `paneId` at `index` counted over that pane's other tabs.
 * Tabs stay one flat list in opening order — a pane's strip is the tabs
 * carrying its id, in list order — so a move only shifts the tab to just
 * before the strip's tab that ends up after it.
 */
const placeTab = (
  tabs: Tab[],
  id: string,
  paneId: string,
  index: number,
): Tab[] => {
  const tab = tabs.find((item) => item.info.id === id);
  if (!tab) return tabs;
  const rest = tabs.filter((item) => item.info.id !== id);
  const siblings = rest.filter((item) => item.paneId === paneId);
  const to = Math.max(0, Math.min(index, siblings.length));
  const at =
    to < siblings.length
      ? rest.indexOf(siblings[to])
      : siblings.length > 0
        ? rest.indexOf(siblings[siblings.length - 1]) + 1
        : rest.length;
  const placed = [...rest];
  placed.splice(at, 0, tab.paneId === paneId ? tab : { ...tab, paneId });
  return placed;
};

type PaneState = Pick<
  AppStore,
  "tabs" | "activeId" | "panes" | "layout" | "activePaneId"
>;

const paneState = (state: PaneState): PaneState => ({
  tabs: state.tabs,
  activeId: state.activeId,
  panes: state.panes,
  layout: state.layout,
  activePaneId: state.activePaneId,
});

/**
 * Settles a pane after a tab left it (closed, or moved to another pane):
 * the pane shows its last tab if the one it showed is gone, or, with no tab
 * left, folds away and hands the focus it had to the pane before it. The
 * only pane stays, empty.
 */
const settlePane = (state: PaneState, paneId: string): PaneState => {
  const pane = state.panes.find((item) => item.id === paneId);
  if (!pane) return state;
  const remaining = state.tabs.filter((tab) => tab.paneId === paneId);
  const focused = state.activePaneId === paneId;
  if (remaining.length > 0) {
    if (remaining.some((tab) => tab.info.id === pane.activeTabId)) return state;
    const activeTabId = remaining[remaining.length - 1].info.id;
    return {
      ...state,
      panes: patchPane(state.panes, paneId, { activeTabId }),
      activeId: focused ? activeTabId : state.activeId,
    };
  }
  if (state.panes.length === 1) {
    return {
      ...state,
      panes: patchPane(state.panes, paneId, { activeTabId: null }),
      activeId: focused ? null : state.activeId,
    };
  }
  const layout = removePaneFromLayout(state.layout, paneId) ?? state.layout;
  const panes = state.panes.filter((item) => item.id !== paneId);
  if (!focused) return { ...state, layout, panes };
  const nextId = adjacentPane(state.layout, paneId, -1);
  const next = panes.find((item) => item.id === nextId) ?? panes[0];
  return {
    ...state,
    layout,
    panes,
    activePaneId: next.id,
    activeId: next.activeTabId,
  };
};

const sameDropTarget = (a: DropTarget | null, b: DropTarget | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.paneId === b.paneId &&
    a.zone === b.zone &&
    (a.zone !== "strip" || b.zone !== "strip" || a.index === b.index));

export const useStore = create<AppStore>((set, get) => ({
  profiles: [],
  groups: [],
  tabs: [],
  activeId: null,
  gutterMode: loadGutterMode(),
  theme: loadTheme(),
  panelFontSize: loadFontSize(PANEL_FONT_SIZE_KEY, PANEL_FONT_SIZE),
  bufferFontSize: loadFontSize(BUFFER_FONT_SIZE_KEY, BUFFER_FONT_SIZE),
  panelFontFamily: loadFontFamily(PANEL_FONT_FAMILY_KEY),
  bufferFontFamily: loadFontFamily(BUFFER_FONT_FAMILY_KEY),
  terminalScrollback: loadScrollback(),
  cursorStyle: loadCursorStyle(),
  cursorBlink: loadCursorBlink(),
  suggestionsEnabled: loadSuggestionsEnabled(),
  rightClickAction: loadRightClickAction(),
  shortcuts: initialShortcuts,
  panels: loadPanels(),
  status: "Ready",
  error: null,
  errorSessionId: null,
  hostKeyPrompt: null,
  authPrompts: [],
  closePrompt: null,
  filerTarget: null,
  senderLibraryVersion: 0,

  panes: [{ id: ROOT_PANE_ID, activeTabId: null }],
  layout: leaf(ROOT_PANE_ID),
  activePaneId: ROOT_PANE_ID,
  draggingTabId: null,
  dropTarget: null,

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
    const { tabs, panes, activePaneId } = get();
    const taken = new Set(tabs.map((tab) => tab.number));
    let number = 1;
    while (taken.has(number)) number += 1;
    const key = sessionKey(info);
    const ordinals = new Set(
      tabs
        .filter((tab) => sessionKey(tab.info) === key)
        .map((tab) => tab.ordinal),
    );
    let ordinal = 0;
    while (ordinals.has(ordinal)) ordinal += 1;
    const tab: Tab = {
      info,
      profile,
      number,
      ordinal,
      state,
      commandActivity: "idle",
      activityKind: "command",
      cols: 80,
      rows: 24,
      paneId: activePaneId,
    };
    set({
      tabs: [...tabs, tab],
      activeId: info.id,
      panes: patchPane(panes, activePaneId, { activeTabId: info.id }),
    });
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
    // Files from this session opened in local editors stop syncing back.
    await api.stopRemoteEdits(id).catch(() => undefined);
    disposeController(id);
    // A challenge nobody will answer now would hold its half-open connection
    // until the backend's own timeout; release it here instead.
    for (const prompt of get().authPrompts) {
      if (prompt.sessionId === id) {
        void api.answerAuthPrompt(prompt.id, null).catch(() => undefined);
      }
    }
    const current = get();
    const closing = current.tabs.find((tab) => tab.info.id === id);
    const remaining = current.tabs.filter((tab) => tab.info.id !== id);
    // The pane shows its last tab next, or folds away with its last tab.
    const settled = closing
      ? settlePane({ ...paneState(current), tabs: remaining }, closing.paneId)
      : { ...paneState(current), tabs: remaining };
    const clearsSessionError = current.errorSessionId === id;
    const closePrompt =
      current.closePrompt?.filter((pending) => pending !== id) ?? null;
    set({
      ...settled,
      tabs: acknowledgeTab(settled.tabs, settled.activeId),
      status: clearsSessionError ? "Ready" : current.status,
      error: clearsSessionError ? null : current.error,
      errorSessionId: clearsSessionError ? null : current.errorSessionId,
      hostKeyPrompt:
        current.hostKeyPrompt?.sessionId === id ? null : current.hostKeyPrompt,
      authPrompts: current.authPrompts.filter(
        (prompt) => prompt.sessionId !== id,
      ),
      closePrompt: closePrompt && closePrompt.length > 0 ? closePrompt : null,
    });
  },

  requestCloseTab(id) {
    get().requestCloseTabs([id]);
  },

  requestCloseTabs(ids) {
    const wanted = new Set(ids);
    const live: string[] = [];
    for (const tab of get().tabs) {
      if (!wanted.has(tab.info.id)) continue;
      if (tab.state === "closed" || tab.state === "error") {
        void get().closeTab(tab.info.id);
      } else {
        live.push(tab.info.id);
      }
    }
    if (live.length > 0) set({ closePrompt: live });
  },

  setClosePrompt(ids) {
    set({ closePrompt: ids && ids.length > 0 ? ids : null });
  },

  setActive(id) {
    const { tabs, panes } = get();
    const tab = tabs.find((item) => item.info.id === id);
    if (!tab) return;
    set({
      activeId: id,
      activePaneId: tab.paneId,
      panes: patchPane(panes, tab.paneId, { activeTabId: id }),
      // A completion is deliberately persistent on a background tab, but
      // selecting it is the acknowledgement. A still-running command keeps
      // its state so the particles return if the user switches away again.
      tabs: acknowledgeTab(tabs, id),
    });
  },

  setActivePane(paneId) {
    const { panes, activePaneId, tabs } = get();
    const pane = panes.find((item) => item.id === paneId);
    if (!pane || paneId === activePaneId) return;
    set({
      activePaneId: paneId,
      activeId: pane.activeTabId,
      tabs: acknowledgeTab(tabs, pane.activeTabId),
    });
  },

  activateAdjacentTab(direction) {
    const { tabs, activeId, activePaneId } = get();
    const strip = tabs.filter((tab) => tab.paneId === activePaneId);
    if (strip.length === 0) return;

    const activeIndex = strip.findIndex((tab) => tab.info.id === activeId);
    const startIndex = activeIndex === -1 ? (direction > 0 ? -1 : 0) : activeIndex;
    const nextIndex = (startIndex + direction + strip.length) % strip.length;
    get().setActive(strip[nextIndex].info.id);
  },

  activateAdjacentPane(direction) {
    const { layout, activePaneId } = get();
    const next = adjacentPane(layout, activePaneId, direction);
    if (next) get().setActivePane(next);
  },

  moveTab(id, index) {
    const tabs = get().tabs;
    const tab = tabs.find((item) => item.info.id === id);
    if (!tab) return;
    const strip = tabs.filter((item) => item.paneId === tab.paneId);
    const from = strip.indexOf(tab);
    const to = Math.max(0, Math.min(index, strip.length - 1));
    if (to === from) return;
    set({ tabs: placeTab(tabs, id, tab.paneId, index) });
  },

  moveTabToPane(id, paneId, index) {
    const current = get();
    const tab = current.tabs.find((item) => item.info.id === id);
    if (!tab || !current.panes.some((pane) => pane.id === paneId)) return;
    if (tab.paneId === paneId) {
      get().moveTab(id, index);
      return;
    }
    // The tab is shown and focused where it lands; then the pane it left
    // picks a new tab to show, or folds away.
    const settled = settlePane(
      {
        tabs: placeTab(current.tabs, id, paneId, index),
        activeId: id,
        panes: patchPane(current.panes, paneId, { activeTabId: id }),
        layout: current.layout,
        activePaneId: paneId,
      },
      tab.paneId,
    );
    set({ ...settled, tabs: acknowledgeTab(settled.tabs, id) });
  },

  splitPane(paneId, side, tabId) {
    const current = get();
    if (!current.panes.some((pane) => pane.id === paneId)) {
      return current.activePaneId;
    }
    const tab = tabId
      ? current.tabs.find((item) => item.info.id === tabId)
      : undefined;
    if (tabId && !tab) return current.activePaneId;
    if (
      tab &&
      tab.paneId === paneId &&
      !current.tabs.some(
        (item) => item.paneId === paneId && item.info.id !== tabId,
      )
    ) {
      return paneId;
    }
    const newId = newPaneId();
    const layout = splitPaneInLayout(current.layout, paneId, side, newId);
    const panes = [
      ...current.panes,
      { id: newId, activeTabId: tab?.info.id ?? null },
    ];
    if (!tab) {
      set({ layout, panes, activePaneId: newId, activeId: null });
      return newId;
    }
    const settled = settlePane(
      {
        tabs: placeTab(current.tabs, tab.info.id, newId, 0),
        activeId: tab.info.id,
        panes,
        layout,
        activePaneId: newId,
      },
      tab.paneId,
    );
    set({ ...settled, tabs: acknowledgeTab(settled.tabs, tab.info.id) });
    return newId;
  },

  resizeLayout(path, index, delta, minSize) {
    const layout = get().layout;
    const resized = resizeSplit(layout, path, index, delta, minSize);
    if (resized !== layout) set({ layout: resized });
  },

  setTabDrag(draggingTabId, dropTarget = null) {
    const current = get();
    if (
      current.draggingTabId === draggingTabId &&
      sameDropTarget(current.dropTarget, dropTarget)
    ) {
      return;
    }
    set({ draggingTabId, dropTarget });
  },

  applyState(id, state, message) {
    set({
      tabs: patchTab(get().tabs, id, {
        state,
        message,
        // A command cannot remain in progress after its session ends; a
        // reconnect starts with a clean terminal activity state as well.
        ...(state === "connected"
          ? {}
          : { commandActivity: "idle" as const, activityKind: "command" as const }),
      }),
    });
    // An ended session has nothing to type into; lock its terminal until a
    // reconnect brings it back.
    getController(id)?.setLocked(state === "closed" || state === "error");
  },

  markCommandStarted(id, kind = "command") {
    set({
      tabs: patchTab(get().tabs, id, {
        commandActivity: "running",
        activityKind: kind,
      }),
    });
  },

  markCommandCompleted(id, kind = "command") {
    const state = get();
    set({
      tabs: patchTab(state.tabs, id, {
        // The active terminal already shows its returned prompt. Background
        // tabs retain a highlight until the user visits them.
        commandActivity: state.activeId === id ? "idle" : "complete",
        activityKind: kind,
      }),
    });
  },

  clearCommandActivity(id) {
    set({ tabs: patchTab(get().tabs, id, { commandActivity: "idle" }) });
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

  setPanelFontFamily(family) {
    const panelFontFamily = normalizeFontFamily(family);
    set({ panelFontFamily });
    saveFontFamily(PANEL_FONT_FAMILY_KEY, panelFontFamily);
  },

  setBufferFontFamily(family) {
    const bufferFontFamily = normalizeFontFamily(family);
    set({ bufferFontFamily });
    saveFontFamily(BUFFER_FONT_FAMILY_KEY, bufferFontFamily);
  },

  setTerminalScrollback(rows) {
    const terminalScrollback = normalizeScrollback(rows);
    set({ terminalScrollback });
    saveScrollback(terminalScrollback);
  },

  setCursorStyle(style) {
    const cursorStyle = parseCursorStyle(style) ?? "block";
    set({ cursorStyle });
    saveSetting(CURSOR_STYLE_KEY, cursorStyle);
  },

  setCursorBlink(blink) {
    set({ cursorBlink: blink });
    saveSetting(CURSOR_BLINK_KEY, blink ? "on" : "off");
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

  setRightClickAction(action) {
    // Nothing to choose on macOS; see loadRightClickAction.
    if (IS_MAC) return;
    set({ rightClickAction: action });
    try {
      localStorage.setItem(RIGHT_CLICK_KEY, action);
    } catch {
      // The setting still applies for this run when storage is unavailable.
    }
  },

  setShortcuts(bindings) {
    const shortcuts = { ...bindings };
    set({ shortcuts });
    setActiveShortcuts(shortcuts);
    saveShortcuts(shortcuts);
  },

  resetSettings() {
    const shortcuts = defaultShortcuts();
    setActiveShortcuts(shortcuts);
    set({
      shortcuts,
      panels: { ...DEFAULT_PANELS },
      gutterMode: "both",
      theme: "dark",
      panelFontSize: PANEL_FONT_SIZE.default,
      bufferFontSize: BUFFER_FONT_SIZE.default,
      panelFontFamily: "",
      bufferFontFamily: "",
      terminalScrollback: TERMINAL_SCROLLBACK.default,
      cursorStyle: "block",
      cursorBlink: true,
      suggestionsEnabled: false,
      rightClickAction: "menu",
    });
    try {
      localStorage.removeItem(PANELS_KEY);
      localStorage.removeItem(GUTTER_MODE_KEY);
      localStorage.removeItem(THEME_KEY);
      localStorage.removeItem(PANEL_FONT_SIZE_KEY);
      localStorage.removeItem(BUFFER_FONT_SIZE_KEY);
      localStorage.removeItem(PANEL_FONT_FAMILY_KEY);
      localStorage.removeItem(BUFFER_FONT_FAMILY_KEY);
      localStorage.removeItem(TERMINAL_SCROLLBACK_KEY);
      localStorage.removeItem(CURSOR_STYLE_KEY);
      localStorage.removeItem(CURSOR_BLINK_KEY);
      localStorage.removeItem(SUGGESTIONS_KEY);
      localStorage.removeItem(RIGHT_CLICK_KEY);
      localStorage.removeItem(SHORTCUTS_KEY);
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
      panelFontFamily: state.panelFontFamily,
      bufferFontFamily: state.bufferFontFamily,
      terminalScrollback: state.terminalScrollback,
      cursorStyle: state.cursorStyle,
      cursorBlink: state.cursorBlink,
      suggestionsEnabled: state.suggestionsEnabled,
      rightClickAction: state.rightClickAction,
      shortcuts: shortcutOverrides(state.shortcuts),
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
    if (typeof values.panelFontFamily === "string") {
      state.setPanelFontFamily(values.panelFontFamily);
    }
    if (typeof values.bufferFontFamily === "string") {
      state.setBufferFontFamily(values.bufferFontFamily);
    }
    if (typeof values.terminalScrollback === "number") {
      state.setTerminalScrollback(values.terminalScrollback);
    }
    const cursorStyle = parseCursorStyle(values.cursorStyle);
    if (cursorStyle) state.setCursorStyle(cursorStyle);
    if (typeof values.cursorBlink === "boolean") {
      state.setCursorBlink(values.cursorBlink);
    }
    if (typeof values.suggestionsEnabled === "boolean") {
      state.setSuggestionsEnabled(values.suggestionsEnabled);
    }
    const rightClickAction = parseRightClickAction(values.rightClickAction);
    if (rightClickAction) state.setRightClickAction(rightClickAction);
    const shortcuts = parseShortcuts(values.shortcuts, state.shortcuts);
    if (shortcuts) state.setShortcuts(shortcuts);
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

  addAuthPrompt(prompt) {
    set({ authPrompts: [...get().authPrompts, prompt] });
  },

  clearAuthPrompt(id) {
    set({
      authPrompts: get().authPrompts.filter((prompt) => prompt.id !== id),
    });
  },

  setHostKeyPrompt(prompt) {
    set({ hostKeyPrompt: prompt });
  },

  revealInFiler(sessionId, path) {
    const token = (get().filerTarget?.token ?? 0) + 1;
    set({ filerTarget: { sessionId, path, token } });
    if (!get().panels.filer) get().togglePanel("filer");
  },
}));

export const useActiveTab = (): Tab | undefined =>
  useStore((s) => s.tabs.find((tab) => tab.info.id === s.activeId));
