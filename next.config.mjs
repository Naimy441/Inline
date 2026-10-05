/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Agent SDK launches the Claude Code CLI that ships inside the package,
  // so it has to be loaded from node_modules rather than bundled.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
};

export default nextConfig;
