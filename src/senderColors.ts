import type { CSSProperties } from "react";

/**
 * The tints a saved command's tag can take (right-click → Color), in menu
 * order. Each name is a theme token, `--tag-<name>` in styles.css, so every
 * theme picks the shade that reads on its own surfaces; a tag with no color
 * keeps the neutral look.
 */
export const SENDER_COLORS = [
  ["red", "Red"],
  ["orange", "Orange"],
  ["yellow", "Yellow"],
  ["green", "Green"],
  ["teal", "Teal"],
  ["blue", "Blue"],
  ["purple", "Purple"],
  ["pink", "Pink"],
] as const;

export type SenderColor = (typeof SENDER_COLORS)[number][0];

const NAMES = new Set<string>(SENDER_COLORS.map(([name]) => name));

/** The palette name, or null for none and for a name this build lacks. */
export function senderColor(value: string | null | undefined): SenderColor | null {
  return value && NAMES.has(value) ? (value as SenderColor) : null;
}

/** The CSS color of a palette entry, for swatches. */
export const senderColorValue = (color: SenderColor) => `var(--tag-${color})`;

/** Sets `--tag-color` on a tinted tag; nothing for an untinted one. */
export function senderColorStyle(
  value: string | null | undefined,
): CSSProperties | undefined {
  const color = senderColor(value);
  return color
    ? ({ "--tag-color": senderColorValue(color) } as CSSProperties)
    : undefined;
}
