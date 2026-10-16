"use client";

import { useRef, useState } from "react";

/** Squares offered as shortcuts. Anything else is chosen on the grid or typed. */
export const TABLE_PRESETS = [2, 3, 4, 5] as const;
/** Cells on the drag grid. Larger tables are typed in the custom-size dialog. */
export const TABLE_GRID = 8;
export const TABLE_SIZE_MAX = 20;

export function tableSize(rows: number, cols: number) {
  return Number.isInteger(rows) && Number.isInteger(cols) && rows >= 1 && cols >= 1 && rows <= TABLE_SIZE_MAX && cols <= TABLE_SIZE_MAX;
}

/**
 * A grid of cells. Hover or drag to choose rows × columns, then release.
 * Keyboard users activate a cell directly. `rows` and `cols` highlight a size
 * chosen another way, such as the number fields.
 */
export function TableSizeGrid({ rows = 0, cols = 0, onPick }: { rows?: number; cols?: number; onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState<{ rows: number; cols: number } | null>(null);
  const dragging = useRef<{ rows: number; cols: number } | null>(null);
  const shown = hover ?? (rows > 0 && cols > 0 ? { rows: Math.min(rows, TABLE_GRID), cols: Math.min(cols, TABLE_GRID) } : null);
  const label = hover ? `${hover.rows} × ${hover.cols}` : rows > 0 && cols > 0 ? `${rows} × ${cols}` : "Drag to choose";

  const read = (target: EventTarget | null) => {
    const cell = target instanceof Element ? target.closest<HTMLElement>("[data-rows]") : null;
    if (!cell) return null;
    const next = { rows: Number(cell.dataset.rows), cols: Number(cell.dataset.cols) };
    return tableSize(next.rows, next.cols) ? next : null;
  };

  return (
    <div
      className="table-size"
      onPointerLeave={() => {
        if (!dragging.current) setHover(null);
      }}
    >
      <div
        className="table-size-grid"
        role="grid"
        aria-label="Table size"
        onPointerDown={(event) => {
          const cell = read(event.target);
          if (!cell) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          dragging.current = cell;
          setHover(cell);
        }}
        onPointerMove={(event) => {
          if (!dragging.current) return;
          const cell = read(document.elementFromPoint(event.clientX, event.clientY));
          if (!cell) return;
          dragging.current = cell;
          setHover(cell);
        }}
        onPointerUp={() => {
          const picked = dragging.current;
          dragging.current = null;
          if (picked) onPick(picked.rows, picked.cols);
        }}
      >
        {Array.from({ length: TABLE_GRID }, (_, row) =>
          Array.from({ length: TABLE_GRID }, (_, col) => {
            const on = shown != null && row < shown.rows && col < shown.cols;
            return (
              <button
                key={`${row}-${col}`}
                type="button"
                role="gridcell"
                data-rows={row + 1}
                data-cols={col + 1}
                aria-label={`${row + 1} × ${col + 1}`}
                className={on ? "is-on" : ""}
                onPointerEnter={() => setHover({ rows: row + 1, cols: col + 1 })}
                onClick={(event) => {
                  if (event.detail !== 0) return;
                  onPick(row + 1, col + 1);
                }}
              />
            );
          }),
        )}
      </div>
      <div className="table-size-label" aria-live="polite">
        {label}
      </div>
    </div>
  );
}
