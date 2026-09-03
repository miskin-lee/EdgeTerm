import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

import { Icon, type IconName } from "./icons";

/**
 * Which control a checkable entry draws in the leading column: a box for an
 * independent on / off setting, a radio for one choice out of a set.
 */
export type MenuMark = "check" | "radio";

export interface MenuAction {
  label: string;
  action?: () => void;
  disabled?: boolean;
  /** Destructive entries are tinted red. */
  danger?: boolean;
  /** Marks the entry as a choice, and says whether it is the chosen one. */
  checked?: boolean;
  /** The control shape a checkable entry draws; a box by default. */
  mark?: MenuMark;
  /** A Codicon in the leading column, before the label. */
  icon?: IconName;
  /** The key combination that runs the same command, shown at the right. */
  shortcut?: string;
  /** Extra left padding in tree levels, for nested choices in a submenu. */
  indent?: number;
  /** Nested entries opened on hover. */
  children?: MenuItem[];
}

/** A quiet caption over the entries that follow, e.g. what a choice decides. */
export interface MenuHeading {
  heading: string;
}

export type MenuItem = MenuAction | MenuHeading | "separator";

interface Props {
  /** Viewport coordinates of the pointer when the menu was requested. */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
  /**
   * Which edge of the menu sits at `x`. "right" is for dropdowns hanging off
   * a button near the right side of the screen.
   */
  align?: "left" | "right";
  /** Extra classes, e.g. to cap the height of a long, scrollable list. */
  className?: string;
}

/** Approximate submenu width, used to decide which side it opens on. */
const SUBMENU_WIDTH = 200;
const EDGE_MARGIN = 6;

function isAction(item: MenuItem): item is MenuAction {
  return typeof item !== "string" && "label" in item;
}

/**
 * Whether one menu level needs the leading column. Any entry with an icon
 * or a check mark gives every row of that level the column, so the labels
 * share one left edge; levels without either stay compact.
 */
function hasLeading(items: MenuItem[]): boolean {
  return items.some(
    (item) =>
      isAction(item) &&
      (item.icon !== undefined || item.checked !== undefined),
  );
}

/**
 * The selection column of a dropdown entry. A checkable entry always draws
 * its control — an empty box or radio when it is off — so the rows that are
 * choices read as choices before anything is picked; entries that are plain
 * commands get a same-width blank so every label shares one left edge.
 * Shared with the menubar's dropdowns.
 */
export function MenuCheck({
  checked,
  mark = "check",
}: {
  checked?: boolean;
  mark?: MenuMark;
}) {
  if (checked === undefined) {
    return <span className="menu-check" aria-hidden="true" />;
  }
  return (
    <span
      className={`menu-check is-${mark}${checked ? " is-checked" : ""}`}
      aria-hidden="true"
    >
      {mark === "check" && checked && <Icon name="check" />}
    </span>
  );
}

/** The ARIA role of an entry: a checkbox, a radio, or a plain command. */
export function menuRole(item: {
  checked?: boolean;
  mark?: MenuMark;
}): "menuitem" | "menuitemcheckbox" | "menuitemradio" {
  if (item.checked === undefined) return "menuitem";
  return item.mark === "radio" ? "menuitemradio" : "menuitemcheckbox";
}

/** The leading column: the entry's icon, else its check mark or a blank. */
function MenuLeading({ entry }: { entry: MenuAction }) {
  if (entry.icon) {
    return (
      <span className="menu-icon" aria-hidden="true">
        <Icon name={entry.icon} />
      </span>
    );
  }
  return <MenuCheck checked={entry.checked} mark={entry.mark} />;
}

/**
 * A right-click menu anchored at a viewport point. It reuses the menubar's
 * dropdown styling, keeps itself inside the window, and closes on any click
 * outside, Escape, scrolling, resizing or the window losing focus — the same
 * moments a native menu would go away.
 */
export function ContextMenu({
  x,
  y,
  items,
  onClose,
  align = "left",
  className,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<{
    left: number;
    top: number;
    flipped: boolean;
  }>({ left: x, top: y, flipped: false });

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const { offsetWidth: width, offsetHeight: height } = element;
    const maxLeft = window.innerWidth - width - EDGE_MARGIN;
    const maxTop = window.innerHeight - height - EDGE_MARGIN;
    const anchorLeft = align === "right" ? x - width : x;
    const left = Math.max(EDGE_MARGIN, Math.min(anchorLeft, maxLeft));
    const top = Math.max(EDGE_MARGIN, Math.min(y, maxTop));
    // Menus opened from the Filer sit at the right edge, so their submenus
    // have to open leftwards to stay visible.
    const flipped = left + width + SUBMENU_WIDTH > window.innerWidth;
    setPlacement({ left, top, flipped });
  }, [x, y, items, align]);

  useEffect(() => {
    const onMouseDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    // Capture phase: a scroll anywhere (the panel body included) would leave
    // the fixed-position menu floating away from its row.
    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("scroll", onClose, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("scroll", onClose, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  const renderItems = (level: MenuItem[]) => {
    const showLeading = hasLeading(level);
    return level.map((item, index) => {
      if (item === "separator") {
        return <div key={`sep-${index}`} className="menu-separator" />;
      }
      if (!isAction(item)) {
        return (
          <div
            key={`heading-${index}`}
            className="menu-heading"
            role="presentation"
          >
            {item.heading}
          </div>
        );
      }
      const key = `${item.label}-${index}`;
      if (item.children) {
        return (
          <div key={key} className="menu-submenu-entry">
            <div className="menu-entry" role="menuitem" aria-haspopup="menu">
              {showLeading && <MenuLeading entry={item} />}
              <span className="menu-entry-label">{item.label}</span>
              <span className="menu-submenu-arrow" aria-hidden="true">
                <Icon name="chevron-right" />
              </span>
            </div>
            <div className="menu-dropdown menu-submenu" role="menu">
              {renderItems(item.children)}
            </div>
          </div>
        );
      }
      return (
        <button
          key={key}
          type="button"
          role={menuRole(item)}
          aria-checked={item.checked !== undefined ? item.checked : undefined}
          className={[
            "menu-entry",
            item.checked ? "is-checked" : "",
            item.danger ? "is-danger" : "",
          ]
            .filter(Boolean)
            .join(" ")}
          disabled={item.disabled}
          style={
            item.indent
              ? ({ paddingLeft: 8 + item.indent * 14 } as CSSProperties)
              : undefined
          }
          onClick={() => {
            onClose();
            item.action?.();
          }}
        >
          {showLeading && <MenuLeading entry={item} />}
          <span className="menu-entry-label">{item.label}</span>
          {item.shortcut && (
            <span className="menu-shortcut">{item.shortcut}</span>
          )}
        </button>
      );
    });
  };

  return (
    <div
      ref={ref}
      className={[
        "menu-dropdown",
        "context-menu",
        align === "right" ? "is-right" : "",
        placement.flipped ? "is-flipped" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      role="menu"
      style={{ left: placement.left, top: placement.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {renderItems(items)}
    </div>
  );
}
