import { findAgentModel, openaiEffort, anthropicThinkingBudget, resolveAgentModel } from "@/lib/agent/models";
import { connectDocumentMcp, toAnthropicTools, toOpenAIChatTools, toOpenAITools, type DocumentMcpRuntime } from "@/lib/agent/mcp/runtime";
import { DocumentSession } from "@/lib/agent/mcp/session";
import {
  defaultMessage,
  mockTitle,
  recentHistory,
  requestAllowsEdits,
  sanitizeAgentMessage,
  stepHits,
  stepTitle,
  systemPrompt,
  userPrompt,
} from "@/lib/agent/mcp/prompt";
import {
  abortError,
  backoffFetch,
  HttpError,
  isAbortError,
  isAuthError,
  isRateLimitError,
  publicModelError,
} from "@/lib/agent/retry";
import { readSseData } from "@/lib/agent/sse";
import type { AgentToolCall, AgentToolName } from "@/lib/agent/tools";
import type {
  AgentCitation,
  AgentEditDraft,
  AgentRequest,
  AgentResponse,
  AgentStreamEvent,
  AgentTask,
  AgentUsage,
} from "@/lib/agent/types";

const MAX_ROUNDS = 24;

export async function runAgent(request: AgentRequest): Promise<AgentResponse> {
  let result: AgentResponse | null = null;
  for await (const event of runAgentStream(request)) {
    if (event.type === "done") result = event.result;
    if (event.type === "error") throw new Error(event.error);
  }
  if (!result) throw new Error("The agent did not finish.");
  return result;
}

export async function* runAgentStream(request: AgentRequest, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  const next: AgentRequest = {
    ...request,
    model: resolveAgentModel(request.model),
    history: recentHistory(request),
  };
  const session = new DocumentSession({
    title: next.title,
    text: next.document,
    pages: next.pages,
    locked: next.lockedRanges,
  });
  const runtime = await connectDocumentMcp(session, {
    allowWrites: requestAllowsEdits(next),
    allowClient: next.mode === "agent",
  });

  yield { type: "phase", phase: next.mode === "plan" ? "planning" : "thinking" };

  try {
    const model = findAgentModel(next.model);
    const openaiKey = process.env.OPENAI_API_KEY?.trim();
    const anthropicKey = process.env.ANTHROPIC_API_KEY?.trim();

    if (model?.provider === "anthropic") {
      if (!anthropicKey) throw new Error("Add ANTHROPIC_API_KEY to use Claude models.");
      yield* runProviderLoop(next, runtime, createAnthropicDriver(anthropicKey, next, runtime, signal), signal);
      return;
    }
    if (!openaiKey) {
      yield* runMockLoop(next, runtime, signal);
      return;
    }
    yield* runProviderLoop(next, runtime, createOpenAIDriver(openaiKey, next, runtime, signal), signal);
  } catch (error) {
    if (isAbortError(error) || signal?.aborted) return;
    yield {
      type: "error",
      error: publicModelError(error instanceof Error ? error.message : "Model request failed."),
    };
  } finally {
    await runtime.close();
  }
}

type ProviderDriver = {
  round: (tools: Awaited<ReturnType<DocumentMcpRuntime["listTools"]>>) => AsyncGenerator<ProviderEvent>;
  continueWith: (results: Array<{ call: ProviderToolCall; text: string }>) => void;
};

