/**
 * Bridge between Inline's pages and the desktop app. Pages get
 * `window.inlineDesktop` (see lib/client/desktop.ts); the app learns the
 * page's theme and header height so the window's own chrome (background,
 * native controls) matches what the page draws.
 */
const { contextBridge, ipcRenderer } = require("electron");

const platform = process.platform;
const version = (process.argv.find((arg) => arg.startsWith("--inline-version=")) || "").slice("--inline-version=".length);

contextBridge.exposeInMainWorld("inlineDesktop", {
  platform,
  version,
  openInBrowser: (path) => ipcRenderer.send("inline:open-in-browser", typeof path === "string" ? path : null),
});

ipcRenderer.on("inline:fullscreen", (_event, fullscreen) => {
  if (fullscreen) document.documentElement.dataset.fullscreen = "";
  else delete document.documentElement.dataset.fullscreen;
});

function chrome() {
  const root = document.documentElement;
  const header = document.querySelector(".titlebar, .home-header");
  const height = header ? Math.round(header.getBoundingClientRect().height) : 0;
  const background = getComputedStyle(document.body || root).backgroundColor;
  return { dark: root.dataset.theme === "dark", height, background };
}

let last = "";
function report() {
  if (!document.body) return;
  const next = chrome();
  const key = JSON.stringify(next);
  if (key === last) return;
  last = key;
  ipcRenderer.send("inline:chrome", next);
}

let scheduled = false;
function schedule() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    report();
  });
}

// Moving between pages swaps the header; the new page renders a moment after the address changes.
ipcRenderer.on("inline:navigated", () => {
  schedule();
  setTimeout(schedule, 250);
  setTimeout(schedule, 1000);
});

window.addEventListener("DOMContentLoaded", () => {
  report();
  setTimeout(schedule, 500);
  // The theme toggle flips data-theme on <html>.
  new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  window.addEventListener("resize", schedule);
});
