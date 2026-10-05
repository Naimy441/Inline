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

export const POST = handle;
export const GET = handle;
export const DELETE = handle;
