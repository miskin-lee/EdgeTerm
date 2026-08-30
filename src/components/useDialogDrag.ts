import { useEffect, useRef } from "react";

interface DragState {
  pointerId: number;
  /** Pointer position at pointerdown. */
  startX: number;
  startY: number;
  /** Dialog offset at pointerdown; the new offset is delta + this. */
  originX: number;
  originY: number;
}

/**
 * Lets a centred dialog be dragged around by its header.
 *
 * The backdrop keeps centring the dialog with CSS grid; dragging only adds a
 * `transform: translate()` on top, so the dialog still opens centred and the
 * offset disappears with the element. The offset is clamped so the dialog
 * never leaves the viewport, and re-clamped when the window or the dialog
 * itself resizes (switching protocol changes its height). Pointer events
 * rather than HTML5 drag-and-drop, for the same reason as the tab strip:
 * Tauri's drag-drop handling swallows HTML5 drags on Windows.
 */
export function useDialogDrag<T extends HTMLElement>() {
  const dialogRef = useRef<T>(null);
  const offset = useRef({ x: 0, y: 0 });
  const drag = useRef<DragState | null>(null);

  const apply = (x: number, y: number) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    // Clamp against where layout put the dialog, i.e. the rect with the
    // current offset taken back out.
    const rect = dialog.getBoundingClientRect();
    const baseLeft = rect.left - offset.current.x;
    const baseTop = rect.top - offset.current.y;
    const minX = -baseLeft;
    const maxX = window.innerWidth - rect.width - baseLeft;
    const minY = -baseTop;
    const maxY = window.innerHeight - rect.height - baseTop;
    x = Math.min(Math.max(x, minX), Math.max(minX, maxX));
    y = Math.min(Math.max(y, minY), Math.max(minY, maxY));
    offset.current = { x, y };
    dialog.style.transform = x || y ? `translate(${x}px, ${y}px)` : "";
  };

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const reclamp = () => apply(offset.current.x, offset.current.y);
    window.addEventListener("resize", reclamp);
    const observer = new ResizeObserver(reclamp);
    observer.observe(dialog);
    return () => {
      window.removeEventListener("resize", reclamp);
      observer.disconnect();
    };
  }, []);

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || drag.current) return;
    const target = event.target as Element;
    // Buttons and inputs in the header keep their own behaviour.
    if (target.closest("button, input, select, textarea, a")) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.current.x,
      originY: offset.current.y,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    apply(
      state.originX + event.clientX - state.startX,
      state.originY + event.clientY - state.startY,
    );
  };

  const endDrag = (event: React.PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || state.pointerId !== event.pointerId) return;
    drag.current = null;
    const handle = event.currentTarget;
    if (handle.hasPointerCapture(event.pointerId)) {
      handle.releasePointerCapture(event.pointerId);
    }
  };

  return {
    dialogRef,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
  };
}
