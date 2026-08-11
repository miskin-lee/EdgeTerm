import { useEffect, useRef, useState } from "react";

import { useStore } from "../store";
import type { GutterMode } from "../terminal";
import { getController } from "../terminalRegistry";

interface Entry {
  label: string;
  shortcut?: string;
  checked?: boolean;
  action: () => void;
}

interface Menu {
  title: string;
  entries: (Entry | "separator")[];
}

interface Props {
  onNewSession: () => void;
  onQuickConnect: () => void;
  onFind: () => void;
  onGotoLine: () => void;
  onSerialPorts: () => void;
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
  const closeTab = useStore((s) => s.closeTab);

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
        { label: "Quick Connect…", shortcut: "⌘T", action: props.onQuickConnect },
        "separator",
        {
          label: "Close Session",
          shortcut: "⌘W",
          action: withActive((id) => void closeTab(id)),
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
      title: "Selection",
      entries: [
        {
          label: "Select All",
          shortcut: "⌘A",
          action: withActive((id) => getController(id)?.term.selectAll()),
        },
        {
          label: "Clear Selection",
          action: withActive((id) => getController(id)?.term.clearSelection()),
        },
      ],
    },
    {
      title: "Goto",
      entries: [
        { label: "Go to Line…", shortcut: "⌃G", action: props.onGotoLine },
        {
          label: "Scroll to Top",
          action: withActive((id) => getController(id)?.term.scrollToTop()),
        },
        {
          label: "Scroll to Bottom",
          action: withActive((id) => getController(id)?.term.scrollToBottom()),
        },
      ],
    },
    {
      title: "View",
      entries: [
        {
          label: "Explorer",
          checked: panels.explorer,
          action: () => togglePanel("explorer"),
        },
        {
          label: "Filer",
          checked: panels.filer,
          action: () => togglePanel("filer"),
        },
        {
          label: "Session",
          checked: panels.sessions,
          action: () => togglePanel("sessions"),
        },
        {
          label: "Outline",
          checked: panels.outline,
          action: () => togglePanel("outline"),
        },
        {
          label: "Sender",
          checked: panels.sender,
          action: () => togglePanel("sender"),
        },
      ],
    },
    {
      title: "Mode",
      entries: [
        gutterEntry("Timestamp + Line Number", "both"),
        gutterEntry("Line Number Only", "line"),
        gutterEntry("Timestamp Only", "time"),
        gutterEntry("No Gutter", "off"),
      ],
    },
    {
      title: "Tool",
      entries: [
        { label: "Serial Ports…", action: props.onSerialPorts },
      ],
    },
    {
      title: "Help",
      entries: [{ label: "About EdgeTerm", action: props.onAbout }],
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
                ) : (
                  <button
                    key={entry.label}
                    className={`menu-entry${entry.checked ? " is-checked" : ""}`}
                    onMouseDown={(event) => {
                      event.stopPropagation();
                      setOpen(null);
                      entry.action();
                    }}
                  >
                    <span>{entry.label}</span>
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

      <div className="menubar-spacer" />
      <button className="menubar-action" onClick={props.onFind}>
        Search
      </button>
      <button className="menubar-action" onClick={props.onNewSession}>
        + Session
      </button>
    </div>
  );
}
