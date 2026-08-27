import { useEffect, useRef } from "react";

import type { SessionProfile } from "../types";

interface Props {
  profile: SessionProfile;
  /** One-line summary of the connection target, shown under the name. */
  target: string;
  /** Saved Sender commands scoped to this profile alone; they go with it. */
  scopedCommands: number;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation shown before a saved session profile is deleted. Enter
 * confirms and Esc cancels, so a stray click on the ✕ button no longer
 * silently drops a saved host and its credentials. Everything that belongs
 * to the profile goes with it, so the dialog spells out what that is.
 */
export function DeleteProfileDialog({
  profile,
  target,
  scopedCommands,
  onConfirm,
  onCancel,
}: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Pull focus out of whatever was active so keystrokes reach the dialog.
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

  const commands =
    scopedCommands === 0
      ? ""
      : scopedCommands === 1
        ? " and its 1 saved Sender command"
        : ` and its ${scopedCommands} saved Sender commands`;

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        className="dialog confirm-dialog"
        role="alertdialog"
        aria-labelledby="delete-profile-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header" id="delete-profile-title">
          Delete Session
        </div>
        <div className="dialog-body confirm-dialog-body">
          <span>
            Delete <strong>{profile.name}</strong>?
          </span>
          <span className="confirm-dialog-target">
            {profile.kind} · {target}
          </span>
          <span className="confirm-dialog-hint">
            The saved session, any stored credentials for it{commands} will
            be removed. This cannot be undone.
          </span>
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Enter</kbd> delete · <kbd>Esc</kbd> cancel
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
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
