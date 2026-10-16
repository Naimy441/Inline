import { spawn } from "node:child_process";

/**
 * Open one file in an app the user picks from the system, not from a list
 * this app keeps. macOS shows its choose-application dialog, Windows its
 * Open With dialog, and Linux the desktop's application chooser (every
 * installed app, plus a way to pick one that isn't listed).
 */

const LINUX_OPEN_WITH = `
import sys
path = sys.argv[1]
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, Gio
Gtk.init([])
target = Gio.File.new_for_path(path)
dialog = Gtk.AppChooserDialog.new(None, Gtk.DialogFlags.MODAL, target)
dialog.set_title("Open with")
chooser = dialog.get_widget()
chooser.set_show_all(True)
chooser.set_show_other(True)
response = dialog.run()
app = dialog.get_app_info() if response == Gtk.ResponseType.OK else None
dialog.destroy()
if app is None:
    raise SystemExit(0)
try:
    app.launch([target], None)
except Exception as error:
    sys.stderr.write(str(error))
    raise SystemExit(1)
`.trim();

/** The process that shows the system chooser and opens this one file. The path is an argument, never part of the script. */
export function openWithInvocation(filePath: string, platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (platform === "darwin") {
    return {
      command: "osascript",
      args: [
        "-e", "on run argv",
        "-e", "try",
        "-e", 'set chosen to POSIX path of (choose application with prompt "Open with:")',
        "-e", 'do shell script "open -a " & quoted form of chosen & " " & quoted form of (item 1 of argv)',
        "-e", "on error number -128",
        "-e", "end try",
        "-e", "end run",
        filePath,
      ],
    };
  }
  if (platform === "win32") return { command: "rundll32.exe", args: ["shell32.dll,OpenAs_RunDLL", filePath] };
  return { command: "python3", args: ["-c", LINUX_OPEN_WITH, filePath] };
}

/** Show the system open-with chooser for this file. Resolves once the chooser is up; cancelling it is not an error. */
export function openWithSystemChoice(filePath: string): Promise<void> {
  const { command, args } = openWithInvocation(filePath);
  return new Promise((resolve, reject) => {
    // Not a file the app reads: keep the build from tracing the project for it.
    const child = spawn(/* turbopackIgnore: true */ command, args, { detached: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr?.destroy();
      if (error) {
        reject(error);
        return;
      }
      child.unref();
      resolve();
    };
    // The chooser stays open until the user picks an app. If it dies at once, surface why.
    const timer = setTimeout(() => finish(), 800);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-500);
    });
    child.once("error", (error) => finish(new Error(`Couldn't open the app chooser (${command}): ${error.message}`)));
    child.once("exit", (code) => {
      if (code === 0 || code === null) finish();
      else finish(new Error(stderr.trim() || `Couldn't open the app chooser (${command}).`));
    });
  });
}
