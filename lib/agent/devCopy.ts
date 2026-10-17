/**
 * Plain-text copies of a chat for debugging: the prompt, thoughts, tool calls
 * and final response. Built only from messages the chat already holds — no
 * credentials, environment variables, or anything else the transcript doesn't.
 */

import type { AssistantMessage, AssistantPart, ChatMessage, DocumentTurnLog, ToolPart, UserMessage } from "@/lib/agent/types";
import { shortToolName } from "@/lib/agent/types";

export type PromptTurn = {
  prompt: UserMessage | null;
  replies: AssistantMessage[];
};

/** Group the transcript into prompt turns: a user message and the replies that follow it. */
export function promptTurns(messages: ChatMessage[]): PromptTurn[] {
  const turns: PromptTurn[] = [];
  for (const message of messages) {
    if (message.role === "user") {
      turns.push({ prompt: message, replies: [] });
      continue;
    }
    const current = turns.at(-1);
    if (current) current.replies.push(message);
    else turns.push({ prompt: null, replies: [message] });
  }
  return turns;
}

/** The message that should offer "Copy turn": the last message of each turn. */
export function turnCopyTargets(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>();
  let end: string | null = null;
  for (const message of messages) {
    if (message.role === "user" && end) ids.add(end);
    end = message.id;
  }
  if (end) ids.add(end);
  return ids;
}

export function turnForMessage(messages: ChatMessage[], messageId: string): PromptTurn | null {
  return promptTurns(messages).find((turn) => turn.prompt?.id === messageId || turn.replies.some((reply) => reply.id === messageId)) ?? null;
}

function block(title: string, body: string) {
  const text = body.trim();
  return `${title}:\n${text || "(none)"}`;
}

function formatPrompt(message: UserMessage | null) {
  if (!message) return "(none)";
  const lines: string[] = [];
  const text = message.text.trim();
  if (text) lines.push(text);
  const selected = message.selection?.text.trim();
  if (selected) lines.push(`Selected text:\n${selected}`);
  if (message.attachments?.length) lines.push(`Attachments: ${message.attachments.map((item) => item.name).join(", ")}`);
  if (message.mentions?.length) lines.push(`Mentioned documents: ${message.mentions.map((item) => item.title).join(", ")}`);
  return lines.join("\n\n") || "(none)";
}

function texts(parts: AssistantPart[], type: "thinking" | "text") {
  return parts.flatMap((part) => (part.type === type && part.text.trim() ? [part.text.trim()] : []));
}

function formatThoughts(replies: AssistantMessage[]) {
  const thoughts = replies.flatMap((reply) => texts(reply.parts, "thinking"));
  return thoughts.join("\n\n") || "(none)";
}

function formatTool(part: ToolPart) {
  const lines = [`${shortToolName(part.name)} (${part.status})`, "Input:", part.input ? JSON.stringify(part.input, null, 2) : part.inputPreview?.trim() || "(none)"];
  if (part.result !== undefined) lines.push("Result:", part.result.trim() || "(empty)");
  return lines.join("\n");
}

function formatTools(replies: AssistantMessage[]) {
  const tools = replies.flatMap((reply) => reply.parts.filter((part): part is ToolPart => part.type === "tool"));
  return tools.length ? tools.map(formatTool).join("\n\n") : "(none)";
}

function formatResponse(replies: AssistantMessage[]) {
  const chunks: string[] = [];
  for (const reply of replies) {
    const text = texts(reply.parts, "text").join("\n\n");
    if (text) chunks.push(text);
    if (reply.status === "error") chunks.push(`Error: ${reply.error?.trim() || "Something went wrong."}`);
    else if (reply.status === "stopped") chunks.push(reply.error?.trim() ? `Stopped. ${reply.error.trim()}` : "Stopped.");
  }
  return chunks.join("\n\n") || "(none)";
}

/** One prompt turn: prompt, thoughts, tool calls and the final response. */
export function formatPromptTurn(turn: PromptTurn) {
  return [block("Prompt", formatPrompt(turn.prompt)), block("Thoughts", formatThoughts(turn.replies)), block("Tool calls", formatTools(turn.replies)), block("Response", formatResponse(turn.replies))].join("\n\n");
}

/** Every turn in the chat, in the same form as a single turn. */
export function formatChatHistory(messages: ChatMessage[]) {
  const turns = promptTurns(messages);
  if (!turns.length) return "(none)";
  return turns.map((turn, index) => `Turn ${index + 1}\n\n${formatPromptTurn(turn)}`).join("\n\n---\n\n");
}

function turnDocuments(replies: AssistantMessage[]): DocumentTurnLog[] {
  const byId = new Map<string, DocumentTurnLog>();
  for (const reply of replies) {
    for (const log of reply.documentLog ?? []) byId.set(log.documentId, log);
  }
  return [...byId.values()];
}

function formatPending(log: DocumentTurnLog) {
  if (!log.pending?.length) return "(none)";
  return log.pending.map((hunk) => `- ${hunk.id}: "${hunk.deleted}" → "${hunk.inserted}"`).join("\n");
}

function formatOneDocument(log: DocumentTurnLog) {
  const lines = [`id: ${log.documentId}`, `title: ${log.title.trim() || "Untitled"}`];
  if (log.diff) lines.push("Diff:", log.diff.trim() || "(none)");
  else if (log.before !== undefined || log.after !== undefined) {
    if (log.before !== undefined) lines.push("Before:", log.before.trim() ? log.before : "(empty)");
    if (log.after !== undefined) lines.push("After:", log.after.trim() ? log.after : "(empty)");
  } else lines.push("Changes:", "(none)");
  lines.push("Pending review:", formatPending(log));
  return lines.join("\n");
}

function formatDocuments(replies: AssistantMessage[]) {
  const logs = turnDocuments(replies);
  return logs.length ? logs.map(formatOneDocument).join("\n\n") : "(none)";
}

/** One turn plus the document state recorded for it. */
export function formatTurnLog(turn: PromptTurn) {
  return [formatPromptTurn(turn), block("Document", formatDocuments(turn.replies))].join("\n\n");
}

/** Every turn, including what each one did to the document. */
export function formatChatLogs(messages: ChatMessage[]) {
  const turns = promptTurns(messages);
  if (!turns.length) return "(none)";
  return turns.map((turn, index) => `Turn ${index + 1}\n\n${formatTurnLog(turn)}`).join("\n\n---\n\n");
}
