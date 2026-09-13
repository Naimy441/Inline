import {
  anthropicThinkingBudget,
  findAgentModel,
  openaiEffort,
  resolveAgentModel,
} from "@/lib/agent/models";
import { readSseData } from "@/lib/agent/sse";
import type { AgentEditDraft, AgentHistoryMessage, AgentRequest, AgentResponse, AgentStreamEvent } from "@/lib/agent/types";

export async function runAgent(request: AgentRequest): Promise<AgentResponse> {
  const modelId = resolveAgentModel(request.model);
  const model = findAgentModel(modelId);
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();

  if (model?.provider === "anthropic") {
    if (!anthropicKey) {
      throw new Error("Add ANTHROPIC_API_KEY to use Claude models.");
    }
    try {
      const parsed = await completeAnthropic(anthropicKey, { ...request, model: modelId });
      return { ...parsed, mock: false };
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : "Claude request failed.");
    }
  }

  if (!openaiKey) {
    return { ...mockAgent(request), mock: true };
  }

  try {
    const parsed = await completeOpenAI(openaiKey, { ...request, model: modelId });
    return { ...parsed, mock: false };
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : "Model request failed.");
  }
}

export async function* runAgentStream(request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
  const modelId = resolveAgentModel(request.model);
  const model = findAgentModel(modelId);
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const next = { ...request, model: modelId };

  yield { type: "phase", phase: request.mode === "plan" ? "planning" : "thinking" };

  try {
    if (model?.provider === "anthropic") {
      if (!anthropicKey) throw new Error("Add ANTHROPIC_API_KEY to use Claude models.");
      yield* streamAnthropic(anthropicKey, next);
      return;
    }
    if (!openaiKey) {
      yield* streamMock(next);
      return;
    }
    yield* streamOpenAI(openaiKey, next);
  } catch (error) {
    yield { type: "error", error: error instanceof Error ? error.message : "Model request failed." };
  }
}

