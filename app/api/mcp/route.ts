import { createMcpHandler } from "@modelcontextprotocol/server";
import { createDocumentMcpServer } from "@/lib/agent/mcp/register";
import { DocumentSession } from "@/lib/agent/mcp/session";

const sessions = new Map<string, DocumentSession>();

function sessionFor(request?: Request) {
  const id = request?.headers.get("x-inline-session")?.trim() || "default";
  const existing = sessions.get(id);
  if (existing) return existing;
  const created = new DocumentSession({ title: "Untitled document", text: "" });
  sessions.set(id, created);
  return created;
}

const handler = createMcpHandler((ctx) =>
  createDocumentMcpServer(sessionFor(ctx.requestInfo), {
    allowWrites: true,
    allowClient: false,
    allowSeed: true,
  }),
);

export async function GET(request: Request) {
  return handler.fetch(request);
}

export async function POST(request: Request) {
  return handler.fetch(request);
}

export async function DELETE(request: Request) {
  return handler.fetch(request);
}
