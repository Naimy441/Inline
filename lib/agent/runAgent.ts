import {
  anthropicThinkingBudget,
  findAgentModel,
  openaiEffort,
  resolveAgentModel,
} from "@/lib/agent/models";
import { readSseData } from "@/lib/agent/sse";
import {
  executeServerTool,
  isClientTool,
  isServerTool,
  parseToolCalls,
  TOOL_GUIDE,
  type AgentToolCall,
} from "@/lib/agent/tools";
import type { AgentCitation, AgentEditDraft, AgentHistoryMessage, AgentRequest, AgentResponse, AgentStreamEvent, AgentTask } from "@/lib/agent/types";
import { lintWriting, summarizeLint } from "@/lib/writing/lint";
import { previewEdits } from "@/lib/writing/review";
import { documentOutline, retrieveChunks, shouldRetrieve } from "@/lib/writing/retrieve";
import { detectAiTropes, summarizeTropes } from "@/lib/writing/tropes";

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

export async function* runAgentStream(request: AgentRequest, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  const modelId = resolveAgentModel(request.model);
  const model = findAgentModel(modelId);
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  const next = { ...request, model: modelId };

  yield { type: "phase", phase: request.mode === "plan" ? "planning" : "thinking" };

  try {
    if (model?.provider === "anthropic") {
      if (!anthropicKey) throw new Error("Add ANTHROPIC_API_KEY to use Claude models.");
      yield* withResolvedTools(next, streamAnthropic(anthropicKey, next, signal), signal);
      return;
    }
    if (!openaiKey) {
      yield* withResolvedTools(next, streamMock(next, signal), signal);
      return;
    }
    yield* withResolvedTools(next, streamOpenAI(openaiKey, next, signal), signal);
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) return;
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
  const lint = lintWriting(document, request.pageCount ?? 1);
  const tropes = detectAiTropes(document);
  const tools: AgentToolCall[] = [];
  if (intent.includes("pdf") || intent.includes("export")) {
    tools.push({ id: "mock-pdf", name: "export_pdf", args: {}, hidden: true });
  }
  if (intent.includes("citation") || intent.includes("bibliograph")) {
    tools.push({ id: "mock-cite", name: "search_citations", args: { query: request.prompt }, hidden: true });
  }

  if (request.mode === "ask") {
    return {
      chatTitle,
      thinking,
      message: document
        ? `${askSummary(request.prompt, document)}\n\n${summarizeLint(lint)}\n${summarizeTropes(tropes)}`
        : "The document is empty, so there is nothing to answer from yet.",
      edits: [],
      tasks: [],
      tools,
    };
  }

  if (request.mode === "plan") {
    return {
      chatTitle,
      thinking,
      message: [
        "Here is a plan without changing the document:",
        "1. Read the draft, comments, and any locked passages.",
        "2. Decide what to keep, what to research, and what to rewrite.",
        "3. Switch to Agent mode when you want those edits applied in the page.",
      ].join("\n"),
      edits: [],
      tasks: mockTasks(request),
      tools,
    };
  }

  if (!requestAllowsEdits(request)) {
    return {
      chatTitle,
      thinking,
      message: `${askSummary(request.prompt, document)}\n\nNo document edits were proposed because this request is read-only.`,
      edits: [],
      tasks: [],
      tools,
    };
  }

  if (!document) {
    return { chatTitle, thinking, message: "The document is empty.", edits: [], tasks: [], tools };
  }

  if (request.comments?.length) {
    const first = request.comments[0];
    const target = first.quote || lastParagraph(document);
    return {
      chatTitle,
      thinking,
      message: `Addressed ${request.comments.length} comment${request.comments.length === 1 ? "" : "s"} in the draft.`,
      edits: [
        {
          find: target,
          replace: mockRewrite(target, first.body || request.prompt),
          reason: first.body || "Comment",
        },
      ],
      tasks: mockTasks(request),
      tools,
    };
  }

  if (/(?:delete|remove|erase|cut|strip)\b/.test(intent)) {
    const selected = selectedContextText(request);
    const newline = /(?:line\s*break|paragraph\s*break|blank\s*line|new\s*line)/.test(intent)
      ? document.match(/\n{1,}/)?.[0] ?? ""
      : "";
    const target = selected || newline || mockEditSource(request, document);
    if (target) {
      return {
        chatTitle,
        thinking,
        message: "Prepared a deletion for review. Keep or undo it in the page.",
        edits: [{ find: target, replace: "", operation: "delete", reason: "Delete requested content" }],
        tasks: [],
        tools,
      };
    }
  }

  if (intent.includes("grammar") || intent.includes("spelling") || intent.includes("formatting")) {
    const source = mockEditSource(request, document);
    return {
      chatTitle,
      thinking,
      message: "Grammar, spelling, and formatting pass is ready to keep or undo.",
      edits: [{ find: source, replace: mockGrammar(source), reason: "Grammar pass" }],
      tasks: [],
      tools,
    };
  }

  if (intent.includes("trope") || intent.includes("watermark") || intent.includes("em dash") || intent.includes("ai writing")) {
    const source = mockEditSource(request, document);
    return {
      chatTitle,
      thinking,
      message: tropes.length ? `Cleaned ${tropes.length} AI-writing flags.` : "No obvious AI tropes. Tightened the selected prose anyway.",
      edits: [{ find: source, replace: mockRewrite(source, "remove AI tropes"), reason: "AI trope clean" }],
      tasks: [],
      tools,
    };
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
      tasks: [],
      tools,
    };
  }
  const source = mockEditSource(request, document);
  return {
    chatTitle,
    thinking,
    message: request.preserveTone
      ? "Proposed a targeted edit that keeps the current tone. Keep or undo it in the page."
      : "Proposed a targeted edit. Keep or undo it in the page.",
    edits: [
      {
        find: source,
        replace: mockRewrite(source, request.prompt),
        reason: request.selection ? "Uses the highlighted passage as extra context" : "Document edit",
      },
    ],
    tasks: [],
    tools,
  };
}

