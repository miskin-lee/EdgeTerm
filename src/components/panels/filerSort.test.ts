import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../platform", () => ({ IS_MAC: true, IS_WINDOWS: false }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../FileIcon", () => ({ FileIcon: () => null }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  localHome: vi.fn().mockResolvedValue("/local"),
  localList: vi.fn(),
  sftpHome: vi.fn().mockResolvedValue("/remote"),
  sftpList: vi.fn(),
  onRemoteEditState: vi.fn().mockResolvedValue(() => {}),
}));

import * as api from "../../api";
import { useStore } from "../../store";
import type { FileEntry } from "../../types";
import { FilerPanel } from "./FilerPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initialState = useStore.getState();
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const listing = (path: string) => ({
  path,
  entries: [
    { name: "file10", size: 100, modified: 3 },
    { name: "folder", isDir: true, size: 4096, modified: 1 },
    { name: "file2", size: 300, modified: 2 },
    { name: "file1", size: 200, modified: 4 },
  ].map((item): FileEntry => ({
    isDir: false, isSymlink: false, permissions: null, owner: null, group: null,
    ...item, path: `${path}/${item.name}`,
  })),
});

describe("Filer sort controls", () => {
  let root: Root;
  let container: HTMLDivElement;
  const mount = async () => { await act(async () => root.render(createElement(FilerPanel))); };
  const button = (label: string) => container.querySelector<HTMLButtonElement>(`[aria-label^="${label}"]`)!;
  const click = async (label: string) => { await act(async () => button(label).click()); };
  const rows = () => [...container.querySelectorAll<HTMLDivElement>(".filer-entry")];
  const names = () => rows().map((row) => row.querySelector(".row-label")!.textContent);
  const selected = () => rows().filter((row) => row.classList.contains("is-active"))
    .map((row) => row.querySelector(".row-label")!.textContent);
  const press = (name: string, shiftKey = false) => {
    const row = rows().find((row) => row.querySelector(".row-label")!.textContent === name)!;
    act(() => row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, shiftKey })));
  };
  const chooseSort = async (label: string) => {
    await click("Sort files");
    const option = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
      .find((item) => item.textContent === label)!;
    await act(async () => option.click());
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
    HTMLElement.prototype.scrollIntoView = vi.fn();
    useStore.setState({ ...initialState }, true);
    vi.mocked(api.localList).mockImplementation(async (path) => listing(path));
    vi.mocked(api.sftpList).mockImplementation(async (_id, path) => listing(path));
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await mount();
    await chooseSort("Name");
    await chooseSort("Ascending");
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useStore.setState({ ...initialState }, true);
    vi.restoreAllMocks();
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    vi.unstubAllGlobals();
  });

  it("toggles column order and keeps selection, Shift ranges and typing aligned with rows", async () => {
    expect(names()).toEqual(["folder", "file1", "file2", "file10"]);
    press("file10");
    await click("Sort by Name");
    expect(names()).toEqual(["folder", "file10", "file2", "file1"]);
    expect(selected()).toEqual(["file10"]);
    press("file1", true);
    expect(selected()).toEqual(["file10", "file2", "file1"]);
    press("folder");
    const list = container.querySelector<HTMLDivElement>(".filer-list")!;
    act(() => list.dispatchEvent(new KeyboardEvent("keydown", { key: "f", bubbles: true })));
    expect(selected()).toEqual(["file10"]);
    expect(rows()[1].scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    await click("Sort by Modified");
    expect(names()).toEqual(["folder", "file1", "file10", "file2"]);
    expect(button("Sort by Modified").getAttribute("aria-label")).toContain("descending");
    await click("Sort by Modified");
    expect(names()).toEqual(["folder", "file2", "file10", "file1"]);
  });

  it("offers size sorting in the narrow sidebar and retains it across refresh, navigation and remount", async () => {
    expect(button("Sort by Size")).toBeNull();
    await chooseSort("Size");
    const expected = ["folder", "file2", "file1", "file10"];
    expect(names()).toEqual(expected);
    await click("Refresh");
    expect(names()).toEqual(expected);
    await act(async () => rows()[0].dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(api.localList).toHaveBeenLastCalledWith("/local/folder");
    expect(names()).toEqual(expected);
    act(() => root.render(null));
    await mount();
    expect(names()).toEqual(expected);
    await chooseSort("Ascending");
    expect(names()).toEqual(["folder", "file10", "file1", "file2"]);
  });

  it("applies the same order after switching to an SSH file listing", async () => {
    await chooseSort("Modified");
    await act(async () => useStore.getState().addTab({
      id: "sort-ssh", profileId: "sort-ssh", name: "Sort SSH", kind: "ssh", protocol: "ssh",
      address: "example:22", color: null, supportsRemoteFiles: true,
    }, { id: "sort-ssh", name: "Sort SSH", kind: "ssh", host: "example" }));
    expect(api.sftpList).toHaveBeenCalled();
    expect(names()).toEqual(["folder", "file1", "file10", "file2"]);
  });

  it("can reopen the menu with the keyboard after toggling it closed with the mouse", async () => {
    const toggle = button("Sort files");
    const mouseClick = async () => {
      act(() => toggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      await act(async () => toggle.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 })));
    };
    await mouseClick();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await mouseClick();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    // Keyboard-generated clicks have no preceding mousedown and detail = 0.
    await click("Sort files");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await click("Sort files");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
  });
});
