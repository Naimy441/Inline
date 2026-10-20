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
    value: ["default-src 'self'", "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'" + (process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""), "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com", "img-src 'self' data: blob: https: http:", "font-src 'self' data: https://fonts.gstatic.com", "connect-src 'self' https://fonts.googleapis.com", "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'"].join("; "),
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The desktop app (desktop/) ships a self-contained server. `next dev`,
  // `next build` and `next start` are unaffected unless this is set.
  ...(process.env.INLINE_STANDALONE === "1" ? { output: "standalone" } : {}),
  // The Agent SDK launches the Claude Code CLI that ships inside the package,
  // so it has to be loaded from node_modules rather than bundled. nspell is
  // loaded the same way; its word list is lib/server/hunspell, read from disk.
  serverExternalPackages: ["@anthropic-ai/claude-agent-sdk", "nspell", "pdfjs-dist", "playwright", "playwright-core"],
  // Files read from node_modules at run time, kept in the desktop app's server:
  // pdf.js's data for importing PDFs, and the Computer Modern faces (KaTeX's)
  // that documents typeset in TeX are shown in.
  outputFileTracingIncludes: {
    "/api/pdfjs/\\[\\.\\.\\.path\\]": ["./node_modules/pdfjs-dist/cmaps/**", "./node_modules/pdfjs-dist/standard_fonts/**", "./node_modules/pdfjs-dist/wasm/**", "./node_modules/pdfjs-dist/iccs/**"],
    "/api/documents/import/pdf": ["./node_modules/katex/dist/fonts/KaTeX_Main-*.ttf"],
    // The page-layout skill is a directory the agent passes to Claude Code, not an import.
    "/api/agent/**": ["./node_modules/@openai/codex/package.json", "./node_modules/pdfjs-dist/legacy/build/**", "./node_modules/@napi-rs/canvas/*", "./lib/agent/skills/page-layout/**/*", "./lib/server/hunspell/**"],
    "/api/mcp/**": ["./lib/server/hunspell/**"],
    "/api/spellcheck": ["./lib/server/hunspell/**"],
  },
  // The agent routes' traces take in the whole project folder, which would put
  // the desktop app's own builds (desktop/dist) and the tests inside its server.
  outputFileTracingExcludes: {
    "/*": ["./desktop/**", "./e2e/**", "./tests/**", "./test-results/**", "./playwright-report/**"],
  },
  experimental: {
    // proxy.ts runs on every request, and Next.js silently truncates bodies
    // past this size when a proxy is present. Imports take ZIP archives (a
    // Google Takeout export) of up to 1 GB.
    proxyClientMaxBodySize: "1gb",
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      {
        // A file from a document folder is not an app page. The general policy
        // allows inline script, which an SVG opened from that folder must not get.
        source: "/api/documents/:id/files/:path*",
        headers: [
          { key: "Content-Security-Policy", value: "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" },
          { key: "X-Content-Type-Options", value: "nosniff" },
        ],
      },
    ];
  },
};

export default nextConfig;
