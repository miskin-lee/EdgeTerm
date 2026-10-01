import { describe, expect, it } from "vitest";

import {
  defaultPanelDocks,
  dockOf,
  movePanel,
  parsePanelDocks,
  samePanelDocks,
} from "./panelDock";

describe("movePanel", () => {
  it("moves a panel to the end of another dock", () => {
    const docks = movePanel(defaultPanelDocks(), "sender", "left");
    expect(docks).toEqual({
      left: ["sessions", "sender"],
      right: ["filer"],
      bottom: [],
    });
    expect(dockOf(docks, "sender")).toBe("left");
  });

  it("inserts in front of the named panel", () => {
    const docks = movePanel(defaultPanelDocks(), "filer", "left", "sessions");
    expect(docks.left).toEqual(["filer", "sessions"]);
    expect(docks.right).toEqual([]);
  });

  it("reorders within a dock", () => {
    let docks = movePanel(defaultPanelDocks(), "filer", "left");
    docks = movePanel(docks, "sender", "left");
    docks = movePanel(docks, "sender", "left", "sessions");
    expect(docks.left).toEqual(["sender", "sessions", "filer"]);
  });

  it("appends when the anchor is the panel itself or elsewhere", () => {
    expect(
      movePanel(defaultPanelDocks(), "sessions", "left", "sessions").left,
    ).toEqual(["sessions"]);
    expect(
      movePanel(defaultPanelDocks(), "sender", "left", "filer").left,
    ).toEqual(["sessions", "sender"]);
  });

  it("does not modify its input", () => {
    const docks = defaultPanelDocks();
    movePanel(docks, "sessions", "bottom");
    expect(samePanelDocks(docks, defaultPanelDocks())).toBe(true);
  });
});

describe("parsePanelDocks", () => {
  it("rejects values that are not a layout", () => {
    expect(parsePanelDocks(null)).toBeNull();
    expect(parsePanelDocks("left")).toBeNull();
    expect(parsePanelDocks(["sessions"])).toBeNull();
  });

  it("places every panel exactly once", () => {
    expect(
      parsePanelDocks({
        left: ["sender", "terminal", "sender"],
        right: "filer",
        bottom: ["sender", "filer"],
      }),
    ).toEqual({ left: ["sender", "sessions"], right: [], bottom: ["filer"] });
  });

  it("falls back to the defaults for an empty object", () => {
    expect(parsePanelDocks({})).toEqual(defaultPanelDocks());
  });
});
