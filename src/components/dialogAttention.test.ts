import { describe, expect, it } from "vitest";

import type { AnimationEvent } from "react";

import {
  DIALOG_ATTENTION_CLASS,
  endDialogAttention,
  requestDialogAttention,
} from "./dialogAttention";

const animationEnd = (
  target: HTMLElement,
  currentTarget: HTMLElement,
  animationName: string,
) =>
  ({ target, currentTarget, animationName }) as unknown as AnimationEvent<HTMLElement>;

describe("dialog attention flash", () => {
  it("adds the class and keeps it on a repeated request", () => {
    const dialog = document.createElement("div");
    requestDialogAttention(dialog);
    expect(dialog.classList.contains(DIALOG_ATTENTION_CLASS)).toBe(true);
    requestDialogAttention(dialog);
    expect(dialog.classList.contains(DIALOG_ATTENTION_CLASS)).toBe(true);
  });

  it("tolerates a missing dialog element", () => {
    expect(() => requestDialogAttention(null)).not.toThrow();
  });

  it("clears the class when the flash animation ends", () => {
    const dialog = document.createElement("div");
    requestDialogAttention(dialog);
    endDialogAttention(animationEnd(dialog, dialog, "dialog-attention"));
    expect(dialog.classList.contains(DIALOG_ATTENTION_CLASS)).toBe(false);

    // The reduced-motion variant ends the flash too.
    requestDialogAttention(dialog);
    endDialogAttention(animationEnd(dialog, dialog, "dialog-attention-steady"));
    expect(dialog.classList.contains(DIALOG_ATTENTION_CLASS)).toBe(false);
  });

  it("ignores animations of children and unrelated animations", () => {
    const dialog = document.createElement("div");
    const child = document.createElement("span");
    dialog.appendChild(child);
    requestDialogAttention(dialog);

    endDialogAttention(animationEnd(child, dialog, "dialog-attention"));
    expect(dialog.classList.contains(DIALOG_ATTENTION_CLASS)).toBe(true);

    endDialogAttention(animationEnd(dialog, dialog, "update-spin"));
    expect(dialog.classList.contains(DIALOG_ATTENTION_CLASS)).toBe(true);
  });
});
