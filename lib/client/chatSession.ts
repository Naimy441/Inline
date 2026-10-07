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
  DocumentMention,
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
      // The server's copy replaces the one the panel showed while sending.
      if (chat.messages.some((message) => message.id === event.message.id)) {
        return { ...chat, messages: chat.messages.map((message) => (message.id === event.message.id ? event.message : message)) };
      }
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

export type SendInput = {
  text: string;
  documentId: string | null;
  selection?: SelectionContext;
  attachments?: Attachment[];
  mentions?: DocumentMention[];
  /** Sent from the home page: the folder the user is looking at. */
  home?: { folderId: string | null };
};

function newId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** A chat that exists only in the panel until its first message reaches the server. */
export function draftChat(id: string, documentId: string | null, settings: ChatSettings): ChatState {
  const now = Date.now();
  return { id, title: "New chat", documentId, createdAt: now, updatedAt: now, settings, messages: [], todos: [], running: false, queue: [] };
}

export class ChatSession {
  readonly ui = new Store<ChatUiState>({ chat: null, connected: false, error: null, rateLimit: null });
  private source: EventSource | null = null;
  private seq: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  /** Streamed events wait here and are applied together once per frame, not one render per token. */
  private pending: SequencedChatEvent[] = [];
  private frame = 0;
  /** Set while the chat is still being created on the server; the stream connects once it exists. */
  private creating: Promise<unknown> | null = null;
  /** A connect is already waiting for the chat to be created. */
  private gated = false;

  constructor(readonly id: string) {}

