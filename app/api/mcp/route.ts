import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createInlineHttpServer } from "@/lib/agent/mcp";

/**
 * Inline's MCP endpoint (Streamable HTTP, stateless). Connect Claude Code with:
 *   claude mcp add --transport http inline http://localhost:3000/api/mcp
 * Changes made through it show up live in the editor for the user to review.
 */
async function handle(request: Request) {
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

/** Stateless: no server-to-client event stream (GET) and no session to end (DELETE). Clients fall back to POST. */
function methodNotAllowed() {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }), {
    status: 405,
    headers: { Allow: "POST", "Content-Type": "application/json" },
  });
}

export const POST = handle;
export const GET = methodNotAllowed;
export const DELETE = methodNotAllowed;
