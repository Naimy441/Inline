import { runAgent } from "@/lib/agent/runAgent";
import type { AgentRequest } from "@/lib/agent/types";

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

  try {
    const result = await runAgent({
      title: typeof body.title === "string" ? body.title.slice(0, 200) : "Untitled document",
      prompt,
      document,
      selection,
    });
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Agent request failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
