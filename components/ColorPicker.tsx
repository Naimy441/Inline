"use client";

import { useEffect, useRef, useState } from "react";

export const TEXT_COLORS = [
  "#000000",
  "#434343",
  "#666666",
  "#999999",
  "#b7b7b7",
  "#cccccc",
  "#d9d9d9",
  "#ffffff",
  "#980000",
  "#ff0000",
  "#ff9900",
  "#ffff00",
  "#00ff00",
  "#00ffff",
  "#4a86e8",
  "#0000ff",
  "#9900ff",
  "#ff00ff",
  "#e6b8af",
  "#f4cccc",
  "#fce5cd",
  "#fff2cc",
  "#d9ead3",
  "#d0e0e3",
  "#c9daf8",
  "#cfe2f3",
  "#dd7e6b",
  "#ea9999",
  "#f9cb9c",
  "#ffe599",
  "#b6d7a8",
  "#a2c4c9",
  "#a4c2f4",
  "#9fc5e8",
  "#cc4125",
  "#e06666",
  "#f6b26b",
  "#ffd966",
  "#93c47d",
  "#76a5af",
  "#6d9eeb",
  "#6fa8dc",
  "#a61c00",
  "#cc0000",
  "#e69138",
  "#f1c232",
  "#6aa84f",
  "#45818e",
  "#3c78d8",
  "#3d85c6",
  "#85200c",
  "#990000",
  "#b45f06",
  "#bf9000",
  "#38761d",
  "#134f5c",
  "#1155cc",
  "#0b5394",
];

export const HIGHLIGHT_COLORS = [
  "#fef7c0",
  "#ffe599",
  "#ffff00",
  "#d9ead3",
  "#00ff00",
  "#cfe2f3",
  "#00ffff",
  "#c9daf8",
  "#4a86e8",
  "#ead1dc",
  "#ff00ff",
  "#f4cccc",
  "#ff0000",
  "#d9d2e9",
  "#9900ff",
  "#cccccc",
];

type Props = {
  label: string;
  kind: "text" | "highlight";
  value: string;
  onPick: (color: string) => void;
};

export function ColorPicker({ label, kind, value, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const frozenRange = useRef<Range | null>(null);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);

  const freezeSelection = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return;
    frozenRange.current = selection.getRangeAt(0).cloneRange();
  };

  const apply = (color: string) => {
    const selection = window.getSelection();
    if (frozenRange.current && selection) {
      selection.removeAllRanges();
      selection.addRange(frozenRange.current);
    }
    onPick(color);
    setOpen(false);
  };

  const colors = kind === "text" ? TEXT_COLORS : HIGHLIGHT_COLORS;

  return (
    <div
      className="color-tool"
      onMouseDown={(event) => {
        freezeSelection();
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <button
        className="tool color-tool-btn"
        type="button"
        title={label}
        aria-label={label}
        aria-expanded={open}
        onMouseDown={(event) => {
          freezeSelection();
          event.preventDefault();
        }}
        onClick={() => setOpen((current) => !current)}
      >
        {kind === "text" ? <TextColorIcon color={value} /> : <HighlightIcon color={value} />}
      </button>
      {open && (
        <div className="color-popover" role="dialog" aria-label={label}>
          <button
            type="button"
            className="color-reset"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => apply(kind === "text" ? "auto" : "transparent")}
          >
            {kind === "text" ? "Automatic" : "None"}
          </button>
          <div className="color-grid">
            {colors.map((color) => (
              <button
                key={color}
                type="button"
                className="color-swatch"
                style={{ background: color }}
                aria-label={color}
                data-active={value === color}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => apply(color)}
              />
            ))}
          </div>
          <label className="color-custom">
            Custom
            <input
              type="color"
              value={
                value === "transparent" || value === "auto"
                  ? kind === "highlight"
                    ? "#ffff00"
                    : "#000000"
                  : value
              }
              onChange={(event) => apply(event.target.value)}
            />
          </label>
        </div>
      )}
    </div>
  );
}

function TextColorIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M9.1 14.3h5.8L13.4 11c-.5-1.3-.9-2.5-1.2-3.5h-.1c-.3 1-.7 2.2-1.2 3.5l-1.8 3.3Zm-2.3 5.2L11.2 6h1.7l4.5 13.5h-2.1l-1-3.2H9.9l-1.1 3.2H6.8Z"
      />
      <rect x="4" y="20" width="16" height="2.4" rx="0.6" fill={color === "auto" || !color ? "var(--paper-ink)" : color} />
    </svg>
  );
}

function HighlightIcon({ color }: { color: string }) {
  const bar = color === "transparent" || !color ? "#fbbc04" : color;
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="currentColor"
        d="M11.2 3.6 20 12.4l-1.4 1.4-1.5-1.5-6.2 6.2H7.2L4.4 21l-1.3-1.3 2.4-2.8v-3.7l6.2-6.2-1.5-1.5L11.2 3.6Zm.7 3.5-5.2 5.2v1.7h1.7l5.2-5.2-1.7-1.7Z"
      />
      <rect x="4" y="20" width="16" height="2.4" rx="0.6" fill={bar} />
    </svg>
  );
}
