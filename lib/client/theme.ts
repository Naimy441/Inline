"use client";

import { useCallback, useSyncExternalStore } from "react";
import { THEME_KEY as KEY } from "@/lib/client/bootScripts";

const listeners = new Set<() => void>();

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
  return { dark, toggle };
}
