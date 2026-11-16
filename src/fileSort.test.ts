import { describe, expect, it } from "vitest";

import { sortFileEntries, type FileSort } from "./fileSort";
import type { FileEntry } from "./types";

const entry = (name: string, extra: Partial<FileEntry> = {}): FileEntry => ({
  name, path: `/${name}`, isDir: false, isSymlink: false, size: 0,
  modified: null, permissions: null, owner: null, group: null, ...extra,
});
const names = (entries: FileEntry[], sort: FileSort) =>
  sortFileEntries(entries, sort).map((item) => item.name);

describe("file sorting", () => {
  it("uses natural, case-insensitive names and keeps folders first in both directions", () => {
    const entries = [entry("File10"), entry("z", { isDir: true }), entry("file2"), entry("a", { isDir: true })];
    expect(names(entries, { key: "name", direction: "ascending" })).toEqual(["a", "z", "file2", "File10"]);
    expect(names(entries, { key: "name", direction: "descending" })).toEqual(["z", "a", "File10", "file2"]);
    expect(entries.map((item) => item.name)).toEqual(["File10", "z", "file2", "a"]);
  });

  it("sorts raw byte sizes, ignoring folder and link stat sizes", () => {
    const entries = [
      entry("a-dir", { isDir: true, size: 8192 }),
      entry("b-dir", { isDir: true, size: 1 }),
      entry("link", { isSymlink: true, size: 50 }),
      entry("large", { size: 2048 }), entry("small", { size: 100 }), entry("empty"),
    ];
    expect(names(entries, { key: "size", direction: "ascending" })).toEqual(["a-dir", "b-dir", "empty", "small", "large", "link"]);
    expect(names(entries, { key: "size", direction: "descending" })).toEqual(["a-dir", "b-dir", "large", "small", "empty", "link"]);
  });

  it("sorts full timestamps, keeping unknown dates last and breaking ties by name", () => {
    const entries = [
      entry("unknown"), entry("epoch", { modified: 0 }),
      entry("later", { modified: 1700000001 }),
      entry("b", { modified: 1700000000 }), entry("a", { modified: 1700000000 }),
      entry("old-dir", { isDir: true, modified: 1 }),
      entry("new-dir", { isDir: true, modified: 2 }),
    ];
    expect(names(entries, { key: "modified", direction: "descending" })).toEqual(["new-dir", "old-dir", "later", "a", "b", "epoch", "unknown"]);
    expect(names(entries, { key: "modified", direction: "ascending" })).toEqual(["old-dir", "new-dir", "epoch", "a", "b", "later", "unknown"]);
    expect(names([...entries].reverse(), { key: "modified", direction: "ascending" })).toEqual(names(entries, { key: "modified", direction: "ascending" }));
  });
});
