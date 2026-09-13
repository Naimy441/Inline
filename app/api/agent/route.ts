import { isAgentMode, isThinkingLevel, resolveAgentModel } from "@/lib/agent/models";
import { runAgentStream } from "@/lib/agent/runAgent";
import { encodeSse } from "@/lib/agent/sse";
import type { AgentHistoryMessage, AgentRequest } from "@/lib/agent/types";

export async function POST(request: Request) {
  let body: Partial<AgentRequest>;
  try {
    body = (await request.json()) as Partial<AgentRequest>;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return Response.json({ error: "Prompt is required." }, { status: 400 });
  }
  if (prompt.length > 4000) {
    return Response.json({ error: "Prompt is too long." }, { status: 400 });
  }

  const document = typeof body.document === "string" ? body.document.slice(0, 50_000) : "";
  const selection =
    body.selection && typeof body.selection.text === "string" && body.selection.text.trim()
      ? {
          text: body.selection.text.slice(0, 12_000),
          before: String(body.selection.before ?? "").slice(0, 600),
          after: String(body.selection.after ?? "").slice(0, 600),
        }
      : null;

  const history = Array.isArray(body.history)
    ? body.history
        .map((item): AgentHistoryMessage | null => {
          if (!item || (item.role !== "user" && item.role !== "assistant")) return null;
          if (typeof item.content !== "string" || !item.content.trim()) return null;
          return { role: item.role, content: item.content.slice(0, 8000) };
        })
        .filter((item): item is AgentHistoryMessage => item !== null)
        .slice(-12)
    : [];

  const agentRequest: AgentRequest = {
    title: typeof body.title === "string" ? body.title.slice(0, 200) : "Untitled document",
    prompt,
    document,
    selection,
    mode: isAgentMode(body.mode) ? body.mode : "agent",
    model: resolveAgentModel(typeof body.model === "string" ? body.model : undefined),
    thinkingLevel: isThinkingLevel(body.thinkingLevel) ? body.thinkingLevel : "medium",
    nameChat: Boolean(body.nameChat),
    history,
  };

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of runAgentStream(agentRequest)) {
          controller.enqueue(encoder.encode(encodeSse(event)));
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Agent request failed.";
        controller.enqueue(encoder.encode(encodeSse({ type: "error", error: message })));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
