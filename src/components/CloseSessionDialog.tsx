import { useEffect, useRef } from "react";

import type { Tab } from "../store";

interface Props {
  tab: Tab;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation shown before a live session is closed. Enter confirms and
 * Esc cancels, so a keyboard-only ⌘W → Enter still closes the tab in two
 * strokes while a single stray ⌘W no longer drops the connection.
 */
export function CloseSessionDialog({ tab, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Pull focus out of xterm so keystrokes reach the dialog, not the shell.
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        // preventDefault keeps the focused button from also firing a click.
        event.preventDefault();
        onConfirm();
      } else if (event.key === "Escape") {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onCancel, onConfirm]);

  const connecting = tab.state === "connecting";

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        className="dialog close-session-dialog"
        role="alertdialog"
        aria-labelledby="close-session-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header" id="close-session-title">
          Close Session
        </div>
        <div className="dialog-body close-session-body">
          <span>
            Close <strong>{tab.info.name}</strong>?
          </span>
          <span className="close-session-target">
            {tab.info.protocol} · {tab.info.address}
          </span>
          <span className="close-session-hint">
            {connecting
              ? "The connection attempt will be abandoned."
              : "The connection will be terminated and any unsaved work in the remote shell may be lost."}
          </span>
        </div>
        <div className="dialog-footer close-session-footer">
          <span className="close-session-keys">
            <kbd>Enter</kbd> close · <kbd>Esc</kbd> cancel
          </span>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="btn is-primary"
            onClick={onConfirm}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