function requestSelections(request: AgentRequest) {
  return request.selections?.length ? request.selections : request.selection ? [request.selection] : [];
}

function selectedContextText(request: AgentRequest) {
  return requestSelections(request)
    .map((selection) => selection.text)
    .filter((text) => text.trim())
    .join("\n\n");
}

function mockEditSource(request: AgentRequest, document: string) {
  const selections = requestSelections(request);
  const selected = selections[selections.length - 1]?.text.trim();
  const intent = request.prompt.toLowerCase();
  if (selected && /\b(this|selection|selected|passage|highlight|highlighted)\b/.test(intent)) {
    return selected;
  }
  return lastParagraph(document);
}

function mockThinking(request: AgentRequest) {
  if (request.mode === "ask") {
    return "I will stay in the document and answer from what is already written, without proposing edits.";
  }
  if (request.mode === "plan") {
    return "I will outline the work first: what to keep, what to change, and when the user should switch back to Agent.";
  }
  if (requestSelections(request).length > 0) {
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
  const canEdit = requestAllowsEdits(request);
  const lines = [
    "You are Inline, a writing agent inside a Google Docs-style editor.",
    `Current mode: ${request.mode}.`,
    request.preserveTone
      ? "Preserve the author's tone, diction, and rhythm unless the user asks to change style."
      : "You may adjust tone if it helps the instruction.",
    canEdit
      ? "You may propose as many document edits and hidden document tools as the task needs. There is no cap on the number or size of edits."
      : "Do not propose document edits. Return an empty edits array.",
    'Return ONLY a JSON object, keys in this exact order: {"thinking"?: string, "edits": [{"find": string, "replace": string, "operation"?: "replace"|"insert"|"delete", "occurrence"?: number, "reason": string}], "tasks"?: [{"title": string, "status": "pending"|"in_progress"|"done", "kind"?: "research"|"draft"|"edit"|"cite"|"review"}], "tools"?: [{"name": string, "args"?: object}], "citations"?: [{"id": string, "author": string, "title": string, "year": string, "inline": string, "bibliography": string}], "message": string, "chatTitle"?: string}',
    "The DOCUMENT is the source of truth. SELECTIONS are optional context attachments. They do not limit the document and are not the only places you may change.",
    "LOCKED passages must not appear in any find/replace.",
    "Comments are instructions about specific quotes. Address every provided comment.",
    "Style attachments are samples to mimic, not text to copy wholesale.",
    "Rules:",
    '- Each non-empty "find" must be an exact substring of the DOCUMENT, including spaces and \\n characters. Do not invent text that is not already there.',
    '- To delete content, use the exact content as "find", set "replace" to "", and set operation to "delete". Deleting a paragraph break means finding "\\n" or "\\n\\n" exactly.',
    '- To add a new paragraph, find the paragraph it should follow and set "replace" to that same paragraph, then \\n\\n, then the new paragraph; or use operation "insert" with find "" to append.',
    '- If the same find text appears more than once, set zero-based "occurrence" to identify the intended match.',
    "- Make every edit the instruction requires. Keep names, facts, and meaning unless the user asks to change them.",
    "- Do not invent citations. Use search_citations or attached sources only.",
    "- When search_citations returns sources, include the useful sources in citations with the exact inline and bibliography strings.",
    '- "message" comes last. Tell the user what changed and why. Never paste, quote, or rewrite the new document text — the edits already show the prose. In plan mode it should be a numbered plan. In ask mode it should answer or ideate without rewriting the page.',
    "The latest user instruction is the active task. Treat earlier conversation turns as background only; do not repeat an earlier action unless the latest instruction explicitly asks for it.",
    "- tools are executed silently. The user does not need to see them. Call a tool only when you need it — do not call lint or counts by default.",
    "- count_words and lint_writing are how you check length. If the user asked for N words, sentences, paragraphs, or pages, write the draft, call the tool on that text, and fix the edit if the result misses. Do not mention tools unless asked.",
    "Available tools:",
    TOOL_GUIDE,
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
  const selections = requestSelections(request);
  const full = request.document;
  const long = shouldRetrieve(full);
  const lint = lintWriting(full, request.pageCount ?? 1);
  const tropes = detectAiTropes(full);
  const lines = [
    `Document title: ${request.title || "Untitled document"}`,
    "ACTIVE REQUEST: Follow only the instruction below. Earlier turns are already handled background, not additional tasks.",
    request.preserveTone ? "Tone lock: preserve existing voice." : "Tone lock: off.",
    "",
    "Instruction:",
    request.prompt.trim(),
    "",
    "Writing lint:",
    summarizeLint(lint),
    `AI tropes: ${summarizeTropes(tropes)}`,
    "",
  ];
  if (long) {
    const chunks = retrieveChunks(full, request.prompt, 6);
    lines.push(
    "The document is long. Retrieval is only a navigation aid. The complete document below remains the source of truth for every edit:",
    "<<<DOCUMENT_INDEX>>>",
    documentIndex(full),
    "<<<END_DOCUMENT_INDEX>>>",
    "",
    "<<<OUTLINE>>>",
    documentOutline(full),
    "<<<END_OUTLINE>>>",
      "",
      "<<<RETRIEVED>>>",
      chunks.map((chunk, index) => `[${index + 1}] ${chunk.text}`).join("\n\n"),
      "<<<END_RETRIEVED>>>",
      "",
      "Full document (source of truth):",
      "<<<DOCUMENT>>>",
      full || "(empty)",
      "<<<END_DOCUMENT>>>",
      "",
    );
  } else {
    lines.push(
      "Full document (source of truth):",
      "<<<DOCUMENT>>>",
      full || "(empty)",
      "<<<END_DOCUMENT>>>",
      "",
    );
  }
  if (selections.length > 0) {
    lines.push(
      `The user attached ${selections.length} highlighted passage${selections.length === 1 ? "" : "s"} as extra context only. They do not limit where you may edit:`,
      "<<<SELECTIONS>>>",
      selections
        .map(
          (selection, index) =>
            `Selection ${index + 1}:\n${selection.text}\nNearby before: ${selection.before || "(start)"}\nNearby after: ${selection.after || "(end)"}`,
        )
        .join("\n\n"),
      "<<<END_SELECTIONS>>>",
    );
    lines.push("");
  }
  if (request.previousEdits?.length) {
    lines.push(
      "Earlier document edits already handled in this chat. Do not emit these edits again unless the active request explicitly asks to repeat or undo them:",
      "<<<PRIOR_EDITS>>>",
      request.previousEdits
        .map((edit, index) => {
          const operation = edit.operation ?? (edit.replace === "" ? "delete" : "replace");
          return `${index + 1}. ${edit.status} ${operation}: find=${JSON.stringify(edit.find)} replace=${JSON.stringify(edit.replace)}${edit.occurrence == null ? "" : ` occurrence=${edit.occurrence}`}`;
        })
        .join("\n"),
      "<<<END_PRIOR_EDITS>>>",
      "",
    );
  }
  if (request.comments?.length) {
    lines.push(
      "Comments to address:",
      "<<<COMMENTS>>>",
      request.comments
        .map((comment, index) => `${index + 1}. Quote: ${comment.quote}\n   Note: ${comment.body || "(no note)"}`)
        .join("\n"),
      "<<<END_COMMENTS>>>",
      "",
    );
  }
  if (request.lockedRanges?.length) {
    lines.push(
      "LOCKED passages. Do not edit these:",
      "<<<LOCKED>>>",
      request.lockedRanges.map((range) => `- ${range.text}`).join("\n"),
      "<<<END_LOCKED>>>",
      "",
    );
  }
  if (request.attachments?.length) {
    lines.push(
      "Style samples to mimic:",
      "<<<STYLE>>>",
      request.attachments.map((file) => `## ${file.name}\n${file.text}`).join("\n\n"),
      "<<<END_STYLE>>>",
      "",
    );
  }
  return lines.join("\n");
}

function documentIndex(text: string) {
  let offset = 0;
  return text
    .split(/\n+/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph, index) => {
      const start = text.indexOf(paragraph, offset);
      const end = start >= 0 ? start + paragraph.length : offset + paragraph.length;
      offset = Math.max(offset, end);
      return `[P${index + 1}] chars ${start >= 0 ? start : 0}-${end}: ${paragraph.slice(0, 180)}`;
    })
    .join("\n");
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
    tasks?: unknown;
    tools?: unknown;
    citations?: unknown;
  };
  const allowEdits = requestAllowsEdits(request);
  const edits = allowEdits ? normalizeEdits(json.edits) : [];
  const thinking =
    request.thinkingLevel === "none"
      ? undefined
      : (typeof json.thinking === "string" && json.thinking.trim()) || nativeThinking;
  const chatTitle =
    request.nameChat && typeof json.chatTitle === "string"
      ? json.chatTitle.replace(/\s+/g, " ").trim()
      : undefined;
  return {
    message: sanitizeAgentMessage(
      typeof json.message === "string" ? json.message : "",
      edits,
      request.mode,
    ),
    thinking: thinking?.trim() || undefined,
    chatTitle: chatTitle && chatTitle.length >= 2 && chatTitle.length <= 48 ? chatTitle : undefined,
    edits,
    tasks: parseTasks(json.tasks),
    tools: parseToolCalls(json.tools),
    // Citations are trusted only when they come back from the server-side source tool.
    // The model may request them in JSON, but it must not be able to manufacture source cards.
    citations: [],
  };
}

