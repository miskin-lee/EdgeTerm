import type { FileEntry } from "./types";

/**
 * The entries picked in a file list (issue #101): their paths, and the one a
 * Shift-click range is measured from. The Filer and the FTP / SFTP pane both
 * keep one per list; a new listing starts empty.
 */
export interface FileSelection {
  paths: string[];
  anchor: string | null;
}

export const EMPTY_SELECTION: FileSelection = { paths: [], anchor: null };

/** What a click does to the selection; see `clickMode`. */
export type SelectMode = "replace" | "toggle" | "range";

/**
 * How a press on an entry changes the selection, the way the system file
 * managers do it: ⌘-click (Ctrl-click elsewhere) adds or drops one entry,
 * Shift-click selects everything from the anchor, a plain click selects
 * just that entry. Null leaves the selection to the context menu: any button
 * but the primary one, and Control-click on macOS, which is a right click
 * there and must not collapse the selection it is about to act on.
 */
export function clickMode(
  event: Pick<MouseEvent, "button" | "metaKey" | "ctrlKey" | "shiftKey">,
  mac: boolean,
): SelectMode | null {
  if (event.button !== 0) return null;
  if (mac && event.ctrlKey) return null;
  if (event.shiftKey) return "range";
  if (mac ? event.metaKey : event.ctrlKey) return "toggle";
  return "replace";
}

/**
 * The selection after a click on `path`. `order` is the list as shown, which
 * is what a range spans; a range whose anchor is no longer listed starts over
 * from the clicked entry.
 */
export function selectEntry(
  selection: FileSelection,
  order: readonly string[],
  path: string,
  mode: SelectMode,
): FileSelection {
  if (mode === "toggle") {
    const paths = selection.paths.includes(path)
      ? selection.paths.filter((selected) => selected !== path)
      : [...selection.paths, path];
    return { paths, anchor: path };
  }
  if (mode === "range" && selection.anchor !== null) {
    const from = order.indexOf(selection.anchor);
    const to = order.indexOf(path);
    if (from >= 0 && to >= 0) {
      const [start, end] = from <= to ? [from, to] : [to, from];
      return { paths: order.slice(start, end + 1), anchor: selection.anchor };
    }
  }
  return { paths: [path], anchor: path };
}

/**
 * The selection a right click on `path` acts on: the whole selection when the
 * entry is part of it, otherwise that entry alone.
 */
export function selectForMenu(
  selection: FileSelection,
  path: string,
): FileSelection {
  return selection.paths.includes(path)
    ? selection
    : { paths: [path], anchor: path };
}

/** The selected entries in the order the list shows them. */
export function selectedEntries(
  entries: readonly FileEntry[],
  selection: FileSelection,
): FileEntry[] {
  const picked = new Set(selection.paths);
  return entries.filter((entry) => picked.has(entry.path));
}

/** A pause this long ends a type-to-select run; the next key starts afresh. */
export const TYPE_SELECT_RESET_MS = 1000;

/** What has been typed into a file list so far; see `typeToSelect`. */
export interface TypeRun {
  text: string;
  /** When its last key arrived, in `performance.now()` time. */
  at: number;
}

/** The parts of a key press `typeToSelect` reads. */
export type TypedKey = Pick<
  KeyboardEvent,
  "key" | "ctrlKey" | "metaKey" | "altKey" | "isComposing"
>;

/**
 * Type-to-select (issue #108), the way Finder, Explorer and VS Code lists do
 * it: typing the start of a name selects the first entry whose name starts
 * with what was typed, ignoring case, and keys that follow within
 * `TYPE_SELECT_RESET_MS` extend it. A new run searches from the entry after
 * the selected one, so the same letter pressed again after a pause steps to
 * the next name with it; a run keeps its entry while that still matches.
 * Typing one letter over and over steps through the names starting with it
 * unless some name starts with the repeated letters ("ss" finds `ssh`).
 *
 * Null for a key that is not typing, which the list leaves alone: modified
 * keys are shortcuts, named keys (Enter, the arrows) are not text, and a
 * space only continues a run, since otherwise it scrolls the list. Otherwise
 * the continued run and the index of the entry to select, -1 when no name
 * starts with what was typed and the selection should stay.
 */
