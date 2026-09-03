import { useEffect, useRef, useState, type FormEvent } from "react";

import * as api from "../api";
import type { AuthPrompt } from "../types";
import {
  endDialogAttention,
  requestDialogAttention,
} from "./dialogAttention";

interface Props {
  prompt: AuthPrompt;
  /** Takes the answered round off the queue, whatever the answer was. */
  onDone: () => void;
}

/**
 * One round of an SSH server's keyboard-interactive challenge: the second
 * factor after a password or a public key — a verification code, a push
 * confirmation, a menu choice. The connection is stopped mid-handshake while
 * this is open, and a server may ask several rounds in a row, so the dialog
 * is rebuilt for each one. Nothing typed here is saved.
 */
export function AuthPromptDialog({ prompt, onDone }: Props) {
  const dialogRef = useRef<HTMLFormElement>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const [answers, setAnswers] = useState<string[]>(() =>
    prompt.prompts.map(() => ""),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Pull focus out of whatever was active so the code can just be typed.
    firstField.current?.focus();
  }, []);

  /** Releases the waiting connection; it reports the cancelled login. */
  const cancel = () => {
    void api.answerAuthPrompt(prompt.id, null).catch(() => undefined);
    onDone();
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    // Capture phase so the dialog answers before any global shortcut handler.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [busy, prompt.id, onDone]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.answerAuthPrompt(prompt.id, answers);
      onDone();
    } catch (e) {
      // The round timed out or the session went away: there is nothing left
      // to answer, so let the user dismiss it.
      setError(String(e));
      setBusy(false);
    }
  };

  const title = prompt.name.trim() || "Verification Required";

  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(event) => {
        // The server is waiting on these answers; a stray click must not
        // discard them (see issue #33). Flash instead of closing.
        event.preventDefault();
        requestDialogAttention(dialogRef.current);
      }}
    >
      <form
        ref={dialogRef}
        className="dialog confirm-dialog auth-prompt-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-prompt-title"
        onMouseDown={(event) => event.stopPropagation()}
        onAnimationEnd={endDialogAttention}
        onSubmit={(event) => void submit(event)}
      >
        <div className="dialog-header" id="auth-prompt-title">
          {title}
        </div>
        <div className="dialog-body confirm-dialog-body">
          <span>
            <strong>{prompt.address}</strong> asked{" "}
            <strong>{prompt.username}</strong> for another authentication
            factor.
          </span>
          {prompt.instructions.trim() && (
            <p className="auth-prompt-instructions">{prompt.instructions}</p>
          )}
          {prompt.prompts.map((field, index) => (
            <label className="auth-prompt-field" key={index}>
              <span>{field.prompt.trim() || "Response"}</span>
              <input
                ref={index === 0 ? firstField : undefined}
                type={field.echo ? "text" : "password"}
                value={answers[index]}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={busy}
                onChange={(event) =>
                  setAnswers((previous) =>
                    previous.map((answer, at) =>
                      at === index ? event.target.value : answer,
                    ),
                  )
                }
              />
            </label>
          ))}
          <span className="confirm-dialog-hint">
            Answers are sent to the server for this login only; EdgeTerm never
            stores them.
          </span>
          {error && <div className="dialog-error">{error}</div>}
        </div>
        <div className="dialog-footer confirm-dialog-footer">
          <span className="confirm-dialog-keys">
            <kbd>Esc</kbd> cancel
          </span>
          <button
            type="button"
            className="btn"
            onClick={cancel}
            disabled={busy}
          >
            Cancel
          </button>
          <button type="submit" className="btn is-primary" disabled={busy}>
            {busy ? "Sending…" : "Continue"}
          </button>
        </div>
      </form>
    </div>
  );
}
