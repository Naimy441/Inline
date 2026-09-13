import { isAgentMode, isThinkingLevel, resolveAgentModel } from "@/lib/agent/models";
import { runAgentStream } from "@/lib/agent/runAgent";
import { encodeSse } from "@/lib/agent/sse";
import type { AgentAttachment, AgentComment, AgentHistoryMessage, AgentLockedRange, AgentRequest } from "@/lib/agent/types";

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

  const document = typeof body.document === "string" ? body.document.slice(0, 80_000) : "";
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

  const comments = Array.isArray(body.comments)
    ? body.comments
        .map((item): AgentComment | null => {
          if (!item || typeof item.quote !== "string") return null;
          return {
            id: typeof item.id === "string" ? item.id : "",
            quote: item.quote.slice(0, 2000),
            body: typeof item.body === "string" ? item.body.slice(0, 2000) : "",
          };
        })
        .filter((item): item is AgentComment => item !== null)
        .slice(0, 40)
    : [];

  const attachments = Array.isArray(body.attachments)
    ? body.attachments
        .map((item): AgentAttachment | null => {
          if (!item || typeof item.name !== "string" || typeof item.text !== "string") return null;
          return {
            id: typeof item.id === "string" ? item.id : "",
            name: item.name.slice(0, 120),
            text: item.text.slice(0, 20_000),
          };
        })
        .filter((item): item is AgentAttachment => item !== null)
        .slice(0, 4)
    : [];

  const lockedRanges = Array.isArray(body.lockedRanges)
    ? body.lockedRanges
        .map((item): AgentLockedRange | null => {
          if (!item || typeof item.text !== "string" || !item.text.trim()) return null;
          return {
            id: typeof item.id === "string" ? item.id : "",
            text: item.text.slice(0, 4000),
          };
        })
        .filter((item): item is AgentLockedRange => item !== null)
        .slice(0, 40)
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
    comments,
    attachments,
    lockedRanges,
    preserveTone: body.preserveTone !== false,
    pageCount: typeof body.pageCount === "number" && body.pageCount > 0 ? Math.min(200, Math.round(body.pageCount)) : 1,
  };

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      try {
        for await (const event of runAgentStream(agentRequest, request.signal)) {
          if (request.signal.aborted) break;
          controller.enqueue(encoder.encode(encodeSse(event)));
        }
      } catch (error) {
        if (request.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Agent request failed.";
        controller.enqueue(encoder.encode(encodeSse({ type: "error", error: message })));
      } finally {
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {},
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
