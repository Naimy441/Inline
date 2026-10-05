import { NextResponse, type NextRequest } from "next/server";

/**
 * Request guard for the API. Inline drives a Claude Code session with the
 * user's own credentials, so its API must only answer the user's own
 * browser and MCP clients:
 *
 * - Host allow-list: blocks DNS-rebinding attacks from other websites.
 *   Local hostnames are always allowed; add others with INLINE_ALLOWED_HOSTS
 *   (comma separated) when serving Inline on a network.
 * - Origin check on state-changing requests: blocks cross-site request forgery.
 * - Optional shared secret (INLINE_ACCESS_TOKEN): required as a Bearer token
 *   or `inline_token` cookie when set; visiting any page with ?token=<secret>
 *   stores the cookie.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

function hostname(host: string) {
  if (host.startsWith("[")) return host.slice(0, host.indexOf("]") + 1);
  return host.split(":")[0]!.toLowerCase();
}

function allowedHosts() {
  return (process.env.INLINE_ALLOWED_HOSTS ?? "")
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function hostAllowed(host: string | null) {
  if (!host) return false;
  const name = hostname(host);
  if (LOCAL_HOSTS.has(name) || name.endsWith(".localhost")) return true;
  const extra = allowedHosts();
  return extra.includes("*") || extra.includes(name) || extra.includes(host.toLowerCase());
}

function deny(status: number, error: string) {
  return NextResponse.json({ error }, { status });
}

export function proxy(request: NextRequest) {
  const host = request.headers.get("host");
  if (!hostAllowed(host)) return deny(403, "Host not allowed. Set INLINE_ALLOWED_HOSTS to serve Inline on this address.");

  const token = process.env.INLINE_ACCESS_TOKEN;
  const isApi = request.nextUrl.pathname.startsWith("/api/");

  if (token) {
    const queryToken = request.nextUrl.searchParams.get("token");
    if (!isApi && queryToken === token) {
      const url = request.nextUrl.clone();
      url.searchParams.delete("token");
      const response = NextResponse.redirect(url);
      response.cookies.set("inline_token", token, { httpOnly: true, sameSite: "strict", path: "/" });
      return response;
    }
    const bearer = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
    const cookie = request.cookies.get("inline_token")?.value;
    if (bearer !== token && cookie !== token) {
      return isApi ? deny(401, "Missing or invalid Inline access token.") : new NextResponse("Open Inline with ?token=<INLINE_ACCESS_TOKEN>.", { status: 401 });
    }
  }

  if (isApi && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    const origin = request.headers.get("origin");
    // Browsers always send Origin on cross-site writes; MCP clients and scripts send none.
    if (origin) {
      let originHost: string | null = null;
      try {
        originHost = new URL(origin).host;
      } catch {
        originHost = null;
      }
      if (!originHost || originHost.toLowerCase() !== host!.toLowerCase()) return deny(403, "Cross-origin requests are not allowed.");
    }
    if (request.headers.get("sec-fetch-site") === "cross-site") return deny(403, "Cross-site requests are not allowed.");
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
