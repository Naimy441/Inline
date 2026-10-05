import { json, route } from "@/lib/server/http";
import { mcpToken } from "@/lib/server/mcpToken";

/**
 * The command that connects Claude Code (or any MCP client) to this Inline.
 * Only Inline's own pages can read it: other sites can't read cross-origin
 * responses, and the request guard refuses other hostnames.
 */
export const GET = route(async (request) => {
  const url = new URL("/api/mcp", request.url).toString();
  const token = await mcpToken();
  const header = token ? ` --header "Authorization: Bearer ${token}"` : "";
  return json({ url, token, command: `claude mcp add --transport http inline ${url}${header}` });
});
