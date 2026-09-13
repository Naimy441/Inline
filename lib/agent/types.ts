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
};

export type AgentHistoryMessage = {
  role: "user" | "assistant";
  content: string;
};

export type AgentRequest = {
  title: string;
  prompt: string;
  document: string;
  selection: Omit<AgentSelection, "start" | "end"> | null;
  mode: AgentMode;
  model: string;
  thinkingLevel: ThinkingLevel;
  nameChat: boolean;
  history: AgentHistoryMessage[];
};

export type AgentResponse = {
  message: string;
  thinking?: string;
  chatTitle?: string;
  edits: AgentEditDraft[];
  mock: boolean;
};

export type AgentStreamEvent =
  | { type: "phase"; phase: "thinking" | "planning" }
  | { type: "thinking"; delta: string }
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
  message: string;
  thinking?: string;
  durationMs?: number;
  mock: boolean;
  mode: AgentMode;
  model: string;
  edits: PendingEdit[];
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
};
