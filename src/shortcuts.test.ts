import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
}));

import {
  chordFromEvent,
  chordLabel,
  chordProblem,
  DEFAULT_SHORTCUTS,
  defaultShortcuts,
  matchAppShortcut,
  parseShortcuts,
  setActiveShortcuts,
  shortcutOverrides,
  type KeyChord,
  type ShortcutKeyEvent,
} from "./shortcuts";

/** A key event as the browser reports it, defaulting to no modifiers. */
function press(
  code: string,
  modifiers: Partial<Omit<ShortcutKeyEvent, "key" | "code">> = {},
  key?: string,
): ShortcutKeyEvent {
  return {
    key: key ?? (/^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : code),
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...modifiers,
  };
}

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

afterEach(() => {
  setActiveShortcuts(defaultShortcuts());
});

describe("default bindings", () => {
  it("keeps the macOS scheme the app shipped with", () => {
    expect(matchAppShortcut(press("KeyN", { metaKey: true }))).toEqual({
      kind: "newSession",
    });
    expect(matchAppShortcut(press("KeyW", { metaKey: true }))).toEqual({
      kind: "closeSession",
    });
    expect(matchAppShortcut(press("BracketLeft", { metaKey: true }))).toEqual({
      kind: "tabStep",
      step: -1,
    });
    expect(
      matchAppShortcut(press("ArrowLeft", { metaKey: true, altKey: true })),
    ).toEqual({ kind: "togglePanel", panel: "sessions" });
  });

  it("lists copy, paste and select all like any other command", () => {
    expect(matchAppShortcut(press("KeyC", { metaKey: true }))).toEqual({
      kind: "copy",
    });
    expect(matchAppShortcut(press("KeyV", { metaKey: true }))).toEqual({
      kind: "paste",
    });
    expect(matchAppShortcut(press("KeyA", { metaKey: true }))).toEqual({
      kind: "selectAll",
    });
  });

  it("switches tabs on ⌘1–9, which stay fixed", () => {
    expect(matchAppShortcut(press("Digit3", { metaKey: true }, "3"))).toEqual({
      kind: "tab",
      number: 3,
    });
    expect(
      matchAppShortcut(press("Digit0", { metaKey: true }, "0")),
    ).toBeNull();
  });

  it("leaves keys the terminal needs alone", () => {
    expect(matchAppShortcut(press("KeyN"))).toBeNull();
    expect(matchAppShortcut(press("KeyN", { ctrlKey: true }))).toBeNull();
    // A modifier the binding does not name is not a wildcard.
    expect(
      matchAppShortcut(press("KeyN", { metaKey: true, shiftKey: true })),
    ).toBeNull();
  });

  it("matches a letter by the character a remapped layout types", () => {
    // Dvorak: the key labelled N sits where QWERTY has L.
    expect(matchAppShortcut(press("KeyL", { metaKey: true }, "n"))).toEqual({
      kind: "newSession",
    });
  });
});

describe("custom bindings", () => {
  it("answers the chord the user assigned", () => {
    setActiveShortcuts({
      ...defaultShortcuts(),
      clear: chord("KeyL", { ctrl: true, shift: true }),
    });
    expect(
      matchAppShortcut(press("KeyL", { ctrlKey: true, shiftKey: true })),
    ).toEqual({ kind: "clear" });
    // The default it replaced no longer runs anything.
    expect(matchAppShortcut(press("KeyK", { metaKey: true }))).toBeNull();
  });

  it("matches an Option chord by its physical key", () => {
    // ⌘⌥[ is Previous Pane by default; one chord runs one command, so the
    // dialog would have cleared that binding when Find took the keys.
    setActiveShortcuts({
      ...defaultShortcuts(),
      prevPane: null,
      find: chord("BracketLeft", { meta: true, alt: true }),
    });
    // ⌥[ types a typographic quote, so only the code identifies the key.
    expect(
      matchAppShortcut(
        press("BracketLeft", { metaKey: true, altKey: true }, "“"),
      ),
    ).toEqual({ kind: "find" });
  });

  it("never fires a command left unassigned", () => {
    setActiveShortcuts({ ...defaultShortcuts(), newSession: null });
    expect(matchAppShortcut(press("KeyN", { metaKey: true }))).toBeNull();
  });
});

