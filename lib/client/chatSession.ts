"use client";

import type {
  AssistantMessage,
  AssistantPart,
  Attachment,
  ChatSettings,
  ChatState,
  ChatSummary,
  RateLimit,
  SelectionContext,
  SequencedChatEvent,
  ToolPart,
} from "@/lib/agent/types";
import { api, del, patch, post, Store } from "@/lib/client/api";

/**
 * A chat as the panel sees it: the server's chat state, kept current by the
 * chat's event stream. Reconnects resume from the last sequence number, so a
 * dropped connection never loses or duplicates streamed text.
 */

export type ChatUiState = { chat: ChatState | null; connected: boolean; error: string | null; rateLimit: RateLimit | null };

function updateMessage(chat: ChatState, id: string, update: (message: AssistantMessage) => AssistantMessage): ChatState {
  return {
    ...chat,
    messages: chat.messages.map((message) => (message.id === id && message.role === "assistant" ? update(message) : message)),
  };
}

function upsertPart(message: AssistantMessage, part: AssistantPart): AssistantMessage {
  const index = message.parts.findIndex((item) => item.id === part.id && item.type === part.type);
  if (index < 0) return { ...message, parts: [...message.parts, part] };
  const parts = message.parts.slice();
  parts[index] = part;
  return { ...message, parts };
}

function appendText(message: AssistantMessage, partId: string, kind: "text" | "thinking", text: string): AssistantMessage {
  return {
    ...message,
    parts: message.parts.map((part) => (part.id === partId && part.type === kind ? { ...part, text: part.text + text } : part)),
  };
}

export function reduceChat(chat: ChatState, event: SequencedChatEvent): ChatState {
  switch (event.type) {
    case "snapshot":
      return event.chat;
    case "message": {
      if (chat.messages.some((message) => message.id === event.message.id)) return chat;
      return { ...chat, messages: [...chat.messages, event.message] };
    }
    case "part":
      return updateMessage(chat, event.messageId, (message) => upsertPart(message, event.part));
    case "text_delta":
      return updateMessage(chat, event.messageId, (message) => appendText(message, event.partId, "text", event.text));
    case "thinking_delta":
      return updateMessage(chat, event.messageId, (message) => appendText(message, event.partId, "thinking", event.text));
    case "tool_input_delta":
      return updateMessage(chat, event.messageId, (message) => ({
        ...message,
        parts: message.parts.map((part) =>
          part.id === event.partId && part.type === "tool" ? ({ ...part, inputPreview: (part.inputPreview ?? "") + event.json } as ToolPart) : part,
        ),
      }));
    case "tool_update":
      return updateMessage(chat, event.messageId, (message) => upsertPart(message, event.part));
    case "message_done":
      return updateMessage(chat, event.message.id, () => event.message);
    case "todos":
      return { ...chat, todos: event.todos };
    case "change":
      return updateMessage(chat, event.messageId, (message) => {
        const changes = [...(message.changes ?? [])];
        const existing = changes.findIndex((item) => item.documentId === event.change.documentId);
        if (existing >= 0) {
          const prior = changes[existing]!;
          changes[existing] = { ...prior, added: prior.added + event.change.added, removed: prior.removed + event.change.removed, title: event.change.title };
        } else {
          changes.push(event.change);
        }
        return { ...message, changes };
      });
    case "status":
      return { ...chat, status: event.status ?? undefined };
    case "running":
      return { ...chat, running: event.running };
    case "queue":
      return { ...chat, queue: event.queue };
    case "meta":
      return { ...chat, title: event.title, documentId: event.documentId, settings: event.settings, updatedAt: event.updatedAt };
    case "context":
      return { ...chat, context: event.context };
    default:
      return chat;
  }
}

export class ChatSession {
  readonly ui = new Store<ChatUiState>({ chat: null, connected: false, error: null, rateLimit: null });
  private source: EventSource | null = null;
  private seq: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(readonly id: string) {}

  connect() {
    if (this.closed) return;
    this.source?.close();
    const query = this.seq != null ? `?after=${this.seq}` : "";
    const source = new EventSource(`/api/agent/chats/${this.id}/events${query}`);
    this.source = source;
    source.onopen = () => this.ui.set((ui) => ({ ...ui, connected: true, error: null }));
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as SequencedChatEvent;
      this.seq = event.seq;
      if (event.type === "rate_limit") {
        this.ui.set((ui) => ({ ...ui, rateLimit: event.rateLimit }));
        return;
      }
      this.ui.set((ui) => {
        if (event.type === "snapshot") return { ...ui, chat: event.chat };
        return ui.chat ? { ...ui, chat: reduceChat(ui.chat, event) } : ui;
      });
    };
    source.onerror = () => {
      source.close();
      if (this.closed) return;
      this.ui.set((ui) => ({ ...ui, connected: false }));
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.connect(), 1000);
    };
  }

  close() {
    this.closed = true;
    this.source?.close();
    if (this.timer) clearTimeout(this.timer);
  }

  async send(input: { text: string; documentId: string | null; selection?: SelectionContext; attachments?: Attachment[] }) {
    try {
      await post(`/api/agent/chats/${this.id}/messages`, input);
      this.ui.set((ui) => ({ ...ui, error: null }));
    } catch (error) {
      this.ui.set((ui) => ({ ...ui, error: error instanceof Error ? error.message : "Couldn't send the message." }));
      throw error;
    }
  }

  interrupt() {
    return post(`/api/agent/chats/${this.id}/interrupt`).catch(() => undefined);
  }

  retry() {
    return post(`/api/agent/chats/${this.id}/retry`).catch(() => undefined);
  }

  removeQueued(queueId: string) {
    return del(`/api/agent/chats/${this.id}/queue/${queueId}`).catch(() => undefined);
  }

  update(input: { title?: string; documentId?: string | null; settings?: Partial<ChatSettings> }) {
    return patch<{ chat: ChatState }>(`/api/agent/chats/${this.id}`, input).then((result) => {
      this.ui.set((ui) => ({ ...ui, chat: ui.chat ? { ...ui.chat, title: result.chat.title, settings: result.chat.settings, documentId: result.chat.documentId } : result.chat }));
      return result.chat;
    });
  }
}

export const chatApi = {
  list: (documentId?: string) => api<{ chats: ChatSummary[] }>(`/api/agent/chats${documentId ? `?documentId=${encodeURIComponent(documentId)}` : ""}`).then((r) => r.chats),
  create: (input: { documentId: string | null; settings?: Partial<ChatSettings> }) => post<{ chat: ChatState }>("/api/agent/chats", input).then((r) => r.chat),
  remove: (id: string) => del(`/api/agent/chats/${id}`),
};
