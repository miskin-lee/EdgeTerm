import { useEffect, useRef } from "react";

import { tabTitle, useStore } from "../store";

interface Props {
  onConfirm: () => void;
  onCancel: () => void;
}

const LISTED_SESSIONS = 4;

/**
 * Confirmation shown when the app is asked to quit (window ✕, ⌘Q, Alt+F4)
 * while session tabs are still connecting or connected, so one stray gesture
 * cannot drop every open connection at once. Enter quits and Esc cancels.
 */
export function QuitConfirmDialog({ onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const tabs = useStore((s) => s.tabs);
  const live = tabs.filter(
    (tab) => tab.state === "connecting" || tab.state === "connected",
  );

  useEffect(() => {
    // Pull focus out of the terminal so keystrokes reach the dialog.
    confirmRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        // preventDefault keeps the focused button from also firing a click.
        event.preventDefault();
        event.stopPropagation();
        onConfirm();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    // Capture phase so the dialog answers before any global shortcut handler.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel, onConfirm]);

  const shown = live.slice(0, LISTED_SESSIONS);
  const extra = live.length - shown.length;

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        className="dialog confirm-dialog"
        role="alertdialog"
        aria-labelledby="quit-app-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header" id="quit-app-title">
          Quit EdgeTerm
        </div>
        <div className="dialog-body confirm-dialog-body">
          <span>
            Quit with{" "}
            <strong>
              {live.length} active session{live.length === 1 ? "" : "s"}
            </strong>
            ?
          </span>
          {shown.map((tab) => (
            <span key={tab.info.id} className="confirm-dialog-target">
              {tabTitle(tab)} · {tab.info.protocol}
            </span>
          ))}
          {extra > 0 && (
            <span className="confirm-dialog-target">…and {extra} more</span>
          )}
          <span className="confirm-dialog-hint">
            All connections will be disconnected and their terminal output
            discarded.
          </span>
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Enter</kbd> quit · <kbd>Esc</kbd> cancel
          </span>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="btn is-danger"
            onClick={onConfirm}
          >
            Quit
          </button>
        </div>
      </div>
    </div>
  );
}
