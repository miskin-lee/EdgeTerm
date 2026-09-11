/**
 * How the terminal area is divided into panes, VS Code editor-group style:
 * a tree whose leaves are panes (each with its own tab strip) and whose inner
 * nodes split their space between their children, side by side (`row`) or
 * stacked (`column`). Sizes are fractions of the parent that sum to 1, so
 * the tree says nothing in pixels and survives any window size.
 *
 * Every function here is pure and returns a new tree; the store owns the
 * current one. A tree is kept in normal form — no split with a single child
 * and no split nested in a split of the same direction — so `layoutRects`
 * and the splitters it places stay simple.
 */

export type SplitDirection = "row" | "column";

/** Where a new pane goes relative to an existing one. */
export type Side = "left" | "right" | "up" | "down";

export interface LeafNode {
  kind: "leaf";
  paneId: string;
}

export interface SplitNode {
  kind: "split";
  direction: SplitDirection;
  children: LayoutNode[];
  /** One fraction per child, summing to 1. */
  sizes: number[];
}

export type LayoutNode = LeafNode | SplitNode;

/** A rectangle in fractions of the workspace: 0…1 on both axes. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A draggable boundary between two children of a split. `rect` is the line
 * it sits on (zero width for a row split, zero height for a column split);
 * `extent` is the split's own size along that axis, as a fraction of the
 * workspace, which turns a pixel drag into a fraction of the split.
 */
export interface SplitterRect {
  /** Child indices from the root down to the split node. */
  path: number[];
  /** The boundary after this child. */
  index: number;
  direction: SplitDirection;
  rect: Rect;
  extent: number;
}

export const leaf = (paneId: string): LayoutNode => ({ kind: "leaf", paneId });

const directionOf = (side: Side): SplitDirection =>
  side === "left" || side === "right" ? "row" : "column";

const sum = (values: number[]): number =>
  values.reduce((total, value) => total + value, 0);

/** The pane ids in reading order: left to right, top to bottom. */
export function paneIds(node: LayoutNode): string[] {
  if (node.kind === "leaf") return [node.paneId];
  return node.children.flatMap(paneIds);
}

/** The pane `step` places after (1) or before (-1) `paneId`, wrapping around. */
export function adjacentPane(
  node: LayoutNode,
  paneId: string,
  step: -1 | 1,
): string | null {
  const ids = paneIds(node);
  if (ids.length === 0) return null;
  const index = ids.indexOf(paneId);
  if (index === -1) return ids[0];
  return ids[(index + step + ids.length) % ids.length];
}

/**
 * Puts a new pane beside an existing one, on the given side, taking half of
 * its room. When the pane already sits in a split running that way the new
 * pane becomes another child of it — three panes side by side stay one row,
 * not a row nested in a row.
 */
export function splitPane(
  node: LayoutNode,
  paneId: string,
  side: Side,
  newPaneId: string,
): LayoutNode {
  const direction = directionOf(side);
  const before = side === "left" || side === "up";

  const visit = (current: LayoutNode): LayoutNode => {
    if (current.kind === "leaf") {
      if (current.paneId !== paneId) return current;
      const added = leaf(newPaneId);
      return {
        kind: "split",
        direction,
        children: before ? [added, current] : [current, added],
        sizes: [0.5, 0.5],
      };
    }
    const index = current.children.findIndex(
      (child) => child.kind === "leaf" && child.paneId === paneId,
    );
    if (index !== -1 && current.direction === direction) {
      const children = [...current.children];
      const sizes = [...current.sizes];
      const half = sizes[index] / 2;
      sizes[index] = half;
      const at = before ? index : index + 1;
      children.splice(at, 0, leaf(newPaneId));
      sizes.splice(at, 0, half);
      return { ...current, children, sizes };
    }
    return { ...current, children: current.children.map(visit) };
  };

  return visit(node);
}

