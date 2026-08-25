import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { IS_MAC, shortcutLabel as sc } from "../platform";
import { useStore } from "../store";
import type { GutterMode } from "../terminal";
import { getController } from "../terminalRegistry";
import type { ThemeMode } from "../types";

const TUTORIAL_URL = "https://miskin-lee.github.io/EdgeTerm/tutorial.html";

// With `titleBarStyle: "Overlay"` macOS paints the traffic lights over our
// content, so the menubar doubles as the drag region and leaves room for them
// (except in native fullscreen, where macOS hides the traffic lights).

function useMacFullscreen(): boolean {
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    if (!IS_MAC) return;
    const win = getCurrentWindow();
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = () => {
      win
        .isFullscreen()
        .then((value) => {
          if (!disposed) setFullscreen(value);
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
  }, []);
  return fullscreen;
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
  onFontSettings: () => void;
  onCheckForUpdates: () => void;
  onAbout: () => void;
}

export function MenuBar(props: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const macFullscreen = useMacFullscreen();

  const activeId = useStore((s) => s.activeId);
  const panels = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const gutterMode = useStore((s) => s.gutterMode);
  const setGutterMode = useStore((s) => s.setGutterMode);
  const theme = useStore((s) => s.theme);
  const setTheme = useStore((s) => s.setTheme);
  const resetSettings = useStore((s) => s.resetSettings);
  const setStatus = useStore((s) => s.setStatus);
  const closeTab = useStore((s) => s.closeTab);
  const activateAdjacentTab = useStore((s) => s.activateAdjacentTab);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      const target = event.target as Node;
      // Outside the bar, or on the bar's blank drag area (window drag start).
      if (!barRef.current?.contains(target) || target === barRef.current) {
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

  const menus: Menu[] = [
    {
      title: "Session",
      entries: [
        { label: "New Session…", shortcut: sc("⌘N", "Ctrl+N"), action: props.onNewSession },
        "separator",
        {
          label: "Previous Session",
          shortcut: sc("⌘←", "Ctrl+Shift+["),
          action: () => activateAdjacentTab(-1),
        },
        {
          label: "Next Session",
          shortcut: sc("⌘→", "Ctrl+Shift+]"),
          action: () => activateAdjacentTab(1),
        },
        "separator",
        {
          label: "Close Session",
          shortcut: sc("⌘W", "Ctrl+W"),
          action: withActive((id) => void closeTab(id)),
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
      ],
    },
    {
      title: "Edit",
      entries: [
        {
          label: "Copy",
          shortcut: sc("⌘C", "Alt+C"),
          action: withActive((id) => {
            const term = getController(id)?.term;
            if (term?.hasSelection())
              void navigator.clipboard.writeText(term.getSelection());
          }),
        },
        {
          label: "Paste",
          shortcut: sc("⌘V", "Alt+V"),
          action: withActive(async (id) => {
            const text = await navigator.clipboard.readText();
            if (text) getController(id)?.term.paste(text);
          }),
        },
        "separator",
        {
          label: "Clear Buffer",
          shortcut: sc("⌘K", "Ctrl+K"),
          action: withActive((id) => getController(id)?.clear()),
        },
      ],
    },
    {
      title: "Search",
      entries: [
        { label: "Find…", shortcut: sc("⌘F", "Ctrl+F"), action: props.onFind },
        { label: "Find Next", shortcut: sc("⌘G", "Ctrl+G"), action: props.onFind },
      ],
    },
    {
      title: "View",
      entries: [
        {
          label: "Filer",
          shortcut: sc("⌘⌥←", "Ctrl+Alt+←"),
          checked: panels.filer,
          action: () => togglePanel("filer"),
        },
        {
          label: "Session",
          shortcut: sc("⌘⌥→", "Ctrl+Alt+→"),
          checked: panels.sessions,
          action: () => togglePanel("sessions"),
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
                "Restore panel visibility, timestamp and line display, theme, font sizes, and scrollback to their defaults?",
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

  return (
    <div
      className={`menubar${IS_MAC && !macFullscreen ? " is-mac" : ""}`}
      ref={barRef}
      data-tauri-drag-region
    >
      {menus.map((menu) => (
        <div
          key={menu.title}
          className={`menu-item${open === menu.title ? " is-open" : ""}`}
          onMouseDown={() => setOpen(open === menu.title ? null : menu.title)}
          onMouseEnter={() => open && setOpen(menu.title)}
        >
          {menu.title}
          {open === menu.title && (
            <div className="menu-dropdown">
              {menu.entries.map((entry, index) =>
                entry === "separator" ? (
                  <div key={index} className="menu-separator" />
                ) : entry.children ? (
                  <div
                    key={entry.label}
                    className="menu-submenu-entry"
                    onMouseDown={(event) => event.stopPropagation()}
                  >
                    <div className="menu-entry" role="menuitem">
                      <span className="menu-entry-label">{entry.label}</span>
                      <span className="menu-submenu-arrow" aria-hidden="true">
                        ›
                      </span>
                    </div>
                    <div className="menu-dropdown menu-submenu">
                      {entry.children.map((child) => (
                        <button
                          key={child.label}
                          className={`menu-entry${child.checked ? " is-checked" : ""}`}
                          onMouseDown={(event) => {
                            event.stopPropagation();
                            setOpen(null);
                            child.action?.();
                          }}
                        >
                          <span className="menu-check" aria-hidden="true">
                            {child.checked ? "✓" : ""}
                          </span>
                          <span className="menu-entry-label">{child.label}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <button
                    key={entry.label}
                    className={`menu-entry${entry.checked ? " is-checked" : ""}`}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      setOpen(null);
                      entry.action?.();
                    }}
                  >
                    {entry.checked !== undefined && (
                      <span className="menu-check" aria-hidden="true">
                        {entry.checked ? "✓" : ""}
                      </span>
                    )}
                    <span className="menu-entry-label">{entry.label}</span>
                    {entry.shortcut && (
                      <span className="menu-shortcut">{entry.shortcut}</span>
                    )}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