async function* runProviderLoop(
  request: AgentRequest,
  runtime: DocumentMcpRuntime,
  driver: ProviderDriver,
  signal?: AbortSignal,
): AsyncGenerator<AgentStreamEvent> {
  const tools = await runtime.listTools();
  const edits: AgentEditDraft[] = [];
  const citations: AgentCitation[] = [];
  const toolsUsed: AgentToolCall[] = [];
  let message = "";
  let thinking = "";
  let tasks: AgentTask[] = [];
  let chatTitle: string | undefined;
  let usage: AgentUsage | undefined;

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    if (signal?.aborted) throw abortError();
    const calls: ProviderToolCall[] = [];
    let retryStepId: string | undefined;
    for await (const event of driver.round(tools)) {
      if (event.type === "retry") {
        retryStepId = `retry-${round}-${event.attempt}`;
        yield {
          type: "step",
          step: {
            id: retryStepId,
            name: "retry",
            title: event.message,
            status: "active",
            detail: `Waiting ${Math.max(1, Math.ceil(event.delayMs / 1000))}s`,
          },
        };
        continue;
      }
      if (retryStepId && (event.type === "thinking" || event.type === "message" || event.type === "tool_call")) {
        yield {
          type: "step",
          step: { id: retryStepId, name: "retry", title: "Resumed after retry", status: "complete" },
        };
        retryStepId = undefined;
      }
      if (event.type === "thinking" && event.delta) {
        thinking += event.delta;
        yield { type: "thinking", delta: event.delta };
      } else if (event.type === "message" && event.delta) {
        message += event.delta;
        yield { type: "message", delta: event.delta };
      } else if (event.type === "usage") {
        usage = mergeUsage(usage, event.usage);
        yield { type: "usage", usage };
      } else if (event.type === "tool_call") {
        calls.push(event.call);
      }
    }
    if (retryStepId) {
      yield {
        type: "step",
        step: { id: retryStepId, name: "retry", title: "Resumed after retry", status: "complete" },
      };
    }

    if (!calls.length) break;

    const outputs: Array<{ call: ProviderToolCall; text: string }> = [];
    for (const call of calls) {
      const stepId = call.id || `tool-${call.name}-${crypto.randomUUID()}`;
      yield { type: "tool", name: call.name, hidden: true };
      yield {
        type: "step",
        step: { id: stepId, name: call.name, title: stepTitle(call.name, call.args), status: "active" },
      };
      const result = await runtime.callTool(call.name, call.args);
      yield* emitExecuted(runtime, { ...call, id: stepId }, result);
      if (result.meta.edit) {
        edits.push(result.meta.edit);
        yield { type: "phase", phase: "editing" };
        yield { type: "edits", edits: [result.meta.edit] };
      }
      if (result.meta.citations?.length) {
        citations.push(...result.meta.citations);
        yield { type: "citations", citations: dedupeCitations(citations) };
      }
      if (result.meta.tasks) {
        tasks = result.meta.tasks;
        yield { type: "tasks", tasks };
      }
      if (result.meta.chatTitle) chatTitle = result.meta.chatTitle;
      toolsUsed.push({
        id: stepId,
        name: call.name as AgentToolName,
        args: call.args,
        hidden: true,
      });
      outputs.push({ call, text: result.text });
    }
    driver.continueWith(outputs);
  }

  const result = finishResult(request, runtime, {
    message,
    thinking,
    edits,
    citations,
    clientTools: toolsUsed,
    tasks,
    chatTitle,
    mock: false,
  });
  if (result.tasks.length) yield { type: "tasks", tasks: result.tasks };
  if (result.citations?.length) yield { type: "citations", citations: result.citations };
  if (usage) yield { type: "usage", usage };
  if (!message && result.message) yield* typewrite("message", result.message, signal);
  yield { type: "done", result };
}