export function typeToSelect(
  entries: readonly FileEntry[],
  selection: FileSelection,
  run: TypeRun | null,
  key: TypedKey,
  now: number,
): { run: TypeRun; index: number } | null {
  if (key.ctrlKey || key.metaKey || key.altKey || key.isComposing) return null;
  if (key.key.length !== 1) return null;
  const live = run !== null && now - run.at < TYPE_SELECT_RESET_MS ? run : null;
  if (key.key === " " && !live) return null;

  const text = (live?.text ?? "") + key.key;
  const current = entries.findIndex((entry) => entry.path === selection.anchor);
  let index = findByPrefix(entries, text, live ? current : current + 1);
  if (index < 0 && text.length > 1 && [...text].every((c) => c === text[0])) {
    index = findByPrefix(entries, text[0], current + 1);
  }
  return { run: { text, at: now }, index };
}

/** The first entry from `start` on, wrapping around, whose name starts with `prefix`. */
function findByPrefix(
  entries: readonly FileEntry[],
  prefix: string,
  start: number,
): number {
  const wanted = foldName(prefix);
  const from = Math.max(start, 0);
  for (let offset = 0; offset < entries.length; offset++) {
    const index = (from + offset) % entries.length;
    if (foldName(entries[index].name).startsWith(wanted)) return index;
  }
  return -1;
}

/**
 * A name as type-to-select compares it. Keyboards type composed characters,
 * while a name may hold decomposed ones (HFS+ stored every name that way).
 */
function foldName(name: string): string {
  return name.normalize("NFC").toLowerCase();
}

/** What copying several entries into one folder runs into; see `batchCollisions`. */
export interface BatchCollisions {
  /** Why the batch cannot start at all, or null. */
  blocked: string | null;
  /** Items whose name is already taken by the same kind: files replaced, folders merged. */
  existing: FileEntry[];
}

/**
 * Checks a batch of `items` against the folder they are about to land in,
 * which already holds `present`, before anything is sent: stopping halfway
 * would leave the user to work out which half arrived. `destination` is the
 * side being written. A download also refuses a name that is not a plain file
 * name (remote listings are untrusted; the backend refuses those too) and a
 * local link, which the backend will not write through. `foldCase` matches
 * names the way a case-insensitive file system does (macOS, Windows).
 */
export function batchCollisions(
  items: readonly FileEntry[],
  present: readonly FileEntry[],
  destination: "local" | "remote",
  foldCase = false,
): BatchCollisions {
  const key = (name: string) => (foldCase ? name.toLowerCase() : name);
  const byName = new Map(present.map((entry) => [key(entry.name), entry]));
  const existing: FileEntry[] = [];
  for (const item of items) {
    if (destination === "local" && !isPlainName(item.name)) {
      return {
        blocked: `“${item.name}” is not a file name that can be saved here.`,
        existing: [],
      };
    }
    const taken = byName.get(key(item.name));
    if (!taken) continue;
    if (destination === "local" && taken.isSymlink) {
      return {
        blocked: `Refusing to replace local symlink “${taken.name}”.`,
        existing: [],
      };
    }
    if (taken.isDir !== item.isDir) {
      return {
        blocked: `A ${destination} ${taken.isDir ? "folder" : "file"} named “${taken.name}” already exists.`,
        existing: [],
      };
    }
    existing.push(item);
  }
  return { blocked: null, existing };
}

/** How many names `replacePrompt` lists before summing up the rest. */
const PROMPT_NAMES = 5;

/**
 * The question asked before a batch replaces or merges into `existing`, and
 * the label of the button that goes ahead.
 */
export function replacePrompt(
  existing: readonly FileEntry[],
  destination: "local" | "remote",
): { message: string; okLabel: string } {
  const okLabel = existing.every((item) => item.isDir) ? "Merge" : "Replace";
  if (existing.length === 1) {
    const [item] = existing;
    return {
      message: item.isDir
        ? `Merge into ${destination} folder “${item.name}”? Existing files with the same names will be replaced.`
        : `Replace ${destination} file “${item.name}”?`,
      okLabel,
    };
  }
  const names = existing.slice(0, PROMPT_NAMES).map((item) => `“${item.name}”`);
  if (existing.length > PROMPT_NAMES) {
    names.push(`and ${existing.length - PROMPT_NAMES} more`);
  }
  return {
    message:
      `${existing.length} items already exist in the ${destination} folder: ${names.join(", ")}.\n\n` +
      "Files with the same names will be replaced and folders merged.",
    okLabel,
  };
}

/** The footer name for item `index` of `count`: just the name when it is alone. */
export function batchItemName(
  name: string,
  index: number,
  count: number,
): string {
  return count > 1 ? `${name} (${index + 1}/${count})` : name;
}

function isPlainName(name: string): boolean {
  return (
    name !== "" && name !== "." && name !== ".." && !/[\\/\0]/.test(name)
  );
}
