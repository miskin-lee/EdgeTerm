import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
}));

import type { CommandSuggestion } from "./history";
import { TerminalController } from "./terminal";

interface PopupState {
  candidates: CommandSuggestion[];
  popupIndex: number;
  filterKey(event: KeyboardEvent): boolean;
}

const controllers: TerminalController[] = [];

function createController() {
  const forgetSuggestion = vi.fn();
  const controller = new TerminalController(
    "suggest-test",
    {
      onData() {},
      onResize() {},
      onStatus() {},
      onCommand() {},
      onCommandState() {},
      suggest: () => [],
      forgetSuggestion,
    },
    13,
    100,
  );
  controllers.push(controller);
  const popup = controller as unknown as PopupState;
  popup.candidates = [
    { command: "git status", matchStart: 0 },
    { command: "gti status", matchStart: 0 },
  ];
  return { popup, forgetSuggestion };
}

function press(key: string, modifiers: Partial<KeyboardEvent> = {}) {
  return {
    type: "keydown",
    key,
    code: key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    isComposing: false,
    preventDefault: vi.fn(),
    ...modifiers,
  } as unknown as KeyboardEvent & { preventDefault: ReturnType<typeof vi.fn> };
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
});

describe("forgetting a suggestion", () => {
  it("removes the selected row on Shift+Delete", () => {
    const { popup, forgetSuggestion } = createController();
    popup.popupIndex = 1;
    const event = press("Delete", { shiftKey: true });
    expect(popup.filterKey(event)).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(forgetSuggestion).toHaveBeenCalledWith("gti status");
  });

  it("takes Shift+⌫ on macOS, which has no forward Delete on laptops", () => {
    const { popup, forgetSuggestion } = createController();
    popup.popupIndex = 0;
    expect(popup.filterKey(press("Backspace", { shiftKey: true }))).toBe(false);
    expect(forgetSuggestion).toHaveBeenCalledWith("git status");
  });

  it("leaves the keys to the shell while no row is selected", () => {
    const { popup, forgetSuggestion } = createController();
    popup.popupIndex = -1;
    popup.filterKey(press("Delete", { shiftKey: true }));
    popup.filterKey(press("Backspace", { shiftKey: true }));
    expect(forgetSuggestion).not.toHaveBeenCalled();
  });

  it("does not take plain Delete or Backspace on a selected row", () => {
    const { popup, forgetSuggestion } = createController();
    popup.popupIndex = 0;
    popup.filterKey(press("Delete"));
    popup.filterKey(press("Backspace"));
    expect(forgetSuggestion).not.toHaveBeenCalled();
  });
});
