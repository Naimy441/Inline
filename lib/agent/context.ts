import { CLIENT_TOOLS, DOCUMENT_TOOLS, SERVER_TOOLS } from "@/lib/agent/toolCatalog";
import { findAgentModel } from "@/lib/agent/models";
import { SHORT_DOC_CHARS } from "@/lib/agent/mcp/session";
import type { AgentHistoryMessage, AgentUsage } from "@/lib/agent/types";

const CHARS_PER_TOKEN = 4;
const SYSTEM_PROMPT_TOKENS = 780;
const TOOL_TOKENS_EACH = 92;
const OUTLINE_CHARS = 2_400;

export type ContextBucket = {
  id: string;
  label: string;
  tokens: number;
};

export type ContextBreakdown = {
  used: number;
  limit: number;
  buckets: ContextBucket[];
  source: "estimate" | "usage";
};

function tokensFromChars(chars: number) {
  return Math.max(0, Math.ceil(Math.max(0, chars) / CHARS_PER_TOKEN));
}

function systemPromptTokens() {
  return SYSTEM_PROMPT_TOKENS;
}

function toolDefinitionTokens() {
  return Math.max(1, (DOCUMENT_TOOLS.length + SERVER_TOOLS.length + CLIENT_TOOLS.length) * TOOL_TOKENS_EACH);
}

export function modelContextLimit(model: string | undefined) {
  const known = findAgentModel(model);
  if (known?.contextWindow) return known.contextWindow;
  const id = model ?? "";
  if (id.includes("nano")) return 128_000;
  if (id.includes("haiku")) return 200_000;
  if (id.includes("mini")) return 256_000;
  return 256_000;
}

function draftChars(documentChars: number, continuing?: boolean, sameDraft?: boolean) {
  if (continuing && sameDraft) return 80;
  if (documentChars > 0 && documentChars <= SHORT_DOC_CHARS) return documentChars;
  return Math.min(OUTLINE_CHARS, documentChars);
}

function documentLabel(documentChars: number, continuing?: boolean, sameDraft?: boolean) {
  if (continuing && sameDraft) return "Document (in thread)";
  if (documentChars <= SHORT_DOC_CHARS) return "Document";
  return "Document outline";
}

export function estimateContextUsage(input: {
  model?: string;
  prompt: string;
  documentChars: number;
  history: AgentHistoryMessage[];
  attachments?: Array<{ text: string }>;
  previousEdits?: Array<{ find: string; replace: string }>;
  continuing?: boolean;
  sameDraft?: boolean;
  liveThinking?: string;
  liveMessage?: string;
  usage?: AgentUsage;
}): ContextBreakdown {
  const limit = modelContextLimit(input.model);
  const system = systemPromptTokens();
  const tools = toolDefinitionTokens();
  const document = tokensFromChars(draftChars(input.documentChars, input.continuing, input.sameDraft));
  const historyChars = input.continuing
    ? 0
    : input.history.reduce((sum, item) => sum + item.content.length, 0);
  const attachmentChars = (input.attachments ?? []).reduce((sum, item) => sum + item.text.length, 0);
  const editChars = (input.previousEdits ?? []).reduce(
    (sum, item) => sum + item.find.length + item.replace.length,
    0,
  );
  const liveChars = (input.liveThinking ?? "").length + (input.liveMessage ?? "").length;
  let conversation = tokensFromChars(
    historyChars + input.prompt.length + attachmentChars + editChars + liveChars,
  );
  let source: ContextBreakdown["source"] = "estimate";
  if (input.usage) {
    source = "usage";
    const billed = input.usage.input + (input.usage.output ?? 0);
    const staticSum = system + tools + document;
    const liveOut = tokensFromChars(liveChars);
    const extraLive = Math.max(0, liveOut - (input.usage.output ?? 0));
    conversation = Math.max(conversation, billed + extraLive - staticSum, 0);
  }
  const buckets: ContextBucket[] = [
    { id: "system", label: "System prompt", tokens: system },
    { id: "tools", label: "Tool definitions", tokens: tools },
    { id: "document", label: documentLabel(input.documentChars, input.continuing, input.sameDraft), tokens: document },
    { id: "conversation", label: "Conversation", tokens: conversation },
  ];
  const used = Math.max(1, buckets.reduce((sum, bucket) => sum + bucket.tokens, 0));
  return { used, limit, buckets, source };
}

export function estimateAgentTokens(input: {
  prompt: string;
  documentChars: number;
  history: AgentHistoryMessage[];
  attachments?: Array<{ text: string }>;
  previousEdits?: Array<{ find: string; replace: string }>;
  continuing?: boolean;
  sameDraft?: boolean;
}) {
  const historyChars = input.continuing
    ? 0
    : input.history.reduce((sum, item) => sum + item.content.length, 0);
  const attachmentChars = (input.attachments ?? []).reduce((sum, item) => sum + item.text.length, 0);
  const editChars = (input.previousEdits ?? []).reduce(
    (sum, item) => sum + item.find.length + item.replace.length,
    0,
  );
  const chars = systemPromptTokens() * CHARS_PER_TOKEN
    + toolDefinitionTokens() * CHARS_PER_TOKEN
    + input.prompt.length
    + historyChars
    + attachmentChars
    + editChars
    + draftChars(input.documentChars, input.continuing, input.sameDraft);
  return Math.max(1, tokensFromChars(chars));
}
