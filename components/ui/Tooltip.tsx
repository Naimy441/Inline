"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Tip = { text: string; rect: DOMRect };

const DELAY_MS = 450;
const GAP = 6;

/** Tips go above controls near the bottom of the window (the message box, the status bar). */
function prefersAbove(element: HTMLElement, rect: DOMRect) {
  return Boolean(element.closest(".composer, .review-bar, .statusbar")) || rect.bottom + 40 > window.innerHeight;
}

/**
 * Tooltips for every element with a data-tip, drawn in a layer above the page
 * so a scrolling toolbar or a panel edge can't clip them. Mouse only: a tap
 * would leave one stuck on.
 */
export function TooltipLayer() {
  const [tip, setTip] = useState<(Tip & { above: boolean }) | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const bubble = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current: HTMLElement | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      current = null;
      clearTimeout(timer);
      setTip(null);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType !== "mouse") return;
      const element = (event.target as Element | null)?.closest?.<HTMLElement>("[data-tip]") ?? null;
      if (element === current) return;
      current = element;
      clearTimeout(timer);
      setTip(null);
      if (!element) return;
      timer = setTimeout(() => {
        const text = element.getAttribute("data-tip");
        // Not over an open menu's own button.
        if (!text || current !== element || !element.isConnected || element.getAttribute("aria-expanded") === "true" || element.classList.contains("is-open")) return;
        const rect = element.getBoundingClientRect();
        setLeft(null);
        setTip({ text, rect, above: prefersAbove(element, rect) });
      }, DELAY_MS);
    };
    document.addEventListener("pointerover", over);
    document.addEventListener("pointerdown", hide, true);
    document.addEventListener("keydown", hide, true);
    document.addEventListener("scroll", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("pointerover", over);
      document.removeEventListener("pointerdown", hide, true);
      document.removeEventListener("keydown", hide, true);
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("blur", hide);
    };
  }, []);

  // Center on the control, kept inside the window.
  useLayoutEffect(() => {
    if (!tip || !bubble.current) return;
    const width = bubble.current.offsetWidth;
    const centered = tip.rect.left + tip.rect.width / 2 - width / 2;
    setLeft(Math.max(8, Math.min(window.innerWidth - width - 8, centered)));
  }, [tip]);

  if (!tip || typeof document === "undefined") return null;
  return createPortal(
    <div
      ref={bubble}
      className="tooltip"
      role="tooltip"
      style={{
        left: left ?? tip.rect.left,
        visibility: left === null ? "hidden" : undefined,
        ...(tip.above ? { bottom: window.innerHeight - tip.rect.top + GAP } : { top: tip.rect.bottom + GAP }),
      }}
    >
      {tip.text}
    </div>,
    document.body,
  );
}
