import { app, utilityProcess } from "electron";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { settings, updateSettings } from "./settings.mjs";

/**
 * Inline's server, run inside the app. It is the same Next.js server as
 * `npm start`, built standalone (desktop/scripts/prepare-server.mjs) and
 * started in an Electron utility process. It listens on this computer only,
 * on a fixed port where possible, so http://localhost:<port> keeps working
 * as a bookmark in any browser while the app is open.
 */

const DEFAULT_PORT = 4319;
const HOST = "127.0.0.1";

let child = null;
let stopping = false;
let onExitHandler = () => {};

export const dataDir = () => path.join(app.getPath("userData"), "data");
export const logFile = () => path.join(dataDir(), "logs", "desktop-server.log");

function serverDir() {
  return app.isPackaged ? path.join(process.resourcesPath, "server") : path.join(import.meta.dirname, "..", ".stage", "server");
}

function portFree(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(false));
    probe.listen({ port, host: HOST, exclusive: true }, () => probe.close(() => resolve(true)));
  });
}

function anyPort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen({ port: 0, host: HOST }, () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

async function choosePort() {
  const preferred = Number(process.env.INLINE_DESKTOP_PORT) || settings().port || DEFAULT_PORT;
  if (await portFree(preferred)) return preferred;
  const port = await anyPort();
  updateSettings({ port });
  return port;
}

async function waitUntilUp(origin, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!child) throw new Error("Inline's server stopped while starting.");
    try {
      const response = await fetch(`${origin}/icon.svg`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Inline's server didn't start in time.");
}

/** Start the server; resolves with its origin once it answers. */
export async function startServer({ onExit }) {
  onExitHandler = onExit;
  if (process.env.INLINE_DEV_URL) return process.env.INLINE_DEV_URL.replace(/\/$/, "");

  const dir = serverDir();
  const entry = path.join(dir, "desktop-server.cjs");
  if (!existsSync(entry)) throw new Error(`Inline's server is missing (${entry}). Run "npm run prepare-server" in desktop/.`);

  const port = await choosePort();
  mkdirSync(path.dirname(logFile()), { recursive: true });
  const log = createWriteStream(logFile(), { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} Inline ${app.getVersion()} on port ${port}\n`);

  stopping = false;
  child = utilityProcess.fork(entry, [], {
    cwd: dir,
    serviceName: "Inline Server",
    stdio: "pipe",
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: HOST,
      INLINE_DATA_DIR: process.env.INLINE_DATA_DIR || dataDir(),
      INLINE_DESKTOP: "1",
      NEXT_TELEMETRY_DISABLED: "1",
    },
  });
  child.stdout?.pipe(log, { end: false });
  child.stderr?.pipe(log, { end: false });
  const current = child;
  current.once("exit", (code) => {
    if (child === current) child = null;
    log.write(`--- server exited with code ${code}\n`);
    if (!stopping) onExitHandler(code);
  });

  // The window shows "localhost", which every browser maps to this computer, so the address in the app and in a browser match.
  const origin = `http://localhost:${port}`;
  await waitUntilUp(`http://${HOST}:${port}`, 60_000);
  return origin;
}

/** Stop the server, letting it save open documents first. */
export function stopServer() {
  const current = child;
  if (!current) return Promise.resolve();
  stopping = true;
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(force);
      resolve();
    };
    const force = setTimeout(() => {
      current.kill();
      resolve();
    }, 5000);
    current.once("exit", done);
    current.postMessage({ type: "shutdown" });
  });
}

export function serverRunning() {
  return Boolean(child) || Boolean(process.env.INLINE_DEV_URL);
}
