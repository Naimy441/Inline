/**
 * The address this process is serving, so a headless browser can open a page
 * of it. Recorded from API requests (the proxy does not share memory with
 * route handlers). Only loopback hosts are kept: a public host may not be
 * reachable from the server itself.
 */

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

let origin: string | null = null;

function localOrigin(request: Request) {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!LOCAL_HOSTS.has(host) && !host.endsWith(".localhost")) return null;
  return url.origin;
}

/** Remember the origin of a request this process is answering, when it is local. */
export function rememberServerOrigin(request: Request) {
  const next = localOrigin(request);
  if (next) origin = next;
}

/** The last local origin a request came in on, or null before any such request. */
export function serverOrigin() {
  return origin;
}

/** Tests drop a recorded origin so a later test does not open a browser. */
export function forgetServerOrigin() {
  origin = null;
}