function defaultMessage(mode: AgentRequest["mode"]) {
  if (mode === "plan") return "Here is a plan for the document.";
  if (mode === "ask") return "Here is what the document shows.";
  return "I made a targeted change. Keep or undo it in the page.";
}

function sanitizeAgentMessage(message: string, edits: AgentEditDraft[], mode: AgentRequest["mode"]) {
  const trimmed = message.trim();
  if (mode !== "agent" || !edits.length) return trimmed || defaultMessage(mode);
  const compact = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase();
  const msg = compact(trimmed);
  if (!msg) return fallbackEditMessage(edits);
  for (const edit of edits) {
    const replace = compact(edit.replace);
    const find = compact(edit.find);
    if (replace && msg === replace) return fallbackEditMessage(edits);
    if (find && msg === find) return fallbackEditMessage(edits);
    if (replace.length > 40 && msg.includes(replace)) return fallbackEditMessage(edits);
    if (msg.length > 80 && replace.includes(msg)) return fallbackEditMessage(edits);
    if (replace.length > 80 && msg.includes(replace.slice(0, 80))) return fallbackEditMessage(edits);
  }
  return trimmed;
}

function fallbackEditMessage(edits: AgentEditDraft[]) {
  const reasons = edits.map((edit) => edit.reason?.trim()).filter((reason): reason is string => Boolean(reason));
  if (reasons.length === 1) return `${reasons[0].replace(/\.+$/, "")}. Keep or undo it in the page.`;
  if (reasons.length > 1) return `I made ${edits.length} targeted changes. Keep or undo them in the page.`;
  return defaultMessage("agent");
}