export function mockAgent(request: AgentRequest): Omit<AgentResponse, "mock"> {
  const document = request.document.trim();
  const intent = request.prompt.toLowerCase();
  const thinking =
    request.thinkingLevel === "none"
      ? undefined
      : mockThinking(request);
  const chatTitle = request.nameChat ? mockTitle(request.prompt) : undefined;

  if (request.mode === "ask") {
    return {
      chatTitle,
      thinking,
      message: document
        ? `The document is ${document.split(/\s+/).length} words. ${askSummary(request.prompt, document)}`
        : "The document is empty, so there is nothing to answer from yet.",
      edits: [],
    };
  }

  if (request.mode === "plan") {
    return {
      chatTitle,
      thinking,
      message: [
        "Here is a plan without changing the document:",
        "1. Read the current draft and the instruction.",
        "2. Decide which passages need to change, and which should stay.",
        "3. Switch to Agent mode when you want those edits applied in the page.",
      ].join("\n"),
      edits: [],
    };
  }

  if (!document) {
    return { chatTitle, thinking, message: "The document is empty.", edits: [] };
  }
  if (intent.includes("paragraph") || intent.includes("new line") || /\badd\b/.test(intent)) {
    const last = lastParagraph(document);
    return {
      chatTitle,
      thinking,
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
    chatTitle,
    thinking,
    message: "Proposed a targeted edit. Keep or undo it in the page.",
    edits: [
      {
        find: source,
        replace: mockRewrite(source, request.prompt),
        reason: request.selection ? "Uses the highlighted passage as context" : "Document edit",
      },
    ],
  };
}

function mockThinking(request: AgentRequest) {
  if (request.mode === "ask") {
    return "I will stay in the document and answer from what is already written, without proposing edits.";
  }
  if (request.mode === "plan") {
    return "I will outline the work first: what to keep, what to change, and when the user should switch back to Agent.";
  }
  if (request.selection?.text.trim()) {
    return "The selection is extra context. I will still ground the edit in the full document and keep the change small enough to review.";
  }
  return "I will make a single, reviewable replacement and leave the rest of the draft alone.";
}

function mockTitle(prompt: string) {
  const words = prompt.replace(/\s+/g, " ").trim().split(" ").slice(0, 5).join(" ");
  return words ? words.replace(/[.?!,:;]+$/, "") : "New chat";
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

function askSummary(prompt: string, document: string) {
  const first = document.split(/\n+/).map((part) => part.trim()).find(Boolean) ?? document.slice(0, 160);
  return `You asked: ${prompt.trim()} The opening reads: “${clip(first, 180)}”`;
}

function systemPrompt(request: AgentRequest) {
  const canEdit = request.mode === "agent";
  const lines = [
    "You are Inline, a writing agent inside a Google Docs-style editor.",
    `Current mode: ${request.mode}.`,
    canEdit
      ? "You may propose targeted document edits."
      : "Do not propose document edits. Return an empty edits array.",
    'Return ONLY a JSON object, with keys in this order: {"thinking"?: string, "message": string, "edits": [{"find": string, "replace": string, "reason": string}], "chatTitle"?: string}',
    "The DOCUMENT is the full current text and is the source of truth. A SELECTION, if present, is extra context. It is not the whole document and not the only place you may change.",
    "Rules:",
    '- Each "find" must be an exact substring of the DOCUMENT. Do not invent text that is not already there.',
    '- To add a new paragraph, find the paragraph it should follow and set "replace" to that same paragraph, then \\n\\n, then the new paragraph. Do not rewrite the earlier paragraph unless asked.',
    '- To append at the end, find the last paragraph, or use find "" and put only the new paragraph in replace.',
    "- Prefer small, targeted edits. Keep names, facts, and meaning. Do not invent citations.",
    '- "message" is the visible reply. In plan mode it should be a numbered plan. In ask mode it should answer the question.',
  ];
  if (request.thinkingLevel !== "none") {
    lines.push('- "thinking" is a brief first-person trace (2–8 sentences) of how you approached the request.');
  }
  if (request.nameChat) {
    lines.push('- "chatTitle" is a 3–6 word name for this chat. No quotes or punctuation at the ends.');
  }
  return lines.join("\n");
}

async function completeOpenAI(apiKey: string, request: AgentRequest): Promise<Omit<AgentResponse, "mock">> {
  const model = request.model;
  const user = buildUserPrompt(request);
  const system = systemPrompt(request);
  const nativeThinking = request.thinkingLevel !== "none" && Boolean(findAgentModel(model)?.thinking);
  const responses = await tryResponses(apiKey, model, system, user, request.history, nativeThinking ? request.thinkingLevel : "none");
  if (responses.ok) return parseAgentJson(responses.text, responses.thinking, request);
  if (nativeThinking) {
    const plain = await tryResponses(apiKey, model, system, user, request.history, "none");
    if (plain.ok) return parseAgentJson(plain.text, plain.thinking, request);
  }
  const chat = await tryChat(apiKey, model, system, user, request.history);
  if (chat.ok) return parseAgentJson(chat.text, undefined, request);
  throw new Error(chat.error || responses.error || "The model did not return a usable response.");
}

async function completeAnthropic(apiKey: string, request: AgentRequest): Promise<Omit<AgentResponse, "mock">> {
  const withThinking = request.thinkingLevel !== "none";
  const first = await tryAnthropic(apiKey, request, withThinking);
  if (first.ok) return parseAgentJson(first.text, first.thinking, request);
  if (withThinking) {
    const second = await tryAnthropic(apiKey, request, false);
    if (second.ok) return parseAgentJson(second.text, second.thinking, request);
    throw new Error(second.error || first.error || "Claude request failed.");
  }
  throw new Error(first.error || "Claude request failed.");
}

async function tryResponses(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  history: AgentHistoryMessage[],
  thinkingLevel: AgentRequest["thinkingLevel"],
): Promise<{ ok: true; text: string; thinking?: string } | { ok: false; error: string }> {
  const body: Record<string, unknown> = {
    model,
    input: [
      { role: "system", content: system },
      ...history.map((item) => ({ role: item.role, content: item.content })),
      { role: "user", content: user },
    ],
    text: { format: { type: "json_object" } },
  };
  if (thinkingLevel !== "none") {
    body.reasoning = { effort: openaiEffort(thinkingLevel) };
  }
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{ type?: string; text?: string; summary?: Array<{ text?: string }> }>;
      summary?: Array<{ text?: string }>;
    }>;
    error?: { message?: string };
  };
  if (!res.ok) {
    return { ok: false, error: payload.error?.message || `Responses API ${res.status}` };
  }
  const text =
    payload.output_text ||
    payload.output?.flatMap((item) => item.content ?? []).map((part) => part.text ?? "").join("") ||
    "";
  const thinking = extractOpenAIThinking(payload.output);
  return text.trim() ? { ok: true, text, thinking } : { ok: false, error: "Empty model response." };
}

