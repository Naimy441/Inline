import { isAgentApiAuthorized } from "@/lib/agent/apiAuth";
import { fixGrammarText } from "@/lib/agent/grammar";

export async function POST(request: Request) {
  if (!isAgentApiAuthorized(request)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  let body: { text?: unknown };
  try {
    body = (await request.json()) as { text?: unknown };
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) {
    return Response.json({ edits: [], model: "none", mock: false });
  }

  try {
    const result = await fixGrammarText(text, request.signal);
    return Response.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Grammar request failed.";
    return Response.json({ error: message }, { status: 502 });
  }
}
