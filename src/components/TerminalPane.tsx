import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import appIcon from "../../src-tauri/icons/128x128@2x.png";
import { ensureController, revealCwdInFiler } from "../actions";
import { IS_MAC, shortcutLabel as sc } from "../platform";
import { useStore, type Tab } from "../store";
import type { TerminalController } from "../terminal";
import { getController } from "../terminalRegistry";
import { isFileSession } from "../types";
import { ContextMenu, type MenuItem } from "./ContextMenu";

// The dual-pane file workspace only exists for FTP and SFTP tabs, so it loads
// with the first one instead of with the window.
const FtpPane = lazy(() =>
  import("./FtpPane").then((module) => ({ default: module.FtpPane })),
);

interface Props {
  onNewSession: () => void;
}

export function TerminalPane({ onNewSession }: Props) {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);

  return (
    <div className="term-stack">
      {tabs.map((tab) => (
        isFileSession(tab.info.kind) ? (
          <Suspense key={tab.info.id} fallback={null}>
            <FtpPane tab={tab} active={tab.info.id === activeId} />
          </Suspense>
        ) : (
          <TerminalHost
            key={tab.info.id}
            tab={tab}
            active={tab.info.id === activeId}
          />
        )
      ))}

      {tabs.length === 0 && (
        <div className="term-empty">
          <img
            className="term-empty-icon"
            src={appIcon}
            alt=""
            draggable={false}
          />
          <h1>EdgeTerm</h1>
          <p className="term-empty-hint">
            Press <kbd>{sc("⌘N", "Alt+N")}</kbd> for a new session, or pick one
            from the Session panel.
          </p>
          <button className="btn is-primary" onClick={onNewSession}>
            New Session
          </button>
        </div>
      )}
    </div>
  );
}

/** The terminal's right-click menu, with the entries' state when it opened. */
interface TerminalMenu {
  x: number;
  y: number;
  canCopy: boolean;
}

/**
 * Mouse copy / paste, the way terminals conventionally do it: right click
 * opens a context menu (the same on every platform) and middle click
 * pastes. Clicks are left alone while a program has enabled mouse
 * reporting, except with Shift held on Windows / Linux, which xterm itself
 * treats as "bypass the program" (macOS has no such key: Option is Meta
 * there).
 */
function TerminalHost({ tab, active }: { tab: Tab; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const gutterMode = useStore((s) => s.gutterMode);
  const bufferFontSize = useStore((s) => s.bufferFontSize);
  const terminalScrollback = useStore((s) => s.terminalScrollback);
  const suggestionsEnabled = useStore((s) => s.suggestionsEnabled);
  const [menu, setMenu] = useState<TerminalMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const id = tab.info.id;
  // xterm loads on demand, so the terminal can arrive a tick after the pane
  // first renders (see ensureController). Effects that looked it up in the
  // registry right away found nothing and silently did nothing — which cost
  // the active tab its `setVisible(true)`, and with it the WebGL renderer and
  // the semantic colors that ride on it. Keeping it in state re-runs them the
  // moment it exists.
  const [terminal, setTerminal] = useState<TerminalController | null>(null);

  const ownsClick = (event: ReactMouseEvent) => {
    const controller = getController(id);
    if (!controller) return null;
    if (controller.isMouseTracked() && (IS_MAC || !event.shiftKey)) {
      return null;
    }
    return controller;
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const controller = ownsClick(event);
    if (!controller) return;
    event.preventDefault();
    setMenu({
      x: event.clientX,
      y: event.clientY,
      canCopy: controller.hasSelection(),
    });
  };

  // Middle click: xterm positions its textarea under the pointer so a
  // browser's native primary-selection paste (Linux) lands in the terminal.
  // That would double up with ours, so both the mouseup and the auxclick
  // default actions are cancelled and the clipboard is pasted explicitly.
  const onMiddleButton = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 1) return;
    const controller = ownsClick(event);
    if (!controller) return;
    event.preventDefault();
    if (event.type === "auxclick") {
      controller.focus();
      controller.pasteFromClipboard();
    }
  };

  // Menu entries run after the menu closed; the terminal takes focus back
  // from the clicked entry so a paste lands in it and typing continues.
  const withTerminal = (fn: (controller: TerminalController) => void) => () => {
    const controller = getController(id);
    if (!controller) return;
    controller.focus();
    fn(controller);
  };

  const menuItems: MenuItem[] = [
    {
      label: "Copy",
      icon: "copy",
      shortcut: sc("⌘C", "Ctrl+Shift+C"),
      disabled: !menu?.canCopy,
      action: withTerminal((controller) => controller.copySelection()),
    },
    {
      label: "Paste",
      icon: "clippy",
      shortcut: sc("⌘V", "Ctrl+Shift+V"),
      action: withTerminal((controller) => controller.pasteFromClipboard()),
    },
    {
      label: "Select All",
      icon: "list-selection",
      shortcut: sc("⌘A", "Ctrl+Shift+A"),
      action: withTerminal((controller) => controller.selectAll()),
    },
    "separator",
    {
      label: "Clear Buffer",
      icon: "clear-all",
      shortcut: sc("⌘K", "Alt+K"),
      action: withTerminal((controller) => controller.clear()),
    },
    "separator",
    {
      label: "Reveal Working Directory in Filer",
      icon: "folder-opened",
      shortcut: sc("⌘J", "Ctrl+Shift+J"),
      action: withTerminal(() => void revealCwdInFiler(id)),
    },
  ];

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // The terminal already exists by the time a session is open; this only
    // waits when the xterm module is still on its way (see ensureController).
    let live = true;
    void ensureController(id).then((controller) => {
      if (!live) return;
      controller.attach(element);
      setTerminal(controller);
    });

    const observer = new ResizeObserver(() => {
      getController(id)?.fit();
    });
    observer.observe(element);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [id]);

  useEffect(() => {
    terminal?.setGutterMode(gutterMode);
  }, [terminal, gutterMode]);

  useEffect(() => {
    terminal?.setFontSize(bufferFontSize);
  }, [bufferFontSize, terminal]);

  useEffect(() => {
    terminal?.setScrollback(terminalScrollback);
  }, [terminal, terminalScrollback]);

  useEffect(() => {
    terminal?.setSuggestions(suggestionsEnabled);
  }, [terminal, suggestionsEnabled]);

  useEffect(() => {
    if (!terminal) return;
    // The terminal keeps its WebGL renderer for the tabs shown recently
    // and gives it up for the rest; see TerminalController.setVisible.
    terminal.setVisible(active);
    if (!active) return;
    // The pane is hidden while inactive, so it can only be measured and
    // focused once it is on screen again.
    const frame = requestAnimationFrame(() => {
      terminal.fit();
      terminal.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, terminal]);

  return (
    <>
      <div
        ref={ref}
        className={`term-pane${active ? "" : " is-hidden"}`}
        onContextMenu={onContextMenu}
        onMouseUp={onMiddleButton}
        onAuxClick={onMiddleButton}
      />
      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems} onClose={closeMenu} />
      )}
    </>
  );
}
