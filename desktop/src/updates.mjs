import { app, dialog } from "electron";
import electronUpdater from "electron-updater";

/**
 * Updates from the project's GitHub Releases (electron-builder's `publish`
 * setting). New versions download in the background and install the next
 * time Inline quits, or right away if the user chooses to restart.
 */

const { autoUpdater } = electronUpdater;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

let manualCheck = false;
let ready = false;

export function startUpdates() {
  if (!app.isPackaged || process.env.INLINE_NO_UPDATES) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = null;

  autoUpdater.on("update-downloaded", async (info) => {
    ready = true;
    const { response } = await dialog.showMessageBox({
      type: "info",
      buttons: ["Restart Now", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Inline ${info.version} is ready to install`,
      detail: "Restart Inline to finish updating. Your documents are saved, and the update also installs the next time you quit.",
    });
    if (response === 0) autoUpdater.quitAndInstall();
  });
  autoUpdater.on("update-not-available", () => {
    if (!manualCheck) return;
    manualCheck = false;
    void dialog.showMessageBox({ type: "info", message: "Inline is up to date", detail: `You have the latest version, ${app.getVersion()}.` });
  });
  autoUpdater.on("error", (error) => {
    if (!manualCheck) return;
    manualCheck = false;
    void dialog.showMessageBox({ type: "warning", message: "Couldn't check for updates", detail: error?.message ?? String(error) });
  });

  const check = () => void autoUpdater.checkForUpdates().catch(() => undefined);
  setTimeout(check, 10_000);
  setInterval(check, CHECK_EVERY_MS);
}

export function checkForUpdatesNow() {
  if (!app.isPackaged) {
    void dialog.showMessageBox({ type: "info", message: "Updates are off in development", detail: "Packaged builds update themselves from GitHub Releases." });
    return;
  }
  if (ready) {
    autoUpdater.quitAndInstall();
    return;
  }
  manualCheck = true;
  void autoUpdater.checkForUpdates().catch(() => undefined);
}
