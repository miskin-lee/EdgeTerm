import {
  Fragment,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { create } from "zustand";

import {
  DOCK_LABELS,
  DOCK_NAMES,
  dockOf,
  PANEL_LABELS,
  type PanelDock,
} from "../panelDock";
import { type PanelName, useStore } from "../store";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Splitter } from "./Splitter";

// A panel is moved by dragging its header: Pointer Events with a threshold,
// like the tab strip (HTML5 drag and drop fights Tauri's file drop on
// Windows). The pointer is captured by the panel's slot, so the terminal
// underneath never sees the drag. Where it would land is shown by an overlay
// over the whole app body, and the move happens on release.

const DRAG_THRESHOLD = 4;
/** Share of the app body, from an edge inward, that docks to that edge. */
const EDGE_BAND = 0.25;
/** Smallest share a panel keeps when a splitter divides a dock. */
const MIN_SLOT_PX = 72;
const INTERACTIVE = "button, input, select, textarea, label, a";

interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface DropTarget {
  dock: PanelDock;
  /** The panel to insert in front of; null appends. */
  before: PanelName | null;
  /** Where the panel would go, in viewport coordinates. */
  area: Rect;
  /** The insertion line between panels already in that dock, if any. */
  line: Rect | null;
}

interface PanelDragState {
  panel: PanelName | null;
  target: DropTarget | null;
  set: (panel: PanelName | null, target?: DropTarget | null) => void;
}

// Kept apart from the app store: the drag updates on pointer moves and only
// the overlay and the dragged slot need to hear about it.
const usePanelDrag = create<PanelDragState>((set) => ({
  panel: null,
  target: null,
  set: (panel, target = null) => set({ panel, target }),
}));

const toRect = (r: DOMRect): Rect => ({
  left: r.left,
  top: r.top,
  width: r.width,
  height: r.height,
});

const contains = (r: DOMRect, x: number, y: number) =>
  x >= r.left && x < r.right && y >= r.top && y < r.bottom;

/** Where in `dockElement` a panel dropped at (x, y) goes. */
function targetInDock(
  dockElement: HTMLElement,
  dock: PanelDock,
  panel: PanelName,
  x: number,
  y: number,
): DropTarget {
  const side = dock !== "bottom";
  const box = dockElement.getBoundingClientRect();
  // The dragged panel's own slot is skipped, so hovering over it lands in
  // front of the next one: the panel stays where it is.
  const slots = [
    ...dockElement.querySelectorAll<HTMLElement>(":scope > .dock-slot"),
  ].filter((slot) => slot.dataset.panel !== panel);
  let before: PanelName | null = null;
  let edge = side ? box.bottom : box.right;
  for (const slot of slots) {
    const r = slot.getBoundingClientRect();
    const mid = side ? r.top + r.height / 2 : r.left + r.width / 2;
    if ((side ? y : x) < mid) {
      before = slot.dataset.panel as PanelName;
      edge = side ? r.top : r.left;
      break;
    }
  }
  const line =
    slots.length === 0
      ? null
      : side
        ? { left: box.left, top: edge - 1, width: box.width, height: 3 }
        : { left: edge - 1, top: box.top, width: 3, height: box.height };
  return { dock, before, area: toRect(box), line };
}

function dropTargetAt(
  panel: PanelName,
  x: number,
  y: number,
): DropTarget | null {
  const body = document.querySelector<HTMLElement>(".app-body");
  const main = body?.querySelector<HTMLElement>(".main");
  if (!body || !main) return null;
  const bodyRect = body.getBoundingClientRect();
  if (!contains(bodyRect, x, y)) return null;

  const docks = new Map<PanelDock, HTMLElement>();
  for (const element of body.querySelectorAll<HTMLElement>("[data-dock]")) {
    docks.set(element.dataset.dock as PanelDock, element);
  }
  for (const [dock, element] of docks) {
    if (contains(element.getBoundingClientRect(), x, y)) {
      return targetInDock(element, dock, panel, x, y);
    }
  }

  // Over the terminal area: the nearest edge, if the pointer is close to it.
  const distances: [PanelDock, number][] = [
    ["left", (x - bodyRect.left) / bodyRect.width],
    ["right", (bodyRect.right - x) / bodyRect.width],
    ["bottom", (bodyRect.bottom - y) / bodyRect.height],
  ];
  distances.sort((a, b) => a[1] - b[1]);
  const [dock, distance] = distances[0];
  if (distance > EDGE_BAND) return null;
  const existing = docks.get(dock);
  if (existing) {
    const target = targetInDock(existing, dock, panel, x, y);
    // Dropped beside the dock rather than on it: last in the dock.
    const box = existing.getBoundingClientRect();
    const side = dock !== "bottom";
    return {
      ...target,
      before: null,
      line:
        target.line &&
        (side
          ? { left: box.left, top: box.bottom - 2, width: box.width, height: 3 }
          : {
              left: box.right - 2,
              top: box.top,
              width: 3,
              height: box.height,
            }),
    };
  }
  const mainRect = main.getBoundingClientRect();
  const width = Math.min(240, mainRect.width * 0.3);
  const height = Math.min(180, bodyRect.height * 0.35);
  const area: Rect =
    dock === "left"
      ? {
          left: mainRect.left,
          top: mainRect.top,
          width,
          height: mainRect.height,
        }
      : dock === "right"
        ? {
            left: mainRect.right - width,
            top: mainRect.top,
            width,
            height: mainRect.height,
          }
        : {
            left: bodyRect.left,
            top: bodyRect.bottom - height,
            width: bodyRect.width,
            height,
          };
  return { dock, before: null, area, line: null };
}

