import { IS_MAC, IS_WINDOWS } from "./platform";
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

/**
 * One key combination. The key itself is kept as `KeyboardEvent.code`, the
 * physical key: `event.key` is unusable for a stored binding because Option
 * composes characters on macOS (⌥[ types a typographic quote) and Shift
 * changes the character of every digit. `chordMatches` still accepts the
 * typed character for letters and digits, so a remapped layout keeps working
 * the way it did before bindings were configurable.
 */
export interface KeyChord {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  meta: boolean;
  code: string;
}

/** Every action a user can put on a key. */
export type ShortcutCommand =
  | "newSession"
  | "closeSession"
  | "find"
  | "findNext"
  | "clear"
  | "revealCwd"
  | "prevTab"
  | "nextTab"
  | "splitRight"
  | "splitDown"
  | "prevPane"
  | "nextPane"
  | "copy"
  | "paste"
  | "selectAll"
  | "panelSessions"
  | "panelFiler"
  | "panelSender";

/** The chord bound to each command; null for a command left unassigned. */
export type ShortcutBindings = Record<ShortcutCommand, KeyChord | null>;

export type AppShortcut =
  | { kind: "newSession" }
  | { kind: "closeSession" }
  | { kind: "find" }
  | { kind: "findNext" }
  | { kind: "clear" }
  | { kind: "revealCwd" }
  | { kind: "tabStep"; step: -1 | 1 }
  | { kind: "tab"; number: number }
  | { kind: "splitPane"; side: "right" | "down" }
  | { kind: "paneStep"; step: -1 | 1 }
  | { kind: "copy" }
  | { kind: "paste" }
  | { kind: "selectAll" }
  | { kind: "togglePanel"; panel: PanelName };

/** What each command does, and the order the settings dialog lists them in. */
export const SHORTCUT_COMMANDS: {
  id: ShortcutCommand;
  label: string;
  hint: string;
  action: AppShortcut;
}[] = [
  {
    id: "newSession",
    label: "New Session",
    hint: "Open the new-session dialog",
    action: { kind: "newSession" },
  },
  {
    id: "closeSession",
    label: "Close Session",
    hint: "Close the current tab",
    action: { kind: "closeSession" },
  },
  {
    id: "prevTab",
    label: "Previous Session",
    hint: "Select the tab on the left",
    action: { kind: "tabStep", step: -1 },
  },
  {
    id: "nextTab",
    label: "Next Session",
    hint: "Select the tab on the right",
    action: { kind: "tabStep", step: 1 },
  },
  {
    id: "splitRight",
    label: "Split Right",
    hint: "Open the current session's profile again in a pane to the right",
    action: { kind: "splitPane", side: "right" },
  },
  {
    id: "splitDown",
    label: "Split Down",
    hint: "Open the current session's profile again in a pane below",
    action: { kind: "splitPane", side: "down" },
  },
  {
    id: "prevPane",
    label: "Previous Pane",
    hint: "Focus the pane before this one",
    action: { kind: "paneStep", step: -1 },
  },
  {
    id: "nextPane",
    label: "Next Pane",
    hint: "Focus the pane after this one",
    action: { kind: "paneStep", step: 1 },
  },
  {
    id: "copy",
    label: "Copy",
    hint: "Copy the terminal selection",
    action: { kind: "copy" },
  },
  {
    id: "paste",
    label: "Paste",
    hint: "Paste the clipboard into the terminal",
    action: { kind: "paste" },
  },
  {
    id: "selectAll",
    label: "Select All",
    hint: "Select the whole terminal buffer",
    action: { kind: "selectAll" },
  },
  {
    id: "find",
    label: "Find",
    hint: "Search the terminal buffer",
    action: { kind: "find" },
  },
  {
    id: "findNext",
    label: "Find Next",
    hint: "Jump to the next match",
    action: { kind: "findNext" },
  },
  {
    id: "clear",
    label: "Clear Buffer",
    hint: "Clear the screen and scrollback",
    action: { kind: "clear" },
  },
  {
    id: "revealCwd",
    label: "Reveal Working Directory",
    hint: "Point the Filer at the shell's directory",
    action: { kind: "revealCwd" },
  },
  {
    id: "panelSessions",
    label: "Toggle Session Panel",
    hint: "Show or hide the left panel",
    action: { kind: "togglePanel", panel: "sessions" },
  },
  {
    id: "panelFiler",
    label: "Toggle Filer Panel",
    hint: "Show or hide the right panel",
    action: { kind: "togglePanel", panel: "filer" },
  },
  {
    id: "panelSender",
    label: "Toggle Sender Panel",
    hint: "Show or hide the bottom panel",
    action: { kind: "togglePanel", panel: "sender" },
  },
];

const chord = (
  code: string,
  mods: Partial<Omit<KeyChord, "code">>,
): KeyChord => ({
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
  code,
  ...mods,
});

