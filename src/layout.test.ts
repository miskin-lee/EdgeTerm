import { describe, expect, it } from "vitest";

import {
  adjacentPane,
  layoutRects,
  leaf,
  paneIds,
  removePane,
  resizeSplit,
  splitPane,
  type LayoutNode,
} from "./layout";

const close = (actual: number, expected: number) =>
  expect(actual).toBeCloseTo(expected, 6);

describe("splitPane", () => {
  it("turns a lone pane into a pair sharing the room", () => {
    const tree = splitPane(leaf("a"), "a", "right", "b");
    expect(tree).toEqual({
      kind: "split",
      direction: "row",
      children: [leaf("a"), leaf("b")],
      sizes: [0.5, 0.5],
    });
    expect(splitPane(leaf("a"), "a", "up", "b")).toEqual({
      kind: "split",
      direction: "column",
      children: [leaf("b"), leaf("a")],
      sizes: [0.5, 0.5],
    });
  });

  it("adds a third pane to a split running the same way instead of nesting", () => {
    const pair = splitPane(leaf("a"), "a", "right", "b");
    const tree = splitPane(pair, "b", "right", "c");
    expect(paneIds(tree)).toEqual(["a", "b", "c"]);
    expect(tree.kind === "split" && tree.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it("nests when the split runs the other way", () => {
    const pair = splitPane(leaf("a"), "a", "right", "b");
    const tree = splitPane(pair, "b", "down", "c");
    expect(paneIds(tree)).toEqual(["a", "b", "c"]);
    const { panes } = layoutRects(tree);
    expect(panes.get("a")).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(panes.get("b")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(panes.get("c")).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });
});

describe("removePane", () => {
  it("hands the room back to the siblings in proportion", () => {
    let tree: LayoutNode = splitPane(leaf("a"), "a", "right", "b");
    tree = splitPane(tree, "b", "right", "c");
    tree = resizeSplit(tree, [], 0, 0.1, 0.05); // a 0.6, b 0.15, c 0.25
    const after = removePane(tree, "b")!;
    expect(paneIds(after)).toEqual(["a", "c"]);
    const sizes = after.kind === "split" ? after.sizes : [];
    close(sizes[0], 0.6 / 0.85);
    close(sizes[1], 0.25 / 0.85);
  });

  it("collapses a split left with one child and flattens same-direction nesting", () => {
    // a | (b over (c | d)): removing b leaves (c | d) inside the row, which
    // becomes a | c | d.
    let tree: LayoutNode = splitPane(leaf("a"), "a", "right", "b");
    tree = splitPane(tree, "b", "down", "c");
    tree = splitPane(tree, "c", "right", "d");
    const after = removePane(tree, "b")!;
    expect(after.kind).toBe("split");
    expect(after.kind === "split" && after.direction).toBe("row");
    expect(paneIds(after)).toEqual(["a", "c", "d"]);
    expect(after.kind === "split" && after.sizes).toEqual([0.5, 0.25, 0.25]);
  });

  it("returns null for the last pane and a leaf for a pair", () => {
    expect(removePane(leaf("a"), "a")).toBeNull();
    const pair = splitPane(leaf("a"), "a", "down", "b");
    expect(removePane(pair, "a")).toEqual(leaf("b"));
    expect(removePane(pair, "zzz")).toEqual(pair);
  });
});

describe("resizeSplit", () => {
  it("moves a boundary and keeps both neighbours above the minimum", () => {
    const pair = splitPane(leaf("a"), "a", "right", "b");
    const wider = resizeSplit(pair, [], 0, 0.2, 0.1);
    expect(wider.kind === "split" && wider.sizes).toEqual([0.7, 0.3]);
    const clamped = resizeSplit(pair, [], 0, 0.9, 0.1);
    const sizes = clamped.kind === "split" ? clamped.sizes : [];
    close(sizes[0], 0.9);
    close(sizes[1], 0.1);
    expect(resizeSplit(pair, [], 0, 0, 0.1)).toBe(pair);
    expect(resizeSplit(pair, [], 1, 0.1, 0.1)).toBe(pair);
  });

  it("reaches a nested split by path", () => {
    let tree: LayoutNode = splitPane(leaf("a"), "a", "right", "b");
    tree = splitPane(tree, "b", "down", "c");
    const resized = resizeSplit(tree, [1], 0, -0.25, 0.1);
    const { panes } = layoutRects(resized);
    expect(panes.get("b")).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.25 });
    expect(panes.get("c")).toEqual({ x: 0.5, y: 0.25, w: 0.5, h: 0.75 });
  });
});

describe("layoutRects", () => {
  it("places one splitter per boundary with the split's extent", () => {
    let tree: LayoutNode = splitPane(leaf("a"), "a", "right", "b");
    tree = splitPane(tree, "b", "down", "c");
    const { splitters } = layoutRects(tree);
    expect(splitters).toEqual([
      {
        path: [],
        index: 0,
        direction: "row",
        rect: { x: 0.5, y: 0, w: 0, h: 1 },
        extent: 1,
      },
      {
        path: [1],
        index: 0,
        direction: "column",
        rect: { x: 0.5, y: 0.5, w: 0.5, h: 0 },
        extent: 1,
      },
    ]);
  });
});

describe("adjacentPane", () => {
  it("steps through panes in reading order and wraps", () => {
    let tree: LayoutNode = splitPane(leaf("a"), "a", "right", "b");
    tree = splitPane(tree, "b", "down", "c");
    expect(adjacentPane(tree, "a", 1)).toBe("b");
    expect(adjacentPane(tree, "c", 1)).toBe("a");
    expect(adjacentPane(tree, "a", -1)).toBe("c");
    expect(adjacentPane(tree, "missing", 1)).toBe("a");
  });
});
