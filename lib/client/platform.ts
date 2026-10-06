import { useCallback, useSyncExternalStore } from "react";

/**
 * Keyboard shortcut labels. Shortcuts are written once in Mac notation
 * ("⌘⇧Z") and shown as "Ctrl+Shift+Z" elsewhere.
 *
 * The server can't know the platform, so it renders Mac labels and the client
 * switches after hydration (useShortcut). Reading navigator during render
 * instead makes the server and client HTML differ, which React reports as a
 * hydration error.
 */

const MODIFIERS: Record<string, string> = { "⌘": "Ctrl", "⌥": "Alt", "⇧": "Shift", "⌃": "Ctrl" };

/** True on macOS and iOS. Only call in the browser after hydration (events, effects, editor code). */
export function isApple() {
  return typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);
}

/** "⌘⇧Z" → "Ctrl+Shift+Z" off Apple platforms; a space after a symbol ("⌘ ⇧ Z") is kept as the separator instead. */
export function formatShortcut(shortcut: string, apple: boolean) {
  if (apple) return shortcut;
  return shortcut.replace(/([⌘⌥⇧⌃])( ?)/g, (_match, symbol: string, space: string) => `${MODIFIERS[symbol]}${space || "+"}`);
}

/** Shortcut labels for the current platform, hydration-safe: the first render matches the server's (Mac) labels. */
export function useShortcut() {
  const apple = useSyncExternalStore(subscribe, isApple, () => true);
  return useCallback((shortcut: string) => formatShortcut(shortcut, apple), [apple]);
}

function subscribe() {
  return () => {};
}
