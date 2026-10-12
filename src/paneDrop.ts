import type { FileEntry } from "./types";

export type PaneSide = "local" | "remote";

/** The entry a drag is carrying, recorded on dragstart and read on drop. */
export interface DraggedEntry {
  side: PaneSide;
  entry: FileEntry;
}

/**
 * Where a drop landed: a pane's current directory, or one of its folder rows
 * the entry was dropped on.
 */
export interface DropTarget {
  side: PaneSide;
  dir: string;
}

export type DropAction =
  /** A local entry heading to the remote pane. */
  | { kind: "upload" }
  /** A remote entry heading to the local pane. */
  | { kind: "download" }
  /** A rename within one side, into the target folder. */
  | { kind: "move" };

/**
 * What dropping `source` on `target` does; null means the drop should be
 * refused. A drop inside one pane is a move, but only when it would actually
 * change something: a folder cannot be dropped into itself or its own
 * subtree, and nothing moves onto the directory it already sits in.
 */
export function dropAction(
  source: DraggedEntry,
  target: DropTarget,
): DropAction | null {
  if (source.side !== target.side) {
    return source.side === "local" ? { kind: "upload" } : { kind: "download" };
  }
  if (source.entry.isDir && isSameOrBelow(target.dir, source.entry.path)) {
    return null;
  }
  if (normalizePath(target.dir) === normalizePath(parentOf(source.entry.path))) {
    return null;
  }
  return { kind: "move" };
}

/**
 * Whether `dir` is `path` itself or inside it. Local Windows paths compare
 * case-insensitively and across separator styles; remote POSIX paths compare
 * exactly.
 */
export function isSameOrBelow(dir: string, path: string): boolean {
  const d = normalizePath(dir);
  const p = normalizePath(path);
  if (d === p) return true;
  return d.startsWith(`${p}/`);
}

function normalizePath(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  const slashes = trimmed.replace(/\\/g, "/");
  return /^[A-Za-z]:/.test(slashes) ? slashes.toLowerCase() : slashes;
}

/**
 * The directory an entry sits in, on either separator style, compared the way
 * `normalizePath` compares. Paths with no separator sit in the root.
 */
function parentOf(path: string): string {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "/" : normalized.slice(0, slash);
}
