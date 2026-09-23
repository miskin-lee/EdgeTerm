/**
 * What a program may do with OSC 52, the sequence tmux, vim, Neovim and TUI
 * agents use to put text on the clipboard of the terminal they draw in
 * (issue #65) — the only way a program on a server can reach it at all.
 * "ask" confirms each session once (WindTerm), "allow" writes straight away
 * (Kitty, Ghostty, WezTerm), "deny" drops it (iTerm2's default).
 */
export type ProgramClipboardMode = "ask" | "allow" | "deny";

export const PROGRAM_CLIPBOARD_LABELS: Record<ProgramClipboardMode, string> =
  {
    ask: "Ask",
    allow: "Allow",
    deny: "Deny",
  };

export const parseProgramClipboardMode = (
  value: unknown,
): ProgramClipboardMode | null =>
  value === "ask" || value === "allow" || value === "deny" ? value : null;

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/**
 * The text an OSC 52 payload (`Pc;Pd`) asks to put on the clipboard, or null
 * when there is nothing to write.
 *
 * `Pd` is base64. A `?` asks the terminal to send the clipboard back, which
 * is never answered: anything on the far end of an SSH session could read
 * whatever the user last copied. An empty `Pd` asks to clear the clipboard,
 * which is not worth a prompt either. `Pc` names the selections: empty means
 * the default (`s 0`), and `c`, `s` and the cut buffers `0`–`7` all land on
 * the one clipboard there is; a request for only the primary selection or
 * the secondary one (`p`, `q`) is left alone, since the clipboard is not
 * what the program asked for.
 */
export function parseOsc52(data: string): string | null {
  const split = data.indexOf(";");
  if (split < 0) return null;
  const targets = data.slice(0, split);
  const payload = data.slice(split + 1).replace(/\s+/g, "");
  if (targets && !/[cs0-7]/.test(targets)) return null;
  if (!payload || payload === "?" || !BASE64.test(payload)) return null;
  let binary: string;
  try {
    binary = atob(payload);
  } catch {
    return null;
  }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const text = new TextDecoder().decode(bytes);
  return text || null;
}
