import { app, BrowserWindow, clipboard, Menu, nativeTheme, screen, shell } from "electron";
import path from "node:path";
import { settings, updateSettings } from "./settings.mjs";

/**
 * Inline's windows. Each one shows a page of Inline's server. The page's own
 * header is the title bar: on macOS the traffic lights sit inside it, and on
 * Windows the minimise / maximise / close buttons are drawn over its right
 * end (Window Controls Overlay). Linux keeps the system's own frame.
 */

const isMac = process.platform === "darwin";
const isWindows = process.platform === "win32";

const LIGHT = "#f6f5f2";
const DARK = "#1b1b1a";
const MIN_WIDTH = 720;
const MIN_HEIGHT = 480;

let origin = null;

export function setOrigin(value) {
  origin = value;
}

export function appOrigin() {
  return origin;
}

/** Whether a URL is one of Inline's own pages. */
export function isAppUrl(url) {
  if (!origin) return false;
  try {
    const target = new URL(url);
    const own = new URL(origin);
    const local = (host) => host === "localhost" || host === "127.0.0.1";
    return target.protocol === own.protocol && target.port === own.port && local(target.hostname);
  } catch {
    return false;
  }
}

function prefersDark() {
  const theme = settings().theme;
  return theme ? theme === "dark" : nativeTheme.shouldUseDarkColors;
}

/** The size and place for a new window: the last one used, if it is still on a screen; else a comfortable default, offset from the window in front. */
function initialBounds() {
  const saved = settings().window;
  const work = screen.getPrimaryDisplay().workArea;
  const fallback = { width: Math.min(1360, Math.round(work.width * 0.86)), height: Math.min(900, Math.round(work.height * 0.9)) };
  const focused = BrowserWindow.getFocusedWindow();
  if (focused && !focused.isFullScreen()) {
    const [x, y] = focused.getPosition();
    const [width, height] = focused.getSize();
    return { x: x + 26, y: y + 26, width, height };
  }
  if (saved?.width && saved?.height) {
    const visible = screen.getAllDisplays().some(({ workArea: area }) => saved.x < area.x + area.width - 80 && saved.x + saved.width > area.x + 80 && saved.y >= area.y - 10 && saved.y < area.y + area.height - 80);
    if (visible) return { x: saved.x, y: saved.y, width: saved.width, height: saved.height };
    return { width: saved.width, height: saved.height };
  }
  return fallback;
}

function rememberBounds(window) {
  if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
  const maximized = window.isMaximized();
  const bounds = maximized ? settings().window ?? window.getNormalBounds() : window.getBounds();
  updateSettings({ window: { ...bounds, maximized } });
}

function chromeOptions(dark) {
  if (isMac) return { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 15 } };
  if (isWindows) return { titleBarStyle: "hidden", titleBarOverlay: { color: "#00000000", symbolColor: dark ? "#e8e6e3" : "#3b3a37", height: 44 } };
  return { autoHideMenuBar: true };
}

/** Open a window on `pathname` (a path on Inline's server, or a loading page before the server is up). */
export function createWindow(pathname = "/", { loadingPage } = {}) {
  const dark = prefersDark();
  const saved = settings().window;
  const window = new BrowserWindow({
    ...initialBounds(),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    title: "Inline",
    backgroundColor: dark ? DARK : LIGHT,
    ...chromeOptions(dark),
    ...(process.platform === "linux" ? { icon: path.join(import.meta.dirname, "..", "resources", "icon.png") } : {}),
    webPreferences: {
      preload: path.join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Inline checks spelling itself, with its own dictionary and suggestions.
      spellcheck: false,
      additionalArguments: [`--inline-version=${app.getVersion()}`],
    },
  });

  if (saved?.maximized && BrowserWindow.getAllWindows().length === 1) window.maximize();
  window.once("ready-to-show", () => window.show());

  let saveTimer = null;
  const save = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => rememberBounds(window), 300);
  };
  window.on("resize", save);
  window.on("move", save);
  window.on("close", () => rememberBounds(window));

  window.on("enter-full-screen", () => window.webContents.send("inline:fullscreen", true));
  window.on("leave-full-screen", () => window.webContents.send("inline:fullscreen", false));

  wireContents(window);

  if (loadingPage) void window.loadFile(path.join(import.meta.dirname, "loading.html"), { query: { theme: dark ? "dark" : "light", state: loadingPage } });
  else void window.loadURL(new URL(pathname, origin).toString());
  return window;
}