/**
 * macOS: ⌘+key for app shortcuts and ⌘⌥+arrow to toggle panels. Option and
 * Ctrl on their own are never taken by default: Option types characters and
 * Ctrl belongs to the shell.
 */
const MAC_DEFAULTS: ShortcutBindings = {
  newSession: chord("KeyN", { meta: true }),
  closeSession: chord("KeyW", { meta: true }),
  find: chord("KeyF", { meta: true }),
  findNext: chord("KeyG", { meta: true }),
  clear: chord("KeyK", { meta: true }),
  revealCwd: chord("KeyJ", { meta: true }),
  prevTab: chord("BracketLeft", { meta: true }),
  nextTab: chord("BracketRight", { meta: true }),
  // ⌘\ splits in VS Code; ⌘⌥[ / ⌘⌥] step panes the way ⌘[ / ⌘] step tabs.
  splitRight: chord("Backslash", { meta: true }),
  splitDown: chord("Backslash", { meta: true, shift: true }),
  prevPane: chord("BracketLeft", { meta: true, alt: true }),
  nextPane: chord("BracketRight", { meta: true, alt: true }),
  copy: chord("KeyC", { meta: true }),
  paste: chord("KeyV", { meta: true }),
  selectAll: chord("KeyA", { meta: true }),
  panelSessions: chord("ArrowLeft", { meta: true, alt: true }),
  panelFiler: chord("ArrowRight", { meta: true, alt: true }),
  panelSender: chord("ArrowDown", { meta: true, alt: true }),
};

/**
 * Windows / Linux. Ctrl+Shift+letter is the safe modifier family in a
 * terminal: the shell receives the same control character as for plain
 * Ctrl+letter (Shift is not encoded), so taking Ctrl+Shift+F costs it
 * nothing, and this is what WindTerm, MobaXterm, GNOME Terminal and VS Code
 * all converge on. Alt+letter is readline's Meta layer (Alt+F is
 * forward-word, Alt+B backward-word, Alt+D kill-word …) and Emacs's M-
 * prefix, so only letters with no default binding there are taken. Plain
 * Ctrl+letter is never a default — those are readline and shell keys (^W
 * kills a word, ^G is BEL, ^K kills to end of line).
 */
const OTHER_DEFAULTS: ShortcutBindings = {
  newSession: chord("KeyN", { alt: true }),
  closeSession: chord("KeyW", { ctrl: true, shift: true }),
  find: chord("KeyF", { ctrl: true, shift: true }),
  findNext: chord("KeyG", { ctrl: true, shift: true }),
  clear: chord("KeyK", { alt: true }),
  revealCwd: chord("KeyJ", { ctrl: true, shift: true }),
  prevTab: chord("BracketLeft", { alt: true }),
  nextTab: chord("BracketRight", { alt: true }),
  // Ctrl+\ is VS Code's split but SIGQUIT in a terminal; with Shift the
  // shell would get the same byte, so it is taken like Ctrl+Shift+letter.
  // Alt+\ is readline's delete-horizontal-space and Alt+Shift switches the
  // input language on Windows, so the second split and the pane steps go
  // to Ctrl+Alt like the panel toggles.
  splitRight: chord("Backslash", { ctrl: true, shift: true }),
  splitDown: chord("Backslash", { ctrl: true, alt: true }),
  prevPane: chord("BracketLeft", { ctrl: true, alt: true }),
  nextPane: chord("BracketRight", { ctrl: true, alt: true }),
  // Ctrl+Shift+C / V is what WindTerm, MobaXterm, GNOME Terminal and VS Code
  // paste with; Ctrl+Insert / Shift+Insert (PuTTY) and plain Ctrl+C / V are
  // a rebinding away.
  copy: chord("KeyC", { ctrl: true, shift: true }),
  paste: chord("KeyV", { ctrl: true, shift: true }),
  selectAll: chord("KeyA", { ctrl: true, shift: true }),
  panelSessions: chord("ArrowLeft", { ctrl: true, alt: true }),
  panelFiler: chord("ArrowRight", { ctrl: true, alt: true }),
  panelSender: chord("ArrowDown", { ctrl: true, alt: true }),
};

/**
 * The bindings a fresh install and Restore Default Settings both start from.
 * Selected once per build: IS_MAC is a compile-time constant, so only the
 * current platform's scheme ships.
 */
export const DEFAULT_SHORTCUTS: Readonly<ShortcutBindings> = IS_MAC
  ? MAC_DEFAULTS
  : OTHER_DEFAULTS;

/** A fresh, mutable copy of the platform defaults. */
export const defaultShortcuts = (): ShortcutBindings => ({
  ...DEFAULT_SHORTCUTS,
});

