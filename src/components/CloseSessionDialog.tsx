import { useEffect, useRef } from "react";

import { tabTitle, type Tab } from "../store";

interface Props {
  /** The live tabs about to close: one, or a strip's worth at once. */
  tabs: Tab[];
  onConfirm: () => void;
  onCancel: () => void;
}

/** Names shown before a bulk close is summarised as "… and N more". */
const LISTED_TABS = 6;

/**
 * Confirmation shown before a live session tab is closed. Enter confirms and
 * Esc cancels, so a stray ⌘W or a mis-click on the tab's ✕ can no longer
 * drop an open SSH / serial / FTP session and its scrollback without asking.
 */
export function CloseSessionDialog({ tabs, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

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

  const single = tabs.length === 1 ? tabs[0] : null;
  const connecting = tabs.some((tab) => tab.state === "connecting");
  const connected = tabs.some((tab) => tab.state === "connected");
  const hint = connecting && connected
    ? "Connected sessions will be disconnected and their terminal output discarded; connection attempts will be cancelled."
    : connecting
      ? tabs.length === 1
        ? "The connection attempt will be cancelled."
        : "The connection attempts will be cancelled."
      : tabs.length === 1
        ? "The session will be disconnected and its terminal output discarded."
        : "The sessions will be disconnected and their terminal output discarded.";
  // A long list is summarised rather than scrolled: the names are a
  // reminder, the decision is the count.
  const listed = tabs.slice(0, LISTED_TABS);

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        className="dialog confirm-dialog"
        role="alertdialog"
        aria-labelledby="close-session-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header" id="close-session-title">
          {single ? "Close Session" : `Close ${tabs.length} Sessions`}
        </div>
        <div className="dialog-body confirm-dialog-body">
          {single ? (
            <>
              <span>
                Close <strong>{single.info.name}</strong>?
              </span>
              <span className="confirm-dialog-target">
                {single.info.protocol} · {single.info.address}
              </span>
            </>
          ) : (
            <>
              <span>
                Close <strong>{tabs.length} sessions</strong>?
              </span>
              {listed.map((tab) => (
                <span className="confirm-dialog-target" key={tab.info.id}>
                  {tabTitle(tab)} · {tab.info.protocol} · {tab.info.address}
                </span>
              ))}
              {tabs.length > listed.length && (
                <span className="confirm-dialog-target">
                  … and {tabs.length - listed.length} more
                </span>
              )}
            </>
          )}
          <span className="confirm-dialog-hint">{hint}</span>
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Enter</kbd> close · <kbd>Esc</kbd> cancel
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
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
