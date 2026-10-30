import type { LineEnding } from "./types";

// What the Sender writes for one command: the text line by line, each line
// with the chosen ending, so a multi-line script runs one line per prompt
// (`senderSend.ts` waits for each prompt).

export type SendUnit = string;

/**
 * The lines of the command box, including empty and whitespace-only lines:
 * a here-document or interactive program may need those bare Enters (#115).
 * A final newline terminates the last line rather than starting another one;
 * the chosen line ending is appended by `buildUnits`.
 */
export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** The first nonblank line of the command box, as a name for the whole of it. */
export function firstLine(text: string): string {
  return splitLines(text).find((line) => line.trim().length > 0) ?? text;
}

export function buildUnits(text: string, ending: LineEnding): SendUnit[] {
  return splitLines(text).map((line) => `${line}${endingText(ending)}`);
}

export function endingText(ending: LineEnding): string {
  if (ending === "lf") return "\n";
  if (ending === "crlf") return "\r\n";
  return "";
}

export function endingLabel(ending: LineEnding): string {
  if (ending === "lf") return "append \\n";
  if (ending === "crlf") return "append \\r\\n";
  return "no line ending";
}