async function* runMockLoop(
  request: AgentRequest,
  runtime: DocumentMcpRuntime,
  signal?: AbortSignal,
): AsyncGenerator<AgentStreamEvent> {
  const thinking = mockThinking(request);
  if (thinking && request.thinkingLevel !== "none") yield* typewrite("thinking", thinking, signal);

  const outline = await runtime.callTool("get_outline", {});
  yield* emitExecuted(runtime, { name: "get_outline", args: {}, id: "outline" }, outline, { silent: true });

  const edits: AgentEditDraft[] = [];
  const toolsUsed: AgentToolCall[] = [
    { id: "outline", name: "get_outline", args: {}, hidden: true },
  ];
  const canEdit = requestAllowsEdits(request);
  const intent = request.prompt.toLowerCase();
  const selected = request.selection?.text.trim() || request.selections?.[0]?.text.trim() || "";

  if (canEdit) {
    if (intent.includes("pdf") || intent.includes("export")) {
      const pdf = await runtime.callTool("export_pdf", {});
      yield* emitExecuted(runtime, { name: "export_pdf", args: {}, id: "pdf" }, pdf);
      toolsUsed.push({ id: "pdf", name: "export_pdf", args: {}, hidden: true });
    }

    if (!runtime.session.text.trim()) {
      const inserted = await runtime.callTool("insert_text", {
        text: mockEmptyInsert(request.prompt),
        reason: "Start the empty draft",
      });
      yield* emitExecuted(runtime, { name: "insert_text", args: {}, id: "insert" }, inserted);
      toolsUsed.push({ id: "insert", name: "insert_text", args: {}, hidden: true });
      if (inserted.meta.edit) {
        edits.push(inserted.meta.edit);
        yield { type: "phase", phase: "editing" };
        yield { type: "edits", edits: [inserted.meta.edit] };
      }
    } else {
      const source = selected || lastParagraph(runtime.session.text);
      const replace = mockRewrite(source, request.prompt);
      const replaced = await runtime.callTool("replace_text", {
        find: source,
        replace,
        reason: selected ? "Uses the highlighted passage" : "Document edit",
      });
      yield* emitExecuted(runtime, { name: "replace_text", args: { find: source }, id: "replace" }, replaced);
      toolsUsed.push({ id: "replace", name: "replace_text", args: { find: source }, hidden: true });
      if (replaced.meta.edit) {
        edits.push(replaced.meta.edit);
        yield { type: "phase", phase: "editing" };
        yield { type: "edits", edits: [replaced.meta.edit] };
      }
    }
  }

  const message = canEdit
    ? edits.length
      ? "Proposed a targeted edit. Keep or undo it in the page."
      : "No document edits were proposed."
    : request.mode === "plan"
      ? "Here is a plan without changing the document:\n1. Read the draft and any comments.\n2. Decide what to keep or rewrite.\n3. Switch to Agent mode to apply edits."
      : runtime.session.text.trim()
        ? `You asked: ${request.prompt.trim()} The opening reads: “${firstLine(runtime.session.text)}”`
        : "The document is empty, so there is nothing to answer from yet.";

  yield* typewrite("message", message, signal);
  yield {
    type: "done",
    result: finishResult(request, runtime, {
      message,
      thinking,
      edits,
      citations: [],
      clientTools: toolsUsed,
      tasks: [],
      chatTitle: request.nameChat ? mockTitle(request.prompt) : undefined,
      mock: true,
    }),
  };
}

async function* emitExecuted(
  _runtime: DocumentMcpRuntime,
  call: { name: string; args: Record<string, unknown>; id?: string },
  result: Awaited<ReturnType<DocumentMcpRuntime["callTool"]>>,
  options?: { silent?: boolean },
): AsyncGenerator<AgentStreamEvent> {
  const stepId = call.id || `tool-${call.name}-${crypto.randomUUID()}`;
  if (options?.silent) {
    yield { type: "tool", name: call.name, hidden: true };
  }
  yield {
    type: "step",
    step: {
      id: stepId,
      name: call.name,
      title: stepTitle(call.name, call.args),
      status: "complete",
      hits: stepHits(call.name, result.raw),
    },
  };
  yield { type: "tool_result", name: call.name, hidden: true };
}

function finishResult(
  request: AgentRequest,
  runtime: DocumentMcpRuntime,
  parts: {
    message: string;
    thinking: string;
    edits: AgentEditDraft[];
    citations: AgentCitation[];
    clientTools: AgentToolCall[];
    tasks: AgentTask[];
    chatTitle?: string;
    mock: boolean;
  },
): AgentResponse {
  return {
    message: sanitizeAgentMessage(parts.message, request.mode, parts.edits.map((edit) => edit.replace)) || defaultMessage(request.mode),
    thinking: request.thinkingLevel === "none" ? undefined : parts.thinking.trim() || undefined,
    chatTitle: parts.chatTitle || (request.nameChat ? mockTitle(request.prompt) : undefined),
    edits: requestAllowsEdits(request) ? parts.edits : [],
    tasks: parts.tasks.length ? parts.tasks : runtime.session.tasks,
    tools: parts.clientTools,
    citations: dedupeCitations(parts.citations),
    mock: parts.mock,
  };
}

type ProviderToolCall = { id?: string; callId?: string; name: string; args: Record<string, unknown> };
type ProviderEvent =
  | { type: "thinking"; delta: string }
  | { type: "message"; delta: string }
  | { type: "tool_call"; call: ProviderToolCall }
  | { type: "usage"; usage: AgentUsage }
  | { type: "retry"; attempt: number; delayMs: number; message: string };

