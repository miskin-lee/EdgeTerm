import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { toggleSessionConnection } from "../actions";
import { useStore } from "../store";
import { colorForSession, type SessionState } from "../types";
import { ContextMenu, type MenuItem } from "./ContextMenu";

/** Tooltip of a tab's power toggle, by the state it would act on. */
const POWER_TITLES: Record<SessionState, string> = {
  connected: "Disconnect",
  connecting: "Connecting…",
  closed: "Reconnect",
  error: "Reconnect",
};

export function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const activeId = useStore((s) => s.activeId);
  const setActive = useStore((s) => s.setActive);
  const requestCloseTab = useStore((s) => s.requestCloseTab);
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
  const listItems: MenuItem[] = tabs.map((tab, index) => ({
    label: `${index + 1}. ${tab.info.name}`,
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

  return (
    <div
      className={[
        "tabstrip",
        overflow.left ? "can-scroll-left" : "",
        overflow.right ? "can-scroll-right" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      ref={stripRef}
      onScroll={updateOverflow}
    >
      <div className="tabstrip-fade-left" aria-hidden="true" />
      {tabs.map((tab, index) => {
        const active = tab.info.id === activeId;
        const sessionColor =
          tab.info.color ??
          colorForSession(tab.info.profileId ?? tab.info.name);
        return (
          <div
            key={tab.info.id}
            className={["tab", active ? "is-active" : "", `is-${tab.state}`]
              .filter(Boolean)
              .join(" ")}
            style={{ "--session-color": sessionColor } as CSSProperties}
            onMouseDown={() => setActive(tab.info.id)}
            title={`${tab.info.protocol} · ${tab.info.address} · ${tab.message ?? tab.state}`}
          >
            <span className="tab-index">{index + 1}.</span>
            <span className="tab-dot" aria-hidden="true" />
            <span className="tab-label">{tab.info.name}</span>
            <button
              className="tab-power"
              disabled={tab.state === "connecting"}
              onMouseDown={(event) => {
                event.stopPropagation();
                toggleSessionConnection(tab.info.id);
              }}
              title={POWER_TITLES[tab.state]}
              aria-label={POWER_TITLES[tab.state]}
            >
              {/* Power symbol: an open ring with a bar through the gap. */}
              <svg viewBox="0 0 10 10" aria-hidden="true">
                <path d="M3.1 2.9A3.3 3.3 0 1 0 6.9 2.9" />
                <path d="M5 0.9v4.3" />
              </svg>
            </button>
            <button
              className="tab-close"
              onMouseDown={(event) => {
                event.stopPropagation();
                requestCloseTab(tab.info.id);
              }}
              title="Close session"
            >
              ✕
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
            ⌄
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