async function tryChat(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  history: AgentHistoryMessage[],
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
        { role: "system", content: system },
        ...history.map((item) => ({ role: item.role, content: item.content })),
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

async function tryAnthropic(
  apiKey: string,
  request: AgentRequest,
  enableThinking: boolean,
): Promise<{ ok: true; text: string; thinking?: string } | { ok: false; error: string }> {
  const budget = anthropicThinkingBudget(request.thinkingLevel);
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: enableThinking && budget > 0 ? budget + 4096 : 4096,
    system: systemPrompt(request),
    messages: [
      ...request.history.map((item) => ({ role: item.role, content: item.content })),
      { role: "user", content: buildUserPrompt(request) },
    ],
  };
  if (enableThinking && budget > 0) {
    body.thinking = { type: "enabled", budget_tokens: budget };
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = (await res.json().catch(() => ({}))) as {
    content?: Array<{ type?: string; text?: string; thinking?: string }>;
    error?: { message?: string };
  };
  if (!res.ok) {
    return { ok: false, error: payload.error?.message || `Anthropic API ${res.status}` };
  }
  const text = (payload.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("");
  const thinking = (payload.content ?? [])
    .filter((part) => part.type === "thinking")
    .map((part) => part.thinking ?? "")
    .join("\n")
    .trim();
  return text.trim()
    ? { ok: true, text, thinking: thinking || undefined }
    : { ok: false, error: "Empty Claude response." };
}

function extractOpenAIThinking(
  output:
    | Array<{
        type?: string;
        content?: Array<{ type?: string; text?: string; summary?: Array<{ text?: string }> }>;
        summary?: Array<{ text?: string }>;
      }>
    | undefined,
) {
  if (!output) return undefined;
  const parts: string[] = [];
  for (const item of output) {
    if (item.type === "reasoning") {
      const fromSummary = item.summary?.map((part) => part.text ?? "").join("\n");
      const fromContent = item.content
        ?.map((part) => part.summary?.map((row) => row.text ?? "").join("\n") || part.text || "")
        .join("\n");
      if (fromSummary) parts.push(fromSummary);
      if (fromContent) parts.push(fromContent);
    }
  }
  const text = parts.join("\n").trim();
  return text || undefined;
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

function parseAgentJson(
  raw: string,
  nativeThinking: string | undefined,
  request: AgentRequest,
): Omit<AgentResponse, "mock"> {
  const json = JSON.parse(unwrapFence(raw)) as {
    message?: unknown;
    thinking?: unknown;
    chatTitle?: unknown;
    edits?: unknown;
  };
  const allowEdits = request.mode === "agent";
  const edits = allowEdits && Array.isArray(json.edits)
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
  const thinking =
    request.thinkingLevel === "none"
      ? undefined
      : (typeof json.thinking === "string" && json.thinking.trim()) || nativeThinking;
  const chatTitle =
    request.nameChat && typeof json.chatTitle === "string"
      ? json.chatTitle.replace(/\s+/g, " ").trim()
      : undefined;
  return {
    message: typeof json.message === "string" && json.message.trim() ? json.message.trim() : defaultMessage(request.mode),
    thinking: thinking?.trim() || undefined,
    chatTitle: chatTitle && chatTitle.length >= 2 && chatTitle.length <= 48 ? chatTitle : undefined,
    edits,
  };
}

function defaultMessage(mode: AgentRequest["mode"]) {
  if (mode === "plan") return "Here is a plan for the document.";
  if (mode === "ask") return "Here is what the document shows.";
  return "Review the proposed edits.";
}

function unwrapFence(raw: string) {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : trimmed;
}

async function* streamMock(request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
  const result = { ...mockAgent(request), mock: true };
  if (result.thinking) yield* typewriteThinking(result.thinking);
  if (request.mode === "agent") {
    yield { type: "phase", phase: "planning" };
    await wait(180);
  }
  yield { type: "done", result };
}

async function* streamOpenAI(apiKey: string, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
  const model = request.model;
  const user = buildUserPrompt(request);
  const system = systemPrompt(request);
  const native = request.thinkingLevel !== "none" && Boolean(findAgentModel(model)?.thinking);
  const attempts = [
    () => tryResponsesStream(apiKey, request, system, user, native ? request.thinkingLevel : "none", true),
    () => tryResponsesStream(apiKey, request, system, user, native ? request.thinkingLevel : "none", false),
    () => tryChatStream(apiKey, model, system, user, request.history, request),
  ];
  for (const attempt of attempts) {
    try {
      const stream = await attempt();
      if (!stream) continue;
      yield* stream;
      return;
    } catch {
      continue;
    }
  }
  const parsed = await completeOpenAI(apiKey, request);
  if (parsed.thinking) yield* typewriteThinking(parsed.thinking);
  yield { type: "done", result: { ...parsed, mock: false } };
}

async function* streamAnthropic(apiKey: string, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
  const withThinking = request.thinkingLevel !== "none";
  const first = await tryAnthropicStream(apiKey, request, withThinking);
  if (first) {
    yield* first;
    return;
  }
  if (withThinking) {
    const second = await tryAnthropicStream(apiKey, request, false);
    if (second) {
      yield* second;
      return;
    }
  }
  const parsed = await completeAnthropic(apiKey, request);
  if (parsed.thinking) yield* typewriteThinking(parsed.thinking);
  yield { type: "done", result: { ...parsed, mock: false } };
}

async function tryResponsesStream(
  apiKey: string,
  request: AgentRequest,
  system: string,
  user: string,
  thinkingLevel: AgentRequest["thinkingLevel"],
  includeSummary: boolean,
): Promise<AsyncGenerator<AgentStreamEvent> | null> {
  const body: Record<string, unknown> = {
    model: request.model,
    stream: true,
    input: [
      { role: "system", content: system },
      ...request.history.map((item) => ({ role: item.role, content: item.content })),
      { role: "user", content: user },
    ],
    text: { format: { type: "json_object" } },
  };
  if (thinkingLevel !== "none") {
    body.reasoning = includeSummary
      ? { effort: openaiEffort(thinkingLevel), summary: "auto" }
      : { effort: openaiEffort(thinkingLevel) };
  }
  const res = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) return null;
  return emitOpenAIStream(res, request);
}

async function* emitOpenAIStream(
  res: Response,
  request: AgentRequest,
): AsyncGenerator<AgentStreamEvent> {
  let output = "";
  let thinking = "";
  for await (const raw of readSseData(res)) {
    let event: {
      type?: string;
      delta?: string;
      text?: string;
      error?: { message?: string };
    };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "error" || event.type === "response.failed") {
      throw new Error(event.error?.message || "Streaming response failed.");
    }
    const delta = typeof event.delta === "string" ? event.delta : "";
    if (
      event.type === "response.reasoning_summary_text.delta" ||
      event.type === "response.reasoning_text.delta"
    ) {
      if (delta) {
        thinking += delta;
        yield { type: "thinking", delta };
      }
      continue;
    }
    if (event.type === "response.output_text.delta" && delta) {
      output += delta;
      const extracted = growingJsonString(output, "thinking");
      if (request.thinkingLevel !== "none" && extracted && extracted.length > thinking.length) {
        yield { type: "thinking", delta: extracted.slice(thinking.length) };
        thinking = extracted;
      }
    }
  }
  if (!output.trim()) throw new Error("Empty model response.");
  const parsed = parseAgentJson(output, thinking || undefined, request);
  yield {
    type: "done",
    result: { ...parsed, thinking: parsed.thinking || thinking || undefined, mock: false },
  };
}

async function tryChatStream(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  history: AgentHistoryMessage[],
  request: AgentRequest,
): Promise<AsyncGenerator<AgentStreamEvent> | null> {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      stream: true,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        ...history.map((item) => ({ role: item.role, content: item.content })),
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok || !res.body) return null;
  return emitChatStream(res, request);
}

