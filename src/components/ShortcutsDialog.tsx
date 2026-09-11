import { useEffect, useRef, useState } from "react";

import { IS_MAC } from "../platform";
import {
  chordFromEvent,
  chordLabel,
  chordProblem,
  defaultShortcuts,
  sameChord,
  SHORTCUT_COMMANDS,
  type ShortcutBindings,
  type ShortcutCommand,
} from "../shortcuts";
import { endDialogAttention, requestDialogAttention } from "./dialogAttention";
import { Icon } from "./icons";

interface Props {
  bindings: ShortcutBindings;
  onApply: (bindings: ShortcutBindings) => void;
  onClose: () => void;
}

/** The shortcuts this dialog cannot change, shown so they are not hunted for. */
const FIXED_SHORTCUTS: { keys: string; label: string }[] = IS_MAC
  ? [{ keys: "⌘1–⌘9", label: "Switch to tab N" }]
  : [{ keys: "Alt+1–Alt+9", label: "Switch to tab N" }];

/**
 * Rebinds the application's keyboard shortcuts. A row records the next chord
 * pressed while it is armed; only the tab-number keys stay fixed (see
 * `chordProblem`).
 */
export function ShortcutsDialog({ bindings, onApply, onClose }: Props) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState<ShortcutBindings>(() => ({ ...bindings }));
  const [recording, setRecording] = useState<ShortcutCommand | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Every key belongs to the row being recorded, so nothing reaches the
      // window shortcut handler, the browser or the terminal underneath.
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setRecording(null);
        return;
      }
      const chord = chordFromEvent(event);
      if (!chord) return;
      const problem = chordProblem(chord);
      if (problem) {
        setNotice(problem);
        return;
      }
      // One chord, one command: whoever held it before gives it up, so the
      // table can never be applied with two commands on the same keys.
      const taken = SHORTCUT_COMMANDS.find(
        ({ id }) => id !== recording && sameChord(draft[id], chord),
      );
      setRecording(null);
      setNotice(
        taken ? `${chordLabel(chord)} was taken from ${taken.label}.` : null,
      );
      setDraft((current) => {
        const next = { ...current, [recording]: chord };
        if (taken) next[taken.id] = null;
        return next;
      });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [draft, recording]);

  useEffect(() => {
    if (recording) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    // Capture phase so the dialog answers before any global shortcut handler.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onClose, recording]);

  const unassign = (command: ShortcutCommand) => {
    setRecording(null);
    setNotice(null);
    setDraft((current) => ({ ...current, [command]: null }));
  };

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={() => requestDialogAttention(dialogRef.current)}
    >
      <form
        ref={dialogRef}
        className="dialog shortcuts-dialog"
        onMouseDown={(event) => event.stopPropagation()}
        onAnimationEnd={endDialogAttention}
        onSubmit={(event) => {
          event.preventDefault();
          onApply(draft);
        }}
      >
        <div className="dialog-header">Keyboard Shortcuts</div>
        <div className="dialog-body shortcuts-dialog-body">
          <div className="shortcuts-list">
            {SHORTCUT_COMMANDS.map(({ id, label, hint }) => {
              const chord = draft[id];
              const armed = recording === id;
              return (
                <div key={id} className="shortcut-row">
                  <span className="shortcut-command">
                    <strong>{label}</strong>
                    <small>{hint}</small>
                  </span>
                  <button
                    type="button"
                    className={`shortcut-key${armed ? " is-recording" : ""}${
                      !armed && !chord ? " is-unset" : ""
                    }`}
                    aria-label={`${label} shortcut`}
                    onClick={() => {
                      setNotice(null);
                      setRecording(armed ? null : id);
                    }}
                  >
                    {armed
                      ? "Press keys…"
                      : chord
                        ? chordLabel(chord)
                        : "Unassigned"}
                  </button>
                  <button
                    type="button"
                    className="shortcut-clear"
                    title="Remove shortcut"
                    aria-label={`Remove the ${label} shortcut`}
                    disabled={!chord}
                    onClick={() => unassign(id)}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              );
            })}
          </div>

          <p className="shortcuts-notice" role="status">
            {notice ??
              (recording
                ? "Press the combination, or Esc to keep the current one."
                : "")}
          </p>

          <div className="shortcuts-fixed">
            <strong>Fixed</strong>
            {FIXED_SHORTCUTS.map(({ keys, label }) => (
              <span key={keys}>
                <kbd>{keys}</kbd> {label}
              </span>
            ))}
          </div>
        </div>
        <div className="dialog-footer shortcuts-dialog-footer">
          <button
            type="button"
            className="btn shortcuts-reset"
            onClick={() => {
              setRecording(null);
              setNotice(null);
              setDraft(defaultShortcuts());
            }}
          >
            Reset Defaults
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn is-primary">
            Apply
          </button>
        </div>
      </form>
    </div>
  );
}