function createOpenAIDriver(
  apiKey: string,
  request: AgentRequest,
  runtime: DocumentMcpRuntime,
  signal?: AbortSignal,
): ProviderDriver {
  let previousId: string | undefined;
  let pendingInput: unknown[] | undefined;
  let chatFallback: ProviderDriver | null = null;

  return {
    async *round(tools) {
      if (chatFallback) {
        yield* chatFallback.round(tools);
        return;
      }
      const body: Record<string, unknown> = {
        model: request.model,
        stream: true,
        store: true,
        tools: toOpenAITools(tools),
        input: pendingInput ?? [
          { role: "system", content: systemPrompt(request) },
          ...request.history.map((item) => ({ role: item.role, content: item.content })),
          { role: "user", content: userPrompt(request, runtime.session) },
        ],
      };
      if (previousId) body.previous_response_id = previousId;
      if (request.thinkingLevel !== "none" && findAgentModel(request.model)?.thinking) {
        body.reasoning = { effort: openaiEffort(request.thinkingLevel), summary: "auto" };
      }
      let res: Response;
      try {
        res = yield* backoffFetch(
          "https://api.openai.com/v1/responses",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
          { signal },
        );
      } catch (error) {
        if (!previousId && shouldFallbackToChat(error)) {
          chatFallback = createOpenAIChatDriver(apiKey, request, runtime, signal);
          yield* chatFallback.round(tools);
          return;
        }
        throw error;
      }
      if (!res.body) throw new Error("The model returned an empty response.");
      const collected = yield* readOpenAIResponse(res);
      if (collected.usage) yield { type: "usage", usage: collected.usage };
      previousId = collected.responseId || previousId;
      pendingInput = undefined;
      for (const call of collected.calls) yield { type: "tool_call", call };
    },
    continueWith(results) {
      if (chatFallback) {
        chatFallback.continueWith(results);
        return;
      }
      pendingInput = results.map((item) => ({
        type: "function_call_output",
        call_id: item.call.callId || item.call.id,
        output: item.text,
      }));
    },
  };
}

async function* readOpenAIResponse(res: Response): AsyncGenerator<ProviderEvent, {
  calls: Array<ProviderToolCall & { callId: string }>;
  responseId?: string;
  usage?: AgentUsage;
}> {
  const calls = new Map<string, { callId: string; name: string; args: string }>();
  let responseId: string | undefined;
  let usage: AgentUsage | undefined;
  for await (const raw of readSseData(res)) {
    let event: {
      type?: string;
      delta?: string;
      item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string };
      response?: {
        id?: string;
        usage?: OpenAIUsage;
        output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }>;
      };
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
    if (event.type === "response.reasoning_summary_text.delta" || event.type === "response.reasoning_text.delta") {
      if (delta) yield { type: "thinking", delta };
      continue;
    }
    if (event.type === "response.output_text.delta" && delta) {
      yield { type: "message", delta };
      continue;
    }
    if (event.type === "response.output_item.done" && event.item?.type === "function_call") {
      const callId = event.item.call_id || event.item.id || crypto.randomUUID();
      calls.set(callId, {
        callId,
        name: event.item.name || "",
        args: event.item.arguments || "",
      });
    }
    if (event.type === "response.completed") {
      responseId = event.response?.id;
      usage = mapOpenAIUsage(event.response?.usage);
      for (const item of event.response?.output ?? []) {
        if (item.type !== "function_call" || !item.name) continue;
        const callId = item.call_id || crypto.randomUUID();
        if (!calls.has(callId)) {
          calls.set(callId, { callId, name: item.name, args: item.arguments || "" });
        }
      }
    }
  }
  return {
    calls: [...calls.values()].filter((call) => call.name).map((call) => ({
      id: call.callId,
      callId: call.callId,
      name: call.name,
      args: parseArgs(call.args),
    })),
    responseId,
    usage,
  };
}