  connect() {
    if (this.closed) return;
    if (this.creating) {
      if (this.gated) return;
      this.gated = true;
      const gate = this.creating;
      void gate.then(
        () => {
          this.gated = false;
          if (this.creating === gate) this.creating = null;
          this.connect();
        },
        () => {
          this.gated = false;
        },
      );
      return;
    }
    this.source?.close();
    const query = this.seq != null ? `?after=${this.seq}` : "";
    const source = new EventSource(`/api/agent/chats/${this.id}/events${query}`);
    this.source = source;
    source.onopen = () => this.ui.set((ui) => ({ ...ui, connected: true, error: null }));
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as SequencedChatEvent;
      this.seq = event.seq;
      this.pending.push(event);
      this.schedule();
    };
    source.onerror = () => {
      source.close();
      if (this.closed) return;
      this.flush();
      this.ui.set((ui) => ({ ...ui, connected: false }));
      if (this.timer) clearTimeout(this.timer);
      this.timer = setTimeout(() => this.connect(), 1000);
    };
  }

  private schedule() {
    if (this.frame) return;
    // A background tab gets no animation frames; a timer keeps it current.
    if (typeof document !== "undefined" && document.hidden) this.frame = window.setTimeout(() => this.flush(), 50) as unknown as number;
    else this.frame = requestAnimationFrame(() => this.flush());
  }

  private flush() {
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      clearTimeout(this.frame);
      this.frame = 0;
    }
    const events = this.pending;
    if (!events.length) return;
    this.pending = [];
    this.ui.set((ui) => {
      let next = ui;
      for (const event of events) {
        if (event.type === "rate_limit") next = { ...next, rateLimit: event.rateLimit };
        else if (event.type === "snapshot") next = { ...next, chat: event.chat };
        else if (next.chat) next = { ...next, chat: reduceChat(next.chat, event) };
      }
      return next;
    });
  }

  /** Connect unless the stream is already open or about to reconnect. */
  ensureConnected() {
    if (this.closed || this.timer || this.gated) return;
    if (this.source && this.source.readyState !== EventSource.CLOSED) return;
    this.connect();
  }

  close() {
    this.closed = true;
    this.source?.close();
    if (this.timer) clearTimeout(this.timer);
    if (this.frame) {
      cancelAnimationFrame(this.frame);
      clearTimeout(this.frame);
    }
  }

  /**
   * Show a message and Claude's reply placeholder at once, before the request
   * goes out; the server keeps the same ids, so its copies replace these.
   * Returns a function that takes them back if sending fails.
   */
  private showSending(input: SendInput, ids: { user: string; assistant: string }) {
    const now = Date.now();
    const chat = this.ui.get().chat;
    if (!chat) return () => undefined;
    if (chat.running) {
      const queued = { id: ids.user, text: input.text, createdAt: now, selection: input.selection, attachments: input.attachments, mentions: input.mentions };
      this.ui.set((ui) => (ui.chat ? { ...ui, error: null, chat: { ...ui.chat, queue: [...ui.chat.queue, queued] } } : ui));
      return () => this.ui.set((ui) => (ui.chat ? { ...ui, chat: { ...ui.chat, queue: ui.chat.queue.filter((item) => item.id !== ids.user) } } : ui));
    }
    const user = { id: ids.user, role: "user" as const, text: input.text, createdAt: now, selection: input.selection, attachments: input.attachments, mentions: input.mentions };
    const assistant: AssistantMessage = { id: ids.assistant, role: "assistant", createdAt: now, parts: [], status: "streaming" };
    this.ui.set((ui) =>
      ui.chat
        ? {
            ...ui,
            error: null,
            chat: {
              ...ui.chat,
              title: ui.chat.messages.length ? ui.chat.title : input.text.slice(0, 60) || ui.chat.title,
              messages: [...ui.chat.messages, user, assistant],
              running: true,
              status: { kind: "starting" },
            },
          }
        : ui,
    );
    return () =>
      this.ui.set((ui) =>
        ui.chat ? { ...ui, chat: { ...ui.chat, running: false, status: undefined, messages: ui.chat.messages.filter((message) => message.id !== ids.user && message.id !== ids.assistant) } } : ui,
      );
  }

  private failed(error: unknown, undo: () => void): never {
    undo();
    this.ui.set((ui) => ({ ...ui, error: error instanceof Error ? error.message : "Couldn't send the message." }));
    throw error;
  }

  async send(input: SendInput) {
    const ids = { user: newId(), assistant: newId() };
    const undo = this.showSending(input, ids);
    try {
      await post(`/api/agent/chats/${this.id}/messages`, { ...input, ids });
    } catch (error) {
      this.failed(error, undo);
    }
  }

  /**
   * Start a new chat with its first message in one request. The panel shows
   * the message straight away; the event stream connects once the chat exists.
   */
  async create(input: SendInput, settings: ChatSettings) {
    const ids = { user: newId(), assistant: newId() };
    this.ui.set((ui) => ({ ...ui, chat: ui.chat ?? draftChat(this.id, input.documentId, settings) }));
    const undo = this.showSending(input, ids);
    const request = post("/api/agent/chats", { id: this.id, documentId: input.documentId, settings, message: { ...input, ids } });
    this.creating = request;
    try {
      await request;
    } catch (error) {
      this.creating = null;
      this.failed(error, undo);
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

/** Start Claude Code ahead of a message: at most once a minute per chat. */
const warmedAt = new Map<string, number>();
export function warmChat(input: { id: string; exists: boolean; documentId: string | null; settings: ChatSettings }) {
  const now = Date.now();
  if (now - (warmedAt.get(input.id) ?? 0) < 60_000) return;
  warmedAt.set(input.id, now);
  const request = input.exists
    ? post(`/api/agent/chats/${input.id}/warm`)
    : post("/api/agent/chats", { id: input.id, documentId: input.documentId, settings: input.settings, warm: true });
  void request.catch(() => warmedAt.delete(input.id));
}

export { newId as newChatId };

export const chatApi = {
  list: (documentId?: string) => api<{ chats: ChatSummary[] }>(`/api/agent/chats${documentId ? `?documentId=${encodeURIComponent(documentId)}` : ""}`).then((r) => r.chats),
  create: (input: { documentId: string | null; settings?: Partial<ChatSettings> }) => post<{ chat: ChatState }>("/api/agent/chats", input).then((r) => r.chat),
  remove: (id: string) => del(`/api/agent/chats/${id}`),
};

// --- open chats ------------------------------------------------------------------------------
// Chats stay open for a while after the panel lets go of them, so closing and
// reopening the panel, or switching document tabs, shows the chat at once
// instead of an empty panel while it reloads.

const KEEP_MS = 2 * 60_000;
const KEEP_IDLE = 2;
const open = new Map<string, { session: ChatSession; users: number; timer: ReturnType<typeof setTimeout> | null }>();

/** The open chat with this id, if there is one, without taking hold of it. */
export function peekChat(id: string) {
  return open.get(id)?.session ?? null;
}

/** Hold a chat open (connecting it if needed). `created` is a session made for a chat that is still being created. */
export function acquireChat(id: string, created?: ChatSession) {
  let entry = open.get(id);
  if (entry && created && entry.session !== created) {
    entry.session.close();
    entry = undefined;
  }
  if (!entry) {
    entry = { session: created ?? new ChatSession(id), users: 0, timer: null };
    open.set(id, entry);
  }
  if (entry.timer) clearTimeout(entry.timer);
  entry.timer = null;
  entry.users += 1;
  entry.session.ensureConnected();
  return entry.session;
}

export function releaseChat(session: ChatSession) {
  const entry = open.get(session.id);
  if (!entry || entry.session !== session) {
    session.close();
    return;
  }
  entry.users = Math.max(0, entry.users - 1);
  if (entry.users > 0) return;
  entry.timer = setTimeout(() => evict(session.id), KEEP_MS);
  // Each open chat holds a connection; keep only the most recent few idle ones.
  const idle = [...open.entries()].filter(([, value]) => value.users === 0);
  for (const [chatId] of idle.slice(0, Math.max(0, idle.length - KEEP_IDLE))) evict(chatId);
}

function evict(id: string) {
  const entry = open.get(id);
  if (!entry || entry.users > 0) return;
  if (entry.timer) clearTimeout(entry.timer);
  open.delete(id);
  entry.session.close();
}

const CHAT_KEY = "inline-chat:";

/** The chat last open for a document (or its tabs, under the first tab's id). */
export function rememberedChat(documentId: string) {
  try {
    return localStorage.getItem(`${CHAT_KEY}${documentId}`);
  } catch {
    return null;
  }
}

export function rememberChat(documentId: string, chatId: string | null) {
  try {
    if (chatId) localStorage.setItem(`${CHAT_KEY}${documentId}`, chatId);
    else localStorage.removeItem(`${CHAT_KEY}${documentId}`);
  } catch {
    // ignore
  }
}
