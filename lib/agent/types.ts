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

export type AgentRequest = {
  title: string;
  prompt: string;
  document: string;
  selection: Omit<AgentSelection, "start" | "end"> | null;
};

export type AgentResponse = {
  message: string;
  edits: AgentEditDraft[];
  mock: boolean;
};

export type PendingEdit = AgentEditDraft & {
  id: string;
  status: "pending" | "accepted" | "rejected" | "missed";
};

export type AgentTurn = {
  id: string;
  prompt: string;
  selection: string | null;
  message: string;
  mock: boolean;
  edits: PendingEdit[];
};
