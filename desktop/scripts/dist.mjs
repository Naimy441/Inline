#!/usr/bin/env node
/**
 * Packages the desktop app for this platform (or `--mac`, `--win`, `--linux`).
 *
 *   npm run dist                  installers for this computer's platform
 *   npm run dist -- --publish     …and upload them to a draft GitHub release (needs GH_TOKEN)
 *   npm run dist -- --dir         an unpacked app only, quicker for trying it out
 *
 * macOS builds are signed and notarized when signing credentials are set
 * (see desktop/README.md); otherwise they are left unsigned. Windows builds
 * are unsigned.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const platform = args.includes("--mac") ? "darwin" : args.includes("--win") ? "win32" : args.includes("--linux") ? "linux" : process.platform;
const arches = platform === "darwin" ? ["arm64", "x64"] : ["x64"];

const run = (command, commandArgs, env = process.env) => execFileSync(command, commandArgs, { cwd: desktop, stdio: "inherit", env, shell: process.platform === "win32" });

run(process.execPath, ["scripts/prepare-server.mjs", "--platform", platform, "--arch", arches.join(","), ...(args.includes("--skip-build") ? ["--skip-build"] : [])]);

const env = { ...process.env };
const builderArgs = ["--config", "electron-builder.config.cjs", { darwin: "--mac", win32: "--win", linux: "--linux" }[platform]];
if (args.includes("--dir")) builderArgs.push("--dir");
builderArgs.push("--publish", args.includes("--publish") ? "always" : "never");

if (platform === "darwin") {
  const canSign = Boolean(env.CSC_LINK || env.CSC_NAME) || env.CSC_IDENTITY_AUTO_DISCOVERY === "true";
  const canNotarize = Boolean((env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) || (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER));
  if (!canSign) {
    console.log("No signing certificate set (CSC_LINK): building an unsigned (ad-hoc signed) Mac app.");
    env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    env.INLINE_MAC_ADHOC = "1";
  }
  env.INLINE_MAC_NOTARIZE = canSign && canNotarize ? "1" : "0";
  if (canSign && !canNotarize) console.log("Signing without notarizing: set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID to notarize.");
}
if (platform === "win32") env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

const builder = path.join(desktop, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");
run(builder, builderArgs, env);
