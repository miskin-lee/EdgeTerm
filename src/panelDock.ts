import type { PanelName } from "./store";

/**
 * Where the tool panels sit around the terminal area. Each dock lists its
 * panels in order (top to bottom in a side dock, left to right in the bottom
 * one); every panel appears in exactly one dock, whether it is shown or not,
 * so hiding a panel and showing it again brings it back to the same place.
 */
export type PanelDock = "left" | "right" | "bottom";
export type PanelDocks = Record<PanelDock, PanelName[]>;

export const PANEL_NAMES: readonly PanelName[] = [
  "sessions",
  "filer",
  "sender",
];
export const DOCK_NAMES: readonly PanelDock[] = ["left", "right", "bottom"];

export const PANEL_LABELS: Record<PanelName, string> = {
  sessions: "Session",
  filer: "Filer",
  sender: "Sender",
};

export const DOCK_LABELS: Record<PanelDock, string> = {
  left: "Left",
  right: "Right",
  bottom: "Bottom",
};

const DEFAULT_DOCK: Record<PanelName, PanelDock> = {
  sessions: "left",
  filer: "right",
  sender: "bottom",
};

export const defaultPanelDocks = (): PanelDocks => ({
  left: ["sessions"],
  right: ["filer"],
  bottom: ["sender"],
});

export const dockOf = (docks: PanelDocks, panel: PanelName): PanelDock =>
  DOCK_NAMES.find((dock) => docks[dock].includes(panel)) ?? DEFAULT_DOCK[panel];

/**
 * Moves `panel` into `dock`, in front of `before` (or last when `before` is
 * null, absent from that dock, or the panel itself).
 */
export function movePanel(
  docks: PanelDocks,
  panel: PanelName,
  dock: PanelDock,
  before: PanelName | null = null,
): PanelDocks {
  const next: PanelDocks = {
    left: docks.left.filter((name) => name !== panel),
    right: docks.right.filter((name) => name !== panel),
    bottom: docks.bottom.filter((name) => name !== panel),
  };
  const index = before ? next[dock].indexOf(before) : -1;
  if (index < 0) next[dock].push(panel);
  else next[dock].splice(index, 0, panel);
  return next;
}

export const samePanelDocks = (a: PanelDocks, b: PanelDocks): boolean =>
  DOCK_NAMES.every(
    (dock) =>
      a[dock].length === b[dock].length &&
      a[dock].every((name, index) => b[dock][index] === name),
  );

/**
 * Reads a stored or imported layout. Unknown names and repeats are dropped,
 * and a panel the value does not place goes back to its default dock, so a
 * file from an older or newer version still yields every panel exactly once.
 * Null when `value` is not a layout at all.
 */
export function parsePanelDocks(value: unknown): PanelDocks | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<Record<PanelDock, unknown>>;
  const seen = new Set<PanelName>();
  const docks: PanelDocks = { left: [], right: [], bottom: [] };
  for (const dock of DOCK_NAMES) {
    const list = raw[dock];
    if (!Array.isArray(list)) continue;
    for (const name of list) {
      if (!PANEL_NAMES.includes(name as PanelName)) continue;
      if (seen.has(name as PanelName)) continue;
      seen.add(name as PanelName);
      docks[dock].push(name as PanelName);
    }
  }
  for (const panel of PANEL_NAMES) {
    if (!seen.has(panel)) docks[DEFAULT_DOCK[panel]].push(panel);
  }
  return docks;
}
