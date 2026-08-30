import { useEffect, useRef } from "react";

import type { FileEntry } from "../types";

interface Props {
  entry: FileEntry;
  /** Where the entry lives, shown next to its path: "local" or the session name. */
  location: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Confirmation shown before the Filer deletes a file or folder, whether the
 * request came from the toolbar or the row's context menu. Enter confirms
 * and Esc cancels, so a stray click can no longer remove something on a
 * remote host without a second look.
 */
export function DeleteEntryDialog({
  entry,
  location,
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

  const kind = entry.isSymlink ? "link" : entry.isDir ? "folder" : "file";
  const title =
    kind === "folder" ? "Delete Folder" : kind === "link" ? "Delete Link" : "Delete File";
  // Both the local and the SFTP backend refuse to remove a folder with
  // anything in it, so say so rather than let the error explain afterwards.
  const hint =
    kind === "folder"
      ? "Only an empty folder can be deleted. This cannot be undone."
      : kind === "link"
        ? "Only the link itself is removed; what it points to is left alone. This cannot be undone."
        : "The file will be removed. This cannot be undone.";

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        className="dialog confirm-dialog"
        role="alertdialog"
        aria-labelledby="delete-entry-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header" id="delete-entry-title">
          {title}
        </div>
        <div className="dialog-body confirm-dialog-body">
          <span>
            Delete {kind} <strong>{entry.name}</strong>?
          </span>
          <span className="confirm-dialog-target">
            {location} · {entry.path}
          </span>
          <span className="confirm-dialog-hint">{hint}</span>
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