function createOpenAIChatDriver(
  apiKey: string,
  request: AgentRequest,
  runtime: DocumentMcpRuntime,
  signal?: AbortSignal,
): ProviderDriver {
  const messages: Array<Record<string, unknown>> = [
    { role: "system", content: systemPrompt(request) },
    ...request.history.map((item) => ({ role: item.role, content: item.content })),
    { role: "user", content: userPrompt(request, runtime.session) },
  ];
  let lastCalls: ProviderToolCall[] = [];
  let lastContent = "";

  return {
    async *round(tools) {
      const res = yield* backoffFetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: request.model,
            stream: true,
            tools: toOpenAIChatTools(tools),
            messages,
          }),
        },
        { signal },
      );
      if (!res.body) throw new Error("The model returned an empty response.");

      lastContent = "";
      const pending = new Map<number, { id: string; name: string; args: string }>();
      for await (const raw of readSseData(res)) {
        let payload: {
          choices?: Array<{
            delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> };
          }>;
          usage?: OpenAIUsage;
          error?: { message?: string };
        };
        try {
          payload = JSON.parse(raw) as typeof payload;
        } catch {
          continue;
        }
        if (payload.error?.message) throw new Error(payload.error.message);
        const delta = payload.choices?.[0]?.delta;
        if (delta?.content) {
          lastContent += delta.content;
          yield { type: "message", delta: delta.content };
        }
        for (const call of delta?.tool_calls ?? []) {
          const index = call.index ?? 0;
          const current = pending.get(index) ?? { id: call.id || `call-${index}`, name: "", args: "" };
          if (call.id) current.id = call.id;
          if (call.function?.name) current.name += call.function.name;
          if (call.function?.arguments) current.args += call.function.arguments;
          pending.set(index, current);
        }
        if (payload.usage) {
          const usage = mapOpenAIUsage(payload.usage);
          if (usage) yield { type: "usage", usage };
        }
      }
      lastCalls = [...pending.values()].filter((call) => call.name).map((call) => ({
        id: call.id,
        callId: call.id,
        name: call.name,
        args: parseArgs(call.args),
      }));
      for (const call of lastCalls) yield { type: "tool_call", call };
    },
    continueWith(results) {
      if (!lastCalls.length) return;
      messages.push({
        role: "assistant",
        content: lastContent || null,
        tool_calls: lastCalls.map((call) => ({
          id: call.callId || call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      });
      for (const item of results) {
        messages.push({
          role: "tool",
          tool_call_id: item.call.callId || item.call.id,
          content: item.text,
        });
      }
      lastCalls = [];
    },
  };
}

function createAnthropicDriver(
  apiKey: string,
  request: AgentRequest,
  runtime: DocumentMcpRuntime,
  signal?: AbortSignal,
): ProviderDriver {
  const messages: Array<{ role: "user" | "assistant"; content: unknown }> = [
    ...request.history.map((item) => ({ role: item.role, content: item.content })),
    { role: "user", content: userPrompt(request, runtime.session) },
  ];
  const budget = anthropicThinkingBudget(request.thinkingLevel);
  let lastBlocks: Array<Record<string, unknown>> = [];

  return {
    async *round(tools) {
      const body: Record<string, unknown> = {
        model: request.model,
        stream: true,
        max_tokens: budget > 0 ? budget + 4096 : 4096,
        system: systemPrompt(request),
        tools: toAnthropicTools(tools),
        messages,
      };
      if (budget > 0) body.thinking = { type: "enabled", budget_tokens: budget };
      const res = yield* backoffFetch(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        },
        { signal },
      );
      if (!res.body) throw new Error("The model returned an empty response.");

      const blocks: Array<Record<string, unknown>> = [];
      let current: Record<string, unknown> | null = null;
      for await (const raw of readSseData(res)) {
        let event: {
          type?: string;
          content_block?: { type?: string; id?: string; name?: string; thinking?: string; text?: string };
          delta?: { type?: string; thinking?: string; text?: string; partial_json?: string };
          usage?: { input_tokens?: number; output_tokens?: number };
          message?: { usage?: { input_tokens?: number; output_tokens?: number } };
        };
        try {
          event = JSON.parse(raw) as typeof event;
        } catch {
          continue;
        }
        if (event.type === "content_block_start" && event.content_block) {
          current = { ...event.content_block };
          if (current.type === "tool_use") current.input_json = "";
          blocks.push(current);
        }
        if (event.type === "content_block_delta" && current) {
          if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
            current.thinking = `${current.thinking ?? ""}${event.delta.thinking}`;
            yield { type: "thinking", delta: event.delta.thinking };
          }
          if (event.delta?.type === "text_delta" && event.delta.text) {
            current.text = `${current.text ?? ""}${event.delta.text}`;
            yield { type: "message", delta: event.delta.text };
          }
          if (event.delta?.type === "input_json_delta" && event.delta.partial_json) {
            current.input_json = `${current.input_json ?? ""}${event.delta.partial_json}`;
          }
        }
        if (event.type === "message_delta" || event.type === "message_start") {
          const rawUsage = event.usage || event.message?.usage;
          if (rawUsage) yield { type: "usage", usage: { input: rawUsage.input_tokens ?? 0, output: rawUsage.output_tokens ?? 0 } };
        }
      }
      lastBlocks = blocks;
      for (const block of blocks) {
        if (block.type !== "tool_use" || typeof block.name !== "string") continue;
        yield {
          type: "tool_call",
          call: {
            id: String(block.id ?? ""),
            callId: String(block.id ?? ""),
            name: String(block.name),
            args: parseArgs(String(block.input_json ?? "")),
          },
        };
      }
    },
    continueWith(results) {
      if (!lastBlocks.length) return;
      messages.push({
        role: "assistant",
        content: lastBlocks.map((block) => {
          if (block.type === "tool_use") {
            return {
              type: "tool_use",
              id: block.id,
              name: block.name,
              input: parseArgs(String(block.input_json ?? "")),
            };
          }
          return block;
        }),
      });
      messages.push({
        role: "user",
        content: results.map((item) => ({
          type: "tool_result",
          tool_use_id: item.call.callId || item.call.id,
          content: item.text,
        })),
      });
      lastBlocks = [];
    },
  };
}

