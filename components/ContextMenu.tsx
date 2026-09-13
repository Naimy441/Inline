"use client";

import { useEffect } from "react";

export type ContextMenuItem = {
  label: string;
  action: string;
  shortcut?: string;
  disabled?: boolean;
};

type Props = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
  onAction: (action: string) => void;
};

export function ContextMenu({ x, y, items, onClose, onAction }: Props) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      className="ctx-menu"
      role="menu"
      style={{ left: x, top: y }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {items.map((item) => (
        <button
          key={item.action}
          type="button"
          role="menuitem"
          disabled={item.disabled}
          onClick={() => {
            onAction(item.action);
            onClose();
          }}
        >
          <span>{item.label}</span>
          {item.shortcut && <span className="ctx-shortcut">{item.shortcut}</span>}
        </button>
      ))}
    </div>
  );
}
