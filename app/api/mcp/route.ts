import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createInlineHttpServer } from "@/lib/agent/mcp";
import { mcpAuthorized } from "@/lib/server/mcpToken";

/**
 * Inline's MCP endpoint (Streamable HTTP, stateless). Clients must send the
 * MCP token as a Bearer token; Help > Connect Claude Code shows the command:
 *   claude mcp add --transport http inline http://localhost:3000/api/mcp --header "Authorization: Bearer <token>"
 * Changes made through it show up live in the editor for the user to review.
 */
async function handle(request: Request) {
  if (!(await mcpAuthorized(request))) {
    return Response.json(
      { jsonrpc: "2.0", error: { code: -32001, message: "Missing or wrong Inline MCP token. In Inline, open Help > Connect Claude Code for the command to run." }, id: null },
      { status: 401, headers: { "WWW-Authenticate": 'Bearer realm="inline"' } },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  const server = createInlineHttpServer({ author: "external" });
  await server.connect(transport);
  try {
    return await transport.handleRequest(request);
  } finally {
    // Stateless: every request gets its own server, so close it once the response is built.
    void server.close().catch(() => undefined);
  }
}

/**
 * A stateless server has no server-initiated stream to offer and no session
 * to end, so GET and DELETE answer 405 as the MCP spec asks; clients then
 * simply use POST. (Serving GET opened a stream that closed at once, which
 * clients treat as a dropped connection and retry.)
 */
function methodNotAllowed() {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. This MCP server is stateless; use POST." }, id: null },
    { status: 405, headers: { Allow: "POST" } },
  );
}

export const POST = handle;
export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
