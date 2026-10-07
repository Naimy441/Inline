#!/usr/bin/env node
/**
 * Packages the desktop app for this platform (or `--mac`, `--win`, `--linux`).
 *
 *   npm run dist                  installers for this computer's platform
 *   npm run dist -- --publish     …and upload them to the draft GitHub release for this version
 *                                 (uses GH_TOKEN, or the GitHub CLI's login)
 *   npm run dist -- --dir         an unpacked app only, quicker for trying it out
 *
 * macOS builds are signed with the Developer ID certificate in this Mac's
 * keychain and notarized when APPLE_KEYCHAIN_PROFILE is set (see
 * desktop/README.md); otherwise they are left unsigned, and can't be
 * published. Windows builds are unsigned.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

const desktop = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const platform = args.includes("--mac") ? "darwin" : args.includes("--win") ? "win32" : args.includes("--linux") ? "linux" : process.platform;
const arches = platform === "darwin" ? ["arm64", "x64"] : ["x64"];

const run = (command, commandArgs, env = process.env) => execFileSync(command, commandArgs, { cwd: desktop, stdio: "inherit", env, shell: process.platform === "win32" });

const env = { ...process.env };
if (args.includes("--publish") && !env.GH_TOKEN) {
  try {
    env.GH_TOKEN = execFileSync("gh", ["auth", "token"], { encoding: "utf8" }).trim();
  } catch {
    throw new Error("Publishing needs GH_TOKEN, or the GitHub CLI signed in (gh auth login).");
  }
}
const builderArgs = ["--config", "electron-builder.config.cjs", { darwin: "--mac", win32: "--win", linux: "--linux" }[platform]];
if (args.includes("--dir")) builderArgs.push("--dir");
builderArgs.push("--publish", args.includes("--publish") ? "always" : "never");

if (platform === "darwin") {
  // A Developer ID certificate in this Mac's keychain is found and used without any settings.
  const hasDeveloperId = process.platform === "darwin" && execFileSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" }).includes("Developer ID Application");
  const canSign = Boolean(env.CSC_LINK || env.CSC_NAME) || env.CSC_IDENTITY_AUTO_DISCOVERY === "true" || hasDeveloperId;
  const canNotarize = Boolean((env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) || (env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER) || env.APPLE_KEYCHAIN_PROFILE);
  if (!canSign) {
    console.log("No Developer ID certificate found: building an unsigned (ad-hoc signed) Mac app.");
    env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    env.INLINE_MAC_ADHOC = "1";
  }
  env.INLINE_MAC_NOTARIZE = canSign && canNotarize ? "1" : "0";
  if (args.includes("--publish") && !(canSign && canNotarize)) throw new Error("Only signed, notarized Mac builds can be published. See desktop/README.md › macOS signing and notarization.");
  if (canSign && !canNotarize) console.log("Signing without notarizing: set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID (or APPLE_KEYCHAIN_PROFILE) to notarize.");
}
if (platform === "win32") env.CSC_IDENTITY_AUTO_DISCOVERY = "false";

run(process.execPath, ["scripts/prepare-server.mjs", "--platform", platform, "--arch", arches.join(","), ...(args.includes("--skip-build") ? ["--skip-build"] : [])]);

const builder = path.join(desktop, "node_modules", ".bin", process.platform === "win32" ? "electron-builder.cmd" : "electron-builder");
run(builder, builderArgs, env);