function normalizeEdits(raw: unknown): AgentEditDraft[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): AgentEditDraft | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as { find?: unknown; replace?: unknown; reason?: unknown; operation?: unknown; occurrence?: unknown };
      if (typeof row.replace !== "string") return null;
      const find = typeof row.find === "string" ? row.find : "";
      if (!find && !row.replace) return null;
      const operation = row.operation === "replace" || row.operation === "insert" || row.operation === "delete"
        ? row.operation
        : undefined;
      const occurrence = typeof row.occurrence === "number" && Number.isInteger(row.occurrence) && row.occurrence >= 0
        ? row.occurrence
        : undefined;
      return {
        find,
        replace: row.replace,
        operation,
        occurrence,
        reason: typeof row.reason === "string" ? row.reason : undefined,
      };
    })
    .filter((item): item is AgentEditDraft => item !== null);
}

function unwrapFence(raw: string) {
  const trimmed = raw.trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1] : trimmed;
}

async function* streamMock(request: AgentRequest, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  const result = { ...mockAgent(request), mock: true };
  if (result.thinking) yield* typewriteThinking(result.thinking, signal);
  if (result.edits.length) {
    yield { type: "phase", phase: "editing" };
    await wait(160, signal);
    yield { type: "edits", edits: result.edits };
    await wait(220, signal);
  }
  if (result.message) yield* typewriteMessage(result.message, false, signal);
  yield { type: "done", result };
}

