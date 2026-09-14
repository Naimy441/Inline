import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { DocumentMcpOptions } from "@/lib/agent/mcp/register";
import { createDocumentMcpServer, jsonFromToolResult, parseToolPayload, type ToolCallMeta } from "@/lib/agent/mcp/register";
import { DocumentSession } from "@/lib/agent/mcp/session";

export type McpToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type DocumentMcpRuntime = {
  session: DocumentSession;
  listTools: () => Promise<McpToolDef[]>;
  callTool: (name: string, args: Record<string, unknown>) => Promise<{ raw: unknown; text: string; meta: ToolCallMeta }>;
  close: () => Promise<void>;
};

export async function connectDocumentMcp(session: DocumentSession, options: DocumentMcpOptions = {}): Promise<DocumentMcpRuntime> {
  const server = createDocumentMcpServer(session, options);
  const client = new Client({ name: "inline-agent", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  return {
    session,
    async listTools() {
      const listed = await client.listTools();
      return listed.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: (tool.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      }));
    },
    async callTool(name, args) {
      const result = await client.callTool({ name, arguments: args });
      const raw = jsonFromToolResult(result);
      return {
        raw,
        text: JSON.stringify(raw),
        meta: parseToolPayload(name, raw),
      };
    },
    async close() {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

export function toOpenAITools(tools: McpToolDef[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));
}

export function toOpenAIChatTools(tools: McpToolDef[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

export function toAnthropicTools(tools: McpToolDef[]) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}
