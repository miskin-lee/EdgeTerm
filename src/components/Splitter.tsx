import { useCallback, useRef, useState } from "react";

interface Props {
  orientation: "vertical" | "horizontal";
  /** Receives the pointer delta in pixels since the last move. */
  onResize: (delta: number) => void;
}

export function Splitter({ orientation, onResize }: Props) {
  const [dragging, setDragging] = useState(false);
  const last = useRef(0);

  const handleDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      last.current = orientation === "vertical" ? event.clientX : event.clientY;
      setDragging(true);
    },
    [orientation],
  );

  const handleMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging) return;
      const current =
        orientation === "vertical" ? event.clientX : event.clientY;
      const delta = current - last.current;
      if (delta !== 0) {
        last.current = current;
        onResize(delta);
      }
    },
    [dragging, orientation, onResize],
  );

  const handleUp = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.currentTarget.releasePointerCapture(event.pointerId);
      setDragging(false);
    },
    [],
  );

  return (
    <div
      className={`splitter is-${orientation}${dragging ? " is-dragging" : ""}`}
      onPointerDown={handleDown}
      onPointerMove={handleMove}
      onPointerUp={handleUp}
      onPointerCancel={handleUp}
    />
  );
}
