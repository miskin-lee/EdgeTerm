import { beforeEach, describe, expect, it, vi } from "vitest";

// The store reaches platform.ts through the shortcut table, and IS_MAC is a
// build-time constant vitest does not define.
vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
  shortcutLabel: (mac: string) => mac,
}));

import { useStore } from "./store";

const initialState = useStore.getState();

beforeEach(() => {
  localStorage.clear();
  useStore.setState({ ...initialState }, true);
});

describe("cursor settings", () => {
  it("default to a blinking block", () => {
    const state = useStore.getState();
    expect(state.cursorStyle).toBe("block");
    expect(state.cursorBlink).toBe(true);
  });

  it("persist the shape and the blink switch", () => {
    const store = useStore.getState();
    store.setCursorStyle("bar");
    store.setCursorBlink(false);

    expect(useStore.getState().cursorStyle).toBe("bar");
    expect(useStore.getState().cursorBlink).toBe(false);
    expect(localStorage.getItem("edgeterm.cursorStyle")).toBe("bar");
    expect(localStorage.getItem("edgeterm.cursorBlink")).toBe("off");
  });

  it("travel with a data export and survive a malformed import", () => {
    const store = useStore.getState();
    store.setCursorStyle("underline");
    store.setCursorBlink(false);
    const exported = useStore.getState().exportSettings();
    expect(exported.cursorStyle).toBe("underline");
    expect(exported.cursorBlink).toBe(false);

    store.resetSettings();
    expect(useStore.getState().cursorStyle).toBe("block");
    expect(useStore.getState().cursorBlink).toBe(true);
    expect(localStorage.getItem("edgeterm.cursorStyle")).toBeNull();
    expect(localStorage.getItem("edgeterm.cursorBlink")).toBeNull();

    useStore.getState().applySettings(exported);
    expect(useStore.getState().cursorStyle).toBe("underline");
    expect(useStore.getState().cursorBlink).toBe(false);

    // A shape the terminal does not draw, or a blink flag that is not a
    // boolean, leaves the current values alone.
    useStore.getState().applySettings({ cursorStyle: "beam", cursorBlink: "yes" });
    expect(useStore.getState().cursorStyle).toBe("underline");
    expect(useStore.getState().cursorBlink).toBe(false);
  });
});