export const sameChord = (a: KeyChord | null, b: KeyChord | null): boolean => {
  if (!a || !b) return a === b;
  return (
    a.ctrl === b.ctrl &&
    a.alt === b.alt &&
    a.shift === b.shift &&
    a.meta === b.meta &&
    a.code === b.code
  );
};

/** The character a code types on a US layout; null for non-typing keys. */
function codeCharacter(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return null;
}

/**
 * Whether `event` is this chord. The physical key decides, with the typed
 * character accepted as well for letters and digits so that a non-QWERTY
 * layout triggers the shortcut printed on the key the user actually pressed.
 */
export function chordMatches(
  binding: KeyChord,
  event: ShortcutKeyEvent,
): boolean {
  if (
    binding.ctrl !== event.ctrlKey ||
    binding.alt !== event.altKey ||
    binding.shift !== event.shiftKey ||
    binding.meta !== event.metaKey
  ) {
    return false;
  }
  if (event.code === binding.code) return true;
  const character = codeCharacter(binding.code);
  return character !== null && event.key.toLowerCase() === character;
}

/** Modifiers pressed on their own are the start of a chord, not a chord. */
const MODIFIER_CODES: ReadonlySet<string> = new Set([
  "ShiftLeft",
  "ShiftRight",
  "ControlLeft",
  "ControlRight",
  "AltLeft",
  "AltRight",
  "MetaLeft",
  "MetaRight",
  "CapsLock",
]);

/** The chord a key press stands for, or null while only modifiers are down. */
export function chordFromEvent(event: ShortcutKeyEvent): KeyChord | null {
  if (!event.code || MODIFIER_CODES.has(event.code)) return null;
  return {
    ctrl: event.ctrlKey,
    alt: event.altKey,
    shift: event.shiftKey,
    meta: event.metaKey,
    code: event.code,
  };
}

const KEY_LABELS: Readonly<Record<string, string>> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  IntlBackslash: "\\",
  Space: "Space",
  Enter: IS_MAC ? "↩" : "Enter",
  Tab: "Tab",
  Backspace: IS_MAC ? "⌫" : "Backspace",
  Delete: IS_MAC ? "⌦" : "Del",
  Escape: "Esc",
  Home: "Home",
  End: "End",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Insert: "Ins",
};

/** How one key is written in a menu: "N", "[", "←", "F5". */
export function keyLabel(code: string): string {
  const known = KEY_LABELS[code];
  if (known) return known;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (code.startsWith("Numpad")) return `Num ${keyLabel(code.slice(6))}`;
  return code;
}

/** The Meta key's name where it is not ⌘. */
const META_NAME = IS_WINDOWS ? "Win" : "Super";

/**
 * The chord as a menu writes it: ⌃⌥⇧⌘ in Apple's order on macOS,
 * Ctrl+Alt+Shift+key elsewhere. An unassigned command has no label.
 */
export function chordLabel(binding: KeyChord | null | undefined): string {
  if (!binding) return "";
  if (IS_MAC) {
    return (
      (binding.ctrl ? "⌃" : "") +
      (binding.alt ? "⌥" : "") +
      (binding.shift ? "⇧" : "") +
      (binding.meta ? "⌘" : "") +
      keyLabel(binding.code)
    );
  }
  const parts: string[] = [];
  if (binding.ctrl) parts.push("Ctrl");
  if (binding.alt) parts.push("Alt");
  if (binding.shift) parts.push("Shift");
  if (binding.meta) parts.push(META_NAME);
  parts.push(keyLabel(binding.code));
  return parts.join("+");
}

/**
 * Chords the OS answers before the app ever sees them, so binding a command
 * to one would leave it silently dead: the macOS entries belong to the
 * system menu Tauri installs. Copy / paste / select all used to be listed
 * here; they are ordinary commands of the table now (#47), answered by the
 * terminal's key filter.
 */
const RESERVED_CHORDS: { chord: KeyChord; owner: string }[] = IS_MAC
  ? [
      { chord: chord("KeyX", { meta: true }), owner: "Cut" },
      { chord: chord("KeyQ", { meta: true }), owner: "Quit EdgeTerm" },
      { chord: chord("KeyH", { meta: true }), owner: "Hide EdgeTerm" },
      { chord: chord("KeyM", { meta: true }), owner: "Minimize" },
    ]
  : [];

/** The modifiers that switch to tab N; the digits themselves stay fixed. */
const tabDigitModifiers = (event: ShortcutKeyEvent): boolean =>
  IS_MAC
    ? event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    : event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;

/** ⌘1–9 / Alt+1–9, the one shortcut family that is not rebindable. */
function tabNumberShortcut(event: ShortcutKeyEvent): AppShortcut | null {
  if (!tabDigitModifiers(event)) return null;
  const digit = /^Digit([1-9])$/.exec(event.code)?.[1] ?? null;
  const number = Number(digit ?? (/^[1-9]$/.test(event.key) ? event.key : 0));
  return number ? { kind: "tab", number } : null;
}

