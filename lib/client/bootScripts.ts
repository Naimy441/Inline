/**
 * Inline scripts for <head> that run before first paint. They live in a
 * plain module, not a "use client" one: the root layout is a server
 * component, and a string exported from a client module reaches it as a
 * client reference rather than as the string.
 */

export const THEME_KEY = "inline-theme";

/** Applies the saved theme. */
export const themeBootScript = `try{var t=localStorage.getItem('${THEME_KEY}');if(t==='dark'||(t!=='light'&&matchMedia('(prefers-color-scheme: dark)').matches))document.documentElement.dataset.theme='dark'}catch(e){}`;

/** Marks the page as running in the desktop app (desktop/, see lib/client/desktop.ts), so its CSS can make room for the window controls. */
export const desktopBootScript = `try{var d=window.inlineDesktop;if(d)document.documentElement.dataset.desktop=d.platform}catch(e){}`;
