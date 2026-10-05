"use client";

import { useEffect, useSyncExternalStore } from "react";

/** Phones get the reflowed, touch-first layout; tablets and up get pages. */
export const PHONE_QUERY = "(max-width: 640px)";
/** Phones and tablets: the menu bar folds into a "More" menu and panels overlay the page. */
export const COMPACT_QUERY = "(max-width: 860px)";

function subscribeTo(query: string) {
  return (listener: () => void) => {
    const list = window.matchMedia(query);
    list.addEventListener("change", listener);
    return () => list.removeEventListener("change", listener);
  };
}

const subscribers = new Map<string, (listener: () => void) => () => void>();

/** Whether a media query matches, kept in sync as the window changes. False while server rendering. */
export function useMediaQuery(query: string) {
  let subscribe = subscribers.get(query);
  if (!subscribe) {
    subscribe = subscribeTo(query);
    subscribers.set(query, subscribe);
  }
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export function useIsPhone() {
  return useMediaQuery(PHONE_QUERY);
}

export function isPhone() {
  return typeof window !== "undefined" && window.matchMedia(PHONE_QUERY).matches;
}

export function isCompact() {
  return typeof window !== "undefined" && window.matchMedia(COMPACT_QUERY).matches;
}

/** Touch screens without a hovering pointer: no tooltips, native long-press menus. */
export function isTouch() {
  return typeof window !== "undefined" && window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

/**
 * Track the visual viewport as CSS variables (--app-height, --app-top) so a
 * full-screen layout can sit above the on-screen keyboard. iOS Safari keeps
 * the layout viewport (and 100dvh) full height while the keyboard is open, so
 * anything pinned to the bottom would otherwise hide behind it. Ignored while
 * the page is pinch-zoomed, so zooming in doesn't shrink the layout.
 */
export function useVisualViewportVars() {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    let frame = 0;
    const update = () => {
      frame = 0;
      if (Math.abs(viewport.scale - 1) > 0.01) return;
      root.style.setProperty("--app-height", `${Math.round(viewport.height)}px`);
      root.style.setProperty("--app-top", `${Math.max(0, Math.round(viewport.offsetTop))}px`);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    viewport.addEventListener("resize", schedule);
    viewport.addEventListener("scroll", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      viewport.removeEventListener("resize", schedule);
      viewport.removeEventListener("scroll", schedule);
      root.style.removeProperty("--app-height");
      root.style.removeProperty("--app-top");
    };
  }, []);
}