/** A chord seen as the key event it would be produced by. */
const toEvent = (binding: KeyChord): ShortcutKeyEvent => ({
  key: codeCharacter(binding.code) ?? binding.code,
  code: binding.code,
  ctrlKey: binding.ctrl,
  altKey: binding.alt,
  shiftKey: binding.shift,
  metaKey: binding.meta,
});

/**
 * Keys that never type a character, so Shift alone is modifier enough for
 * them: Shift+Insert is the paste key of PuTTY, MobaXterm and every X
 * terminal, and Ctrl+Insert / Shift+Delete are its copy / cut companions.
 */
const SHIFT_ONLY_KEYS = /^(Insert|Delete|Home|End|PageUp|PageDown|F([1-9]|1\d|2[0-4]))$/;

/**
 * Why `binding` cannot be given to `command`, or null when it can. Chords
 * without a real modifier are refused because they would swallow ordinary
 * typing, and chords the system already answers are refused because the
 * command would never run.
 */
export function chordProblem(binding: KeyChord): string | null {
  const bareShift = binding.shift && SHIFT_ONLY_KEYS.test(binding.code);
  if (!binding.ctrl && !binding.alt && !binding.meta && !bareShift) {
    return IS_MAC
      ? "Hold ⌘, ⌥ or ⌃ as well, or the key would be typed into the terminal."
      : "Hold Ctrl or Alt as well, or the key would be typed into the terminal.";
  }
  const reserved = RESERVED_CHORDS.find((entry) =>
    sameChord(entry.chord, binding),
  );
  if (reserved) return `${chordLabel(binding)} is already ${reserved.owner}.`;
  if (
    /^Digit[1-9]$/.test(binding.code) &&
    tabDigitModifiers(toEvent(binding))
  ) {
    return `${chordLabel(binding)} switches to tab ${binding.code.slice(5)}.`;
  }
  return null;
}

// --- storage ----------------------------------------------------------------

const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";

/** Validates one stored or imported chord; null for anything unknown. */
function parseChord(value: unknown): KeyChord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Record<keyof KeyChord, unknown>>;
  if (typeof raw.code !== "string" || !raw.code) return null;
  if (
    !isBoolean(raw.ctrl) ||
    !isBoolean(raw.alt) ||
    !isBoolean(raw.shift) ||
    !isBoolean(raw.meta)
  ) {
    return null;
  }
  return {
    ctrl: raw.ctrl,
    alt: raw.alt,
    shift: raw.shift,
    meta: raw.meta,
    code: raw.code.slice(0, 40),
  };
}

/**
 * Reads a stored or imported binding table over `base`, which supplies every
 * command the value does not mention. Returns null when the value is not a
 * table at all; a malformed single entry is skipped, and an explicit null
 * means the command is deliberately unassigned.
 */
export function parseShortcuts(
  value: unknown,
  base: Readonly<ShortcutBindings>,
): ShortcutBindings | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const bindings = { ...base };
  for (const { id } of SHORTCUT_COMMANDS) {
    if (!(id in raw)) continue;
    const entry = raw[id];
    if (entry === null) bindings[id] = null;
    else {
      const parsed = parseChord(entry);
      if (parsed) bindings[id] = parsed;
    }
  }
  return bindings;
}

/**
 * Only the commands that differ from this platform's defaults. Storing the
 * difference rather than the whole table lets a later release change a
 * default the user never touched.
 */
export function shortcutOverrides(
  bindings: Readonly<ShortcutBindings>,
): Partial<ShortcutBindings> {
  const overrides: Partial<ShortcutBindings> = {};
  for (const { id } of SHORTCUT_COMMANDS) {
    if (!sameChord(bindings[id], DEFAULT_SHORTCUTS[id])) {
      overrides[id] = bindings[id];
    }
  }
  return overrides;
}

// --- dispatch ---------------------------------------------------------------

// `matchAppShortcut` is called from the window handler, the search box and
// xterm's key filter — none of them React — so the table in force is held
// here and the store pushes every change into it (see `setShortcuts`).
let activeShortcuts: ShortcutBindings = defaultShortcuts();

export function setActiveShortcuts(bindings: Readonly<ShortcutBindings>): void {
  activeShortcuts = { ...bindings };
}

/**
 * Resolves a key event to the app shortcut it triggers, or null when the key
 * must keep reaching whatever has focus.
 */
export function matchAppShortcut(event: ShortcutKeyEvent): AppShortcut | null {
  for (const { id, action } of SHORTCUT_COMMANDS) {
    const binding = activeShortcuts[id];
    if (binding && chordMatches(binding, event)) return action;
  }
  return tabNumberShortcut(event);
}
