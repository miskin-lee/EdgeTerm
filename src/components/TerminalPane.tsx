import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { ensureController, revealCwdInFiler } from "../actions";
import { fontStack } from "../fonts";
import { IS_MAC, shortcutLabel as sc } from "../platform";
import { chordLabel, type ShortcutCommand } from "../shortcuts";
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
  tab: Tab;
  /** Shown in its pane: the tab its strip has selected. */
  visible: boolean;
  /** The active tab of the active pane, which is where keys go. */
  focused: boolean;
  /** Where the pane sits in the workspace; see `Workspace`. */
  style: CSSProperties;
}

/** The user-configurable accelerator for `command`, as a menu writes it. */
export const useAccelerator = (command: ShortcutCommand): string =>
  useStore((s) => chordLabel(s.shortcuts[command]));

export function SessionPane({ tab, visible, focused, style }: Props) {
  const setActive = useStore((s) => s.setActive);
  const id = tab.info.id;

  // A press or keyboard focus anywhere in the pane makes its session the
  // active one — menus, the Filer and the Sender follow it — the way a
  // click in a VS Code editor group focuses that group. Capture phase, so
  // xterm's own mousedown handling is untouched.
  const claim = () => {
    if (useStore.getState().activeId !== id) setActive(id);
  };

  return (
    <div
      className={`pane-slot${visible ? "" : " is-hidden"}`}
      style={style}
      onMouseDownCapture={claim}
      onFocusCapture={claim}
    >
      {isFileSession(tab.info.kind) ? (
        <Suspense fallback={null}>
          <FtpPane tab={tab} active={visible} />
        </Suspense>
      ) : (
        <TerminalHost tab={tab} visible={visible} focused={focused} />
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
 * follows the `rightClickAction` setting (a context menu, or the Windows
 * console's copy-or-paste on Windows / Linux) and middle click always
 * pastes. Clicks are left alone while a program has enabled mouse
 * reporting, except with Shift held on Windows / Linux, which xterm itself
 * treats as "bypass the program" (macOS has no such key: Option is Meta
 * there).
 */
function TerminalHost({
  tab,
  visible,
  focused,
}: {
  tab: Tab;
  visible: boolean;
  focused: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const gutterMode = useStore((s) => s.gutterMode);
  const bufferFontSize = useStore((s) => s.bufferFontSize);
  const bufferFontFamily = useStore((s) => s.bufferFontFamily);
  const terminalScrollback = useStore((s) => s.terminalScrollback);
  const cursorStyle = useStore((s) => s.cursorStyle);
  const cursorBlink = useStore((s) => s.cursorBlink);
  const suggestionsEnabled = useStore((s) => s.suggestionsEnabled);
  const rightClickAction = useStore((s) => s.rightClickAction);
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
  const clearKey = useAccelerator("clear");
  const revealCwdKey = useAccelerator("revealCwd");

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
    if (rightClickAction === "copyPaste") {
      // conhost / Windows Terminal: the selection is consumed by the copy.
      if (controller.copySelection()) controller.clearSelection();
      else controller.pasteFromClipboard();
      return;
    }
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
      shortcut: clearKey,
      action: withTerminal((controller) => controller.clear()),
    },
    "separator",
    {
      label: "Reveal Working Directory in Filer",
      icon: "folder-opened",
      shortcut: revealCwdKey,
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
    terminal?.setFontFamily(fontStack("mono", bufferFontFamily));
  }, [bufferFontFamily, terminal]);

  useEffect(() => {
    terminal?.setScrollback(terminalScrollback);
  }, [terminal, terminalScrollback]);

  useEffect(() => {
    terminal?.setCursor(cursorStyle, cursorBlink);
  }, [terminal, cursorStyle, cursorBlink]);

  useEffect(() => {
    terminal?.setSuggestions(suggestionsEnabled);
  }, [terminal, suggestionsEnabled]);

  useEffect(() => {
    terminal?.setRightClickAction(rightClickAction);
  }, [terminal, rightClickAction]);

  useEffect(() => {
    if (!terminal) return;
    // The terminal keeps its WebGL renderer for the tabs shown recently
    // and gives it up for the rest; see TerminalController.setVisible.
    terminal.setVisible(visible);
    if (!visible) return;
    // The pane is hidden while its strip shows another tab, so it can only
    // be measured once it is on screen again.
    const frame = requestAnimationFrame(() => terminal.fit());
    return () => cancelAnimationFrame(frame);
  }, [visible, terminal]);

  // Keys go to the active tab of the active pane; a tab shown in another
  // pane stays visible without taking them.
  useEffect(() => {
    if (!terminal || !focused) return;
    const frame = requestAnimationFrame(() => terminal.focus());
    return () => cancelAnimationFrame(frame);
  }, [focused, terminal]);

  return (
    <>
      <div
        ref={ref}
        className="term-pane"
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
