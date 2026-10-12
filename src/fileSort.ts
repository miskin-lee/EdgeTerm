import type { FileEntry } from "./types";

export type SortKey = "name" | "modified" | "size";
export type SortDirection = "asc" | "desc";

export interface FileSort {
  key: SortKey;
  direction: SortDirection;
}

const SORT_STORAGE_KEY = "edgeterm.filerSort";

export const DEFAULT_FILE_SORT: FileSort = { key: "name", direction: "asc" };

const SORT_KEYS: readonly SortKey[] = ["name", "modified", "size"];
const DIRECTIONS: readonly SortDirection[] = ["asc", "desc"];

/** Clicking a column caption: a new key starts ascending, the active one flips. */
export function toggleFileSort(current: FileSort, key: SortKey): FileSort {
  if (current.key !== key) return { key, direction: "asc" };
  return { key, direction: current.direction === "asc" ? "desc" : "asc" };
}

/** The suffix a sorted column's caption shows; empty for an inactive column. */
export function sortIndicator(current: FileSort, key: SortKey): string {
  if (current.key !== key) return "";
  return current.direction === "asc" ? " ↑" : " ↓";
}

function compareNames(a: string, b: string): number {
  // Numeric so file2 sorts before file10, the way Explorer and Finder do.
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Orders a listing for display. Directories stay ahead of files under every
 * key (the backends list them that way too), and a modified time the server
 * did not report sorts last whichever way the direction points.
 */
export function sortFileEntries(
  entries: readonly FileEntry[],
  sort: FileSort,
): FileEntry[] {
  const descending = sort.direction === "desc";
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    let order = 0;
    if (sort.key === "name") {
      order = compareNames(a.name, b.name);
    } else if (sort.key === "modified") {
      if (a.modified === null || b.modified === null) {
        // Unknown times sort last whichever way the direction points, so the
        // verdict is returned before the flip below can reverse it.
        if (a.modified === null && b.modified === null) return 0;
        return a.modified === null ? 1 : -1;
      }
      order = a.modified < b.modified ? -1 : a.modified > b.modified ? 1 : 0;
    } else {
      order = a.size < b.size ? -1 : a.size > b.size ? 1 : 0;
    }
    return descending ? -order : order;
  });
}

export function loadFileSort(): FileSort {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(SORT_STORAGE_KEY) ?? "null",
    );
    if (
      SORT_KEYS.includes(parsed?.key) &&
      DIRECTIONS.includes(parsed?.direction)
    ) {
      return { key: parsed.key, direction: parsed.direction };
    }
  } catch {
    // A corrupt or blocked entry falls through to the default.
  }
  return DEFAULT_FILE_SORT;
}

export function saveFileSort(sort: FileSort): void {
  try {
    localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sort));
  } catch {
    // Storage full or blocked; the in-memory sort still applies.
  }
}
