import { createSdkMcpServer, tool as sdkTool } from "@anthropic-ai/claude-agent-sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DOCUMENT_FORMAT_GUIDE } from "@/lib/agent/prompt";
import { TOOLS, runTool, type ToolContext, type ToolResult } from "@/lib/agent/tools";

/**
 * The Inline MCP server, in two transports over the same tool registry:
 * - in-process, for the Claude Code session that powers the in-app agent;
 * - Streamable HTTP at /api/mcp, so any MCP client (including a user's own
 *   Claude Code: `claude mcp add --transport http inline <url>/api/mcp`)
 *   can work in Inline documents.
 */

export const MCP_SERVER_NAME = "inline";
const VERSION = "1.0.0";

export const mcpToolName = (name: string) => `mcp__${MCP_SERVER_NAME}__${name}`;

function toCallToolResult(result: ToolResult) {
  return { content: [{ type: "text" as const, text: result.text }], isError: result.isError || undefined };
}

function annotations(tool: (typeof TOOLS)[number]) {
  return {
    title: tool.title,
    readOnlyHint: !tool.write,
    destructiveHint: Boolean(tool.destructive),
    idempotentHint: !tool.write,
    openWorldHint: false,
  };
}

/** In-process MCP server for an in-app chat. `context` is read on every call, so it can change between turns. */
export function createInlineSdkServer(context: () => ToolContext) {
  return createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: VERSION,
    tools: TOOLS.map((definition) =>
      sdkTool(
        definition.name,
        definition.description,
        definition.shape,
        async (args) => toCallToolResult(await runTool(definition.name, args as Record<string, unknown>, context())),
        { annotations: annotations(definition), alwaysLoad: true },
      ),
    ),
  });
}

/** A standalone MCP server for external clients. */
export function createInlineHttpServer(context: ToolContext) {
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: VERSION, title: "Inline" },
    {
      instructions: `Inline is a document editor. These tools read and edit the user's Inline documents; the user sees changes live and can keep or undo each one.\n\n${DOCUMENT_FORMAT_GUIDE}`,
    },
  );
  for (const definition of TOOLS) {
    server.registerTool(
      definition.name,
      { title: definition.title, description: definition.description, inputSchema: definition.shape, annotations: annotations(definition) },
      async (args: Record<string, unknown>) => toCallToolResult(await runTool(definition.name, args, context)),
    );
  }
  return server;
}
