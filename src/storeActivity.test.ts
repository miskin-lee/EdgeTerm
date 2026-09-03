import { beforeEach, describe, expect, it } from "vitest";

import { useStore, type Tab } from "./store";

const initialState = useStore.getState();

const makeTab = (id: string): Tab => ({
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
  profile: { id, name: id, kind: "local" },
  number: id === "one" ? 1 : 2,
  ordinal: 0,
  state: "connected",
  commandActivity: "idle",
  activityKind: "command",
  cols: 80,
  rows: 24,
});

beforeEach(() => {
  useStore.setState(
    { ...initialState, tabs: [makeTab("one"), makeTab("two")], activeId: "one" },
    true,
  );
});

describe("tab command activity", () => {
  it("keeps a background completion unread until the tab is selected", () => {
    const store = useStore.getState();
    store.markCommandStarted("two");
    store.markCommandCompleted("two");

    expect(useStore.getState().tabs[1].commandActivity).toBe("complete");
    useStore.getState().setActive("two");
    expect(useStore.getState().tabs[1].commandActivity).toBe("idle");
  });

  it("does not leave a notification for the visible terminal", () => {
    const store = useStore.getState();
    store.markCommandStarted("one");
    store.markCommandCompleted("one");

    expect(useStore.getState().tabs[0].commandActivity).toBe("idle");
  });

  it("preserves running state when visited and clears it when the session ends", () => {
    const store = useStore.getState();
    store.markCommandStarted("two");
    store.setActive("two");
    expect(useStore.getState().tabs[1].commandActivity).toBe("running");

    useStore.getState().applyState("two", "closed", "exited");
    expect(useStore.getState().tabs[1].commandActivity).toBe("idle");
  });
});
