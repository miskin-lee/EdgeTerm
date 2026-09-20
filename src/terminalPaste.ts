/**
 * What the paste path and the dialog that confirms a paste have to agree on.
 * It lives apart from `terminal.ts` so the dialog can read it without pulling
 * xterm into the start-up bundle (see `ensureController` in actions.ts).
 */

/**
 * How long a single-line paste may be before it is confirmed. Past this it is
 * not something the user reached for the clipboard for: it is a page they
 * copied by accident, or a file they meant to transfer.
 */
const PASTE_WARNING_CHARS = 2048;

/**
 * The lines a paste would submit. Every line break in a paste is an Enter —
 * the shell runs each line as it arrives — except a single trailing one,
 * which is what copying a command line brings along and is the paste the
 * user meant.
 */
export function pasteLineCount(text: string): number {
  const body = text.replace(/\r\n$|[\r\n]$/, "");
  return body === "" ? 0 : body.split(/\r\n|[\r\n]/).length;
}

/** The paste split into the lines it would submit, for the dialog's preview. */
export function pasteLines(text: string): string[] {
  const body = text.replace(/\r\n$|[\r\n]$/, "");
  return body === "" ? [] : body.split(/\r\n|[\r\n]/);
}

/**
 * Whether a paste is worth confirming: it would run more than one command,
 * or it is longer than anyone reads before pasting. Warning about a single
 * command line would mean warning about nearly every paste, and a warning
 * that fires every time is one the user turns off.
 */
export function needsPasteWarning(text: string): boolean {
  return pasteLineCount(text) > 1 || text.length > PASTE_WARNING_CHARS;
}