type OpenAIUsage = {
  input_tokens?: number;
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens?: number };
  input_tokens_details?: { cached_tokens?: number };
  prompt_tokens?: number;
  completion_tokens?: number;
};

function mapOpenAIUsage(usage?: OpenAIUsage): AgentUsage | undefined {
  if (!usage) return undefined;
  return {
    input: usage.input_tokens ?? usage.prompt_tokens ?? 0,
    output: usage.output_tokens ?? usage.completion_tokens ?? 0,
    reasoning: usage.output_tokens_details?.reasoning_tokens,
    cached: usage.input_tokens_details?.cached_tokens,
  };
}

function mergeUsage(current: AgentUsage | undefined, next: AgentUsage): AgentUsage {
  if (!current) return next;
  return {
    input: current.input + next.input,
    output: current.output + next.output,
    reasoning: (current.reasoning ?? 0) + (next.reasoning ?? 0) || undefined,
    cached: (current.cached ?? 0) + (next.cached ?? 0) || undefined,
  };
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
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

async function* typewrite(kind: "thinking" | "message", text: string, signal?: AbortSignal): AsyncGenerator<AgentStreamEvent> {
  for (let i = 0; i < text.length; i += 4) {
    if (signal?.aborted) throw abortError();
    yield { type: kind, delta: text.slice(i, i + 4) };
    await wait(kind === "thinking" ? 14 : 12, signal);
  }
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

function shouldFallbackToChat(error: unknown) {
  if (isAbortError(error) || isRateLimitError(error) || isAuthError(error)) return false;
  if (error instanceof HttpError) return [400, 404, 405, 422].includes(error.status);
  return error instanceof Error && /not found|invalid url|unknown field|unrecognized request/i.test(error.message);
}

function lastParagraph(document: string) {
  const parts = document.split(/\n+/).map((part) => part.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? document.slice(-220);
}

function firstLine(document: string) {
  return (document.split(/\n+/).map((part) => part.trim()).find(Boolean) ?? document).slice(0, 180);
}

function mockThinking(request: AgentRequest) {
  if (request.mode === "ask") return "I will stay in the document and answer from what is already written.";
  if (request.mode === "plan") return "I will outline the work without changing the page.";
  if (request.selection?.text || request.selections?.length) {
    return "I will read the outline, then make a small reviewable change.";
  }
  return "I will inspect the draft and propose one reviewable replacement.";
}

function mockEmptyInsert(prompt: string) {
  const trimmed = prompt.replace(/^(please\s+)?(add|write|insert|make|fix)\s+(a\s+)?/i, "").trim();
  return trimmed ? trimmed.replace(/[.!?]?$/, ".") : "Please provide the text to work with.";
}

function mockRewrite(text: string, prompt: string) {
  const intent = prompt.toLowerCase();
  const words = text.trim().split(/\s+/);
  if (intent.includes("short") || intent.includes("concise") || intent.includes("brief")) {
    return words.slice(0, Math.max(4, Math.ceil(words.length / 2))).join(" ");
  }
  if (intent.includes("formal")) {
    return text.replace(/\bcan't\b/gi, "cannot").replace(/\bdon't\b/gi, "do not").replace(/\bit's\b/gi, "it is");
  }
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
