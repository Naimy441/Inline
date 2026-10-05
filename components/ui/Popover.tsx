"use client";

import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useAnchoredPosition, type Placement } from "./floating";

/** A floating panel anchored to an element; closes on outside click or Escape. */
export function Popover({
  open,
  onClose,
  anchor,
  placement = "bottom-start",
  className,
  children,
  role = "dialog",
}: {
  open: boolean;
  onClose: () => void;
  anchor: RefObject<HTMLElement | null> | DOMRect | null;
  placement?: Placement;
  className?: string;
  children: ReactNode;
  role?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const style = useAnchoredPosition(open, anchor, ref, placement);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (anchor && "current" in anchor && anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, anchor]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <div ref={ref} role={role} className={`popover${className ? ` ${className}` : ""}`} style={{ position: "fixed", ...style }}>
      {children}
    </div>,
    document.body,
  );
}