async function* streamOpenAI(apiKey: string, request: AgentRequest, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  const model = request.model;
  const user = buildUserPrompt(request);
  const system = systemPrompt(request);
  const native = request.thinkingLevel !== "none" && Boolean(findAgentModel(model)?.thinking);
  const attempts = [
    () => tryResponsesStream(apiKey, request, system, user, native ? request.thinkingLevel : "none", true, signal),
    () => tryResponsesStream(apiKey, request, system, user, native ? request.thinkingLevel : "none", false, signal),
    () => tryChatStream(apiKey, model, system, user, request.history, request, signal),
  ];
  for (const attempt of attempts) {
    try {
      const stream = await attempt();
      if (!stream) continue;
      yield* stream;
      return;
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw abortError();
      continue;
    }
  }
  const parsed = await completeOpenAI(apiKey, request);
  yield* revealResult(parsed, signal);
  yield { type: "done", result: { ...parsed, mock: false } };
}

async function* streamAnthropic(apiKey: string, request: AgentRequest, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  const withThinking = request.thinkingLevel !== "none";
  const first = await tryAnthropicStream(apiKey, request, withThinking, signal);
  if (first) {
    yield* first;
    return;
  }
  if (withThinking) {
    const second = await tryAnthropicStream(apiKey, request, false, signal);
    if (second) {
      yield* second;
      return;
    }
  }
  const parsed = await completeAnthropic(apiKey, request);
  yield* revealResult(parsed, signal);
  yield { type: "done", result: { ...parsed, mock: false } };
}

async function tryResponsesStream(
  apiKey: string,
  request: AgentRequest,
  system: string,
  user: string,
  thinkingLevel: AgentRequest["thinkingLevel"],
  includeSummary: boolean,
  signal?: AbortSignal,
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
    signal,
  });
  if (!res.ok || !res.body) return null;
  return emitOpenAIStream(res, request);
}

async function* emitOpenAIStream(
  res: Response,
  request: AgentRequest,
): AsyncGenerator<AgentStreamEvent> {
  let output = "";
  let nativeThinking = "";
  const progress = createStreamProgress();
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
        nativeThinking += delta;
        yield { type: "thinking", delta };
      }
      continue;
    }
    if (event.type === "response.output_text.delta" && delta) {
      output += delta;
      yield* emitJsonProgress(output, request, progress);
    }
  }
  if (!output.trim()) throw new Error("Empty model response.");
  const parsed = parseAgentJson(output, nativeThinking || progress.thinking || undefined, request);
  yield* finishProgress(parsed, progress);
  yield {
    type: "done",
    result: { ...parsed, thinking: parsed.thinking || nativeThinking || progress.thinking || undefined, mock: false },
  };
}

