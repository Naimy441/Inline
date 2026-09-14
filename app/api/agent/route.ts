import { isAgentMode, isThinkingLevel, resolveAgentModel } from "@/lib/agent/models";
import { runAgentStream } from "@/lib/agent/runAgent";
import { encodeSse } from "@/lib/agent/sse";
import type { AgentAttachment, AgentComment, AgentEditDraft, AgentHistoryMessage, AgentLockedRange, AgentPriorEdit, AgentRequest, DocumentPageSlice } from "@/lib/agent/types";

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

  const document = typeof body.document === "string" ? body.document : "";
  const parseSelection = (value: unknown) => {
    if (!value || typeof value !== "object") return null;
    const item = value as { text?: unknown; before?: unknown; after?: unknown };
    if (typeof item.text !== "string" || !item.text.trim()) return null;
    return {
      text: item.text.slice(0, 12_000),
      before: String(item.before ?? "").slice(-600),
      after: String(item.after ?? "").slice(0, 600),
    };
  };
  const selections = (Array.isArray(body.selections) ? body.selections : [])
    .map(parseSelection)
    .filter((item): item is { text: string; before: string; after: string } => item !== null)
    .slice(0, 12);
  const legacySelection = parseSelection(body.selection);
  const normalizedSelections = selections.length ? selections : legacySelection ? [legacySelection] : [];
  const selection = normalizedSelections[normalizedSelections.length - 1] ?? null;

  const history = Array.isArray(body.history)
    ? body.history
        .map((item): AgentHistoryMessage | null => {
          if (!item || (item.role !== "user" && item.role !== "assistant")) return null;
          if (typeof item.content !== "string" || !item.content.trim()) return null;
          return { role: item.role, content: item.content };
        })
        .filter((item): item is AgentHistoryMessage => item !== null)
        .slice(-16)
    : [];

  const comments = Array.isArray(body.comments)
    ? body.comments
        .map((item): AgentComment | null => {
          if (!item || typeof item.quote !== "string") return null;
          return {
            id: typeof item.id === "string" ? item.id : "",
            quote: item.quote,
            body: typeof item.body === "string" ? item.body : "",
          };
        })
        .filter((item): item is AgentComment => item !== null)
    : [];

  const attachments = Array.isArray(body.attachments)
    ? body.attachments
        .map((item): AgentAttachment | null => {
          if (!item || typeof item.name !== "string" || typeof item.text !== "string") return null;
          return {
            id: typeof item.id === "string" ? item.id : "",
            name: item.name,
            text: item.text,
          };
        })
        .filter((item): item is AgentAttachment => item !== null)
    : [];

  const lockedRanges = Array.isArray(body.lockedRanges)
    ? body.lockedRanges
        .map((item): AgentLockedRange | null => {
          if (!item || typeof item.text !== "string" || !item.text.trim()) return null;
          return {
            id: typeof item.id === "string" ? item.id : "",
            text: item.text,
          };
        })
        .filter((item): item is AgentLockedRange => item !== null)
    : [];

  const previousEdits = Array.isArray(body.previousEdits)
    ? body.previousEdits
        .map((item): AgentPriorEdit | null => {
          if (!item || typeof item !== "object") return null;
          const row = item as {
            find?: unknown;
            replace?: unknown;
            operation?: unknown;
            occurrence?: unknown;
            status?: unknown;
          };
          if (typeof row.find !== "string" || typeof row.replace !== "string") return null;
          if (row.status !== "pending" && row.status !== "accepted") return null;
          return {
            find: row.find.slice(0, 1_500),
            replace: row.replace.slice(0, 1_500),
            operation: row.operation === "replace" || row.operation === "insert" || row.operation === "delete"
              ? row.operation as AgentEditDraft["operation"]
              : undefined,
            occurrence: typeof row.occurrence === "number" && Number.isInteger(row.occurrence) && row.occurrence >= 0
              ? row.occurrence
              : undefined,
            status: row.status,
          };
        })
        .filter((item): item is AgentPriorEdit => item !== null)
        .slice(-8)
    : [];

  const pages = (Array.isArray(body.pages) ? body.pages : [])
    .map((item): DocumentPageSlice | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as { number?: unknown; start?: unknown; end?: unknown; text?: unknown };
      if (typeof row.start !== "number" || typeof row.end !== "number" || typeof row.text !== "string") return null;
      return {
        number: typeof row.number === "number" && row.number > 0 ? Math.round(row.number) : 0,
        start: Math.max(0, Math.round(row.start)),
        end: Math.max(0, Math.round(row.end)),
        text: row.text.slice(0, 20_000),
      };
    })
    .filter((item): item is DocumentPageSlice => item !== null)
    .slice(0, 80);

  const agentRequest: AgentRequest = {
    title: typeof body.title === "string" ? body.title : "Untitled document",
    prompt,
    document,
    pages: pages.length ? pages : undefined,
    selection,
    selections: normalizedSelections,
    mode: isAgentMode(body.mode) ? body.mode : "agent",
    model: resolveAgentModel(typeof body.model === "string" ? body.model : undefined),
    thinkingLevel: isThinkingLevel(body.thinkingLevel) ? body.thinkingLevel : "medium",
    nameChat: Boolean(body.nameChat),
    history,
    comments,
    attachments,
    lockedRanges,
    previousEdits,
    preserveTone: body.preserveTone !== false,
    pageCount: typeof body.pageCount === "number" && body.pageCount > 0 ? Math.round(body.pageCount) : 1,
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
