import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

export interface MenuAction {
  label: string;
  action?: () => void;
  disabled?: boolean;
  /** Destructive entries are tinted red. */
  danger?: boolean;
  /** Shows a check mark column; true marks the entry. */
  checked?: boolean;
  /** Extra left padding in tree levels, for nested choices in a submenu. */
  indent?: number;
  /** Nested entries opened on hover. */
  children?: MenuItem[];
}

export type MenuItem = MenuAction | "separator";

interface Props {
  /** Viewport coordinates of the pointer when the menu was requested. */
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

/** Approximate submenu width, used to decide which side it opens on. */
const SUBMENU_WIDTH = 200;
const EDGE_MARGIN = 6;

/**
 * A right-click menu anchored at a viewport point. It reuses the menubar's
 * dropdown styling, keeps itself inside the window, and closes on any click
 * outside, Escape, scrolling, resizing or the window losing focus — the same
 * moments a native menu would go away.
 */
export function ContextMenu({ x, y, items, onClose }: Props) {
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
    const left = Math.max(EDGE_MARGIN, Math.min(x, maxLeft));
    const top = Math.max(EDGE_MARGIN, Math.min(y, maxTop));
    // The Session panel sits on the right edge, so submenus usually have to
    // open leftwards to stay visible.
    const flipped = left + width + SUBMENU_WIDTH > window.innerWidth;
    setPlacement({ left, top, flipped });
  }, [x, y, items]);

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

  const renderEntry = (entry: MenuAction, key: string) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      className={[
        "menu-entry",
        entry.checked ? "is-checked" : "",
        entry.danger ? "is-danger" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      disabled={entry.disabled}
      style={
        entry.indent
          ? ({ paddingLeft: 8 + entry.indent * 14 } as CSSProperties)
          : undefined
      }
      onClick={() => {
        onClose();
        entry.action?.();
      }}
    >
      {entry.checked !== undefined && (
        <span className="menu-check" aria-hidden="true">
          {entry.checked ? "✓" : ""}
        </span>
      )}
      <span className="menu-entry-label">{entry.label}</span>
    </button>
  );

  return (
    <div
      ref={ref}
      className={`menu-dropdown context-menu${
        placement.flipped ? " is-flipped" : ""
      }`}
      role="menu"
      style={{ left: placement.left, top: placement.top }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item, index) =>
        item === "separator" ? (
          <div key={`sep-${index}`} className="menu-separator" />
        ) : item.children ? (
          <div key={item.label} className="menu-submenu-entry">
            <div className="menu-entry" role="menuitem" aria-haspopup="menu">
              <span className="menu-entry-label">{item.label}</span>
              <span className="menu-submenu-arrow" aria-hidden="true">
                ›
              </span>
            </div>
            <div className="menu-dropdown menu-submenu" role="menu">
              {item.children.map((child, childIndex) =>
                child === "separator" ? (
                  <div
                    key={`sep-${childIndex}`}
                    className="menu-separator"
                  />
                ) : (
                  renderEntry(child, `${child.label}-${childIndex}`)
                ),
              )}
            </div>
          </div>
        ) : (
          renderEntry(item, `${item.label}-${index}`)
        ),
      )}
    </div>
  );
}
