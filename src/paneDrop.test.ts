import { describe, expect, it } from "vitest";

import {
  dropAction,
  isSameOrBelow,
  type DraggedEntry,
} from "./paneDrop";
import type { FileEntry } from "./types";

const entry = (name: string, overrides: Partial<FileEntry> = {}): FileEntry => ({
  name,
  path: `/${name}`,
  isDir: false,
  isSymlink: false,
  size: 0,
  modified: null,
  permissions: null,
  owner: null,
  group: null,
  ...overrides,
});

const localEntry = (path: string, overrides: Partial<FileEntry> = {}): FileEntry =>
  entry(path.split(/[\\/]/).pop() ?? path, { path, ...overrides });

describe("dropAction", () => {
  it("transfers across panes in both directions", () => {
    const source: DraggedEntry = {
      side: "local",
      entry: localEntry("C:\\Users\\me\\report.pdf"),
    };
    expect(dropAction(source, { side: "remote", dir: "/srv" })).toEqual({
      kind: "upload",
    });

    const remote: DraggedEntry = { side: "remote", entry: entry("log.txt") };
    expect(dropAction(remote, { side: "local", dir: "C:\\Users\\me" })).toEqual({
      kind: "download",
    });
  });

  it("moves a file dropped on its own pane's folder row", () => {
    const source: DraggedEntry = {
      side: "remote",
      entry: entry("notes.md", { path: "/home/me/notes.md" }),
    };
    expect(dropAction(source, { side: "remote", dir: "/home/me/archive" })).toEqual({
      kind: "move",
    });
  });

  it("refuses a no-op move onto the folder the entry already sits in", () => {
    const source: DraggedEntry = {
      side: "remote",
      entry: entry("notes.md", { path: "/home/me/notes.md" }),
    };
    expect(dropAction(source, { side: "remote", dir: "/home/me" })).toBeNull();
  });

  it("refuses dropping a folder into itself or its own subtree", () => {
    const source: DraggedEntry = {
      side: "remote",
      entry: entry("project", { path: "/home/me/project", isDir: true }),
    };
    expect(dropAction(source, { side: "remote", dir: "/home/me/project" })).toBeNull();
    expect(
      dropAction(source, { side: "remote", dir: "/home/me/project/src" }),
    ).toBeNull();
    // Onto its parent the move would change nothing; on an unrelated
    // folder it still moves.
    expect(dropAction(source, { side: "remote", dir: "/home/me" })).toBeNull();
    expect(dropAction(source, { side: "remote", dir: "/tmp" })).toEqual({
      kind: "move",
    });
  });

  it("keeps local path checks case- and separator-insensitive", () => {
    const source: DraggedEntry = {
      side: "local",
      entry: localEntry("C:\\Data\\Site", { isDir: true }),
    };
    expect(dropAction(source, { side: "local", dir: "c:/data/site/assets" })).toBeNull();
    expect(dropAction(source, { side: "local", dir: "c:/other" })).toEqual({
      kind: "move",
    });
  });
});

describe("isSameOrBelow", () => {
  it("compares local paths across case and separators", () => {
    expect(isSameOrBelow("c:/users/me/docs", "C:\\Users\\ME")).toBe(true);
    expect(isSameOrBelow("C:\\Users\\Me", "C:\\Users")).toBe(true);
    expect(isSameOrBelow("C:\\Users", "C:\\Users")).toBe(true);
  });

  it("compares remote paths exactly", () => {
    expect(isSameOrBelow("/Home/me", "/home")).toBe(false);
    expect(isSameOrBelow("/home/me/docs", "/home/me")).toBe(true);
    expect(isSameOrBelow("/home/me/", "/home/me")).toBe(true);
  });

  it("does not treat sibling prefixes as containment", () => {
    expect(isSameOrBelow("/home/metrics", "/home/me")).toBe(false);
  });
});
