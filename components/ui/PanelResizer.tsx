"use client";

/** A drag handle on a side panel's left edge; dragging left widens the panel, within `min` and `max`. */
export function PanelResizer({ width, onResize, min = 320, max = 760 }: { width: number; onResize: (width: number) => void; min?: number; max?: number }) {
  return (
    <div
      className="panel-resizer"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize panel"
      onPointerDown={(event) => {
        const startX = event.clientX;
        const start = width;
        const target = event.currentTarget;
        target.setPointerCapture(event.pointerId);
        const move = (moveEvent: PointerEvent) => onResize(Math.max(min, Math.min(max, start + (startX - moveEvent.clientX))));
        const up = () => {
          target.removeEventListener("pointermove", move);
          target.removeEventListener("pointerup", up);
        };
        target.addEventListener("pointermove", move);
        target.addEventListener("pointerup", up);
      }}
    />
  );
}
