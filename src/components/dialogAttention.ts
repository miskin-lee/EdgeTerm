import type { AnimationEvent } from "react";

/**
 * Flashes a modal dialog to acknowledge a click outside it.
 *
 * A dialog that holds a form must not close on a backdrop click: a stray
 * click used to throw away everything typed into New Session (issue #33).
 * Instead the dialog blinks, the way macOS bounces a modal window and
 * Windows flashes its title bar, so the refused click is still visibly
 * answered. The class drives a CSS animation and `endDialogAttention` takes
 * it off again on `animationend`.
 */
export const DIALOG_ATTENTION_CLASS = "is-attention";

/** Starts (or restarts) the flash on `dialog`. */
export function requestDialogAttention(dialog: HTMLElement | null): void {
  if (!dialog) return;
  // Remove and re-add so a click during a running flash restarts it instead
  // of being swallowed. The layout read in between forces a style flush;
  // without it the browser coalesces the two class changes into no-op.
  dialog.classList.remove(DIALOG_ATTENTION_CLASS);
  void dialog.offsetWidth;
  dialog.classList.add(DIALOG_ATTENTION_CLASS);
}

/** `onAnimationEnd` handler for the dialog element itself. */
export function endDialogAttention(event: AnimationEvent<HTMLElement>): void {
  // `animationend` bubbles: ignore animations of children and any other
  // animation the dialog may run.
  if (event.target !== event.currentTarget) return;
  if (!event.animationName.startsWith("dialog-attention")) return;
  event.currentTarget.classList.remove(DIALOG_ATTENTION_CLASS);
}
