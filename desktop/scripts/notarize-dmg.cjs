/**
 * electron-builder artifactBuildCompleted hook: notarizes and staples each
 * signed Mac disk image, so the download itself checks out with Gatekeeper,
 * not just the app inside it. electron-builder notarizes only the app.
 *
 * Runs before the image is uploaded. The images are left out of
 * latest-mac.yml (dmg.writeUpdateInfo: false; updates use the zips), so
 * stapling, which changes the file, leaves no stale checksum behind.
 */
const { execFileSync } = require("node:child_process");

exports.default = async function notarizeDmg(event) {
  if (!event.file.endsWith(".dmg") || process.env.INLINE_MAC_NOTARIZE !== "1") return;
  const env = process.env;
  const credentials = env.APPLE_KEYCHAIN_PROFILE
    ? ["--keychain-profile", env.APPLE_KEYCHAIN_PROFILE, ...(env.APPLE_KEYCHAIN ? ["--keychain", env.APPLE_KEYCHAIN] : [])]
    : env.APPLE_API_KEY
      ? ["--key", env.APPLE_API_KEY, "--key-id", env.APPLE_API_KEY_ID, "--issuer", env.APPLE_API_ISSUER]
      : ["--apple-id", env.APPLE_ID, "--password", env.APPLE_APP_SPECIFIC_PASSWORD, "--team-id", env.APPLE_TEAM_ID];
  console.log(`  • notarizing disk image  file=${event.file}`);
  execFileSync("xcrun", ["notarytool", "submit", event.file, ...credentials, "--wait"], { stdio: ["ignore", "inherit", "inherit"] });
  execFileSync("xcrun", ["stapler", "staple", event.file], { stdio: ["ignore", "inherit", "inherit"] });
};
