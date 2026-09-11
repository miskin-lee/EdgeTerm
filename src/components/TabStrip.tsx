import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { splitSession } from "../actions";
import { tabTitle, useStore, type DropTarget, type Tab } from "../store";
import { colorForSession } from "../types";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Icon } from "./icons";
import { useAccelerator } from "./TerminalPane";

/** Pointer travel before a press on a tab turns into a drag. */
const DRAG_THRESHOLD = 4;
/** Distance from either strip edge inside which a drag scrolls the strip. */
const EDGE_SCROLL_ZONE = 32;
const EDGE_SCROLL_STEP = 6;
/** Kept deliberately small: every open tab owns these DOM-only particles. */
const COMMAND_PARTICLES = 6;
/**
 * How far in from a pane's edge, as a share of its size, a dropped tab
 * splits the pane on that side rather than joining it.
 */
const SPLIT_ZONE = 0.25;

interface Props {
  paneId: string;
}

/**
 * What the tab's activity treatment is reporting, or null while there is
 * nothing to report. An agentic CLI is named for what it is: its session
 * lasts as long as the user keeps it open, so only the assistant's own turns
 * are worth a running or a finished tab.
 */
function activityLabel(tab: Tab): string | null {
  if (tab.commandActivity === "idle") return null;
  const subject = tab.activityKind === "ai" ? "AI" : "command";
  return `${subject} ${tab.commandActivity === "running" ? "running" : "finished"}`;
}

interface TabDrag {
  id: string;
  pointerId: number;
  /** Pointer x at pointerdown, to tell a click from a drag. */
  startX: number;
  /** Where inside the tab it was grabbed, so it stays under the pointer. */
  grabX: number;
  /** Last known pointer x, for edge scrolling between pointer events. */
  x: number;
  startY: number;
  y: number;
  /** Set once the pointer has travelled past the threshold. */
  active: boolean;
  scrollFrame: number;
  /**
   * Stands in for the tab once the pointer has left the strip, where the
   * tab itself cannot follow; null while the drag is along its own strip.
   */
  ghost: HTMLElement | null;
}

const showGhost = (state: TabDrag, label: string) => {
  if (!state.ghost) {
    const ghost = document.createElement("div");
    ghost.className = "tab-drag-ghost";
    ghost.textContent = label;
    document.body.appendChild(ghost);
    state.ghost = ghost;
  }
  state.ghost.style.transform = `translate(${state.x + 14}px, ${state.y + 14}px)`;
};

const hideGhost = (state: TabDrag) => {
  state.ghost?.remove();
  state.ghost = null;
};

/** The slot in `strip` a tab dropped at `x` would take: after every tab whose middle it has passed. */
const slotIndex = (strip: HTMLElement, x: number): number => {
  let index = 0;
  for (const tab of strip.querySelectorAll<HTMLElement>(".tab")) {
    const rect = tab.getBoundingClientRect();
    if (x > rect.left + rect.width / 2) index += 1;
  }
  return index;
};

/**
 * What a tab dragged from `ownPaneId` would do if released at (x, y):
 * take a slot in another pane's strip, join another pane, or split the pane
 * under the pointer on the side nearest the pointer. Null along the tab's
 * own strip, where the drag reorders live, and anywhere that takes no tab.
 * `elementsFromPoint` looks through the session covering a pane, since the
 * session is placed over the pane rather than inside it (see Workspace).
 */
const dropTargetAt = (
  x: number,
  y: number,
  ownPaneId: string,
): DropTarget | null => {
  for (const element of document.elementsFromPoint(x, y)) {
    const strip = element.closest<HTMLElement>(".tabstrip");
    if (strip) {
      const paneId = strip.dataset.paneId;
      if (!paneId || paneId === ownPaneId) return null;
      return { paneId, zone: "strip", index: slotIndex(strip, x) };
    }
    const stack = element.closest<HTMLElement>(".pane-stack");
    if (stack) {
      const paneId = stack.dataset.paneId;
      if (!paneId) return null;
      const rect = stack.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const px = (x - rect.left) / rect.width;
      const py = (y - rect.top) / rect.height;
      const nearest = Math.min(px, 1 - px, py, 1 - py);
      if (nearest > SPLIT_ZONE) {
        return paneId === ownPaneId ? null : { paneId, zone: "center" };
      }
      const zone =
        nearest === px
          ? "left"
          : nearest === 1 - px
            ? "right"
            : nearest === py
              ? "up"
              : "down";
      return { paneId, zone };
    }
  }
  return null;
};

