import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
}));

import {
  defaultShortcuts,
  setActiveShortcuts,
  type KeyChord,
  type ShortcutBindings,
} from "./shortcuts";
import { TerminalController } from "./terminal";

const controllers: TerminalController[] = [];

function createController() {
  const controller = new TerminalController(
    "keys-test",
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
    },
    13,
    100,
  );
  controllers.push(controller);
  // The clipboard is not there in jsdom, and a paste would call into Tauri.
  vi.spyOn(controller, "copySelection").mockReturnValue(true);
  vi.spyOn(controller, "pasteFromClipboard").mockImplementation(() => {});
  vi.spyOn(controller.term, "selectAll").mockImplementation(() => {});
  return controller;
}

/** A keydown as xterm's key filter receives it. */
function press(
  code: string,
  modifiers: Partial<
    Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">
  > = {},
  key = /^Key[A-Z]$/.test(code) ? code.slice(3).toLowerCase() : code,
) {
  const event = {
    type: "keydown",
    key,
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...modifiers,
  };
  return event as unknown as KeyboardEvent & {
    preventDefault: ReturnType<typeof vi.fn>;
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

const bind = (overrides: Partial<ShortcutBindings>) =>
  setActiveShortcuts({ ...defaultShortcuts(), ...overrides });

const filter = (controller: TerminalController, event: KeyboardEvent) =>
  (
    controller as unknown as { filterKey(event: KeyboardEvent): boolean }
  ).filterKey(event);

afterEach(() => {
  setActiveShortcuts(defaultShortcuts());
  for (const controller of controllers.splice(0)) controller.dispose();
});

describe("copy, paste and select all keys", () => {
  it("answers the defaults inside the terminal", () => {
    const controller = createController();
    vi.spyOn(controller.term, "hasSelection").mockReturnValue(true);

    const copy = press("KeyC", { metaKey: true });
    expect(filter(controller, copy)).toBe(false);
    expect(copy.preventDefault).toHaveBeenCalled();
    expect(controller.copySelection).toHaveBeenCalledTimes(1);

    const paste = press("KeyV", { metaKey: true });
    expect(filter(controller, paste)).toBe(false);
    expect(paste.preventDefault).toHaveBeenCalled();
    expect(controller.pasteFromClipboard).toHaveBeenCalledTimes(1);

    const all = press("KeyA", { metaKey: true });
    expect(filter(controller, all)).toBe(false);
    expect(controller.term.selectAll).toHaveBeenCalledTimes(1);
  });

  it("follows the keys the user moved them to", () => {
    bind({
      paste: chord("Insert", { shift: true }),
      copy: chord("Insert", { ctrl: true }),
    });
    const controller = createController();

    const paste = press("Insert", { shiftKey: true });
    expect(filter(controller, paste)).toBe(false);
    expect(paste.preventDefault).toHaveBeenCalled();
    expect(controller.pasteFromClipboard).toHaveBeenCalledTimes(1);

    // Ctrl+Insert with nothing selected is consumed: it has no shell meaning
    // to preserve, and the copy itself is a no-op.
    const copy = press("Insert", { ctrlKey: true });
    expect(filter(controller, copy)).toBe(false);
    expect(copy.preventDefault).toHaveBeenCalled();
    expect(controller.copySelection).toHaveBeenCalledTimes(1);
  });

  it("swallows the macOS keys WebKit and xterm would otherwise still answer", () => {
    bind({
      paste: chord("KeyV", { meta: true, shift: true }),
      selectAll: null,
    });
    const controller = createController();

    // ⌘V is unassigned now; without this WebKit's paste command would run.
    const paste = press("KeyV", { metaKey: true });
    expect(filter(controller, paste)).toBe(false);
    expect(paste.preventDefault).toHaveBeenCalled();
    expect(controller.pasteFromClipboard).not.toHaveBeenCalled();

    // Likewise xterm's built-in ⌘A select-all.
    const all = press("KeyA", { metaKey: true });
    expect(filter(controller, all)).toBe(false);
    expect(all.preventDefault).toHaveBeenCalled();
    expect(controller.term.selectAll).not.toHaveBeenCalled();

    // The new key works.
    const moved = press("KeyV", { metaKey: true, shiftKey: true });
    expect(filter(controller, moved)).toBe(false);
    expect(controller.pasteFromClipboard).toHaveBeenCalledTimes(1);
  });

  it("lets a plain Ctrl+letter copy key reach the shell when nothing is selected", () => {
    bind({ copy: chord("KeyC", { ctrl: true }) });
    const controller = createController();
    const hasSelection = vi
      .spyOn(controller.term, "hasSelection")
      .mockReturnValue(false);

    // ^C still interrupts, as in Windows Terminal.
    const interrupt = press("KeyC", { ctrlKey: true });
    expect(filter(controller, interrupt)).toBe(true);
    expect(interrupt.preventDefault).not.toHaveBeenCalled();
    expect(controller.copySelection).not.toHaveBeenCalled();

    hasSelection.mockReturnValue(true);
    const copy = press("KeyC", { ctrlKey: true });
    expect(filter(controller, copy)).toBe(false);
    expect(controller.copySelection).toHaveBeenCalledTimes(1);
  });

  it("consumes Ctrl+Shift+C without a selection rather than sending a stray ^C", () => {
    bind({ copy: chord("KeyC", { ctrl: true, shift: true }) });
    const controller = createController();
    vi.spyOn(controller.term, "hasSelection").mockReturnValue(false);

    const copy = press("KeyC", { ctrlKey: true, shiftKey: true });
    expect(filter(controller, copy)).toBe(false);
    expect(copy.preventDefault).toHaveBeenCalled();
  });

  it("leaves the other app shortcuts to the window handler and the rest to xterm", () => {
    const controller = createController();

    // Unhandled but not cancelled: the window-level handler acts on it.
    const newSession = press("KeyN", { metaKey: true });
    expect(filter(controller, newSession)).toBe(false);
    expect(newSession.preventDefault).not.toHaveBeenCalled();

    // Shell keys go through untouched.
    expect(filter(controller, press("KeyC", { ctrlKey: true }))).toBe(true);
    expect(filter(controller, press("KeyN"))).toBe(true);
  });
});
