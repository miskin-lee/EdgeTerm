import { useEffect, useRef, useState } from "react";

import { t, tf } from "../i18n";
import { pasteLineCount, pasteLines } from "../terminalPaste";

interface Props {
  /** The clipboard text waiting to go into the terminal. */
  text: string;
  /** Pastes it; `remember` also turns the warning off for good. */
  onConfirm: (remember: boolean) => void;
  onCancel: () => void;
}

/** Lines of the paste shown before the rest is summarised. */
const PREVIEW_LINES = 6;
/** How much of a line is shown; the rest is a tail the user cannot read anyway. */
const PREVIEW_COLUMNS = 120;

/**
 * Confirmation shown before a paste that would submit more than one command
 * (issue #63). The shell runs every line as it arrives, so a clipboard that
 * turned out to hold six lines is six commands on a production host — the
 * reason Windows Terminal, iTerm2 and Xshell all ask first.
 *
 * Enter pastes and Esc cancels, so the common answer costs one keystroke.
 */
export function PasteWarningDialog({ text, onConfirm, onCancel }: Props) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  const [remember, setRemember] = useState(false);
  // Read once: the checkbox must not change what Enter does mid-keystroke.
  const rememberRef = useRef(remember);
  rememberRef.current = remember;

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
        onConfirm(rememberRef.current);
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

  const lines = pasteLineCount(text);
  const preview = pasteLines(text);
  const shown = preview.slice(0, PREVIEW_LINES);

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <div
        className="dialog confirm-dialog paste-warning-dialog"
        role="alertdialog"
        aria-labelledby="paste-warning-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header" id="paste-warning-title">
          {lines > 1
            ? tf("Paste {n} Lines", { n: lines })
            : t("Paste Long Text")}
        </div>
        <div className="dialog-body confirm-dialog-body">
          <span>
            {lines > 1 ? (
              <>
                {t("The clipboard holds")}{" "}
                <strong>{tf("{n} lines", { n: lines })}</strong>{" "}
                {tf(
                  "({n} characters). Every line after the first runs as its own command.",
                  { n: text.length.toLocaleString() },
                )}
              </>
            ) : (
              <>
                {t("The clipboard holds")}{" "}
                <strong>
                  {tf("{n} characters", {
                    n: text.length.toLocaleString(),
                  })}
                </strong>{" "}
                {t("on one line.")}
              </>
            )}
          </span>
          <pre className="paste-warning-preview">
            {shown.map((line, index) => (
              <span key={index}>
                {line.length > PREVIEW_COLUMNS
                  ? `${line.slice(0, PREVIEW_COLUMNS)}…`
                  : line}
                {"\n"}
              </span>
            ))}
            {preview.length > shown.length && (
              <span className="paste-warning-more">
                {tf("… and {n} more lines", {
                  n: preview.length - shown.length,
                })}
              </span>
            )}
          </pre>
          <label className="paste-warning-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>{t("Don’t warn me again")}</span>
          </label>
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Enter</kbd> {t("paste")} · <kbd>Esc</kbd> {t("cancel")}
          </span>
          <button type="button" className="btn" onClick={onCancel}>
            {t("Cancel")}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className="btn is-primary"
            onClick={() => onConfirm(remember)}
          >
            {t("Paste")}
          </button>
        </div>
      </div>
    </div>
  );
}
