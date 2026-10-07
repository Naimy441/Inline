/**
 * electron-builder afterPack hook: copies Inline's server (staged by
 * prepare-server.mjs) into the app's resources, with the Claude Code CLI
 * for the platform and architecture being built. Runs before macOS signing,
 * so the CLI is signed along with the app.
 */
const { cpSync, existsSync, rmSync } = require("node:fs");
const path = require("node:path");
const { Arch } = require("builder-util");

exports.default = async function afterPack(context) {
  const stage = path.join(__dirname, "..", ".stage");
  const platform = context.electronPlatformName;
  const arch = Arch[context.arch];
  const resources =
    platform === "darwin"
      ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Resources")
      : path.join(context.appOutDir, "resources");
  const server = path.join(resources, "server");
  const cli = path.join(stage, "claude", `${platform}-${arch}`);
  if (!existsSync(cli)) throw new Error(`No Claude Code CLI staged for ${platform}-${arch}. Run scripts/prepare-server.mjs --platform ${platform} --arch ${arch}.`);

  rmSync(server, { recursive: true, force: true });
  cpSync(path.join(stage, "server"), server, {
    recursive: true,
    // The staged server carries this machine's CLI for unpackaged runs; the one for the target goes in below.
    filter: (source) => !/[\\/]node_modules[\\/]@anthropic-ai[\\/]claude-agent-sdk-[^\\/]+-[^\\/]+/.test(source),
  });
  cpSync(cli, path.join(server, "node_modules", "@anthropic-ai"), { recursive: true });
};
