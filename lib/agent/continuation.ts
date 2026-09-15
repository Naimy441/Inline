import type { AgentContinuation, AgentMode, AgentProvider, AgentRequest } from "@/lib/agent/types";

export const CONVERSATION_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_THREADS = 64;
const MAX_STORED_MESSAGES = 28;

export type StoredThread = {
  chatId: string;
  provider: AgentProvider;
  model: string;
  mode: AgentMode;
  openaiResponseId?: string;
  anthropicMessages?: Array<{ role: "user" | "assistant"; content: unknown }>;
  openaiChatMessages?: Array<Record<string, unknown>>;
  updatedAt: number;
};

const threads = new Map<string, StoredThread>();

export function documentFingerprint(text: string) {
  const normalized = text.replace(/\u00a0/g, " ");
  return `${normalized.length}:${fnv1a(normalized)}`;
}

export function continuationFits(
  stored: Pick<AgentContinuation, "provider" | "model" | "mode"> | undefined,
  request: Pick<AgentRequest, "model" | "mode">,
  provider: AgentProvider,
) {
  if (!stored) return false;
  return stored.provider === provider && stored.model === request.model && stored.mode === request.mode;
}

export function parseContinuation(value: unknown): AgentContinuation | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as {
    provider?: unknown;
    model?: unknown;
    mode?: unknown;
    openaiResponseId?: unknown;
    documentFingerprint?: unknown;
  };
  if (row.provider !== "openai" && row.provider !== "anthropic") return undefined;
  if (typeof row.model !== "string" || !row.model.trim()) return undefined;
  if (row.mode !== "agent" && row.mode !== "plan" && row.mode !== "ask") return undefined;
  return {
    provider: row.provider,
    model: row.model.trim(),
    mode: row.mode,
    openaiResponseId: typeof row.openaiResponseId === "string" && row.openaiResponseId.trim()
      ? row.openaiResponseId.trim().slice(0, 128)
      : undefined,
    documentFingerprint: typeof row.documentFingerprint === "string" && row.documentFingerprint.trim()
      ? row.documentFingerprint.trim().slice(0, 80)
      : undefined,
  };
}

export function parseChatId(value: unknown) {
  if (typeof value !== "string") return undefined;
  const id = value.trim().slice(0, 80);
  return /^[\w-]+$/.test(id) ? id : undefined;
}

export function rememberThread(thread: StoredThread) {
  pruneThreads();
  threads.set(thread.chatId, { ...thread, updatedAt: Date.now() });
}

export function recallThread(chatId: string | undefined): StoredThread | undefined {
  if (!chatId) return undefined;
  pruneThreads();
  const row = threads.get(chatId);
  if (!row) return undefined;
  if (Date.now() - row.updatedAt > CONVERSATION_TTL_MS) {
    threads.delete(chatId);
    return undefined;
  }
  return row;
}

export function forgetThread(chatId: string | undefined) {
  if (chatId) threads.delete(chatId);
}

export function capMessages<T>(messages: T[], max = MAX_STORED_MESSAGES): T[] {
  if (messages.length <= max) return messages;
  return messages.slice(messages.length - max);
}

export function initialOpenAIResponseId(request: AgentRequest) {
  if (request.continuation?.openaiResponseId && continuationFits(request.continuation, request, "openai")) {
    return request.continuation.openaiResponseId;
  }
  const recalled = recallThread(request.chatId);
  if (recalled?.openaiResponseId && continuationFits(recalled, request, "openai")) {
    return recalled.openaiResponseId;
  }
  return undefined;
}

export function initialAnthropicMessages(request: AgentRequest) {
  const recalled = recallThread(request.chatId);
  if (recalled?.anthropicMessages?.length && continuationFits(recalled, request, "anthropic")) {
    return capMessages(recalled.anthropicMessages);
  }
  return undefined;
}

export function initialOpenAIChatMessages(request: AgentRequest) {
  const recalled = recallThread(request.chatId);
  if (recalled?.openaiChatMessages?.length && continuationFits(recalled, request, "openai")) {
    return capMessages(recalled.openaiChatMessages);
  }
  return undefined;
}

export function isStaleContinuation(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /previous_response_id|unknown response|response id|expired.*response|invalid.*response_id/i.test(message);
}

function pruneThreads() {
  const now = Date.now();
  for (const [id, row] of threads) {
    if (now - row.updatedAt > CONVERSATION_TTL_MS) threads.delete(id);
  }
  if (threads.size <= MAX_THREADS) return;
  const oldest = [...threads.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  for (const [id] of oldest.slice(0, threads.size - MAX_THREADS)) threads.delete(id);
}

function fnv1a(text: string) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
