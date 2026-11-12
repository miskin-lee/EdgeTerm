import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../platform", () => ({ IS_MAC: true, IS_WINDOWS: false }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ onDragDropEvent: async () => () => {} }),
}));
vi.mock("../../nativeDialog", () => ({
  open: vi.fn().mockResolvedValue(["/local/archive.zip"]),
  save: vi.fn().mockResolvedValue("/local/download.txt"),
  ask: vi.fn().mockResolvedValue(true),
}));
vi.mock("../FileIcon", () => ({ FileIcon: () => null }));
vi.mock("../../api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../api")>()),
  sftpHome: vi.fn().mockImplementation(async (id: string) => `/${id}`),
  sftpList: vi.fn().mockImplementation(async (_id: string, path: string) => ({ path, entries: [
    { name: "file.txt", path: `${path}/file.txt`, isDir: false, isSymlink: false, size: 10, modified: null },
  ] })),
  localHome: vi.fn().mockResolvedValue("/local"),
  localList: vi.fn().mockResolvedValue({ path: "/local", entries: [] }),
  localIsDirectory: vi.fn().mockResolvedValue(false),
  sftpUpload: vi.fn(),
  sftpDownload: vi.fn(),
  cancelTransfer: vi.fn().mockResolvedValue(undefined),
  onRemoteEditState: vi.fn().mockResolvedValue(() => {}),
}));

import * as api from "../../api";
import { filerActivity, remoteEditActivity } from "../../filerActivity";
import * as nativeDialog from "../../nativeDialog";
import { useStore } from "../../store";
import { FilerPanel } from "./FilerPanel";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const initialState = useStore.getState();
interface PendingCopy {
  session: string;
  id?: string;
  progress: (progress: api.TransferProgress) => void;
  resolve: () => void;
  reject: (reason: Error) => void;
}

