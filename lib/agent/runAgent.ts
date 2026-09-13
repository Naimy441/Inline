import type { AgentRequest, AgentResponse, AgentEditDraft } from "@/lib/agent/types";

const SYSTEM = `You are Inline, a writing agent inside a Google Docs-style editor.
Return ONLY a JSON object: {"message": string, "edits": [{"find": string, "replace": string, "reason": string}]}

The DOCUMENT is the full current text and is the source of truth. A SELECTION, if present, is extra context the user pointed at. It is not the whole document and not the only place you may change.

Rules:
- Each "find" must be an exact substring of the DOCUMENT. Do not invent text that is not already there.
- To add a new paragraph, find the paragraph it should follow and set "replace" to that same paragraph, then \\n\\n, then the new paragraph. Do not rewrite the earlier paragraph unless asked.
- To append at the end, find the last paragraph, or use find "" and put only the new paragraph in replace.
- Prefer small, targeted edits. Keep names, facts, and meaning. Do not invent citations.
- "message" is a short explanation. The user will keep or undo the edits.`;

export async function runAgent(request: AgentRequest): Promise<AgentResponse> {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    return { ...mockAgent(request), mock: true };
  }

  try {
    const content = await completeJson(key, request);
    const parsed = parseAgentJson(content);
    return { ...parsed, mock: false };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Model request failed";
    throw new Error(detail);
  }
}

export function mockAgent(request: AgentRequest): Omit<AgentResponse, "mock"> {
  const document = request.document.trim();
  const intent = request.prompt.toLowerCase();
  if (!document) {
    return { message: "The document is empty.", edits: [] };
  }
  if (intent.includes("paragraph") || intent.includes("new line") || /\badd\b/.test(intent)) {
    const last = lastParagraph(document);
    return {
      message: "Added a new paragraph after the existing text.",
      edits: [
        {
          find: last,
          replace: `${last}\n\n${mockNewParagraph(request.prompt)}`,
          reason: "Insert paragraph",
        },
      ],
    };
  }
  const source = request.selection?.text.trim() || lastParagraph(document);
  return {
    message: "Proposed a targeted edit. Keep or undo it in the chat.",
    edits: [
      {
        find: source,
        replace: mockRewrite(source, request.prompt),
        reason: request.selection ? "Uses the highlighted passage as context" : "Document edit",
      },
    ],
  };
}

function lastParagraph(document: string) {
  const parts = document.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? document.slice(-220);
}

function mockNewParagraph(prompt: string) {
  const trimmed = prompt.replace(/^(please\s+)?(add|write|insert|make)\s+(a\s+)?/i, "").trim();
  return trimmed ? trimmed.replace(/[.!?]?$/, ".") : "A new paragraph continues the document.";
}

function mockRewrite(text: string, prompt: string) {
  const intent = prompt.toLowerCase();
  const words = text.trim().split(/\s+/);
  if (intent.includes("short") || intent.includes("concise") || intent.includes("brief")) {
    return words.slice(0, Math.max(4, Math.ceil(words.length / 2))).join(" ");
  }
  if (intent.includes("formal")) {
    return text
      .replace(/\bcan't\b/gi, "cannot")
      .replace(/\bdon't\b/gi, "do not")
      .replace(/\bwon't\b/gi, "will not")
      .replace(/\bit's\b/gi, "it is");
  }
  if (intent.includes("expand") || intent.includes("longer")) {
    return `${text.trim().replace(/[.!?]?$/, "")}. This can be developed with one more concrete detail.`;
  }
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

async function completeJson(apiKey: string, request: AgentRequest): Promise<string> {
  const model = process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini";
  const user = buildUserPrompt(request);
  const responsesError = await tryResponses(apiKey, model, user);
  if (responsesError.ok) return responsesError.text;
  const chat = await tryChat(apiKey, model, user);
  if (chat.ok) return chat.text;
  throw new Error(chat.error || responsesError.error || "The model did not return a usable response.");
}

async function tryResponses(
  apiKey: string,
  model: string,
  user: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
      text: { format: { type: "json_object" } },
    }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    error?: { message?: string };
  };
  if (!res.ok) {
    return { ok: false, error: payload.error?.message || `Responses API ${res.status}` };
  }
  const text =
    payload.output_text ||
    payload.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("") ||
    "";
  return text.trim() ? { ok: true, text } : { ok: false, error: "Empty model response." };
}

async function tryChat(
  apiKey: string,
  model: string,
  user: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    }),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    choices?: Array<{ message?: { content?: string } }>;
    error?: { message?: string };
  };
  if (!res.ok) {
    return { ok: false, error: payload.error?.message || `Chat API ${res.status}` };
  }
  const text = payload.choices?.[0]?.message?.content ?? "";
  return text.trim() ? { ok: true, text } : { ok: false, error: "Empty model response." };
}

function buildUserPrompt(request: AgentRequest) {
  const selection = request.selection;
  const document = clip(request.document, 40_000);
  const lines = [
    `Document title: ${request.title || "Untitled document"}`,
    "",
    "Instruction:",
    request.prompt.trim(),
    "",
    "Full document (source of truth):",
    "<<<DOCUMENT>>>",
    document || "(empty)",
    "<<<END_DOCUMENT>>>",
    "",
  ];
  if (selection?.text.trim()) {
    lines.push(
      "The user also highlighted this passage as extra context. It is not the whole document. Use it if it helps, but follow the instruction against the full document:",
      "<<<SELECTION>>>",
      selection.text,
      "<<<END_SELECTION>>>",
    );
    if (selection.before || selection.after) {
      lines.push("", `Nearby before: ${selection.before || "(start)"}`, `Nearby after: ${selection.after || "(end)"}`);
    }
  }
  return lines.join("\n");
}

function clip(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[Document truncated]`;
}

function parseAgentJson(raw: string): Omit<AgentResponse, "mock"> {
  const json = JSON.parse(unwrapFence(raw)) as {
    message?: unknown;
    edits?: unknown;
  };
  const edits = Array.isArray(json.edits)
    ? json.edits
        .map((item): AgentEditDraft | null => {
          if (!item || typeof item !== "object") return null;
          const row = item as { find?: unknown; replace?: unknown; reason?: unknown };
          if (typeof row.replace !== "string") return null;
          const find = typeof row.find === "string" ? row.find : "";
          if (!find && !row.replace) return null;
          return {
            find,
            replace: row.replace,
            reason: typeof row.reason === "string" ? row.reason : undefined,
          };
        })
        .filter((item): item is AgentEditDraft => item !== null)
        .slice(0, 8)
    : [];
  return {
    message: typeof json.message === "string" && json.message.trim() ? json.message.trim() : "Review the proposed edits.",
    edits,
  };
}

function unwrapFence(raw: string) {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : trimmed;
}
