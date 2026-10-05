/**
 * Security headers for every response. Inline acts with the user's Claude
 * account, so its pages must not be framed by other sites (clickjacking),
 * and plugins, <base> hijacking and off-site form posts are ruled out.
 * Scripts stay same-origin; images may come from anywhere, since documents
 * can embed web images.
 */
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: ["default-src 'self'", "script-src 'self' 'unsafe-inline'" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""), "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "img-src 'self' data: blob: https: http:", "font-src 'self' data: https://fonts.gstatic.com", "connect-src 'self'", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join("; "),
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Agent SDK launches the Claude Code CLI that ships inside the package,
  // so it has to be loaded from node_modules rather than bundled.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
