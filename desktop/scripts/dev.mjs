#!/usr/bin/env node
/**
 * The desktop app against `next dev`, with hot reload: starts Inline's dev
 * server from the project folder, waits for it, then opens Electron on it.
 * Quitting the app stops both.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "..");
const port = process.env.INLINE_DEV_PORT || "4320";
const url = `http://localhost:${port}`;
// Started directly rather than through npx, so stopping them stops the real processes.
const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
const electronBin = createRequire(import.meta.url)("electron");

const next = spawn(process.execPath, [nextBin, "dev", "-p", port], { cwd: root, stdio: "inherit" });

async function waitForServer() {
  for (let attempt = 0; attempt < 240; attempt++) {
    try {
      const response = await fetch(`${url}/icon.svg`);
      if (response.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`next dev didn't start on ${url}`);
}

await waitForServer();
const electron = spawn(electronBin, [".", ...process.argv.slice(2)], {
  cwd: desktop,
  stdio: "inherit",
  env: { ...process.env, INLINE_DEV_URL: url },
});

const stop = () => {
  next.kill();
  electron.kill();
};
electron.on("exit", (code) => {
  next.kill();
  process.exit(code ?? 0);
});
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
