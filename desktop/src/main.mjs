import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from "electron";
import path from "node:path";
import { installMenus } from "./menu.mjs";
import { dataDir, logFile, serverRunning, startServer, stopServer } from "./server.mjs";
import { flushSettings } from "./settings.mjs";
import { checkForUpdatesNow, startUpdates } from "./updates.mjs";
import { appOrigin, applyChrome, createWindow, isAppUrl, setOrigin } from "./windows.mjs";

/**
 * Inline's desktop app: starts Inline's server on this computer, then shows
 * it in native windows. The same server answers at http://localhost:<port>,
 * so File › Open in Browser shows any page in the user's web browser too.
 *
 * Links: inline://open opens Inline, inline://d/<id> opens a document.
 */

const isMac = process.platform === "darwin";
const PROTOCOL = "inline";

app.setName("Inline");
if (process.env.INLINE_DESKTOP_USER_DATA) app.setPath("userData", process.env.INLINE_DESKTOP_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  let startup = null;
  let pendingPath = pathFromArgs(process.argv);
  let quitting = false;

  if (process.defaultApp) {
    if (process.argv[1]) app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  app.setAboutPanelOptions({
    applicationName: "Inline",
    applicationVersion: app.getVersion(),
    copyright: "A document editor with Claude built in.",
    website: "https://github.com/Naimy441/Inline",
  });

  // A second launch (or an inline:// link) lands here instead of starting another copy.
  app.on("second-instance", (_event, argv) => {
    const target = pathFromArgs(argv);
    if (target) return openPath(target);
    focusOrOpen();
  });

  app.on("open-url", (event, url) => {
    event.preventDefault();
    const target = pathFromUrl(url);
    if (!target) return;
    // Before the app is ready the link becomes the first window's page; after that it waits for the server if it has to.
    if (startup) openPath(target);
    else pendingPath = target;
  });

  app.whenReady().then(async () => {
    installMenus({
      newDocument,
      newWindow: () => whenStarted(() => createWindow("/")),
      home: () => whenStarted(() => navigateFocused("/")),
      openInBrowser,
      copyLink: () => clipboard.writeText(browserUrl()),
      showDataFolder: () => void shell.openPath(dataDir()),
      showLog: () => shell.showItemInFolder(logFile()),
      checkForUpdates: checkForUpdatesNow,
    });

    ipcMain.on("inline:open-in-browser", (event, pathname) => openInBrowser(pathname ?? undefined, event.sender.getURL()));
    ipcMain.on("inline:chrome", (event, chrome) => {
      const window = BrowserWindow.fromWebContents(event.sender);
      if (window) applyChrome(window, chrome);
    });

    startup = start(pendingPath ?? "/");
    pendingPath = null;
    startUpdates();
  });

  // macOS: Inline stays running with no windows open (so browser tabs keep working), like other Mac apps.
  app.on("window-all-closed", () => {
    if (!isMac) app.quit();
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) focusOrOpen();
  });

  app.on("before-quit", async (event) => {
    flushSettings();
    if (quitting || !serverRunning()) return;
    event.preventDefault();
    quitting = true;
    await stopServer();
    app.quit();
  });

  async function start(initialPath) {
    const window = createWindow("/", { loadingPage: "starting" });
    try {
      const origin = await startServer({ onExit: serverStopped });
      setOrigin(origin);
      await window.loadURL(new URL(initialPath, origin).toString());
    } catch (error) {
      showFailure(window, error);
    }
  }

  function serverStopped(code) {
    if (quitting) return;
    setOrigin(null);
    const windows = BrowserWindow.getAllWindows();
    windows.slice(1).forEach((window) => window.close());
    const window = windows[0] ?? createWindow("/", { loadingPage: "failed" });
    showFailure(window, new Error(`The server stopped unexpectedly (exit code ${code}).`));
  }

  function showFailure(window, error) {
    if (window.isDestroyed()) return;
    const detail = error instanceof Error ? error.message : String(error);
    void window.loadFile(path.join(import.meta.dirname, "loading.html"), { query: { state: "failed", detail, theme: "light" } });
    const onHash = (_event, url) => {
      const hash = new URL(url).hash;
      if (hash === "#log") shell.showItemInFolder(logFile());
      if (hash === "#retry") {
        window.webContents.off("did-navigate-in-page", onHash);
        // Open the new window before closing this one, so Windows and Linux don't take the last window closing as quitting.
        startup = start("/");
        window.close();
      }
    };
    window.webContents.on("did-navigate-in-page", onHash);
  }

  function whenStarted(action) {
    if (appOrigin()) return action();
    void startup?.then(() => appOrigin() && action());
  }

  function focusOrOpen() {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
      return;
    }
    whenStarted(() => createWindow("/"));
  }

  function openPath(pathname) {
    whenStarted(() => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      if (!window) return createWindow(pathname);
      if (window.isMinimized()) window.restore();
      window.focus();
      void window.loadURL(new URL(pathname, appOrigin()).toString());
    });
  }

  function navigateFocused(pathname) {
    const window = BrowserWindow.getFocusedWindow();
    if (window) void window.loadURL(new URL(pathname, appOrigin()).toString());
    else createWindow(pathname);
  }

  async function newDocument() {
    whenStarted(async () => {
      try {
        // Talk to the server directly: requests from the app itself carry no browser Origin.
        const response = await fetch(new URL("/api/documents", appOrigin()), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `Request failed (${response.status}).`);
        const { document } = await response.json();
        const pathname = `/d/${document.meta.id}`;
        const window = BrowserWindow.getFocusedWindow();
        if (window && isAppUrl(window.webContents.getURL())) void window.loadURL(new URL(pathname, appOrigin()).toString());
        else createWindow(pathname);
      } catch (error) {
        dialog.showErrorBox("Couldn't create a document", error instanceof Error ? error.message : String(error));
      }
    });
  }

  /** The browser address of the page in front, or of `pathname`. */
  function browserUrl(pathname, pageUrl) {
    const origin = appOrigin();
    if (!origin) return "";
    const current = pageUrl ?? BrowserWindow.getFocusedWindow()?.webContents.getURL() ?? "";
    if (pathname) return new URL(pathname, origin).toString();
    if (isAppUrl(current)) {
      const url = new URL(current);
      return new URL(url.pathname + url.search + url.hash, origin).toString();
    }
    return `${origin}/`;
  }

  function openInBrowser(pathname, pageUrl) {
    whenStarted(() => void shell.openExternal(browserUrl(pathname, pageUrl)));
  }
}

/** The Inline page an inline:// link points to: inline://d/<id> is a document, anything else the home page. */
function pathFromUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== `${PROTOCOL}:`) return null;
    const parts = `${parsed.host}${parsed.pathname}`.split("/").filter(Boolean);
    if (parts[0] === "d" && /^[\w-]{1,80}$/.test(parts[1] ?? "")) return `/d/${parts[1]}`;
    return "/";
  } catch {
    return null;
  }
}

function pathFromArgs(argv) {
  const link = argv.find((arg) => arg.startsWith(`${PROTOCOL}://`));
  return link ? pathFromUrl(link) : null;
}
