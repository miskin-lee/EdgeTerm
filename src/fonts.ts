import { IS_MAC, IS_WINDOWS } from "./platform";

/**
 * Monospace font stack for the terminal buffer and code-like UI.
 *
 * EdgeTerm ships no fonts of its own; like VS Code it renders the buffer with
 * the platform's stock monospace face so it looks native on every machine.
 * The three stacks are VS Code's `editor.fontFamily` defaults verbatim (its
 * integrated terminal inherits the same value), picked at build time.
 */
export const MONO_FONT_FAMILY: string = IS_MAC
  ? "Menlo, Monaco, 'Courier New', monospace"
  : IS_WINDOWS
    ? "Consolas, 'Courier New', monospace"
    : "'Droid Sans Mono', 'monospace', monospace";

/** Publish the stack as `--font-mono` so stylesheets share it with xterm. */
export function applyMonoFontFamily(
  root: HTMLElement = document.documentElement,
) {
  root.style.setProperty("--font-mono", MONO_FONT_FAMILY);
}
