import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import type { ToolContext } from "@/lib/agent/tools";

/**
 * Helpers for driving Inline's MCP server the way a real client does: over
 * the in-process server the in-app agent uses, or over HTTP through the
 * /api/mcp route handler.
 */

/** Point the file store at a fresh directory. The store reads the variable on every call. */
export function useTempDataDir(prefix = "inline-test-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  process.env.INLINE_DATA_DIR = dir;
  return dir;
}

export type CallResult = { text: string; isError: boolean };

export type McpHarness = {
  client: Client;
  call: (name: string, args?: Record<string, unknown>) => Promise<CallResult>;
  close: () => Promise<void>;
};

function wrap(client: Client, close: () => Promise<void>): McpHarness {
  return {
    client,
    async call(name, args = {}) {
      const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
      return { text: result.content.map((block) => block.text ?? "").join("\n"), isError: Boolean(result.isError) };
    },
    close,
  };
}

/** Connect an MCP client to the in-process server the in-app Claude Code session uses. */
export async function connectInProcess(context: () => ToolContext): Promise<McpHarness> {
  const { createInlineSdkServer } = await import("@/lib/agent/mcp");
  const config = createInlineSdkServer(context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await config.instance.connect(serverTransport);
  const client = new Client({ name: "inline-tests", version: "1.0.0" });
  await client.connect(clientTransport);
  return wrap(client, async () => {
    await client.close();
    await config.instance.close();
  });
}

/** A fetch that serves requests with the /api/mcp route handler, no network or Next server involved. */
export async function routeFetch(): Promise<typeof fetch> {
  const route = await import("@/app/api/mcp/route");
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const handler = route[request.method as "GET" | "POST" | "DELETE"];
    if (!handler) return new Response(null, { status: 405 });
    return handler(request);
  }) as typeof fetch;
}

export const MCP_URL = "http://localhost:3000/api/mcp";

/** Connect an MCP client to the HTTP endpoint (the transport external Claude Code uses). */
export async function connectHttp(): Promise<McpHarness> {
  const fetchImpl = await routeFetch();
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: fetchImpl });
  const client = new Client({ name: "inline-tests-http", version: "1.0.0" });
  await client.connect(transport);
  return wrap(client, () => client.close());
}