async function* emitChatStream(res: Response, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
  let output = "";
  let thinking = "";
  for await (const raw of readSseData(res)) {
    let payload: { choices?: Array<{ delta?: { content?: string } }>; error?: { message?: string } };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      continue;
    }
    if (payload.error?.message) throw new Error(payload.error.message);
    const delta = payload.choices?.[0]?.delta?.content ?? "";
    if (!delta) continue;
    output += delta;
    const extracted = growingJsonString(output, "thinking");
    if (request.thinkingLevel !== "none" && extracted && extracted.length > thinking.length) {
      yield { type: "thinking", delta: extracted.slice(thinking.length) };
      thinking = extracted;
    }
  }
  if (!output.trim()) throw new Error("Empty model response.");
  const parsed = parseAgentJson(output, thinking || undefined, request);
  yield { type: "done", result: { ...parsed, mock: false } };
}

async function tryAnthropicStream(
  apiKey: string,
  request: AgentRequest,
  enableThinking: boolean,
): Promise<AsyncGenerator<AgentStreamEvent> | null> {
  const budget = anthropicThinkingBudget(request.thinkingLevel);
  const body: Record<string, unknown> = {
    model: request.model,
    stream: true,
    max_tokens: enableThinking && budget > 0 ? budget + 4096 : 4096,
    system: systemPrompt(request),
    messages: [
      ...request.history.map((item) => ({ role: item.role, content: item.content })),
      { role: "user", content: buildUserPrompt(request) },
    ],
  };
  if (enableThinking && budget > 0) {
    body.thinking = { type: "enabled", budget_tokens: budget };
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) return null;
  return emitAnthropicStream(res, request);
}

