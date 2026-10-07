/**
 * Installers for Inline's desktop app. Run through scripts/dist.mjs, which
 * stages the server first and decides whether the Mac app is signed and
 * notarized (INLINE_MAC_NOTARIZE).
 *
 * @type {import("electron-builder").Configuration}
 */
module.exports = {
  appId: "com.naimy441.inline",
  productName: "Inline",
  copyright: "Copyright © Inline",
  directories: { output: "dist", buildResources: "resources" },
  files: ["src/**/*", "resources/icon.png", "package.json", "!**/*.map"],
  asar: true,

  // Inline's server and the Claude Code CLI are copied in by this hook rather
  // than extraResources, which leaves out node_modules folders.
  afterPack: "scripts/after-pack.cjs",

  protocols: [{ name: "Inline", schemes: ["inline"] }],

  publish: { provider: "github", owner: "Naimy441", repo: "Inline", releaseType: "draft" },

  mac: {
    category: "public.app-category.productivity",
    icon: "resources/icon.png",
    target: [
      { target: "dmg", arch: ["arm64", "x64"] },
      { target: "zip", arch: ["arm64", "x64"] },
    ],
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.mac.plist",
    entitlementsInherit: "resources/entitlements.mac.plist",
    notarize: process.env.INLINE_MAC_NOTARIZE === "1",
    // Without a certificate, sign ad hoc: Apple silicon Macs won't run code with no signature at all.
    ...(process.env.INLINE_MAC_ADHOC === "1" ? { identity: "-" } : {}),
    darkModeSupport: true,
    extendInfo: {
      NSDocumentsFolderUsageDescription: "Inline keeps a Word copy of every document in your Documents folder.",
    },
    artifactName: "Inline-${version}-mac-${arch}.${ext}",
  },

  dmg: {
    title: "Inline ${version}",
    window: { width: 540, height: 380 },
    contents: [
      { x: 140, y: 190 },
      { x: 400, y: 190, type: "link", path: "/Applications" },
    ],
  },

  win: {
    icon: "resources/icon.png",
    target: [{ target: "nsis", arch: ["x64"] }],
    artifactName: "Inline-${version}-windows-${arch}-setup.${ext}",
  },

  nsis: {
    oneClick: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
    shortcutName: "Inline",
  },

  linux: {
    icon: "resources/icon.png",
    executableName: "inline",
    syncDesktopName: true,
    category: "Office",
    synopsis: "A document editor with Claude built in",
    description: "Inline is a paginated document editor with Claude Code built in.",
    target: [
      { target: "AppImage", arch: ["x64"] },
      { target: "tar.gz", arch: ["x64"] },
    ],
    artifactName: "Inline-${version}-linux-${arch}.${ext}",
  },
};