async function tryChatStream(
  apiKey: string,
  model: string,
  system: string,
  user: string,
  history: AgentHistoryMessage[],
  request: AgentRequest,
  signal?: AbortSignal,
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
    signal,
  });
  if (!res.ok || !res.body) return null;
  return emitChatStream(res, request);
}

async function* emitChatStream(res: Response, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
  let output = "";
  const progress = createStreamProgress();
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
    yield* emitJsonProgress(output, request, progress);
  }
  if (!output.trim()) throw new Error("Empty model response.");
  const parsed = parseAgentJson(output, progress.thinking || undefined, request);
  yield* finishProgress(parsed, progress);
  yield { type: "done", result: { ...parsed, mock: false } };
}

async function tryAnthropicStream(
  apiKey: string,
  request: AgentRequest,
  enableThinking: boolean,
  signal?: AbortSignal,
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
    signal,
  });
  if (!res.ok || !res.body) return null;
  return emitAnthropicStream(res, request);
}

async function* emitAnthropicStream(res: Response, request: AgentRequest): AsyncGenerator<AgentStreamEvent> {
  let output = "";
  let nativeThinking = "";
  const progress = createStreamProgress();
  for await (const raw of readSseData(res)) {
    let event: { type?: string; delta?: { type?: string; thinking?: string; text?: string } };
    try {
      event = JSON.parse(raw) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "content_block_delta") continue;
    if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
      nativeThinking += event.delta.thinking;
      yield { type: "thinking", delta: event.delta.thinking };
      continue;
    }
    if (event.delta?.type === "text_delta" && event.delta.text) {
      output += event.delta.text;
      yield* emitJsonProgress(output, request, progress);
    }
  }
  if (!output.trim()) throw new Error("Empty Claude response.");
  const parsed = parseAgentJson(output, nativeThinking || progress.thinking || undefined, request);
  yield* finishProgress(parsed, progress);
  yield { type: "done", result: { ...parsed, mock: false } };
}

async function* typewriteThinking(text: string, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  for (let i = 0; i < text.length; i += 4) {
    if (signal?.aborted) throw abortError();
    yield { type: "thinking", delta: text.slice(i, i + 4) };
    await wait(14, signal);
  }
}

async function* typewriteMessage(text: string, reset = false, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  for (let i = 0; i < text.length; i += 3) {
    if (signal?.aborted) throw abortError();
    yield { type: "message", delta: text.slice(i, i + 3), reset: reset && i === 0 };
    await wait(12, signal);
  }
}

type StreamProgress = {
  thinking: string;
  message: string;
  editsEmitted: boolean;
};

function createStreamProgress(): StreamProgress {
  return { thinking: "", message: "", editsEmitted: false };
}

function* emitJsonProgress(
  output: string,
  request: AgentRequest,
  state: StreamProgress,
): Generator<AgentStreamEvent> {
  const thinking = growingJsonString(output, "thinking");
  if (request.thinkingLevel !== "none" && thinking.length > state.thinking.length) {
    yield { type: "thinking", delta: thinking.slice(state.thinking.length) };
    state.thinking = thinking;
  }
  if (!state.editsEmitted && requestAllowsEdits(request)) {
    const rawEdits = growingJsonArray(output, "edits");
    if (rawEdits) {
      state.editsEmitted = true;
      const edits = normalizeEdits(rawEdits);
      if (edits.length) {
        yield { type: "phase", phase: "editing" };
        yield { type: "edits", edits };
      }
    }
  }
  if (request.mode !== "agent") {
    const message = growingJsonString(output, "message");
    if (message.length > state.message.length) {
      yield { type: "message", delta: message.slice(state.message.length) };
      state.message = message;
    }
  }
}

