import { useEffect, useRef, useState } from "react";

import type { HostKeyPrompt } from "../store";

interface Props {
  prompt: HostKeyPrompt;
  /** Records the new key and reconnects; rejects if known_hosts can't be updated. */
  onAccept: () => Promise<void>;
  onCancel: () => void;
}

/** The file under /etc/ssh whose fingerprint the user can compare against. */
function serverKeyFile(keyType: string): string {
  const family = ["ed25519", "ecdsa", "rsa"].find((name) =>
    keyType.includes(name),
  );
  return `/etc/ssh/ssh_host_${family ?? "<type>"}_key.pub`;
}

/**
 * Shown when an SSH server presents a key that differs from the one recorded
 * for it. The safe answer is the default: Cancel has focus, Esc cancels, and
 * accepting takes a deliberate click.
 */
export function HostKeyDialog({ prompt, onAccept, onCancel }: Props) {
  const { change } = prompt;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // Pull focus out of whatever was active so keystrokes reach the dialog.
    cancelRef.current?.focus();
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

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      // On success the prompt is cleared and this dialog unmounts.
      await onAccept();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" onMouseDown={busy ? undefined : onCancel}>
      <div
        className="dialog confirm-dialog host-key-dialog"
        role="alertdialog"
        aria-labelledby="host-key-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="dialog-header" id="host-key-title">
          Host Key Changed
        </div>
        <div className="dialog-body confirm-dialog-body">
          <span>
            <strong>
              {change.host}:{change.port}
            </strong>{" "}
            presented a key that does not match the one recorded for it.
          </span>
          <dl className="host-key-facts">
            <dt>New key</dt>
            <dd>
              {change.keyType} {change.fingerprint}
            </dd>
            <dt>Recorded in</dt>
            <dd>
              {change.knownHosts}, line {change.line}
            </dd>
          </dl>
          <span className="confirm-dialog-hint">
            Accept only if you expect this — the server was reinstalled, or the
            address now belongs to a different machine. A changed key can also
            mean the connection is being intercepted; when in doubt, cancel and
            compare the fingerprint with{" "}
            <code>ssh-keygen -lf {serverKeyFile(change.keyType)}</code> on the
            server. Accepting replaces every key recorded for this host.
          </span>
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Esc</kbd> cancel
          </span>
          <button
            ref={cancelRef}
            type="button"
            className="btn"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn is-danger"
            onClick={() => void accept()}
            disabled={busy}
          >
            {busy ? "Accepting…" : "Accept New Key"}
          </button>
        </div>
      </div>
    </div>
  );
}
