"use client";

import { useCallback, useEffect, useState } from "react";

export const THEME_KEY = "inline-theme";

function prefersDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function readStoredTheme() {
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === "dark") return true;
  if (stored === "light") return false;
  return prefersDark();
}

export function applyTheme(dark: boolean) {
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  window.localStorage.setItem(THEME_KEY, dark ? "dark" : "light");
}

export function useInlineTheme() {
  const [darkMode, setDarkMode] = useState<boolean | null>(null);

  useEffect(() => {
    setDarkMode(readStoredTheme());
  }, []);

  useEffect(() => {
    if (darkMode == null) return;
    applyTheme(darkMode);
  }, [darkMode]);

  const toggleTheme = useCallback(() => {
    setDarkMode((on) => (on == null ? document.documentElement.dataset.theme !== "dark" : !on));
  }, []);

  return { darkMode: Boolean(darkMode), toggleTheme };
}
