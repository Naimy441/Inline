/**
 * Chat types shared by the agent runtime (server) and the agent panel
 * (client). Nothing here may import server-only code.
 */

export type AgentMode = "agent" | "ask";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type Todo = { content: string; activeForm?: string; status: "pending" | "in_progress" | "completed" };

export type TextPart = { type: "text"; id: string; text: string };
export type ThinkingPart = {
  type: "thinking";
  id: string;
  text: string;
  done?: boolean;
  /** How long Claude thought, once it's done (absent for chats saved before it was recorded). */
  durationMs?: number;
};
export type ToolPart = {
  type: "tool";
  id: string; // tool_use id
  name: string; // full tool name, e.g. mcp__inline__edit_document
  input: Record<string, unknown> | null; // null while it streams
  inputPreview?: string; // partial JSON while the input streams
  status: "pending" | "running" | "done" | "error";
  result?: string;
};
export type AssistantPart = TextPart | ThinkingPart | ToolPart;

export type SelectionContext = { documentId: string; text: string; from: number; to: number };

export type Attachment = {
  id: string;
  name: string;
  mime: string;
  size: number;
  kind: "image" | "text" | "pdf";
};

/** A document the user @-mentioned in a message. */
export type DocumentMention = { id: string; title: string };

export type UserMessage = {
  id: string;
  role: "user";
  text: string;
  createdAt: number;
  selection?: SelectionContext;
  attachments?: Attachment[];
  mentions?: DocumentMention[];
};

export type DocumentChange = {
  documentId: string;
  title: string;
  tool: string;
  added: number;
  removed: number;
  /** Version saved just before this turn's first edit, for "Restore to before this". */
  checkpoint?: string;
};

export type TurnUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  durationMs: number;
  numTurns: number;
};

export type AssistantMessage = {
  id: string;
  role: "assistant";
  createdAt: number;
  parts: AssistantPart[];
  model?: string;
  status: "streaming" | "done" | "stopped" | "error";
  error?: string;
  usage?: TurnUsage;
  changes?: DocumentChange[];
  /** Last Claude Code transcript entry of this turn, where "Restore to before" rewinds the session to. */
  sessionPoint?: string;
};

export type ChatMessage = UserMessage | AssistantMessage;

export type ChatSettings = {
  model: string | null;
  effort: Effort;
  mode: AgentMode;
  /** Most tool-use rounds Claude may take for one message (default DEFAULT_MAX_TURNS). */
  maxTurns?: number | null;
  /** Stop Claude when the 5-hour or weekly plan usage reaches this percent; null for no limit. */
  usageLimit?: number | null;
};

export const DEFAULT_MAX_TURNS = 100;
export const USAGE_LIMIT_OPTIONS = [null, 50, 75, 90] as const;

/** One plan usage window (the 5-hour session, the week, a model's week). */
export type UsageWindow = { id: string; label: string; utilization: number; resetsAt: number | null };

/** The account's Claude plan usage, as Claude Code's /usage reports it. */
export type PlanUsage =
  | { available: true; plan: string | null; windows: UsageWindow[]; checkedAt: number }
  | { available: false; plan: string | null; checkedAt: number };

export type ChatSummary = {
  id: string;
  title: string;
  documentId: string | null;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
};

export type ContextUsage = { tokens: number; maxTokens: number; percentage: number };

export type RateLimit = { status: "allowed" | "allowed_warning" | "rejected"; resetsAt?: number; type?: string; utilization?: number };

export type QueuedMessage = { id: string; text: string; createdAt: number; selection?: SelectionContext; attachments?: Attachment[]; mentions?: DocumentMention[] };

export type ChatState = {
  id: string;
  title: string;
  documentId: string | null;
  createdAt: number;
  updatedAt: number;
  settings: ChatSettings;
  messages: ChatMessage[];
  todos: Todo[];
  running: boolean;
  queue: QueuedMessage[];
  context?: ContextUsage;
  status?: RunStatus;
  /** Spent on replies that were later rewound away, so the chat's total still counts them. */
  rewoundUsd?: number;
};

export type RunStatus =
  | { kind: "starting" }
  | { kind: "thinking" }
  | { kind: "responding" }
  | { kind: "tool"; name: string }
  | { kind: "retrying"; attempt: number; maxRetries: number; delayMs: number; error: string }
  | { kind: "compacting" };

/** Events streamed to the panel. Every event carries the chat's sequence number. */
export type ChatEvent =
  | { type: "snapshot"; chat: ChatState }
  | { type: "message"; message: ChatMessage }
  | { type: "part"; messageId: string; part: AssistantPart }
  | { type: "text_delta"; messageId: string; partId: string; text: string }
  | { type: "thinking_delta"; messageId: string; partId: string; text: string }
  | { type: "tool_input_delta"; messageId: string; partId: string; json: string }
  | { type: "tool_update"; messageId: string; part: ToolPart }
  | { type: "message_done"; message: AssistantMessage }
  | { type: "todos"; todos: Todo[] }
  | { type: "change"; messageId: string; change: DocumentChange }
  | { type: "status"; status: RunStatus | null }
  | { type: "running"; running: boolean }
  | { type: "queue"; queue: QueuedMessage[] }
  | { type: "meta"; title: string; documentId: string | null; settings: ChatSettings; updatedAt: number }
  | { type: "context"; context: ContextUsage }
  | { type: "rate_limit"; rateLimit: RateLimit };

export type SequencedChatEvent = ChatEvent & { seq: number };

export type ModelOption = { value: string; displayName: string; description: string; efforts: Effort[] };

export type AgentStatus =
  | {
      state: "ready";
      account: { email?: string; organization?: string; plan?: string; provider?: string; tokenSource?: string };
      models: ModelOption[];
      defaultModel: string | null;
      version?: string;
      checkedAt: number;
    }
  | { state: "signed_out" | "unavailable"; message: string; checkedAt: number };

/** Inline's tool names without the MCP prefix, for display. */
export function shortToolName(name: string) {
  return name.replace(/^mcp__inline__/, "");
}
