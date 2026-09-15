export function readInlineToken(request: Request) {
  const header = request.headers.get("x-inline-token")?.trim();
  if (header) return header;
  const auth = request.headers.get("authorization")?.trim() ?? "";
  const bearer = auth.match(/^Bearer\s+(.+)$/i);
  return bearer?.[1]?.trim() || "";
}

export function isAgentApiAuthorized(request: Request) {
  const token = process.env.INLINE_API_TOKEN?.trim();
  if (!token) return true;
  return readInlineToken(request) === token;
}

export function isMcpAuthorized(request?: Request) {
  const token = process.env.INLINE_MCP_TOKEN?.trim() || process.env.INLINE_API_TOKEN?.trim();
  if (!token || !request) return false;
  return readInlineToken(request) === token;
}