async function* emitAnthropicStream(res: Response, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
  let output = "";
  let thinking = "";
  for await (const raw of readSseData(res)) {
    let event: { type?: string; delta?: { type?: string; thinking?: string; text?: string } };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "content_block_delta") continue;
    if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
      thinking += event.delta.thinking;
      yield { type: "thinking", delta: event.delta.thinking };
      continue;
    }
    if (event.delta?.type === "text_delta" && event.delta.text) {
      output += event.delta.text;
    }
  }
  if (!output.trim()) throw new Error("Empty Claude response.");
  const parsed = parseAgentJson(output, thinking || undefined, request);
  yield { type: "done", result: { ...parsed, mock: false } };
}

async function* typewriteThinking(text: string): AsyncGenerator<AgentStreamEvent> {
  for (let i = 0; i < text.length; i += 4) {
    yield { type: "thinking", delta: text.slice(i, i + 4) };
    await wait(14);
  }
}

function growingJsonString(raw: string, key: string) {
  const token = `"${key}"`;
  const startKey = raw.indexOf(token);
  if (startKey < 0) return "";
  const colon = raw.indexOf(":", startKey + token.length);
  if (colon < 0) return "";
  const firstQuote = raw.indexOf('"', colon + 1);
  if (firstQuote < 0) return "";
  let value = "";
  for (let i = firstQuote + 1; i < raw.length; i += 1) {
    const char = raw[i];
    if (char === "\\" && raw[i + 1]) {
      const next = raw[i + 1];
      value += next === "n" ? "\n" : next === "t" ? "\t" : next;
      i += 1;
      continue;
    }
    if (char === '"') return value;
    value += char;
  }
  return value;
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
