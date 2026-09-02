import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { tabTitle, useStore } from "../store";
import { colorForSession } from "../types";
import { ContextMenu, type MenuItem } from "./ContextMenu";
import { Icon } from "./icons";

/** Pointer travel before a press on a tab turns into a drag. */
const DRAG_THRESHOLD = 4;
/** Distance from either strip edge inside which a drag scrolls the strip. */
const EDGE_SCROLL_ZONE = 32;
const EDGE_SCROLL_STEP = 6;
/** Kept deliberately small: every open tab owns these DOM-only particles. */
const COMMAND_PARTICLES = 6;

interface TabDrag {
  id: string;
  pointerId: number;
  /** Pointer x at pointerdown, to tell a click from a drag. */
  startX: number;
  /** Where inside the tab it was grabbed, so it stays under the pointer. */
  grabX: number;
  /** Last known pointer x, for edge scrolling between pointer events. */
  x: number;
  /** Set once the pointer has travelled past the threshold. */
  active: boolean;
  scrollFrame: number;
}

export function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const requestCloseTab = useStore((s) => s.requestCloseTab);
  const moveTab = useStore((s) => s.moveTab);
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
      tab.commandActivity === "running"
        ? " · command running"
        : tab.commandActivity === "complete"
          ? " · command finished"
          : ""
    }`,
    checked: tab.info.id === activeId,
    action: () => setActive(tab.info.id),
  }));

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

  // Keep the active tab visible when it changes via click, shortcut or a new
  // session being opened past the right edge.
  useEffect(() => {
    stripRef.current
      ?.querySelector<HTMLElement>(".tab.is-active")
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activeId]);

  // Drag to reorder. Pointer events rather than HTML5 drag and drop: Tauri's
  // drag-drop handler (which the Filer needs for files dropped from outside)
  // swallows HTML5 drags on Windows, and pointer capture gives the dragged tab
  // a plain follow-the-pointer feel with no ghost image anyway. The store is
  // reordered live as the tab's visual centre crosses a neighbour's midpoint;
  // the dragged tab itself is offset with a transform so it never leaves the
  // pointer while React reflows the others under it. The pointer is captured
  // by the strip, not the tab: reordering keyed children moves nodes in the
  // DOM, and engines implicitly release capture from a removed element.
  const drag = useRef<TabDrag | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

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
    if (draggingId) updateDrag();
  }, [tabs, draggingId, updateDrag]);

  // Holding a tab near either edge pans the strip so tabs hidden past it can
  // still be reached; runs on frames because the pointer may sit still.
  const edgeScroll = useCallback(() => {
    const state = drag.current;
    const strip = stripRef.current;
    if (!state?.active || !strip) return;
    const rect = strip.getBoundingClientRect();
    let delta = 0;
    if (state.x < rect.left + EDGE_SCROLL_ZONE) delta = -EDGE_SCROLL_STEP;
    else if (state.x > rect.right - EDGE_SCROLL_ZONE) delta = EDGE_SCROLL_STEP;
    if (delta !== 0) {
      const before = strip.scrollLeft;
      strip.scrollLeft += delta;
      if (strip.scrollLeft !== before) updateDrag();
    }
    state.scrollFrame = requestAnimationFrame(edgeScroll);
  }, [updateDrag]);

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || drag.current) return;
    const target = event.target as Element;
    if (target.closest(".tab-close")) return;
    const tab = target.closest<HTMLElement>(".tab");
    const id = tab?.dataset.tabId;
    if (!tab || !id) return;
    drag.current = {
      id,
      pointerId: event.pointerId,
      startX: event.clientX,
      grabX: event.clientX - tab.getBoundingClientRect().left,
      x: event.clientX,
      active: false,
      scrollFrame: 0,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    state.x = event.clientX;
    if (!state.active) {
      if (Math.abs(event.clientX - state.startX) < DRAG_THRESHOLD) return;
      state.active = true;
      setDraggingId(state.id);
      state.scrollFrame = requestAnimationFrame(edgeScroll);
    }
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
    if (state.active) {
      const element = strip.querySelector<HTMLElement>(".tab.is-dragging");
      if (element) element.style.transform = "";
      setDraggingId(null);
    }
  };

  return (
    <div
      className={[
        "tabstrip",
        overflow.left ? "can-scroll-left" : "",
        overflow.right ? "can-scroll-right" : "",
        draggingId ? "is-reordering" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={stripRef}
      onScroll={updateOverflow}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div className="tabstrip-fade-left" aria-hidden="true" />
      {tabs.map((tab) => {
        const active = tab.info.id === activeId;
        const sessionColor =
          tab.info.color ??
          colorForSession(tab.info.profileId ?? tab.info.name);
        return (
          <div
            key={tab.info.id}
            className={[
              "tab",
              active ? "is-active" : "",
              `is-${tab.state}`,
              `is-command-${tab.commandActivity}`,
              tab.info.id === draggingId ? "is-dragging" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ "--session-color": sessionColor } as CSSProperties}
            data-tab-id={tab.info.id}
            onMouseDown={() => setActive(tab.info.id)}
            title={`${tab.info.protocol} · ${tab.info.address} · ${
              tab.commandActivity === "running"
                ? "command running"
                : tab.commandActivity === "complete"
                  ? "command finished — select to view"
                  : (tab.message ?? tab.state)
            }`}
          >
            <span className="tab-command-activity" aria-hidden="true">
              {Array.from({ length: COMMAND_PARTICLES }, (_, index) => (
                <span className="tab-command-particle" key={index} />
              ))}
            </span>
            <span className="tab-index">{tab.number}.</span>
            <span className="tab-dot" aria-hidden="true" />
            <span className="tab-label">{tabTitle(tab)}</span>
            <button
              className="tab-close"
              onMouseDown={(event) => {
                event.stopPropagation();
                requestCloseTab(tab.info.id);
              }}
              title="Close session"
              aria-label="Close session"
            >
              <Icon name="close" />
            </button>
          </div>
        );
      })}

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
    </div>
  );
}
