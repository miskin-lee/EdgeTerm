import { useEffect, useRef, useState } from "react";
import { ask } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";

import { useStore } from "../store";
import type { GutterMode } from "../terminal";
import { getController } from "../terminalRegistry";

const TUTORIAL_URL = "https://miskin-lee.github.io/EdgeTerm/tutorial.html";

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

  const activeId = useStore((s) => s.activeId);
  const panels = useStore((s) => s.panels);
  const togglePanel = useStore((s) => s.togglePanel);
  const gutterMode = useStore((s) => s.gutterMode);
  const setGutterMode = useStore((s) => s.setGutterMode);
  const resetSettings = useStore((s) => s.resetSettings);
  const setStatus = useStore((s) => s.setStatus);
  const closeTab = useStore((s) => s.closeTab);
  const activateAdjacentTab = useStore((s) => s.activateAdjacentTab);

  useEffect(() => {
    if (!open) return;
    const dismiss = (event: MouseEvent) => {
      if (!barRef.current?.contains(event.target as Node)) setOpen(null);
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

  const menus: Menu[] = [
    {
      title: "Session",
      entries: [
        { label: "New Session…", shortcut: "⌘N", action: props.onNewSession },
        "separator",
        {
          label: "Previous Session",
          shortcut: "⌘←",
          action: () => activateAdjacentTab(-1),
        },
        {
          label: "Next Session",
          shortcut: "⌘→",
          action: () => activateAdjacentTab(1),
        },
        "separator",
        {
          label: "Close Session",
          shortcut: "⌘W",
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
          shortcut: "⌘C",
          action: withActive((id) => {
            const term = getController(id)?.term;
            if (term?.hasSelection())
              void navigator.clipboard.writeText(term.getSelection());
          }),
        },
        {
          label: "Paste",
          shortcut: "⌘V",
          action: withActive(async (id) => {
            const text = await navigator.clipboard.readText();
            if (text) getController(id)?.term.paste(text);
          }),
        },
        "separator",
        {
          label: "Clear Buffer",
          shortcut: "⌘K",
          action: withActive((id) => getController(id)?.clear()),
        },
      ],
    },
    {
      title: "Search",
      entries: [
        { label: "Find…", shortcut: "⌘F", action: props.onFind },
        { label: "Find Next", shortcut: "⌘G", action: props.onFind },
      ],
    },
    {
      title: "View",
      entries: [
        {
          label: "Filer",
          shortcut: "⌘⌥←",
          checked: panels.filer,
          action: () => togglePanel("filer"),
        },
        {
          label: "Session",
          shortcut: "⌘⌥→",
          checked: panels.sessions,
          action: () => togglePanel("sessions"),
        },
        {
          label: "Sender",
          shortcut: "⌘⌥↓",
          checked: panels.sender,
          action: () => togglePanel("sender"),
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
                "Restore panel visibility, timestamp and line display, font sizes, and scrollback to their defaults?",
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
    <div className="menubar" ref={barRef}>
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