/**
 * Folds a same-direction child split into its parent and rescales the
 * fractions to sum to 1 again.
 */
function normalizeSplit(node: SplitNode): SplitNode {
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const size = node.sizes[index];
    if (child.kind === "split" && child.direction === node.direction) {
      const total = sum(child.sizes) || 1;
      child.children.forEach((grandchild, grandIndex) => {
        children.push(grandchild);
        sizes.push((size * child.sizes[grandIndex]) / total);
      });
    } else {
      children.push(child);
      sizes.push(size);
    }
  });
  const total = sum(sizes) || 1;
  return {
    kind: "split",
    direction: node.direction,
    children,
    sizes: sizes.map((size) => size / total),
  };
}

/**
 * Takes a pane out; its siblings share the room it had, in proportion. Null
 * when it was the only pane. A split left with one child gives way to that
 * child.
 */
export function removePane(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === "leaf") return node.paneId === paneId ? null : node;
  const children: LayoutNode[] = [];
  const sizes: number[] = [];
  node.children.forEach((child, index) => {
    const kept = removePane(child, paneId);
    if (kept) {
      children.push(kept);
      sizes.push(node.sizes[index]);
    }
  });
  if (children.length === 0) return null;
  if (children.length === 1) return children[0];
  return normalizeSplit({ ...node, children, sizes });
}

/**
 * Moves the boundary after child `index` of the split at `path` by `delta`,
 * a fraction of that split's extent; neither neighbour goes below `minSize`
 * (the same unit). A boundary whose neighbours are both already at the
 * minimum stays put.
 */
export function resizeSplit(
  node: LayoutNode,
  path: number[],
  index: number,
  delta: number,
  minSize: number,
): LayoutNode {
  if (path.length === 0) {
    if (node.kind !== "split" || index < 0 || index >= node.sizes.length - 1) {
      return node;
    }
    const sizes = [...node.sizes];
    const low = minSize - sizes[index];
    const high = sizes[index + 1] - minSize;
    if (low > high) return node;
    const applied = Math.min(high, Math.max(low, delta));
    if (applied === 0) return node;
    sizes[index] += applied;
    sizes[index + 1] -= applied;
    return { ...node, sizes };
  }
  if (node.kind !== "split") return node;
  const [head, ...rest] = path;
  const child = node.children[head];
  if (!child) return node;
  const resized = resizeSplit(child, rest, index, delta, minSize);
  if (resized === child) return node;
  const children = [...node.children];
  children[head] = resized;
  return { ...node, children };
}

/**
 * Where everything goes, in fractions of the workspace: the rectangle of
 * each pane and the line of each splitter.
 */
export function layoutRects(node: LayoutNode): {
  panes: Map<string, Rect>;
  splitters: SplitterRect[];
} {
  const panes = new Map<string, Rect>();
  const splitters: SplitterRect[] = [];

  const walk = (current: LayoutNode, rect: Rect, path: number[]) => {
    if (current.kind === "leaf") {
      panes.set(current.paneId, rect);
      return;
    }
    const row = current.direction === "row";
    let offset = 0;
    current.children.forEach((child, index) => {
      const size = current.sizes[index];
      walk(
        child,
        row
          ? { x: rect.x + rect.w * offset, y: rect.y, w: rect.w * size, h: rect.h }
          : { x: rect.x, y: rect.y + rect.h * offset, w: rect.w, h: rect.h * size },
        [...path, index],
      );
      offset += size;
      if (index < current.children.length - 1) {
        splitters.push({
          path,
          index,
          direction: current.direction,
          rect: row
            ? { x: rect.x + rect.w * offset, y: rect.y, w: 0, h: rect.h }
            : { x: rect.x, y: rect.y + rect.h * offset, w: rect.w, h: 0 },
          extent: row ? rect.w : rect.h,
        });
      }
    });
  };

  walk(node, { x: 0, y: 0, w: 1, h: 1 }, []);
  return { panes, splitters };
}
