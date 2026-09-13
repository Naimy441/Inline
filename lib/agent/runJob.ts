import { readSseData } from "@/lib/agent/sse";
import type { AgentEditDraft, AgentRequest, AgentResponse, AgentStreamEvent, AgentTask } from "@/lib/agent/types";

export type AgentJobHandlers = {
  signal?: AbortSignal;
  onPhase?: (phase: "thinking" | "planning" | "editing" | "reviewing") => void;
  onThinking?: (text: string) => void;
  onMessage?: (text: string) => void;
  onEdits?: (edits: AgentEditDraft[]) => void;
  onTool?: (name: string, hidden?: boolean) => void;
  onTasks?: (tasks: AgentTask[]) => void;
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
      handlers.onThinking?.(streamedThinking);
    }
    if (event.type === "message") {
      streamedMessage = event.reset ? event.delta : streamedMessage + event.delta;
      handlers.onMessage?.(streamedMessage);
    }
    if (event.type === "edits") handlers.onEdits?.(event.edits);
    if (event.type === "tool") handlers.onTool?.(event.name, event.hidden);
    if (event.type === "tasks") handlers.onTasks?.(event.tasks);
    if (event.type === "error") throw new Error(event.error);
    if (event.type === "done") data = event.result;
  }
  if (handlers.signal?.aborted) throw abortError();
  if (!data) throw new Error("The agent could not propose edits.");
  return {
    ...data,
    message: data.message || streamedMessage,
    thinking: data.thinking || streamedThinking || undefined,
    tasks: data.tasks ?? [],
    tools: data.tools ?? [],
  };
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}
