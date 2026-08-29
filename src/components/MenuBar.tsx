import { type MouseEvent as ReactMouseEvent, type ReactElement, useEffect, useRef, useState } from "react";
import {
  getCurrentWindow,
  type Window as TauriWindow,
} from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import appIcon from "../../src-tauri/icons/32x32.png";
import { toggleSessionConnection } from "../actions";
import { windowControl } from "../api";
import { exportAppData, importAppData } from "../dataTransfer";
import { commandHistory } from "../history";
import { IS_MAC, IS_WINDOWS, shortcutLabel as sc } from "../platform";
import { useActiveTab, useStore } from "../store";
import type { GutterMode, RightClickAction } from "../terminal";
import { getController } from "../terminalRegistry";
import type { ThemeMode } from "../types";

const TUTORIAL_URL = "https://miskin-lee.github.io/EdgeTerm/tutorial.html";

// The menubar is also the title bar: it is the window drag region and shares
// its row with the window controls.
// - macOS: `titleBarStyle: "Overlay"` paints the traffic lights over our
//   content, so the bar leaves room for them (except in native fullscreen,
//   where macOS hides them).
// - Windows: the window is undecorated (see `create_main_window` in lib.rs),
//   so the bar shows the app icon and draws minimize / maximize / close itself.
// - Linux keeps the native title bar above the menubar.

/** Track a boolean window property, re-reading it whenever the window resizes. */
function useWindowFlag(
  enabled: boolean,
  read: (win: TauriWindow) => Promise<boolean>,
): boolean {
  const [value, setValue] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      read(win)
        .then((next) => {
          if (!disposed) setValue(next);
        })
        .catch(() => {});
    };
    sync();
    win
      .onResized(sync)
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [enabled, read]);
  return value;
}

const readFullscreen = (win: TauriWindow) => win.isFullscreen();
const readMaximized = (win: TauriWindow) => win.isMaximized();

interface WindowControl {
  label: string;
  icon: ReactElement;
  action: (win: TauriWindow) => Promise<void>;
  className?: string;
}

// Segoe Fluent-style caption glyphs on a 10px grid, drawn with 1px strokes.
const MINIMIZE_ICON = <path d="M0 5.5h10" />;
const MAXIMIZE_ICON = <rect x="0.5" y="0.5" width="9" height="9" />;
const RESTORE_ICON = (
  <>
    <rect x="0.5" y="2.5" width="7" height="7" />
    <path d="M2.5 2.5v-2h7v7h-2" />
  </>
);
const CLOSE_ICON = <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" />;

function WindowControls({ maximized }: { maximized: boolean }) {
  // Minimize / maximize go through `windowControl` (WM_SYSCOMMAND, like the
  // native caption buttons) rather than `win.minimize()` /
  // `win.toggleMaximize()`: the tao path behind those refreshes the frame
  // right after `ShowWindow`, which kills the DWM grow / shrink animation on
  // the undecorated window. The middle button toggles against the window's
  // real state (IsZoomed) rather than the cached `maximized` flag, so it is
  // right even if the flag lags. Close stays on the window API so the
  // close-requested hook still guards live sessions.
  const toggleMaximize = () => windowControl("toggle-maximize");
  const controls: WindowControl[] = [
    { label: "Minimize", icon: MINIMIZE_ICON, action: () => windowControl("minimize") },
    maximized
      ? { label: "Restore Down", icon: RESTORE_ICON, action: toggleMaximize }
      : { label: "Maximize", icon: MAXIMIZE_ICON, action: toggleMaximize },
    { label: "Close", icon: CLOSE_ICON, action: (win) => win.close(), className: " is-close" },
  ];
  return (
    <div className="window-controls">
      {controls.map((control) => (
        <button
          key={control.label}
          className={`window-control${control.className ?? ""}`}
          title={control.label}
          aria-label={control.label}
          tabIndex={-1}
          // Keep keyboard focus in the terminal.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void control.action(getCurrentWindow()).catch(() => {})}
        >
          <svg viewBox="0 0 10 10" aria-hidden="true">
            {control.icon}
          </svg>
        </button>
      ))}
    </div>
  );
}

