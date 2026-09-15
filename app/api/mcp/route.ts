import { createMcpHandler } from "@modelcontextprotocol/server";
import { isMcpAuthorized } from "@/lib/agent/apiAuth";
import { createDocumentMcpServer } from "@/lib/agent/mcp/register";
import { DocumentSession } from "@/lib/agent/mcp/session";

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 32;

type TimedSession = { session: DocumentSession; at: number };

const sessions = new Map<string, TimedSession>();

function pruneSessions() {
  const now = Date.now();
  for (const [id, row] of sessions) {
    if (now - row.at > SESSION_TTL_MS) sessions.delete(id);
  }
  if (sessions.size <= MAX_SESSIONS) return;
  const oldest = [...sessions.entries()].sort((a, b) => a[1].at - b[1].at);
  for (const [id] of oldest.slice(0, sessions.size - MAX_SESSIONS)) sessions.delete(id);
}

function sessionFor(request?: Request) {
  pruneSessions();
  const raw = request?.headers.get("x-inline-session")?.trim() || "default";
  const id = raw.slice(0, 80);
  const existing = sessions.get(id);
  if (existing) {
    existing.at = Date.now();
    return existing.session;
  }
  const created = new DocumentSession({ title: "Untitled document", text: "" });
  sessions.set(id, { session: created, at: Date.now() });
  return created;
}

const handler = createMcpHandler((ctx) => {
  const request = ctx.requestInfo instanceof Request ? ctx.requestInfo : undefined;
  const authed = isMcpAuthorized(request);
  return createDocumentMcpServer(sessionFor(request), {
    allowWrites: authed,
    allowClient: false,
    allowSeed: authed,
    allowRunCode: false,
    allowWeb: authed,
  });
});

export async function GET(request: Request) {
  return handler.fetch(request);
}

export async function POST(request: Request) {
  return handler.fetch(request);
}

export async function DELETE(request: Request) {
  return handler.fetch(request);
}
