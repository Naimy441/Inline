import type { AgentToolCall } from "@/lib/agent/tools";

export type AgentMode = "agent" | "plan" | "ask";
export type ThinkingLevel = "none" | "low" | "medium" | "high" | "xhigh";
export type AgentProvider = "openai" | "anthropic";

export type AgentSelection = {
  text: string;
  start: number;
  end: number;
  before: string;
  after: string;
};

export type AgentEditDraft = {
  find: string;
  replace: string;
  reason?: string;
  /** Optional explicit intent. The text payload remains the source of truth. */
  operation?: "replace" | "insert" | "delete";
  /** Zero-based occurrence when the same text appears more than once. */
  occurrence?: number;
};

export type AgentHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AgentComment = {
  id: string;
  quote: string;
  body: string;
};

export type AgentAttachment = {
  id: string;
  name: string;
  text: string;
};

export type AgentLockedRange = {
  id: string;
  text: string;
};

export type AgentPriorEdit = {
  find: string;
  replace: string;
  operation?: AgentEditDraft["operation"];
  occurrence?: number;
  status: "pending" | "accepted";
};

export type AgentTaskStatus = "pending" | "in_progress" | "done";
export type AgentTaskKind = "research" | "draft" | "edit" | "cite" | "review";

export type AgentTask = {
  id: string;
  title: string;
  status: AgentTaskStatus;
  kind?: AgentTaskKind;
};

export type AgentCitation = {
  id: string;
  author: string;
  title: string;
  year: string;
  publisher?: string;
  url?: string;
  inline: string;
  bibliography: string;
};

export type DocumentPageSlice = {
  number: number;
  start: number;
  end: number;
  text: string;
};

export type AgentRequest = {
  title: string;
  prompt: string;
  document: string;
  pages?: DocumentPageSlice[];
  selection: Omit<AgentSelection, "start" | "end"> | null;
  selections?: Array<Omit<AgentSelection, "start" | "end">>;
  mode: AgentMode;
  model: string;
  thinkingLevel: ThinkingLevel;
  nameChat: boolean;
  history: AgentHistoryMessage[];
  comments?: AgentComment[];
  attachments?: AgentAttachment[];
  lockedRanges?: AgentLockedRange[];
  previousEdits?: AgentPriorEdit[];
  preserveTone?: boolean;
  pageCount?: number;
  reviewAttempt?: number;
};

export type AgentResponse = {
  message: string;
  thinking?: string;
  chatTitle?: string;
  edits: AgentEditDraft[];
  tasks: AgentTask[];
  tools: AgentToolCall[];
  citations?: AgentCitation[];
  mock: boolean;
};

export type AgentStepStatus = "pending" | "active" | "complete";

export type AgentStep = {
  id: string;
  name?: string;
  title: string;
  detail?: string;
  status: AgentStepStatus;
  hits?: string[];
};

export type AgentUsage = {
  input: number;
  output: number;
  reasoning?: number;
  cached?: number;
};

export type AgentStreamEvent =
  | { type: "phase"; phase: "thinking" | "planning" | "editing" | "reviewing" }
  | { type: "thinking"; delta: string }
  | { type: "message"; delta: string; reset?: boolean }
  | { type: "edits"; edits: AgentEditDraft[] }
  | { type: "tool"; name: string; hidden?: boolean }
  | { type: "tool_result"; name: string; hidden?: boolean }
  | { type: "step"; step: AgentStep }
  | { type: "usage"; usage: AgentUsage }
  | { type: "tasks"; tasks: AgentTask[] }
  | { type: "citations"; citations: AgentCitation[] }
  | { type: "done"; result: AgentResponse }
  | { type: "error"; error: string };

export type PendingEdit = AgentEditDraft & {
  id: string;
  status: "pending" | "accepted" | "rejected" | "missed";
};

export type AgentTurn = {
  id: string;
  prompt: string;
  selection: string | null;
  selections?: string[];
  message: string;
  thinking?: string;
  durationMs?: number;
  mock: boolean;
  mode: AgentMode;
  model: string;
  edits: PendingEdit[];
  tasks?: AgentTask[];
  tools?: Array<{ name: string; hidden?: boolean }>;
  citations?: AgentCitation[];
  snapshotId?: string;
  error?: string;
};

export type AgentChat = {
  id: string;
  title: string;
  titled: boolean;
  createdAt: number;
  updatedAt: number;
  mode: AgentMode;
  model: string;
  thinkingLevel: ThinkingLevel;
  turns: AgentTurn[];
  tasks: AgentTask[];
};

export type AgentQueueItem = {
  id: string;
  prompt: string;
  selection?: string | null;
};