const sameTarget = (a: DropTarget | null, b: DropTarget | null) =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.dock === b.dock &&
    a.before === b.before &&
    a.area.left === b.area.left &&
    a.area.top === b.area.top &&
    a.area.width === b.area.width &&
    a.area.height === b.area.height &&
    a.line?.left === b.line?.left &&
    a.line?.top === b.line?.top);

/** Shows where a dragged panel would be docked. */
export function PanelDropOverlay() {
  const target = usePanelDrag((s) => s.target);
  if (!target) return null;
  const box = (r: Rect) => ({
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height,
  });
  return (
    <>
      <div className="panel-drop-area" style={box(target.area)} />
      {target.line && (
        <div className="panel-drop-line" style={box(target.line)} />
      )}
    </>
  );
}

interface DockAreaProps {
  dock: PanelDock;
  /** The panels shown in this dock, in order; the dock is not rendered empty. */
  panels: PanelName[];
  /** Width of a side dock or height of the bottom one, in pixels. */
  size: number;
  render: (panel: PanelName) => ReactNode;
}

interface Pending {
  panel: PanelName;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
}

export function DockArea({ dock, panels, size, render }: DockAreaProps) {
  const side = dock !== "bottom";
  const ref = useRef<HTMLDivElement>(null);
  const movePanel = useStore((s) => s.movePanel);
  const togglePanel = useStore((s) => s.togglePanel);
  const panelDocks = useStore((s) => s.panelDocks);
  const dragging = usePanelDrag((s) => s.panel);

  // Splitters between panels share the dock out by weight (flex-grow), so
  // the split survives the dock being resized.
  const [weights, setWeights] = useState<Partial<Record<PanelName, number>>>(
    {},
  );
  const resize = (a: PanelName, b: PanelName, delta: number) => {
    const element = ref.current;
    if (!element) return;
    setWeights((current) => {
      const weight = (panel: PanelName) => current[panel] ?? 1;
      const total = panels.reduce((sum, panel) => sum + weight(panel), 0);
      const extent = side ? element.clientHeight : element.clientWidth;
      if (extent <= 0) return current;
      const perWeight = extent / total;
      const min = MIN_SLOT_PX / perWeight;
      const wa = weight(a);
      const wb = weight(b);
      const change = Math.min(Math.max(delta / perWeight, min - wa), wb - min);
      if (change === 0 || wa + change < min || wb - change < min) {
        return current;
      }
      return { ...current, [a]: wa + change, [b]: wb - change };
    });
  };

  const drag = useRef<Pending | null>(null);
  const finish = useCallback(() => {
    drag.current = null;
    usePanelDrag.getState().set(null);
  }, []);

  // Escape abandons a drag in progress.
  useEffect(() => {
    if (dragging === null || !panels.includes(dragging)) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      finish();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [dragging, panels, finish]);

  // Only the header grabs a panel, and not through its own controls.
  const fromHeader = (event: ReactPointerEvent | ReactMouseEvent) => {
    const target = event.target as Element;
    return (
      target.closest(".panel-header") !== null &&
      target.closest(INTERACTIVE) === null
    );
  };

  const onPointerDown = (
    panel: PanelName,
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (event.button !== 0 || !fromHeader(event)) return;
    event.preventDefault();
    drag.current = {
      panel,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    if (!state.active) {
      const travelled = Math.hypot(
        event.clientX - state.startX,
        event.clientY - state.startY,
      );
      if (travelled < DRAG_THRESHOLD) return;
      state.active = true;
    }
    const target = dropTargetAt(state.panel, event.clientX, event.clientY);
    const current = usePanelDrag.getState();
    if (current.panel !== state.panel || !sameTarget(current.target, target)) {
      current.set(state.panel, target);
    }
  };

  const onPointerEnd = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    const element = event.currentTarget;
    if (element.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
    if (!state || state.pointerId !== event.pointerId) return;
    const target = usePanelDrag.getState().target;
    // A drag cancelled with Escape has already cleared the shared state.
    const live = state.active && usePanelDrag.getState().panel === state.panel;
    finish();
    if (!live || !target || event.type === "pointercancel") return;
    movePanel(state.panel, target.dock, target.before);
  };

  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    panel: PanelName;
  } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const onContextMenu = (
    panel: PanelName,
    event: ReactMouseEvent<HTMLDivElement>,
  ) => {
    if (!fromHeader(event)) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, panel });
  };
  const menuItems = (panel: PanelName): MenuItem[] => {
    const current = dockOf(panelDocks, panel);
    return [
      ...DOCK_NAMES.map((name) => ({
        label: `Dock ${DOCK_LABELS[name]}`,
        checked: current === name,
        mark: "radio" as const,
        action: () => {
          if (current !== name) movePanel(panel, name);
        },
      })),
      "separator",
      {
        label: `Hide ${PANEL_LABELS[panel]}`,
        action: () => togglePanel(panel),
      },
    ];
  };

  return (
    <div
      ref={ref}
      className={side ? `sidebar sidebar-${dock}` : "bottom-dock"}
      data-dock={dock}
      style={side ? { width: size, flex: `0 0 ${size}px` } : { height: size }}
    >
      {panels.map((panel, index) => (
        <Fragment key={panel}>
          {index > 0 && (
            <Splitter
              orientation={side ? "horizontal" : "vertical"}
              onResize={(delta) => resize(panels[index - 1], panel, delta)}
            />
          )}
          <div
            className={`dock-slot${dragging === panel ? " is-dragging" : ""}`}
            data-panel={panel}
            style={{ flex: `${weights[panel] ?? 1} 1 0px` }}
            onPointerDown={(event) => onPointerDown(panel, event)}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            onContextMenu={(event) => onContextMenu(panel, event)}
          >
            {render(panel)}
          </div>
        </Fragment>
      ))}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menuItems(menu.panel)}
          onClose={closeMenu}
        />
      )}
    </div>
  );
}