function wireContents(window) {
  const contents = window.webContents;

  // Pinch-to-zoom scales the whole window in Chromium; Inline zooms pages itself.
  void contents.setVisualZoomLevelLimits(1, 1);

  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url)) {
      createWindow(new URL(url).pathname + new URL(url).search + new URL(url).hash);
      return { action: "deny" };
    }
    openExternal(url);
    return { action: "deny" };
  });

  contents.on("will-navigate", (event, url) => {
    if (isAppUrl(url) || url.startsWith("file:")) {
      // Dropping a file on the window would otherwise open it in place of Inline.
      if (url.startsWith("file:") && !url.includes("loading.html")) event.preventDefault();
      return;
    }
    event.preventDefault();
    openExternal(url);
  });

  contents.on("did-navigate-in-page", () => contents.send("inline:navigated"));
  contents.on("did-navigate", () => contents.send("inline:navigated"));

  contents.on("context-menu", (_event, params) => {
    const menu = contextMenu(params, contents);
    if (menu) menu.popup({ window });
  });

  watchDownloads(contents.session);
}

const watchedSessions = new WeakSet();

/** Downloads use the system save dialog; on macOS a finished one also bounces the Downloads stack in the Dock. */
function watchDownloads(session) {
  if (!isMac || watchedSessions.has(session)) return;
  watchedSessions.add(session);
  session.on("will-download", (_event, item) => {
    item.once("done", (_doneEvent, state) => {
      if (state === "completed") app.dock?.downloadFinished(item.getSavePath());
    });
  });
}

/** A native menu for the right-clicks Inline's pages leave alone: text fields, plain text and links. */
function contextMenu(params, contents) {
  const items = [];
  if (params.linkURL && !isAppUrl(params.linkURL)) {
    items.push({ label: "Open Link in Browser", click: () => openExternal(params.linkURL) });
    items.push({ label: "Copy Link", click: () => clipboard.writeText(params.linkURL) });
  }
  if (params.isEditable) {
    if (items.length) items.push({ type: "separator" });
    items.push({ role: "cut", enabled: params.editFlags.canCut }, { role: "copy", enabled: params.editFlags.canCopy }, { role: "paste", enabled: params.editFlags.canPaste }, { type: "separator" }, { role: "selectAll" });
  } else if (params.selectionText.trim()) {
    if (items.length) items.push({ type: "separator" });
    items.push({ role: "copy" });
  }
  if (!app.isPackaged) {
    items.push({ type: "separator" }, { label: "Inspect Element", click: () => contents.inspectElement(params.x, params.y) });
  }
  return items.length ? Menu.buildFromTemplate(items) : null;
}

export function openExternal(url) {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

/** Bring the window's own chrome in line with the page: its background, the theme of native menus and dialogs, the controls' place and colour. */
export function applyChrome(window, { dark, height, background }) {
  if (window.isDestroyed()) return;
  if (typeof dark === "boolean") {
    updateSettings({ theme: dark ? "dark" : "light" });
    nativeTheme.themeSource = dark ? "dark" : "light";
  }
  if (typeof background === "string" && /^rgb/.test(background)) window.setBackgroundColor(rgbToHex(background));
  const header = Number(height) > 0 ? Math.round(height) : 44;
  if (isMac) window.setWindowButtonPosition?.({ x: 16, y: Math.max(6, Math.round((header - 16) / 2)) });
  if (isWindows) window.setTitleBarOverlay?.({ color: "#00000000", symbolColor: dark ? "#e8e6e3" : "#3b3a37", height: header });
}

function rgbToHex(value) {
  const [r = 0, g = 0, b = 0] = value.match(/[\d.]+/g)?.map(Number) ?? [];
  return `#${[r, g, b].map((part) => Math.round(part).toString(16).padStart(2, "0")).join("")}`;
}
