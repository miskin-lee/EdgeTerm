import { useEffect, useRef, useState } from "react";

import { useT } from "../i18n";
import { pasteLines } from "../terminalPaste";

interface Props {
  /** The session's tab title, so the user knows which program asks. */
  session: string;
  /** What the program wants on the clipboard. */
  text: string;
  /** Writes it; `always` also lets every program do so from now on. */
  onAllow: (always: boolean) => void;
  onDeny: () => void;
}

const PREVIEW_LINES = 6;
const PREVIEW_COLUMNS = 120;

/**
 * Asked the first time a session's program sets the clipboard with OSC 52
 * (issue #65), the way WindTerm asks. Allowing covers the rest of the
 * session, since a program that copies (tmux, an agent's copy mode) does so
 * on every selection.
 *
 * Enter allows and Esc denies.
 */
export function ClipboardWriteDialog({ session, text, onAllow, onDeny }: Props) {
  const t = useT();
  const allowRef = useRef<HTMLButtonElement>(null);
  const [always, setAlways] = useState(false);
  const alwaysRef = useRef(always);
  alwaysRef.current = always;

  useEffect(() => {
    allowRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        onAllow(alwaysRef.current);
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onDeny();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onAllow, onDeny]);

  const preview = pasteLines(text);
  const shown = preview.slice(0, PREVIEW_LINES);

  return (
    <div className="dialog-backdrop" onMouseDown={onDeny}>
      <div
        className="dialog confirm-dialog paste-warning-dialog"
        role="alertdialog"
        aria-labelledby="clipboard-write-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header" id="clipboard-write-title">
          {t("Allow Clipboard Access")}
        </div>
        <div className="dialog-body confirm-dialog-body">
          <span>
            {t("A program in")} <strong>{session}</strong>{" "}
            {t("wants to copy")}{" "}
            {text.length.toLocaleString()}{" "}
            {t(
              "characters to the clipboard. Allowing it lets this session set the clipboard until it closes.",
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
                {t("… and {count} more lines", {
                  count: preview.length - shown.length,
                })}
              </span>
            )}
          </pre>
          <label className="paste-warning-remember">
            <input
              type="checkbox"
              checked={always}
              onChange={(event) => setAlways(event.target.checked)}
            />
            <span>{t("Always allow programs to set the clipboard")}</span>
          </label>
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Enter</kbd> {t("allow")} · <kbd>Esc</kbd> {t("deny")}
          </span>
          <button type="button" className="btn" onClick={onDeny}>
            {t("Deny")}
          </button>
          <button
            ref={allowRef}
            type="button"
            className="btn is-primary"
            onClick={() => onAllow(always)}
          >
            {t("Allow")}
          </button>
        </div>
      </div>
    </div>
  );
}