describe("Filer transfers by session", () => {
  let root: Root;
  let container: HTMLDivElement;
  let requests: PendingCopy[];

  const mount = async () => {
    await act(async () => root.render(createElement(FilerPanel)));
  };
  const switchTo = async (id: string) => {
    await act(async () => useStore.getState().setActive(id));
  };
  const progressbar = () => container.querySelector('[role="progressbar"]');
  const uploadButton = () => container.querySelector<HTMLButtonElement>('[aria-label="Upload files or folders"]')!;
  const upload = async () => {
    await act(async () => uploadButton().click());
    const menu = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
      .find((item) => item.textContent?.trim() === "Upload files…")!;
    await act(async () => menu.click());
  };

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    useStore.setState({ ...initialState }, true);
    filerActivity("").clear();
    for (const id of ["A", "B"]) {
      useStore.getState().addTab({
        id, profileId: id, name: id, kind: "ssh", protocol: "ssh",
        address: `${id}:22`, color: null, supportsRemoteFiles: true,
      }, { id, name: id, kind: "ssh", host: id });
    }
    useStore.getState().setActive("A");
    requests = [];
    const pending: typeof api.sftpUpload = (session, _from, _to, progress, id) =>
      new Promise<void>((resolve, reject) => requests.push({ session, progress, id, resolve, reject }));
    vi.mocked(api.sftpUpload).mockImplementation(pending);
    vi.mocked(api.sftpDownload).mockImplementation(pending);
    vi.mocked(nativeDialog.open).mockResolvedValue(["/local/archive.zip"]);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await mount();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    useStore.setState({ ...initialState }, true);
    filerActivity("").clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("keeps each SSH session's progress and Cancel button separate, including parallel uploads", async () => {
    await upload();
    act(() => requests[0].progress({ transferred: 25, total: 100 }));
    expect(progressbar()?.getAttribute("aria-valuenow")).toBe("25");
    await switchTo("B");
    expect(progressbar()).toBeNull();
    expect(uploadButton().disabled).toBe(false);
    await upload();
    expect(requests.map((request) => request.session)).toEqual(["A", "B"]);
    act(() => requests[1].progress({ transferred: 60, total: 100 }));
    expect(progressbar()?.getAttribute("aria-valuenow")).toBe("60");
    await switchTo("A");
    expect(progressbar()?.getAttribute("aria-valuenow")).toBe("25");
    act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Cancel:"]')!.click());
    expect(api.cancelTransfer).toHaveBeenCalledExactlyOnceWith(requests[0].id);
    await switchTo("B");
    expect(progressbar()?.getAttribute("aria-valuenow")).toBe("60");
  });

  it("retains progress when the panel is hidden or moved to another dock", async () => {
    await upload();
    act(() => root.render(null));
    requests[0].progress({ transferred: 80, total: 100 });
    await mount();
    expect(progressbar()?.getAttribute("aria-valuenow")).toBe("80");
    await act(async () => requests[0].resolve());
    expect(progressbar()?.getAttribute("aria-label")).toContain("Upload complete");
  });

  it("clears a disconnected session even when its upload never returns, and ignores its late callbacks after reconnect", async () => {
    await upload();
    act(() => useStore.getState().applyState("A", "closed"));
    expect(api.cancelTransfer).toHaveBeenCalledExactlyOnceWith(requests[0].id);
    expect(progressbar()).toBeNull();
    await switchTo("B");
    expect(progressbar()).toBeNull();
    act(() => useStore.getState().applyState("A", "connected"));
    await switchTo("A");
    await upload();
    act(() => requests[0].progress({ transferred: 99, total: 100 }));
    await act(async () => requests[0].reject(new Error("old connection lost")));
    expect(progressbar()?.getAttribute("aria-label")).toContain("Uploading");
    expect(progressbar()?.getAttribute("aria-valuenow")).toBeNull();
    expect(container.textContent).not.toContain("old connection lost");
  });

  it("ends cancellation immediately and does not resume the remainder of a batch on a late reply", async () => {
    vi.mocked(nativeDialog.open).mockResolvedValueOnce(["/local/first.zip", "/local/second.zip"]);
    await upload();
    act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Cancel:"]')!.click());
    expect(progressbar()?.getAttribute("aria-label")).toContain("Upload cancelled");
    expect(uploadButton().disabled).toBe(false);
    act(() => vi.advanceTimersByTime(1800));
    expect(progressbar()).toBeNull();
    await upload();
    act(() => requests[1].progress({ transferred: 30, total: 100 }));
    await act(async () => requests[0].resolve());
    expect(requests).toHaveLength(2);
    expect(progressbar()?.getAttribute("aria-valuenow")).toBe("30");
  });

  it("can cancel during local preparation without starting a copy or registering a stray backend cancel", async () => {
    let ready!: (directory: boolean) => void;
    vi.mocked(api.localIsDirectory).mockImplementationOnce(() => new Promise((resolve) => { ready = resolve; }));
    await upload();
    expect(requests).toHaveLength(0);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label^="Cancel:"]')!.click());
    await act(async () => ready(false));
    expect(requests).toHaveLength(0);
    expect(api.cancelTransfer).not.toHaveBeenCalled();
    expect(uploadButton().disabled).toBe(false);
  });

  it("does not leave an upload on the local Filer after every session is closed", async () => {
    await upload();
    await act(async () => useStore.setState({
      tabs: [], activeId: null,
      panes: [{ id: initialState.activePaneId, activeTabId: null }],
    }));
    expect(progressbar()).toBeNull();
    expect(container.querySelector(".panel-badge")?.textContent).toBe("local");
    expect(api.cancelTransfer).toHaveBeenCalledExactlyOnceWith(requests[0].id);
    act(() => requests[0].progress({ transferred: 90, total: 100 }));
    await act(async () => requests[0].reject(new Error("session closed")));
    expect(progressbar()).toBeNull();
    expect(container.textContent).not.toContain("session closed");
  });

  it("ignores a directory reply from before a disconnect and reconnect", async () => {
    let oldListing!: (listing: Awaited<ReturnType<typeof api.sftpList>>) => void;
    vi.mocked(api.sftpList).mockImplementationOnce(() => new Promise((resolve) => { oldListing = resolve; }));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Refresh"]')!.click());
    await act(async () => useStore.getState().applyState("A", "closed"));
    await act(async () => useStore.getState().applyState("A", "connected"));
    await act(async () => oldListing({ path: "/outdated", entries: [] }));
    expect(container.querySelector<HTMLInputElement>(".filer-path input")?.value).toBe("/A");
    expect(container.querySelector(".filer-entry")?.textContent).toContain("file.txt");
    expect(uploadButton().disabled).toBe(false);
  });

  it("scopes downloads and remote-edit saves to their source session as well", async () => {
    act(() => container.querySelector(".filer-entry")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Download file or folder"]')!.click());
    expect(requests[0].session).toBe("A");
    await switchTo("B");
    expect(progressbar()).toBeNull();
    act(() => remoteEditActivity({ sessionId: "A", remotePath: "/A/edit.txt", name: "edit.txt", status: "uploading", message: null }));
    expect(progressbar()).toBeNull();
    await act(async () => requests[0].resolve());
    act(() => remoteEditActivity({ sessionId: "A", remotePath: "/A/edit.txt", name: "edit.txt", status: "uploading", message: null }));
    await switchTo("A");
    expect(progressbar()?.getAttribute("aria-label")).toBe("Syncing: edit.txt");
    act(() => remoteEditActivity({ sessionId: "A", remotePath: "/A/edit.txt", name: "edit.txt", status: "synced", message: null }));
    expect(progressbar()?.getAttribute("aria-label")).toBe("Synced: edit.txt");
  });
});
