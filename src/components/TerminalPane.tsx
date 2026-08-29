import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { ensureController } from "../actions";
import { IS_MAC } from "../platform";
import { useStore, type Tab } from "../store";
import type { TerminalController } from "../terminal";
import { getController } from "../terminalRegistry";
import { isFileSession } from "../types";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { FtpPane } from "./FtpPane";

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
          <FtpPane
            key={tab.info.id}
            tab={tab}
            active={tab.info.id === activeId}
          />
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
          <h1>EdgeTerm</h1>
          <div className="term-empty-hint">
            <span>No session is open.</span>
            <span>
              Press <kbd>⌘N</kbd> for a new session, or pick one from the
              Session panel.
            </span>
          </div>
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
 * follows the `rightClickAction` setting (Windows console copy-or-paste,
 * a context menu, or plain paste) and middle click always pastes. Clicks
 * are left alone while a program has enabled mouse reporting, except with
 * Shift held on Windows / Linux, which xterm itself treats as "bypass the
 * program" (macOS has no such key: Option is Meta there).
 */
function TerminalHost({ tab, active }: { tab: Tab; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const gutterMode = useStore((s) => s.gutterMode);
  const bufferFontSize = useStore((s) => s.bufferFontSize);
  const terminalScrollback = useStore((s) => s.terminalScrollback);
  const suggestionsEnabled = useStore((s) => s.suggestionsEnabled);
  const rightClickAction = useStore((s) => s.rightClickAction);
  const [menu, setMenu] = useState<TerminalMenu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const id = tab.info.id;

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
    switch (rightClickAction) {
      case "copyPaste":
        // conhost / Windows Terminal: the selection is consumed by the copy.
        if (controller.copySelection()) controller.clearSelection();
        else controller.pasteFromClipboard();
        break;
      case "menu":
        setMenu({
          x: event.clientX,
          y: event.clientY,
          canCopy: controller.hasSelection(),
        });
        break;
    }
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
      disabled: !menu?.canCopy,
      action: withTerminal((controller) => controller.copySelection()),
    },
    {
      label: "Paste",
      action: withTerminal((controller) => controller.pasteFromClipboard()),
    },
    {
      label: "Select All",
      action: withTerminal((controller) => controller.selectAll()),
    },
    "separator",
    {
      label: "Clear Buffer",
      action: withTerminal((controller) => controller.clear()),
    },
  ];

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    ensureController(id).attach(element);

    const observer = new ResizeObserver(() => {
      getController(id)?.fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [id]);

  useEffect(() => {
    getController(id)?.setGutterMode(gutterMode);
  }, [id, gutterMode]);

  useEffect(() => {
    getController(id)?.setFontSize(bufferFontSize);
  }, [bufferFontSize, id]);

  useEffect(() => {
    getController(id)?.setScrollback(terminalScrollback);
  }, [id, terminalScrollback]);

  useEffect(() => {
    getController(id)?.setSuggestions(suggestionsEnabled);
  }, [id, suggestionsEnabled]);

  useEffect(() => {
    getController(id)?.setRightClickAction(rightClickAction);
  }, [id, rightClickAction]);

  useEffect(() => {
    if (!active) return;
    // The pane is hidden while inactive, so it can only be measured and
    // focused once it is on screen again.
    const frame = requestAnimationFrame(() => {
      const controller = getController(id);
      controller?.fit();
      controller?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [active, id]);

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
