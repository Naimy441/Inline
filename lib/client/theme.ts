"use client";

import { useCallback, useSyncExternalStore } from "react";

const KEY = "inline-theme";

/** Inline script for <head> that applies the saved theme before first paint. */
export const themeBootScript = `try{var t=localStorage.getItem('${KEY}');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.dataset.theme='dark'}catch(e){}`;

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