export function TabStrip({ paneId }: Props) {
  const allTabs = useStore((s) => s.tabs);
  // The strip is the pane's tabs in list order; see `placeTab` in the store.
  const tabs = useMemo(
    () => allTabs.filter((tab) => tab.paneId === paneId),
    [allTabs, paneId],
  );
  const pane = useStore((s) => s.panes.find((item) => item.id === paneId));
  const shownId = pane?.activeTabId ?? null;
  const draggingTabId = useStore((s) => s.draggingTabId);
  const dropTarget = useStore((s) => s.dropTarget);
  const setActive = useStore((s) => s.setActive);
  const setActivePane = useStore((s) => s.setActivePane);
  const requestCloseTabs = useStore((s) => s.requestCloseTabs);
  const moveTab = useStore((s) => s.moveTab);
  const moveTabToPane = useStore((s) => s.moveTabToPane);
  const splitPane = useStore((s) => s.splitPane);
  const setTabDrag = useStore((s) => s.setTabDrag);
  const closeKey = useAccelerator("closeSession");
  const splitRightKey = useAccelerator("splitRight");
  const splitDownKey = useAccelerator("splitDown");
  const stripRef = useRef<HTMLDivElement>(null);

  // Which edges hide further tabs; drives the fade hints since the native
  // scrollbar is hidden and a mouse user otherwise has no cue that the strip
  // scrolls at all.
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const updateOverflow = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const left = strip.scrollLeft > 0;
    const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
    setOverflow((prev) =>
      prev.left === left && prev.right === right ? prev : { left, right },
    );
  }, []);

  useLayoutEffect(updateOverflow, [tabs, updateOverflow]);

  // "All sessions" list, the fallback that works with any input device once
  // the strip holds more tabs than fit — scrolling through 20+ tabs is slower
  // than picking from a list.
  const [listMenu, setListMenu] = useState<{ x: number; y: number } | null>(
    null,
  );
  const closeListMenu = useCallback(() => setListMenu(null), []);
  // ContextMenu closes itself on any outside mousedown, so by the time the
  // button's click fires the menu is already gone; remember whether it was
  // open so the button toggles instead of reopening.
  const listWasOpen = useRef(false);
  const listItems: MenuItem[] = tabs.map((tab) => ({
    label: `${tab.number}. ${tabTitle(tab)}${
      activityLabel(tab) ? ` · ${activityLabel(tab)}` : ""
    }`,
    checked: tab.info.id === shownId,
    mark: "radio" as const,
    action: () => setActive(tab.info.id),
  }));

  // A tab's own menu: the close commands work along this strip, the way
  // VS Code's "Close to the Right" stays inside its editor group.
  const [tabMenu, setTabMenu] = useState<{
    x: number;
    y: number;
    id: string;
  } | null>(null);
  const closeTabMenu = useCallback(() => setTabMenu(null), []);
  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    const id = (event.target as Element).closest<HTMLElement>(".tab")?.dataset
      .tabId;
    if (!id) return;
    event.preventDefault();
    setTabMenu({ x: event.clientX, y: event.clientY, id });
  };
  const tabMenuItems = (id: string): MenuItem[] => {
    const ids = tabs.map((tab) => tab.info.id);
    const index = ids.indexOf(id);
    return [
      {
        label: "Close",
        shortcut: closeKey,
        action: () => requestCloseTabs([id]),
      },
      {
        label: "Close Others",
        disabled: ids.length < 2,
        action: () => requestCloseTabs(ids.filter((other) => other !== id)),
      },
      {
        label: "Close to the Left",
        disabled: index <= 0,
        action: () => requestCloseTabs(ids.slice(0, index)),
      },
      {
        label: "Close to the Right",
        disabled: index >= ids.length - 1,
        action: () => requestCloseTabs(ids.slice(index + 1)),
      },
      { label: "Close All", action: () => requestCloseTabs(ids) },
      "separator",
      {
        label: "Split Right",
        icon: "split-horizontal",
        shortcut: splitRightKey,
        action: () => void splitSession(id, "right"),
      },
      {
        label: "Split Down",
        icon: "split-vertical",
        shortcut: splitDownKey,
        action: () => void splitSession(id, "down"),
      },
    ];
  };

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const observer = new ResizeObserver(updateOverflow);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [updateOverflow]);

  // The strip only scrolls horizontally. Trackpads already emit horizontal
  // deltas, but a mouse wheel (Windows in particular) only produces vertical
  // ones, which a horizontal scroller ignores. Translate those so the wheel
  // pans the tabs; leave native horizontal gestures (and shift+wheel, which the
  // browser already maps to deltaX) untouched. Registered natively because
  // React's onWheel is passive and cannot preventDefault.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (event.deltaX !== 0 || event.deltaY === 0) return;
      if (strip.scrollWidth <= strip.clientWidth) return;
      let delta = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
      else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE)
        delta *= strip.clientWidth;
      const before = strip.scrollLeft;
      strip.scrollLeft += delta;
      if (strip.scrollLeft !== before) event.preventDefault();
    };
    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => strip.removeEventListener("wheel", onWheel);
  }, []);

  // Keep the shown tab visible when it changes via click, shortcut or a new
  // session being opened past the right edge.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>(".tab.is-active")
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [shownId]);

  // Drag to reorder, or to another pane. Pointer events rather than HTML5
  // drag and drop: Tauri's drag-drop handler (which the Filer needs for files
  // dropped from outside) swallows HTML5 drags on Windows, and pointer capture
  // gives the dragged tab a plain follow-the-pointer feel with no ghost image
  // anyway. Along its own strip the store is reordered live as the tab's
  // visual centre crosses a neighbour's midpoint; the dragged tab itself is
  // offset with a transform so it never leaves the pointer while React
  // reflows the others under it. The pointer is captured by the strip, not
  // the tab: reordering keyed children moves nodes in the DOM, and engines
  // implicitly release capture from a removed element.
  //
  // Elsewhere — another pane's strip, or a pane's session area — the tab
  // stays in its slot, a small ghost follows the pointer, the target draws
  // where the tab would land (an insertion mark in the strip, a highlighted
  // half or whole of the pane) and the move happens on release: moving live
  // would fold an emptied pane away under the pointer mid-drag.
  const drag = useRef<TabDrag | null>(null);
  const dragging = draggingTabId !== null && drag.current?.active === true;

  // Places the dragged tab under the pointer relative to wherever layout put
  // it, and moves it in the store once it has crossed into another slot.
  const updateDrag = useCallback(() => {
    const state = drag.current;
    const strip = stripRef.current;
    if (!state?.active || !strip) return;
    const element = strip.querySelector<HTMLElement>(".tab.is-dragging");
    if (!element) return;

    // Measure without the offset: a transformed element reports its visual
    // rect, and the offset must be relative to the layout position.
    element.style.transform = "";
    // Over another target the tab waits in its slot; see above.
    if (state.ghost) return;
    const stripRect = strip.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const left = state.x - state.grabX;
    const shown = Math.min(
      Math.max(left, stripRect.left),
      Math.max(stripRect.right - rect.width, stripRect.left),
    );
    element.style.transform = `translateX(${shown - rect.left}px)`;

    // Slot from the unclamped position: pinned at an edge, a wide tab's
    // visible centre could otherwise never pass the end tab's midpoint.
    const centre = left + rect.width / 2;
    let index = 0;
    for (const other of strip.querySelectorAll<HTMLElement>(".tab")) {
      if (other === element) continue;
      const otherRect = other.getBoundingClientRect();
      if (centre > otherRect.left + otherRect.width / 2) index += 1;
    }
    moveTab(state.id, index);
  }, [moveTab]);

  // Re-anchor the offset after every reorder commits: the element's layout
  // position changed while the pointer did not.
  useLayoutEffect(() => {
    if (dragging) updateDrag();
  }, [tabs, dragging, updateDrag]);

  // Holding a tab near either edge pans the strip so tabs hidden past it can
  // still be reached; runs on frames because the pointer may sit still.
  const edgeScroll = useCallback(() => {
    const state = drag.current;
    const strip = stripRef.current;
    if (!state?.active || !strip) return;
    if (!state.ghost) {
      const rect = strip.getBoundingClientRect();
      let delta = 0;
      if (state.x < rect.left + EDGE_SCROLL_ZONE) delta = -EDGE_SCROLL_STEP;
      else if (state.x > rect.right - EDGE_SCROLL_ZONE) delta = EDGE_SCROLL_STEP;
      if (delta !== 0) {
        const before = strip.scrollLeft;
        strip.scrollLeft += delta;
        if (strip.scrollLeft !== before) updateDrag();
      }
    }
    state.scrollFrame = requestAnimationFrame(edgeScroll);
  }, [updateDrag]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    const target = event.target as Element;
    if (target.closest(".tab-close")) return;
    const tab = target.closest<HTMLElement>(".tab");
    const id = tab?.dataset.tabId;
    if (!tab || !id) {
      // A press on the strip's blank part still focuses its pane.
      if (!target.closest("button")) setActivePane(paneId);
      return;
    }
    drag.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - tab.getBoundingClientRect().left,
      x: event.clientX,
      y: event.clientY,
      active: false,
      scrollFrame: 0,
      ghost: null,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    state.x = event.clientX;
    state.y = event.clientY;
    if (!state.active) {
      const travelled = Math.hypot(
        event.clientX - state.startX,
        event.clientY - state.startY,
      );
      if (travelled < DRAG_THRESHOLD) return;
      state.active = true;
      setTabDrag(state.id);
      state.scrollFrame = requestAnimationFrame(edgeScroll);
    }
    const target = dropTargetAt(event.clientX, event.clientY, paneId);
    if (target) {
      const tab = tabs.find((item) => item.info.id === state.id);
      showGhost(state, tab ? tabTitle(tab) : "");
    } else {
      hideGhost(state);
    }
    setTabDrag(state.id, target);
    updateDrag();
  };

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    cancelAnimationFrame(state.scrollFrame);
    drag.current = null;
    const strip = event.currentTarget;
    if (strip.hasPointerCapture(event.pointerId)) {
      strip.releasePointerCapture(event.pointerId);
    }
    if (!state.active) return;
    hideGhost(state);
    const element = strip.querySelector<HTMLElement>(".tab.is-dragging");
    if (element) element.style.transform = "";
    const target = useStore.getState().dropTarget;
    setTabDrag(null);
    if (!target || event.type === "pointercancel") return;
    if (target.zone === "strip") {
      moveTabToPane(state.id, target.paneId, target.index);
    } else if (target.zone === "center") {
      moveTabToPane(state.id, target.paneId, Number.MAX_SAFE_INTEGER);
    } else {
      splitPane(target.paneId, target.zone, state.id);
    }
  };

  // Where a tab dragged from another strip would be inserted here.
  const marker =
    dropTarget?.paneId === paneId && dropTarget.zone === "strip"
      ? dropTarget.index
      : null;

  return (
    <div
      className={[
        "tabstrip",
        overflow.left ? "can-scroll-left" : "",
        overflow.right ? "can-scroll-right" : "",
        draggingTabId ? "is-reordering" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={stripRef}
      data-pane-id={paneId}
      onScroll={updateOverflow}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onContextMenu={onContextMenu}
    >
      <div className="tabstrip-fade-left" aria-hidden="true" />
      {tabs.flatMap((tab, index) => {
        const active = tab.info.id === shownId;
        const sessionColor =
          tab.info.color ??
          colorForSession(tab.info.profileId ?? tab.info.name);
        const element = (
          <div
            key={tab.info.id}
            className={[
              "tab",
              active ? "is-active" : "",
              `is-${tab.state}`,
              `is-command-${tab.commandActivity}`,
              tab.info.id === draggingTabId ? "is-dragging" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ "--session-color": sessionColor } as CSSProperties}
            data-tab-id={tab.info.id}
            onMouseDown={() => setActive(tab.info.id)}
            title={`${tab.info.protocol} · ${tab.info.address} · ${
              tab.commandActivity === "running"
                ? activityLabel(tab)
                : tab.commandActivity === "complete"
                  ? `${activityLabel(tab)} — select to view`
                  : (tab.message ?? tab.state)
            }`}
          >
            <span className="tab-command-activity" aria-hidden="true">
              {Array.from({ length: COMMAND_PARTICLES }, (_, particle) => (
                <span className="tab-command-particle" key={particle} />
              ))}
            </span>
            <span className="tab-index">{tab.number}.</span>
            <span className="tab-dot" aria-hidden="true" />
            <span className="tab-label">{tabTitle(tab)}</span>
            <button
              className="tab-close"
              onMouseDown={(event) => {
                event.stopPropagation();
                requestCloseTabs([tab.info.id]);
              }}
              title="Close session"
              aria-label="Close session"
            >
              <Icon name="close" />
            </button>
          </div>
        );
        return marker === index
          ? [<div className="tab-drop-marker" key="drop" aria-hidden="true" />, element]
          : [element];
      })}
      {marker !== null && marker >= tabs.length && (
        <div className="tab-drop-marker" aria-hidden="true" />
      )}

      {(overflow.left || overflow.right) && (
        <div className="tabstrip-actions">
          <button
            className={`panel-action${listMenu ? " is-open" : ""}`}
            onMouseDown={() => {
              listWasOpen.current = listMenu !== null;
            }}
            onClick={(event) => {
              if (listWasOpen.current) return;
              const rect = event.currentTarget.getBoundingClientRect();
              setListMenu({ x: rect.right, y: rect.bottom + 2 });
            }}
            title="All sessions"
            aria-haspopup="menu"
            aria-expanded={listMenu !== null}
          >
            <Icon name="chevron-down" />
          </button>
        </div>
      )}

      {listMenu && (
        <ContextMenu
          x={listMenu.x}
          y={listMenu.y}
          align="right"
          className="tab-list-menu"
          items={listItems}
          onClose={closeListMenu}
        />
      )}

      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems(tabMenu.id)}
          onClose={closeTabMenu}
        />
      )}
    </div>
  );
}