/**
 * The check column of a dropdown entry. Checkable entries get a box (ticked
 * when on); the rest keep the same width blank so labels share one left edge.
 */
function MenuCheck({ checked }: { checked?: boolean }) {
  return (
    <span
      className={`menu-check${checked !== undefined ? " is-box" : ""}`}
      aria-hidden="true"
    >
      {checked && (
        <svg viewBox="0 0 10 10">
          <path d="M2 5.3l2.2 2.2L8 3" />
        </svg>
      )}
    </span>
  );
}

/** Whether a dropdown holds at least one checkable entry (and so needs a check column). */
function hasCheckable(entries: (Entry | "separator")[]): boolean {
  return entries.some(
    (entry) => entry !== "separator" && entry.checked !== undefined,
  );
}

interface Entry {
  label: string;
  shortcut?: string;
  checked?: boolean;
  action?: () => void;
  children?: Entry[];
}

interface Menu {
  title: string;
  entries: (Entry | "separator")[];
}

interface Props {
  onNewSession: () => void;
  onFind: () => void;
  onFindNext: () => void;
  onFontSettings: () => void;
  onCheckForUpdates: () => void;
  onAbout: () => void;
}

export function MenuBar(props: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const macFullscreen = useWindowFlag(IS_MAC, readFullscreen);
  const maximized = useWindowFlag(IS_WINDOWS, readMaximized);

  const activeId = useStore((s) => s.activeId);
  const activeState = useActiveTab()?.state;
  const panels = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const gutterMode = useStore((s) => s.gutterMode);
  const setGutterMode = useStore((s) => s.setGutterMode);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const suggestionsEnabled = useStore((s) => s.suggestionsEnabled);
  const setSuggestionsEnabled = useStore((s) => s.setSuggestionsEnabled);
  const rightClickAction = useStore((s) => s.rightClickAction);
  const setRightClickAction = useStore((s) => s.setRightClickAction);
  const resetSettings = useStore((s) => s.resetSettings);
  const setStatus = useStore((s) => s.setStatus);
  const requestCloseTab = useStore((s) => s.requestCloseTab);
  const activateAdjacentTab = useStore((s) => s.activateAdjacentTab);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      const target = event.target;
      // Anywhere but a menu title or its dropdown: outside the bar, the bar's
      // blank drag area (window drag start), the app icon or window controls.
      if (!(target instanceof Element) || !target.closest(".menu-item")) {
        setOpen(null);
      }
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, [open]);

  const withActive = (fn: (id: string) => void) => () => {
    if (activeId) fn(activeId);
  };

  const gutterEntry = (label: string, mode: GutterMode): Entry => ({
    label,
    checked: gutterMode === mode,
    action: () => setGutterMode(mode),
  });

  const themeEntry = (label: string, mode: ThemeMode): Entry => ({
    label,
    checked: theme === mode,
    action: () => setTheme(mode),
  });

  const rightClickEntry = (label: string, action: RightClickAction): Entry => ({
    label,
    checked: rightClickAction === action,
    action: () => setRightClickAction(action),
  });

  const menus: Menu[] = [
    {
      title: "Session",
      entries: [
        { label: "New Session…", shortcut: sc("⌘N", "Alt+N"), action: props.onNewSession },
        "separator",
        {
          label: "Previous Session",
          shortcut: sc("⌘[", "Alt+["),
          action: () => activateAdjacentTab(-1),
        },
        {
          label: "Next Session",
          shortcut: sc("⌘]", "Alt+]"),
          action: () => activateAdjacentTab(1),
        },
        "separator",
        {
          // One entry that mirrors the Session panel's power toggle: it names
          // whichever side of the switch applies to the active session now.
          label:
            activeState === "closed" || activeState === "error"
              ? "Reconnect Session"
              : "Disconnect Session",
          action: withActive(toggleSessionConnection),
        },
        {
          label: "Close Session",
          shortcut: sc("⌘W", "Ctrl+Shift+W"),
          action: withActive(requestCloseTab),
        },
        {
          label: "Cancel ZMODEM Transfer",
          action: withActive((id) => {
            if (!getController(id)?.cancelZmodem()) {
              setStatus("ZMODEM: no active transfer");
            }
          }),
        },
        "separator",
        {
          label: "Timestamp & Line",
          children: [
            gutterEntry("Timestamp + Line Number", "both"),
            gutterEntry("Line Number Only", "line"),
            gutterEntry("Timestamp Only", "time"),
            gutterEntry("No Gutter", "off"),
          ],
        },
        "separator",
        { label: "Export Data…", action: () => void exportAppData() },
        { label: "Import Data…", action: () => void importAppData() },
      ],
    },
    {
      title: "Edit",
      entries: [
        {
          label: "Copy",
          shortcut: sc("⌘C", "Ctrl+Shift+C"),
          action: withActive((id) => getController(id)?.copySelection()),
        },
        {
          label: "Paste",
          shortcut: sc("⌘V", "Ctrl+Shift+V"),
          action: withActive((id) => getController(id)?.pasteFromClipboard()),
        },
        {
          label: "Select All",
          shortcut: sc("⌘A", "Ctrl+Shift+A"),
          action: withActive((id) => getController(id)?.selectAll()),
        },
        "separator",
        {
          label: "Right Click",
          children: [
            rightClickEntry("Copy or Paste", "copyPaste"),
            rightClickEntry("Show Menu", "menu"),
          ],
        },
        "separator",
        {
          label: "Clear Buffer",
          shortcut: sc("⌘K", "Alt+K"),
          action: withActive((id) => getController(id)?.clear()),
        },
        "separator",
        {
          label: "Command Suggestions",
          checked: suggestionsEnabled,
          action: () => setSuggestionsEnabled(!suggestionsEnabled),
        },
        {
          label: "Clear Command History…",
          action: () => {
            void (async () => {
              const confirmed = await ask(
                "Delete the recorded command history used for inline suggestions?",
                {
                  title: "Clear Command History",
                  kind: "warning",
                  okLabel: "Clear",
                  cancelLabel: "Cancel",
                },
              );
              if (!confirmed) return;
              try {
                await commandHistory.clear();
                setStatus("Command history cleared");
              } catch (error) {
                setStatus(`Failed to clear command history: ${error}`);
              }
            })();
          },
        },
      ],
    },
    {
      title: "Search",
      entries: [
        { label: "Find…", shortcut: sc("⌘F", "Ctrl+Shift+F"), action: props.onFind },
        { label: "Find Next", shortcut: sc("⌘G", "Ctrl+Shift+G"), action: props.onFindNext },
      ],
    },
    {
      title: "View",
      entries: [
        {
          label: "Session",
          shortcut: sc("⌘⌥←", "Ctrl+Alt+←"),
          checked: panels.sessions,
          action: () => togglePanel("sessions"),
        },
        {
          label: "Filer",
          shortcut: sc("⌘⌥→", "Ctrl+Alt+→"),
          checked: panels.filer,
          action: () => togglePanel("filer"),
        },
        {
          label: "Sender",
          shortcut: sc("⌘⌥↓", "Ctrl+Alt+↓"),
          checked: panels.sender,
          action: () => togglePanel("sender"),
        },
        "separator",
        {
          label: "Theme",
          children: [
            themeEntry("Dark", "dark"),
            themeEntry("Light", "light"),
          ],
        },
        "separator",
        { label: "Display Settings…", action: props.onFontSettings },
      ],
    },
    {
      title: "Help",
      entries: [
        {
          label: "Tutorial",
          action: () => {
            void openUrl(TUTORIAL_URL).catch((error) => {
              setStatus(`Failed to open tutorial: ${error}`);
            });
          },
        },
        { label: "Check for Updates…", action: props.onCheckForUpdates },
        "separator",
        {
          label: "Restore Default Settings…",
          action: () => {
            void (async () => {
              const confirmed = await ask(
                "Restore panel visibility, timestamp and line display, theme, font sizes, scrollback, command suggestions, and mouse copy / paste to their defaults?",
                {
                  title: "Restore Default Settings",
                  kind: "warning",
                  okLabel: "Restore",
                  cancelLabel: "Cancel",
                },
              );
              if (!confirmed) return;
              resetSettings();
              setStatus("Default settings restored");
            })();
          },
        },
        "separator",
        { label: "About EdgeTerm", action: props.onAbout },
      ],
    },
  ];

  // Windows: a double-click on the drag region maximizes / restores. Tauri's
  // injected drag script would do that too (`internal_toggle_maximize` on the
  // document mousedown listener), but through the animation-less tao path, so
  // take the double-click here first, on the same elements the script treats
  // as the drag region (the bar itself and the app icon, not the menu titles),
  // and stop it before it reaches the document. Single clicks still fall
  // through to the script's `start_dragging`.
  const onDragRegionMouseDown = IS_WINDOWS
    ? (event: ReactMouseEvent<HTMLDivElement>) => {
        if (event.button !== 0 || event.detail !== 2) return;
        if (!(event.target instanceof HTMLElement)) return;
        if (!event.target.hasAttribute("data-tauri-drag-region")) return;
        event.preventDefault();
        event.stopPropagation();
        void windowControl("toggle-maximize").catch(() => {});
      }
    : undefined;

  return (
    <div
      className={`menubar${IS_MAC ? " is-mac" : ""}${IS_MAC && !macFullscreen ? " has-traffic-lights" : ""}`}
      ref={barRef}
      data-tauri-drag-region
      onMouseDown={onDragRegionMouseDown}
    >
      {IS_WINDOWS && (
        <img
          className="menubar-icon"
          src={appIcon}
          alt=""
          draggable={false}
          data-tauri-drag-region
        />
      )}
      {menus.map((menu) => (
        <div
          key={menu.title}
          className={`menu-item${open === menu.title ? " is-open" : ""}`}
          onMouseDown={() => setOpen(open === menu.title ? null : menu.title)}
          onMouseEnter={() => open && setOpen(menu.title)}
        >
          {menu.title}
          {open === menu.title && (
            // When a dropdown has checkable entries, every entry in it
            // (submenu parents included) renders the check column so labels
            // share one left edge. Dropdowns without any stay compact.
            <div className="menu-dropdown">
              {menu.entries.map((entry, index) => {
                if (entry === "separator") {
                  return <div key={index} className="menu-separator" />;
                }
                const showCheck = hasCheckable(menu.entries);
                if (entry.children) {
                  const children = entry.children;
                  const showChildCheck = hasCheckable(children);
                  return (
                    <div
                      key={entry.label}
                      className="menu-submenu-entry"
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <div className="menu-entry" role="menuitem">
                        {showCheck && <MenuCheck />}
                        <span className="menu-entry-label">{entry.label}</span>
                        <span className="menu-submenu-arrow" aria-hidden="true">
                          ›
                        </span>
                      </div>
                      <div className="menu-dropdown menu-submenu">
                        {children.map((child) => (
                          <button
                            key={child.label}
                            className={`menu-entry${child.checked ? " is-checked" : ""}`}
                            onMouseDown={(event) => {
                              event.stopPropagation();
                              setOpen(null);
                              child.action?.();
                            }}
                          >
                            {showChildCheck && (
                              <MenuCheck checked={child.checked} />
                            )}
                            <span className="menu-entry-label">
                              {child.label}
                            </span>
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                }
                return (
                  <button
                    key={entry.label}
                    className={`menu-entry${entry.checked ? " is-checked" : ""}`}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      setOpen(null);
                      entry.action?.();
                    }}
                  >
                    {showCheck && <MenuCheck checked={entry.checked} />}
                    <span className="menu-entry-label">{entry.label}</span>
                    {entry.shortcut && (
                      <span className="menu-shortcut">{entry.shortcut}</span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      ))}
      {IS_WINDOWS && <WindowControls maximized={maximized} />}
    </div>
  );
}
