import { app } from "electron";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * The desktop app's own small settings (window size and place, port, last
 * theme), kept as JSON next to Electron's other per-user data. Inline's
 * documents and preferences live in the server's data folder, not here.
 */

const file = () => path.join(app.getPath("userData"), "desktop.json");

let cache = null;
let timer = null;

export function settings() {
  if (cache) return cache;
  try {
    cache = JSON.parse(readFileSync(file(), "utf8"));
  } catch {
    cache = {};
  }
  return cache;
}

export function updateSettings(patch) {
  cache = { ...settings(), ...patch };
  clearTimeout(timer);
  timer = setTimeout(flushSettings, 400);
}

export function flushSettings() {
  clearTimeout(timer);
  if (!cache) return;
  try {
    mkdirSync(path.dirname(file()), { recursive: true });
    const temp = `${file()}.tmp`;
    writeFileSync(temp, JSON.stringify(cache, null, 2));
    renameSync(temp, file());
  } catch {
    // settings are a convenience; never fail over them
  }
}
