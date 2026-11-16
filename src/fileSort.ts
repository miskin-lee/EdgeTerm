import type { FileEntry } from "./types";

export const FILE_SORT_LABELS = {
  name: "Name",
  size: "Size",
  modified: "Modified",
} as const;

export type FileSortKey = keyof typeof FILE_SORT_LABELS;
export interface FileSort {
  key: FileSortKey;
  direction: "ascending" | "descending";
}

export const DEFAULT_FILE_SORT: FileSort = { key: "name", direction: "ascending" };

/** Newest / largest first for metadata; names start at A. */
export function defaultFileSort(key: FileSortKey): FileSort {
  return { key, direction: key === "name" ? "ascending" : "descending" };
}

export function toggleFileSort(sort: FileSort, key: FileSortKey): FileSort {
  return sort.key === key
    ? { key, direction: sort.direction === "ascending" ? "descending" : "ascending" }
    : defaultFileSort(key);
}

const names = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
const compareNames = (a: FileEntry, b: FileEntry): number =>
  names.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/**
 * Sort a copy, keeping folders first in either direction. Missing metadata
 * stays last within its group; ties use names so refreshes don't shuffle them.
 * Folder/link sizes aren't comparable across local and SFTP listings and are
 * hidden by the Filer, so they don't participate in size ordering either.
 */
export function sortFileEntries(
  entries: readonly FileEntry[],
  sort: FileSort,
): FileEntry[] {
  const direction = sort.direction === "ascending" ? 1 : -1;
  const value = (entry: FileEntry) => sort.key === "modified"
    ? entry.modified
    : entry.isDir || entry.isSymlink ? null : entry.size;
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (sort.key === "name") return direction * compareNames(a, b);
    const av = value(a);
    const bv = value(b);
    if (av === null && bv !== null) return 1;
    if (av !== null && bv === null) return -1;
    return (av !== null && bv !== null ? direction * (av - bv) : 0) || compareNames(a, b);
  });
}