function requestAllowsEdits(request: AgentRequest) {
  if (request.mode !== "agent") return false;
  return !/\b(?:do\s+not|don't|dont|without|no)\s+(?:edit|editing|change|changes|rewrite|rewriting)\b/i.test(request.prompt);
}

async function* revealResult(parsed: Omit<AgentResponse, "mock">, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  if (parsed.thinking) yield* typewriteThinking(parsed.thinking, signal);
  if (parsed.edits.length) {
    yield { type: "phase", phase: "editing" };
    yield { type: "edits", edits: parsed.edits };
    await wait(180, signal);
  }
  if (parsed.message) yield* typewriteMessage(parsed.message, false, signal);
}

async function* finishProgress(
  parsed: Omit<AgentResponse, "mock">,
  state: StreamProgress,
): AsyncGenerator<AgentStreamEvent> {
  if (!state.editsEmitted && parsed.edits.length) {
    yield { type: "phase", phase: "editing" };
    yield { type: "edits", edits: parsed.edits };
    await wait(120);
  }
  if (parsed.message && parsed.message.length > state.message.length) {
    yield* typewriteMessage(parsed.message.slice(state.message.length));
  }
}

function growingJsonArray(raw: string, key: string): unknown[] | null {
  const token = `"${key}"`;
  const startKey = raw.indexOf(token);
  if (startKey < 0) return null;
  const colon = raw.indexOf(":", startKey + token.length);
  if (colon < 0) return null;
  const bracket = raw.indexOf("[", colon + 1);
  if (bracket < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = bracket; i < raw.length; i += 1) {
    const char = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\" && inString) {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "[") depth += 1;
    if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(raw.slice(bracket, i + 1));
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
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

function wait(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(resolve, ms);
    if (!signal) return;
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown) {
  return (
    (error instanceof Error && (error.name === "AbortError" || /aborted|AbortError/i.test(error.message))) ||
    (typeof DOMException !== "undefined" && error instanceof DOMException && error.name === "AbortError")
  );
}

function abortError() {
  return typeof DOMException !== "undefined" ? new DOMException("Aborted", "AbortError") : Object.assign(new Error("Aborted"), { name: "AbortError" });
}

function parseTasks(raw: unknown): AgentTask[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): AgentTask | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as { title?: unknown; status?: unknown; kind?: unknown; id?: unknown };
      if (typeof row.title !== "string" || !row.title.trim()) return null;
      const status =
        row.status === "done" || row.status === "in_progress" || row.status === "pending" ? row.status : "pending";
      const kind =
        row.kind === "research" || row.kind === "draft" || row.kind === "edit" || row.kind === "cite" || row.kind === "review"
          ? row.kind
          : undefined;
      return {
        id: typeof row.id === "string" && row.id ? row.id : crypto.randomUUID(),
        title: row.title.trim(),
        status,
        kind,
      };
    })
    .filter((item): item is AgentTask => item !== null);
}

function normalizeCitations(raw: unknown): AgentCitation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): AgentCitation | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      if (typeof row.title !== "string" || typeof row.author !== "string") return null;
      const year = typeof row.year === "string" || typeof row.year === "number" ? String(row.year) : "";
      const inline = typeof row.inline === "string" && row.inline.trim() ? row.inline : `(${row.author}, ${year})`;
      const bibliography = typeof row.bibliography === "string" && row.bibliography.trim()
        ? row.bibliography
        : [row.author, row.title, row.publisher, year].filter(Boolean).join(". ") + ".";
      return {
        id: typeof row.id === "string" && row.id ? row.id : crypto.randomUUID(),
        author: row.author,
        title: row.title,
        year,
        publisher: typeof row.publisher === "string" ? row.publisher : undefined,
        url: typeof row.url === "string" && /^https?:\/\//i.test(row.url) ? row.url : undefined,
        inline,
        bibliography,
      };
    })
    .filter((item): item is AgentCitation => item !== null);
}

function mockTasks(request: AgentRequest): AgentTask[] {
  const comments = request.comments?.length ?? 0;
  return [
    { id: "task-read", title: "Read the current draft and instruction", status: "done", kind: "review" },
    {
      id: "task-research",
      title: comments ? `Resolve ${comments} comment${comments === 1 ? "" : "s"}` : "Gather any missing facts",
      status: "pending",
      kind: comments ? "edit" : "research",
    },
    { id: "task-draft", title: "Apply a tight revision pass", status: "pending", kind: "draft" },
  ];
}

