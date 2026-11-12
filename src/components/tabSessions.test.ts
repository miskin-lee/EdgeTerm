import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform", () => ({ IS_MAC: true, IS_WINDOWS: false }));
vi.mock("../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../api")>()),
  saveProfile: vi.fn(),
  openSession: vi.fn(),
  closeSession: vi.fn(),
  resizeSession: vi.fn().mockResolvedValue(undefined),
  defaultRecordingDir: vi.fn().mockResolvedValue("/recordings"),
}));

import * as api from "../api";
import { ensureController } from "../actions";
import { useStore } from "../store";
import { allControllers, disposeController, getController } from "../terminalRegistry";
import type { SessionProfile } from "../types";
import { SessionDialog } from "./SessionDialog";
import { TabStrip } from "./TabStrip";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useStore.getState();
const sourcePane = initialState.activePaneId;
const profile: SessionProfile = {
  id: "",
  name: "Temporary SSH",
  kind: "ssh",
  host: "server.example",
  username: "operator",
  auth: "password",
  password: "temporary-password",
  encoding: "gbk",
  backspace: "controlH",
};

function addTab(id: string, settings: SessionProfile) {
  useStore.getState().addTab({
    id,
    profileId: settings.id || null,
    name: settings.name,
    kind: settings.kind,
    protocol: "ssh",
    address: `${settings.host}:22`,
    color: null,
    supportsRemoteFiles: true,
  }, settings);
}

function Harness() {
  const [saving, setSaving] = useState<string | null>(null);
  const tab = useStore((s) => s.tabs.find((item) => item.info.id === saving));
  return createElement("div", null,
    createElement(TabStrip, { paneId: sourcePane, onSaveSession: setSaving }),
    tab && createElement(SessionDialog, {
      initial: tab.profile,
      saveSessionId: tab.info.id,
      onClose: () => setSaving(null),
    }),
  );
}

describe("tab session commands", () => {
  let container: HTMLDivElement;
  let root: Root;

  const button = (text: string) => {
    const found = [...container.querySelectorAll("button")]
      .find((item) => item.textContent?.trim() === text);
    expect(found, `button ${text}`).toBeDefined();
    return found!;
  };
  const click = async (text: string) => {
    await act(async () => button(text).click());
  };
  const contextMenu = () => act(() => {
    container.querySelector('[data-tab-id="source"]')!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 10 }),
    );
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    Element.prototype.scrollIntoView = vi.fn();
    useStore.setState({ ...initialState }, true);
    addTab("source", profile);
    const otherPane = useStore.getState().splitPane(sourcePane, "right");
    addTab("foreground", { ...profile, name: "Other server", host: "other.example" });
    expect(useStore.getState().activePaneId).toBe(otherPane);
    vi.mocked(api.openSession).mockImplementation(async (settings, id) => {
      // Every duplicate gets its own terminal before the backend can emit output.
      expect(getController(id)).toBeDefined();
      return { status: "connected", info: {
        id,
        profileId: settings.id || null,
        name: settings.name,
        kind: settings.kind,
        protocol: "ssh",
        address: `${settings.host}:22`,
        color: settings.color ?? null,
        supportsRemoteFiles: true,
      } };
    });
    vi.mocked(api.saveProfile).mockImplementation(async (settings) => ({
      ...settings,
      id: settings.id || "saved-profile",
      password: null,
      passphrase: null,
    }));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(createElement(Harness)));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    for (const controller of allControllers()) disposeController(controller.sessionId);
    vi.unstubAllGlobals();
  });

  it("duplicates the right-clicked background session in its own pane with a fresh connection", async () => {
    const original = await ensureController("source");
    await new Promise<void>((resolve) => original.term.write("existing output", resolve));
    contextMenu();
    await click("Duplicate Session");

    const state = useStore.getState();
    const duplicate = state.tabs.find((tab) => !["source", "foreground"].includes(tab.info.id))!;
    expect(api.openSession).toHaveBeenCalledExactlyOnceWith(profile, duplicate.info.id);
    expect(duplicate.paneId).toBe(sourcePane);
    expect(duplicate.state).toBe("connected");
    expect(state.activeId).toBe(duplicate.info.id);
    expect(state.panes).toHaveLength(2);
    expect(duplicate.ordinal).toBe(1);
    expect(getController("source")).toBe(original);
    expect(getController(duplicate.info.id)).not.toBe(original);
    expect(original.term.buffer.active.getLine(0)?.translateToString(true)).toBe("existing output");
    expect(api.closeSession).not.toHaveBeenCalled();
    expect(api.saveProfile).not.toHaveBeenCalled();
  });

  it("saves the right-clicked session's settings without reconnecting and updates the same profile next time", async () => {
    const source = useStore.getState().tabs[0];
    contextMenu();
    await click("Save Session…");
    expect(container.querySelector("#session-dialog-title")?.textContent).toBe("Save Session");
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(profile.password);
    expect([...container.querySelectorAll("button")].some((item) => item.textContent?.trim() === "Connect")).toBe(false);
    const name = [...container.querySelectorAll("label")]
      .find((item) => item.querySelector("span")?.textContent === "Name")!
      .querySelector("input")!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(name, "Saved server");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("Save");

    const state = useStore.getState();
    expect(api.saveProfile).toHaveBeenCalledWith(expect.objectContaining({ ...profile, name: "Saved server" }));
    expect(state.profiles).toHaveLength(1);
    expect(state.profiles[0].password).toBeNull();
    expect(state.tabs[0]).toMatchObject({
      number: source.number,
      ordinal: source.ordinal,
      state: "connected",
      paneId: sourcePane,
      profile: { id: "saved-profile", name: "Saved server" },
      info: { id: "source", profileId: "saved-profile", name: "Saved server", address: source.info.address },
    });
    expect(state.tabs).toHaveLength(2);
    expect(state.activeId).toBe("foreground");
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    contextMenu();
    await click("Save Session…");
    await click("Save");
    expect(vi.mocked(api.saveProfile).mock.calls[1][0].id).toBe("saved-profile");
    expect(useStore.getState().profiles).toHaveLength(1);
    expect(api.openSession).not.toHaveBeenCalled();
    expect(api.closeSession).not.toHaveBeenCalled();
  });

  it("keeps the form and the original session when saving fails", async () => {
    const before = useStore.getState().tabs;
    vi.mocked(api.saveProfile).mockRejectedValueOnce(new Error("disk is read-only"));
    contextMenu();
    await click("Save Session…");
    await click("Save");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("disk is read-only");
    expect(container.querySelector('[role="dialog"]')).not.toBeNull();
    expect(useStore.getState().tabs).toBe(before);
    expect(useStore.getState().profiles).toEqual([]);
    expect(api.openSession).not.toHaveBeenCalled();
  });

  it("leaves the original connected when a duplicate cannot connect", async () => {
    const source = useStore.getState().tabs[0];
    vi.mocked(api.openSession).mockRejectedValueOnce(new Error("connection refused"));
    contextMenu();
    await click("Duplicate Session");
    expect(useStore.getState().tabs[0]).toBe(source);
    const tabs = useStore.getState().tabs;
    expect(tabs[tabs.length - 1]).toMatchObject({ state: "error", message: "Error: connection refused" });
    expect(api.closeSession).not.toHaveBeenCalled();
  });
});
