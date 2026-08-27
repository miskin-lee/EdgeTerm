import { useEffect, useRef, useState } from "react";

interface Props {
  title: string;
  /** Where the group lives, e.g. "SSH Sessions / prod". */
  location: string;
  initialName?: string;
  submitLabel: string;
  /** Rejections are shown inline and keep the dialog open. */
  onSubmit: (name: string) => Promise<void>;
  onCancel: () => void;
}

/** Asks for a group name when creating or renaming a Session panel group. */
export function GroupNameDialog({
  title,
  location,
  initialName = "",
  submitLabel,
  onSubmit,
  onCancel,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
    };
    // Capture phase so the dialog answers before any global shortcut handler.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Enter a group name.");
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={onCancel}>
      <form
        className="dialog confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="group-name-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="dialog-header" id="group-name-title">
          {title}
        </div>
        <div className="dialog-body confirm-dialog-body">
          <label className="session-field is-wide">
            <span className="session-field-label">Name</span>
            <input
              ref={inputRef}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              value={name}
              placeholder="Group name"
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <span className="confirm-dialog-hint">In {location}</span>
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Enter</kbd> {submitLabel.toLowerCase()} · <kbd>Esc</kbd>{" "}
            cancel
          </span>
          <button type="button" className="btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn is-primary" disabled={busy}>
            {submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
