import { IS_MAC } from "./platform";
import type { PanelName } from "./store";

/**
 * The keyboard-event fields the matchers read. Satisfied by both DOM and
 * React keyboard events.
 */
export interface ShortcutKeyEvent {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

export type AppShortcut =
  | { kind: "newSession" }
  | { kind: "closeSession" }
  | { kind: "find" }
  | { kind: "findNext" }
  | { kind: "clear" }
  | { kind: "revealCwd" }
  | { kind: "tabStep"; step: -1 | 1 }
  | { kind: "tab"; number: number }
  | { kind: "togglePanel"; panel: PanelName };

const LETTER_SHORTCUTS: Record<string, AppShortcut> = {
  n: { kind: "newSession" },
  w: { kind: "closeSession" },
  f: { kind: "find" },
  g: { kind: "findNext" },
  k: { kind: "clear" },
  j: { kind: "revealCwd" },
};

/** Each arrow points at the edge its panel docks on. */
const PANEL_BY_ARROW_CODE: Partial<Record<string, PanelName>> = {
  ArrowLeft: "sessions",
  ArrowRight: "filer",
  ArrowDown: "sender",
};

/** The letter shortcuts in `letters`, if the event's key is one of them. */
function letterShortcut(
  event: ShortcutKeyEvent,
  letters: ReadonlySet<string>,
): AppShortcut | null {
  const key = event.key.toLowerCase();
  return letters.has(key) ? LETTER_SHORTCUTS[key] : null;
}

/**
 * Previous / next tab on [ / ] and tab N on 1–9. Brackets are matched by
 * physical key because Option+[ on a macOS keyboard yields a typographic
 * quote in `event.key`.
 */
function tabShortcut(event: ShortcutKeyEvent): AppShortcut | null {
  if (event.code === "BracketLeft") return { kind: "tabStep", step: -1 };
  if (event.code === "BracketRight") return { kind: "tabStep", step: 1 };
  const key = event.key;
  if (/^[1-9]$/.test(key)) return { kind: "tab", number: Number(key) };
  return null;
}

function panelShortcut(event: ShortcutKeyEvent): AppShortcut | null {
  const panel = PANEL_BY_ARROW_CODE[event.code];
  return panel ? { kind: "togglePanel", panel } : null;
}

// --- macOS ------------------------------------------------------------------

const MAC_LETTERS: ReadonlySet<string> = new Set([
  "n",
  "w",
  "f",
  "g",
  "k",
  "j",
]);

/**
 * macOS: ⌘+key for app shortcuts (⌘N / ⌘W / ⌘F / ⌘G / ⌘K / ⌘J, ⌘[ / ⌘],
 * ⌘1–9) and ⌘⌥+arrow to toggle panels. Option and Ctrl on their own are
 * never taken: Option types characters and Ctrl belongs to the shell.
 */
function matchMacShortcut(event: ShortcutKeyEvent): AppShortcut | null {
  if (!event.metaKey || event.ctrlKey || event.shiftKey) return null;
  if (event.altKey) return panelShortcut(event);
  return tabShortcut(event) ?? letterShortcut(event, MAC_LETTERS);
}

// --- Windows / Linux ---------------------------------------------------------

/**
 * Ctrl+Shift+letter is the safe modifier family in a terminal: the shell
 * receives the same control character as for plain Ctrl+letter (Shift is not
 * encoded), so taking Ctrl+Shift+F costs it nothing, and this is what
 * WindTerm, MobaXterm, GNOME Terminal and VS Code all converge on.
 */
const CTRL_SHIFT_LETTERS: ReadonlySet<string> = new Set(["w", "f", "g", "j"]);

/**
 * Alt+letter is readline's Meta layer (Alt+F is forward-word, Alt+B
 * backward-word, Alt+D kill-word …) and Emacs's M- prefix, so only letters
 * with no default binding there are taken.
 */
const ALT_LETTERS: ReadonlySet<string> = new Set(["n", "k"]);

/**
 * Windows / Linux: Ctrl+Shift+W / F / G / J close, find, find next and
 * reveal the working directory in the Filer; Alt+N and Alt+K open a session
 * and clear; Alt+[ / Alt+] and Alt+1–9 switch tabs;
 * Ctrl+Alt+arrow toggles panels. Plain Ctrl+letter is never taken — those
 * are readline and shell keys (^W kills a word, ^G is BEL, ^K kills to end
 * of line).
 */
function matchOtherShortcut(event: ShortcutKeyEvent): AppShortcut | null {
  if (event.metaKey) return null;
  const { ctrlKey, altKey, shiftKey } = event;
  if (ctrlKey && shiftKey && !altKey) {
    return letterShortcut(event, CTRL_SHIFT_LETTERS);
  }
  if (ctrlKey && altKey && !shiftKey) return panelShortcut(event);
  if (altKey && !ctrlKey && !shiftKey) {
    return tabShortcut(event) ?? letterShortcut(event, ALT_LETTERS);
  }
  return null;
}

/**
 * Resolves a key event to the app shortcut it triggers, or null when the
 * key must keep reaching whatever has focus. Selected once per build: IS_MAC
 * is a compile-time constant, so only the current platform's flow ships.
 */
export const matchAppShortcut: (event: ShortcutKeyEvent) => AppShortcut | null =
  IS_MAC ? matchMacShortcut : matchOtherShortcut;