function mockGrammar(text: string) {
  return text
    .replace(/\s+/g, " ")
    .replace(/\s+,/g, ",")
    .replace(/\s+\./g, ".")
    .replace(/\bi\b/g, "I")
    .replace(/(^|[.!?]\s+)([a-z])/g, (_, left: string, letter: string) => left + letter.toUpperCase())
    .replace(/[^.!?]$/, (value) => `${value}.`);
}

async function* withResolvedTools(
  request: AgentRequest,
  source: AsyncGenerator<AgentStreamEvent>,
  signal?: AbortSignal,
): AsyncGenerator<AgentStreamEvent> {
  for await (const event of source) {
    if (signal?.aborted) throw abortError();
    if (event.type !== "done") {
      yield event;
      continue;
    }
    let current = event.result;
    let round = 0;
    const clientTools: AgentToolCall[] = [];
    const citations = [...(current.citations ?? [])];
    let prompt = request.prompt;

    while (round < 24) {
      const serverCalls = (current.tools ?? []).filter((tool) => isServerTool(tool.name));
      if (requestAllowsEdits(request)) {
        clientTools.push(...(current.tools ?? []).filter((tool) => isClientTool(tool.name)));
      }
      if (!serverCalls.length) break;
      yield { type: "phase", phase: "reviewing" };
      for (const tool of serverCalls) {
        yield { type: "tool", name: tool.name, hidden: tool.hidden };
      }
      const proposed = current.edits.length ? previewEdits(request.document, current.edits) : request.document;
      const results = serverCalls.map((call) => executeServerTool(call, {
        document: proposed,
        prompt: request.prompt,
        pageCount: request.pageCount,
      }));
      for (const tool of serverCalls) {
        yield { type: "tool_result", name: tool.name, hidden: tool.hidden };
      }
      citations.push(...citationResults(results));
      round += 1;
      prompt = `${prompt}\n\nHidden tool results (use them, do not mention tools unless asked):\n${JSON.stringify(results)}`;
      try {
        const parsed = await completeFollowUp({
          ...request,
          nameChat: false,
          reviewAttempt: round,
          prompt,
        });
        current = {
          message: parsed.message || current.message,
          thinking: parsed.thinking || current.thinking,
          chatTitle: current.chatTitle || parsed.chatTitle,
          edits: parsed.edits.length ? parsed.edits : current.edits,
          tasks: parsed.tasks.length ? parsed.tasks : current.tasks,
          tools: parsed.tools,
          citations: current.citations,
          mock: current.mock,
        };
      } catch {
        break;
      }
    }

    const next: AgentResponse = {
      ...current,
      tools: clientTools,
      citations: dedupeCitations(citations),
      tasks: current.tasks ?? [],
    };
    if (next.edits.length && next.edits !== event.result.edits) {
      yield { type: "phase", phase: "editing" };
      yield { type: "edits", edits: next.edits };
      await wait(160, signal);
    }
    if (next.message && next.message !== event.result.message) {
      yield* typewriteMessage(next.message, true, signal);
    }
    if (next.tasks.length) yield { type: "tasks", tasks: next.tasks };
    if (next.citations?.length) yield { type: "citations", citations: next.citations };
    yield { type: "done", result: next };
  }
}

function citationResults(results: Array<{ name: string; result: unknown }>): AgentCitation[] {
  const found: AgentCitation[] = [];
  for (const item of results) {
    if (item.name !== "search_citations" || !Array.isArray(item.result)) continue;
    found.push(...normalizeCitations(item.result));
  }
  return found;
}

function dedupeCitations(citations: AgentCitation[]) {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = citation.id || `${citation.author}:${citation.title}:${citation.year}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function completeFollowUp(request: AgentRequest): Promise<Omit<AgentResponse, "mock">> {
  const model = findAgentModel(request.model);
  const openaiKey = process.env.OPENAI_API_KEY?.trim();
  const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (model?.provider === "anthropic" && anthropicKey) return completeAnthropic(anthropicKey, request);
  if (openaiKey) return completeOpenAI(openaiKey, request);
  return mockAgent(request);
}
