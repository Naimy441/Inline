/**
 * The desktop app (desktop/) loads Inline in a native window and exposes a
 * small bridge from its preload script as `window.inlineDesktop`. In a
 * browser it is undefined and everything here is a no-op.
 */

export type DesktopBridge = {
  platform: "darwin" | "win32" | "linux";
  version: string;
  /** Open this page, or `path`, in the default web browser. */
  openInBrowser: (path?: string) => void;
};

declare global {
  interface Window {
    inlineDesktop?: DesktopBridge;
  }
}

export function desktop(): DesktopBridge | null {
  return typeof window !== "undefined" ? (window.inlineDesktop ?? null) : null;
}