describe("chords", () => {
  it("ignores a modifier pressed on its own", () => {
    expect(chordFromEvent(press("MetaLeft", { metaKey: true }))).toBeNull();
    expect(chordFromEvent(press("KeyK", { metaKey: true }))).toEqual(
      chord("KeyK", { meta: true }),
    );
  });

  it("writes macOS labels in Apple's modifier order", () => {
    expect(chordLabel(chord("KeyN", { meta: true }))).toBe("⌘N");
    expect(
      chordLabel(chord("ArrowLeft", { meta: true, alt: true, ctrl: true })),
    ).toBe("⌃⌥⌘←");
    expect(chordLabel(chord("BracketRight", { meta: true }))).toBe("⌘]");
    expect(chordLabel(null)).toBe("");
  });

  it("refuses chords the app could never answer", () => {
    expect(chordProblem(chord("KeyN", { shift: true }))).toMatch(/⌘/);
    expect(chordProblem(chord("KeyX", { meta: true }))).toMatch(/Cut/);
    expect(chordProblem(chord("Digit1", { meta: true }))).toMatch(/tab 1/);
    expect(chordProblem(chord("KeyN", { meta: true }))).toBeNull();
  });

  it("lets copy and paste move, PuTTY's Shift+Insert included", () => {
    // ⌘C / ⌘V / ⌘A used to be reserved for the terminal.
    expect(chordProblem(chord("KeyC", { meta: true }))).toBeNull();
    expect(chordProblem(chord("KeyV", { ctrl: true }))).toBeNull();
    // Shift alone is enough for a key that never types a character…
    expect(chordProblem(chord("Insert", { shift: true }))).toBeNull();
    expect(chordProblem(chord("F12", { shift: true }))).toBeNull();
    // …but not for one that does, and a bare key is still refused.
    expect(chordProblem(chord("KeyV", { shift: true }))).toMatch(/⌘/);
    expect(chordProblem(chord("Insert", {}))).toMatch(/⌘/);
    expect(chordLabel(chord("Insert", { shift: true }))).toBe("⇧Ins");
  });
});

describe("storage", () => {
  it("stores only what differs from the defaults", () => {
    expect(shortcutOverrides(defaultShortcuts())).toEqual({});
    const bindings = {
      ...defaultShortcuts(),
      find: chord("KeyF", { ctrl: true, shift: true }),
      clear: null,
    };
    expect(shortcutOverrides(bindings)).toEqual({
      find: chord("KeyF", { ctrl: true, shift: true }),
      clear: null,
    });
  });

  it("keeps the base for commands a stored table does not name", () => {
    const parsed = parseShortcuts({ clear: null }, DEFAULT_SHORTCUTS);
    expect(parsed?.clear).toBeNull();
    expect(parsed?.newSession).toEqual(DEFAULT_SHORTCUTS.newSession);
  });

  it("skips malformed entries and rejects a non-table", () => {
    const parsed = parseShortcuts(
      {
        find: { code: "KeyF" },
        clear: 7,
        revealCwd: chord("KeyR", { meta: true }),
      },
      DEFAULT_SHORTCUTS,
    );
    expect(parsed?.find).toEqual(DEFAULT_SHORTCUTS.find);
    expect(parsed?.clear).toEqual(DEFAULT_SHORTCUTS.clear);
    expect(parsed?.revealCwd).toEqual(chord("KeyR", { meta: true }));
    expect(parseShortcuts("nonsense", DEFAULT_SHORTCUTS)).toBeNull();
  });

  it("round-trips an export through an import", () => {
    const bindings = {
      ...defaultShortcuts(),
      nextTab: chord("Tab", { ctrl: true }),
    };
    const parsed = parseShortcuts(
      shortcutOverrides(bindings),
      DEFAULT_SHORTCUTS,
    );
    expect(parsed).toEqual(bindings);
  });
});
