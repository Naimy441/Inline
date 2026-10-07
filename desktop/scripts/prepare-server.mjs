#!/usr/bin/env node
/**
 * Builds Inline's server for the desktop app into desktop/.stage/server:
 * a standalone Next.js build (next.config.mjs, INLINE_STANDALONE=1) with its
 * static files, plus the Claude Code CLI for each platform being packaged.
 *
 *   node scripts/prepare-server.mjs [--skip-build] [--platform darwin] [--arch arm64,x64]
 *
 * The CLI ships with the Agent SDK as one optional npm package per platform,
 * and npm only installs the one for the machine it runs on, so the others are
 * fetched from the registry here. electron-builder copies the right one into
 * each build (scripts/after-pack.cjs).
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const root = path.resolve(desktop, "..");
const stage = path.join(desktop, ".stage");
const server = path.join(stage, "server");

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
};
const platform = option("platform", process.platform);
const arches = option("arch", process.arch).split(",");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, commandArgs, options = {}) {
  execFileSync(command, commandArgs, { stdio: "inherit", shell: process.platform === "win32", ...options });
}

if (!args.includes("--skip-build")) {
  console.log("Building Inline (standalone)…");
  run(npm, ["run", "build"], { cwd: root, env: { ...process.env, INLINE_STANDALONE: "1", NEXT_TELEMETRY_DISABLED: "1" } });
}

const standalone = path.join(root, ".next", "standalone");
if (!existsSync(path.join(standalone, "server.js"))) {
  console.error("No standalone build found. Run without --skip-build.");
  process.exit(1);
}

console.log("Staging the server…");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(standalone, server, { recursive: true, dereference: true });
cpSync(path.join(root, ".next", "static"), path.join(server, ".next", "static"), { recursive: true });
cpSync(path.join(root, "public"), path.join(server, "public"), { recursive: true });

// Never ship local data or secrets that happened to be in the project folder.
for (const name of [".inline", ".env", ".env.local", ".env.production", ".env.production.local"]) rmSync(path.join(server, name), { recursive: true, force: true });
// sharp is only for next/image, which Inline doesn't use, and is built for one platform.
for (const name of ["sharp", "@img"]) rmSync(path.join(server, "node_modules", name), { recursive: true, force: true });

// The utility process's entry: lets the app ask the server to save open documents and stop.
writeFileSync(
  path.join(server, "desktop-server.cjs"),
  `"use strict";
// Started by the desktop app (desktop/src/server.mjs) in an Electron utility process.
process.parentPort?.on("message", async (event) => {
  if (event?.data?.type !== "shutdown") return;
  try {
    await globalThis.__inlineHub?.flushAll();
  } finally {
    process.exit(0);
  }
});
require("./server.js");
`,
);

const sdkVersion = JSON.parse(readFileSync(path.join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")).version;
for (const arch of arches) {
  const name = `claude-agent-sdk-${platform}-${arch}`;
  const target = path.join(stage, "claude", `${platform}-${arch}`, name);
  const installed = path.join(root, "node_modules", "@anthropic-ai", name);
  mkdirSync(path.dirname(target), { recursive: true });
  if (existsSync(installed) && JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8")).version === sdkVersion) {
    console.log(`Claude Code CLI for ${platform}-${arch}: from node_modules`);
    cpSync(installed, target, { recursive: true });
    continue;
  }
  console.log(`Claude Code CLI for ${platform}-${arch}: downloading @anthropic-ai/${name}@${sdkVersion}…`);
  const download = path.join(stage, "download");
  mkdirSync(download, { recursive: true });
  const tarball = execFileSync(npm, ["pack", `@anthropic-ai/${name}@${sdkVersion}`, "--silent"], { cwd: download, shell: process.platform === "win32" }).toString().trim().split(/\r?\n/).pop();
  mkdirSync(target, { recursive: true });
  run("tar", ["-xzf", path.join(download, tarball), "-C", target, "--strip-components=1"]);
  rmSync(download, { recursive: true, force: true });
}

// Running the app unpackaged (npm start in desktop/) uses this machine's CLI straight from the staged server.
const host = path.join(stage, "claude", `${process.platform}-${process.arch}`);
if (existsSync(host)) cpSync(host, path.join(server, "node_modules", "@anthropic-ai"), { recursive: true });

console.log(`Server ready in ${path.relative(root, server)}`);
