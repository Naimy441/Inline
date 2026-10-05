"use client";

import { useLayoutEffect, useState, type RefObject } from "react";

export type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end" | "bottom" | "top" | "right-start";

/** Fixed-position coordinates for a floating element anchored to `anchor`, flipped to stay on screen. */
export function useAnchoredPosition(
  open: boolean,
  anchor: RefObject<HTMLElement | null> | DOMRect | null,
  floating: RefObject<HTMLElement | null>,
  placement: Placement = "bottom-start",
  offset = 6,
) {
  const [style, setStyle] = useState<{ top: number; left: number; visibility: "hidden" | "visible" }>({ top: -9999, left: -9999, visibility: "hidden" });
  useLayoutEffect(() => {
    if (!open) return;
    const commit = (top: number, left: number) =>
      setStyle((current) => (current.top === top && current.left === left && current.visibility === "visible" ? current : { top, left, visibility: "visible" }));
    const update = () => {
      const rect = anchor && "current" in anchor ? anchor.current?.getBoundingClientRect() : (anchor as DOMRect | null);
      const el = floating.current;
      if (!rect || !el) return;
      const width = el.offsetWidth;
      const height = el.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      if (placement === "right-start") {
        // Submenus: beside the parent item, flipping to the left edge when there's no room.
        let left = rect.right + 2;
        if (left + width > vw - 8) left = Math.max(8, rect.left - width - 2);
        const top = Math.max(8, Math.min(rect.top - 5, vh - height - 8));
        commit(top, left);
        return;
      }
      let top = placement.startsWith("top") ? rect.top - height - offset : rect.bottom + offset;
      if (placement.startsWith("bottom") && top + height > vh - 8 && rect.top - height - offset > 8) top = rect.top - height - offset;
      if (placement.startsWith("top") && top < 8) top = rect.bottom + offset;
      let left = placement.endsWith("end") ? rect.right - width : placement === "bottom" || placement === "top" ? rect.left + rect.width / 2 - width / 2 : rect.left;
      left = Math.max(8, Math.min(left, vw - width - 8));
      top = Math.max(8, Math.min(top, vh - height - 8));
      commit(top, left);
    };
    update();
    const observer = new ResizeObserver(update);
    if (floating.current) observer.observe(floating.current);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, anchor, floating, placement, offset]);
  return style;
}
