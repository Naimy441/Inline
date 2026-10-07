import { app, BrowserWindow, Menu, shell } from "electron";

/**
 * The native menus. Inline's pages have their own menus and shortcuts
 * (bold, find, the Claude panel…), so the app's menus stick to what a page
 * can't do: windows, the browser, updates and the standard Edit and View
 * commands. Pages see a keystroke first; a menu shortcut only runs when the
 * page leaves it alone.
 */

const isMac = process.platform === "darwin";

export function installMenus(actions) {
  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { label: "Check for Updates…", click: actions.checkForUpdates },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          },
        ]
      : []),
    {
      label: "File",
      submenu: [
        { label: "New Document", accelerator: "CmdOrCtrl+N", click: actions.newDocument },
        { label: "New Window", accelerator: "CmdOrCtrl+Shift+N", click: actions.newWindow },
        { label: "All Documents", accelerator: "CmdOrCtrl+Shift+D", click: actions.home },
        { type: "separator" },
        { label: "Open in Browser", accelerator: "CmdOrCtrl+Shift+O", click: () => actions.openInBrowser() },
        { label: "Copy Browser Link", click: actions.copyLink },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "pasteAndMatchStyle" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Back", accelerator: "CmdOrCtrl+[", click: () => focusedContents()?.navigationHistory.goBack() },
        { label: "Forward", accelerator: "CmdOrCtrl+]", click: () => focusedContents()?.navigationHistory.goForward() },
        { role: "reload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        ...(app.isPackaged ? [] : [{ type: "separator" }, { role: "toggleDevTools" }]),
      ],
    },
    {
      role: "window",
      submenu: isMac ? [{ role: "minimize" }, { role: "zoom" }, { type: "separator" }, { role: "front" }] : [{ role: "minimize" }, { role: "close" }],
    },
    {
      role: "help",
      submenu: [
        { label: "Inline on GitHub", click: () => void shell.openExternal("https://github.com/Naimy441/Inline") },
        { label: "Show Data Folder", click: actions.showDataFolder },
        { label: "Show Server Log", click: actions.showLog },
        ...(isMac ? [] : [{ type: "separator" }, { label: "Check for Updates…", click: actions.checkForUpdates }, { role: "about" }]),
        { type: "separator" },
        { role: "toggleDevTools", label: "Developer Tools" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));

  if (isMac) {
    app.dock?.setMenu(
      Menu.buildFromTemplate([
        { label: "New Document", click: actions.newDocument },
        { label: "New Window", click: actions.newWindow },
        { label: "Open in Browser", click: () => actions.openInBrowser() },
      ]),
    );
  }
}

function focusedContents() {
  return BrowserWindow.getFocusedWindow()?.webContents ?? null;
}
