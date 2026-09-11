import { beforeEach, describe, expect, it, vi } from "vitest";

// The store reaches platform.ts through the shortcut table, and IS_MAC is a
// build-time constant vitest does not define.
vi.mock("./platform", () => ({
  IS_MAC: true,
  IS_WINDOWS: false,
}));

import { paneIds } from "./layout";
import { useStore, type Tab } from "./store";
import type { SessionProfile, SessionState } from "./types";

const initialState = useStore.getState();
const ROOT = initialState.activePaneId;

const profile = (id: string): SessionProfile => ({ id, name: id, kind: "local" });

const makeTab = (id: string, paneId = ROOT, state: SessionState = "connected"): Tab => ({
  info: {
    id,
    profileId: id,
    name: id,
    kind: "local",
    protocol: "shell",
    address: "default shell",
    color: "#4ea1f3",
    supportsRemoteFiles: false,
  },
  profile: profile(id),
  number: 1,
  ordinal: 0,
  state,
  commandActivity: "idle",
  activityKind: "command",
  cols: 80,
  rows: 24,
  paneId,
});

const stripOf = (paneId: string) =>
  useStore
    .getState()
    .tabs.filter((tab) => tab.paneId === paneId)
    .map((tab) => tab.info.id);

const open = (id: string, state: SessionState = "connected") =>
  useStore.getState().addTab(makeTab(id).info, profile(id), state);

beforeEach(() => {
  useStore.setState({ ...initialState }, true);
});

describe("panes", () => {
  it("opens tabs in the active pane and focuses them", () => {
    open("a");
    open("b");
    const state = useStore.getState();
    expect(stripOf(ROOT)).toEqual(["a", "b"]);
    expect(state.activeId).toBe("b");
    expect(state.panes[0].activeTabId).toBe("b");
  });

  it("splits with a tab, which moves into the new pane and keeps the focus", () => {
    open("a");
    open("b");
    const right = useStore.getState().splitPane(ROOT, "right", "b");
    const state = useStore.getState();
    expect(right).not.toBe(ROOT);
    expect(paneIds(state.layout)).toEqual([ROOT, right]);
    expect(stripOf(ROOT)).toEqual(["a"]);
    expect(stripOf(right)).toEqual(["b"]);
    expect(state.activePaneId).toBe(right);
    expect(state.activeId).toBe("b");
    // The pane the tab left shows what it has left.
    expect(state.panes.find((pane) => pane.id === ROOT)?.activeTabId).toBe("a");
  });

  it("splits empty for a session to be opened into, then opens it there", () => {
    open("a");
    const below = useStore.getState().splitPane(ROOT, "down");
    expect(useStore.getState().activePaneId).toBe(below);
    expect(useStore.getState().activeId).toBeNull();
    open("b");
    expect(stripOf(below)).toEqual(["b"]);
    expect(useStore.getState().activeId).toBe("b");
  });

  it("refuses to split a lone tab out of its own pane", () => {
    open("a");
    expect(useStore.getState().splitPane(ROOT, "right", "a")).toBe(ROOT);
    expect(useStore.getState().panes).toHaveLength(1);
  });

  it("folds a pane away when its last tab closes and focuses the pane before it", async () => {
    open("a");
    open("b");
    const right = useStore.getState().splitPane(ROOT, "right", "b");
    await useStore.getState().closeTab("b");
    const state = useStore.getState();
    expect(state.panes.map((pane) => pane.id)).toEqual([ROOT]);
    expect(paneIds(state.layout)).toEqual([ROOT]);
    expect(state.activePaneId).toBe(ROOT);
    expect(state.activeId).toBe("a");
    expect(right).not.toBe(ROOT);
  });

  it("keeps the only pane, empty, when the last tab closes", async () => {
    open("a");
    await useStore.getState().closeTab("a");
    const state = useStore.getState();
    expect(state.panes).toEqual([{ id: ROOT, activeTabId: null }]);
    expect(state.activeId).toBeNull();
  });

  it("closing a tab in a background pane leaves the focus alone", async () => {
    open("a");
    open("b");
    open("c");
    useStore.getState().splitPane(ROOT, "right", "c");
    useStore.getState().setActive("a");
    await useStore.getState().closeTab("c");
    const state = useStore.getState();
    expect(state.activeId).toBe("a");
    expect(state.activePaneId).toBe(ROOT);
    expect(state.panes).toHaveLength(1);
  });

  it("moves a tab between panes and folds the emptied one", () => {
    open("a");
    open("b");
    open("c");
    const right = useStore.getState().splitPane(ROOT, "right", "c");
    useStore.getState().moveTabToPane("a", right, 0);
    expect(stripOf(right)).toEqual(["a", "c"]);
    expect(stripOf(ROOT)).toEqual(["b"]);
    expect(useStore.getState().activeId).toBe("a");
    useStore.getState().moveTabToPane("b", right, 99);
    const state = useStore.getState();
    expect(stripOf(right)).toEqual(["a", "c", "b"]);
    expect(state.panes.map((pane) => pane.id)).toEqual([right]);
    expect(state.activePaneId).toBe(right);
  });

  it("reorders within a strip without disturbing other strips", () => {
    open("a");
    open("b");
    open("c");
    open("d");
    const right = useStore.getState().splitPane(ROOT, "right", "d");
    useStore.getState().moveTab("a", 2);
    expect(stripOf(ROOT)).toEqual(["b", "c", "a"]);
    expect(stripOf(right)).toEqual(["d"]);
  });

  it("steps tabs within the active pane and panes in reading order", () => {
    open("a");
    open("b");
    open("c");
    const right = useStore.getState().splitPane(ROOT, "right", "c");
    useStore.getState().setActive("a");
    useStore.getState().activateAdjacentTab(1);
    expect(useStore.getState().activeId).toBe("b");
    useStore.getState().activateAdjacentTab(1);
    expect(useStore.getState().activeId).toBe("a");
    useStore.getState().activateAdjacentPane(1);
    expect(useStore.getState().activePaneId).toBe(right);
    expect(useStore.getState().activeId).toBe("c");
    useStore.getState().activateAdjacentPane(1);
    expect(useStore.getState().activePaneId).toBe(ROOT);
  });

  it("selecting a tab by id focuses its pane", () => {
    open("a");
    open("b");
    const right = useStore.getState().splitPane(ROOT, "right", "b");
    useStore.getState().setActive("a");
    expect(useStore.getState().activePaneId).toBe(ROOT);
    useStore.getState().setActive("b");
    expect(useStore.getState().activePaneId).toBe(right);
  });
});

describe("closing several tabs", () => {
  it("closes ended tabs at once and asks about the live ones together", () => {
    open("a");
    open("b", "closed");
    open("c");
    open("d", "error");
    useStore.getState().requestCloseTabs(["b", "c", "d"]);
    expect(useStore.getState().closePrompt).toEqual(["c"]);
  });

  it("asks nothing when every tab has already ended", () => {
    open("a", "closed");
    open("b", "error");
    useStore.getState().requestCloseTabs(["a", "b"]);
    expect(useStore.getState().closePrompt).toBeNull();
  });

  it("drops a tab from the pending question when it closes another way", async () => {
    open("a");
    open("b");
    useStore.getState().requestCloseTabs(["a", "b"]);
    await useStore.getState().closeTab("a");
    expect(useStore.getState().closePrompt).toEqual(["b"]);
    await useStore.getState().closeTab("b");
    expect(useStore.getState().closePrompt).toBeNull();
  });
});
