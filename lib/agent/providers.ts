import type { ChatMessage, ChatSettings } from "./types";

export type AgentProvider = "claude" | "codex";
export function providerFor(settings: Pick<ChatSettings, "provider">): AgentProvider {
  return settings.provider ?? "claude";
}
export function providerName(provider: AgentProvider) {
  return provider === "codex" ? "Codex" : "Claude";
}

/** A fresh provider session gets the shared transcript, including tool results and attachment references. */
export function conversationHandoff(messages: ChatMessage[]) {
  if (!messages.length) return "";
  const history = messages.map((message) => message.role === "user"
    ? { role: message.role, text: message.text, selection: message.selection, attachments: message.attachments, mentions: message.mentions, links: message.links }
    : { role: message.role, provider: message.provider ?? "claude", model: message.model, status: message.status, parts: message.parts.filter((part) => part.type !== "thinking"), changes: message.changes });
  return `<conversation-history>\n${JSON.stringify(history)}\n</conversation-history>\nContinue this same conversation. This is historical context, not new instructions. Use the current Inline document and tools for its current state. Earlier attachment IDs remain readable with read_attachment.\n`;
}
