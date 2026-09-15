import { readSseData } from "@/lib/agent/sse";
import type { AgentToolCall } from "@/lib/agent/toolCatalog";
import type { AgentCitation, AgentEditDraft, AgentRequest, AgentResponse, AgentStep, AgentStreamEvent, AgentTask, AgentUsage } from "@/lib/agent/types";

export type AgentJobHandlers = {
  signal?: AbortSignal;
  onPhase?: (phase: "thinking" | "planning" | "editing" | "reviewing") => void;
  onThinking?: (text: string) => void;
  onMessage?: (text: string) => void;
  onEdits?: (edits: AgentEditDraft[]) => void | Promise<void>;
  onTool?: (name: string, hidden?: boolean) => void;
  onClientTool?: (call: AgentToolCall) => void | Promise<void>;
  onStep?: (step: AgentStep) => void;
  onUsage?: (usage: AgentUsage) => void;
  onTasks?: (tasks: AgentTask[]) => void;
  onCitations?: (citations: AgentCitation[]) => void;
};

export async function runAgentJob(request: AgentRequest, handlers: AgentJobHandlers = {}): Promise<AgentResponse> {
  const response = await fetch("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
    signal: handlers.signal,
  });
  if (!response.ok) {
    const failed = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(failed.error || "The agent could not propose edits.");
  }
  let data: AgentResponse | null = null;
  let streamedThinking = "";
  let streamedMessage = "";
  const thinkingStream = createStreamUpdater((text) => handlers.onThinking?.(text));
  const messageStream = createStreamUpdater((text) => handlers.onMessage?.(text));
  for await (const raw of readSseData(response)) {
    if (handlers.signal?.aborted) throw abortError();
    let event: AgentStreamEvent;
    try {
      event = JSON.parse(raw) as AgentStreamEvent;
    } catch {
      continue;
    }
    if (event.type === "phase") handlers.onPhase?.(event.phase);
    if (event.type === "thinking") {
      streamedThinking += event.delta;
      thinkingStream.push(streamedThinking);
    }
    if (event.type === "message") {
      streamedMessage = event.reset ? event.delta : streamedMessage + event.delta;
      messageStream.push(streamedMessage);
    }
    if (event.type === "edits") await handlers.onEdits?.(event.edits);
    if (event.type === "tool") handlers.onTool?.(event.name, event.hidden);
    if (event.type === "client_tool") await handlers.onClientTool?.(event.call);
    if (event.type === "step") handlers.onStep?.(event.step);
    if (event.type === "usage") handlers.onUsage?.(event.usage);
    if (event.type === "tasks") handlers.onTasks?.(event.tasks);
    if (event.type === "citations") handlers.onCitations?.(event.citations);
    if (event.type === "error") throw new Error(event.error);
    if (event.type === "done") data = event.result;
  }
  thinkingStream.flush();
  messageStream.flush();
  if (handlers.signal?.aborted) throw abortError();
  if (!data) throw new Error("The agent could not propose edits.");
  return {
    ...data,
    message: data.message || streamedMessage,
    thinking: data.thinking || streamedThinking || undefined,
    tasks: data.tasks ?? [],
    tools: data.tools ?? [],
    citations: data.citations ?? [],
    continuation: data.continuation,
  };
}

function createStreamUpdater(onUpdate: (text: string) => void, intervalMs = 48) {
  let pending = "";
  let emitted = "";
  let lastUpdate = 0;

  return {
    push(text: string) {
      pending = text;
      const now = performance.now();
      if (now - lastUpdate >= intervalMs) {
        emitted = pending;
        lastUpdate = now;
        onUpdate(emitted);
      }
    },
    flush() {
      if (pending !== emitted) {
        emitted = pending;
        onUpdate(emitted);
      }
    },
  };
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}
