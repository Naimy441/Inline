"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { patch } from "@/lib/client/api";
import { THEME_KEY as KEY } from "@/lib/client/bootScripts";

const listeners = new Set<() => void>();
let reportTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * The appearance to store for closed-document pictures, or null to leave the
 * saved one alone. A light window that never chose a theme must not overwrite
 * a dark appearance another window already saved.
 */
export function appearanceToRemember(chosen: string | null, showing: "light" | "dark"): "light" | "dark" | null {
  if (chosen !== "light" && chosen !== "dark" && showing !== "dark") return null;
  return showing;
}

/** Remember the appearance the user is actually using, so a closed document can be pictured that way. */
function rememberAppearance() {
  if (typeof document === "undefined") return;
  if (reportTimer) clearTimeout(reportTimer);
  reportTimer = setTimeout(() => {
    reportTimer = null;
    let chosen: string | null = null;
    try {
      chosen = localStorage.getItem(KEY);
    } catch {
      chosen = null;
    }
    const showing = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
    const appearance = appearanceToRemember(chosen, showing);
    if (!appearance) return;
    void patch("/api/preferences", { appearance }).catch(() => undefined);
  }, 200);
}

function isDark() {
  return document.documentElement.dataset.theme === "dark";
}

export function useTheme() {
  const dark = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    isDark,
    () => false,
  );
  const toggle = useCallback(() => {
    const next = !isDark();
    document.documentElement.dataset.theme = next ? "dark" : "light";
    try {
      localStorage.setItem(KEY, next ? "dark" : "light");
    } catch {
      // private mode
    }
    for (const listener of listeners) listener();
  }, []);
  // A closed document has no editor. Remember the appearance on screen so a screenshot can match it.
  useEffect(() => {
    rememberAppearance();
  }, [dark]);
  return { dark, toggle };
}
