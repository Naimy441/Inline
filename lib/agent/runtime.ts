import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createInlineSdkServer, mcpToolName } from "@/lib/agent/mcp";
import { systemPrompt } from "@/lib/agent/prompt";
import { documentListing, type ToolContext } from "@/lib/agent/tools";
import type {
  AgentStatus,
  AssistantMessage,
  AssistantPart,
  Attachment,
  ChatEvent,
  ChatMessage,
  ChatSettings,
  ChatState,
  ChatSummary,
  DocumentChange,
  Effort,
  ModelOption,
  PlanUsage,
  QueuedMessage,
  RunStatus,
  SelectionContext,
  SequencedChatEvent,
  Todo,
  ThinkingPart,
  ToolPart,
  UserMessage,
  UsageWindow,
  DocumentMention,
} from "@/lib/agent/types";
import { DEFAULT_MAX_TURNS } from "@/lib/agent/types";
import { documentHub, type LiveDocument } from "@/lib/server/hub";
import { folderPathName, listFolders } from "@/lib/server/folders";
import { library } from "@/lib/server/library";
import { findText, textblockLines } from "@/lib/doc/editing";
import { serializeDoc } from "@/lib/doc/markdown";
import { chatFilePath, deleteChatFile, FileSummaryCache, findUpload, listChatIds, readChatFile, workspaceDir, writeChatFile } from "@/lib/server/store";
import { isUserSuggestion } from "@/lib/doc/review";
import { log } from "@/lib/server/log";
import { attachmentText } from "@/lib/agent/attachments";

/**
 * The in-app agent: each chat is a Claude Code session (via the Claude Agent
 * SDK) whose only tools are Inline's MCP document tools plus web search,
 * web fetch and a todo list. Authentication is the user's own Claude Code
 * login; Inline never handles API keys.
 *
 * A chat keeps one long-lived streaming-input query while it is in use, so
 * follow-up messages start instantly. Idle sessions are closed and resumed
 * from Claude Code's transcript on the next message.
 */

export const BUILTIN_TOOLS = ["WebSearch", "WebFetch", "TodoWrite"];
const IDLE_CLOSE_MS = 15 * 60 * 1000;
const MAX_LIVE_SESSIONS = 6;
const EVENT_BUFFER = 4000;
const PERSIST_DELAY_MS = 1500;
/** A session started ahead of a message (the user is typing) closes sooner if nothing is sent. */
const WARM_CLOSE_MS = 5 * 60 * 1000;

type PersistedChat = {
  format: 1;
  id: string;
  title: string;
  documentId: string | null;
  createdAt: number;
  updatedAt: number;
  settings: ChatSettings;
  messages: ChatMessage[];
  todos: Todo[];
  /** Whether Claude Code has a transcript for this chat's session, so it can be resumed. */
  sessionStarted: boolean;
  /** Claude Code's session id; the chat id until a rewind forks a new session. */
  sessionId?: string;
  /** A rewind not yet applied: the next session forks `forkFrom` at this transcript entry, as `sessionId`. */
  forkAt?: string | null;
  forkFrom?: string | null;
  /** Claude Code's running cost total for the session when it was last seen, to work out each reply's own cost. */
  sessionCostUsd?: number;
  rewoundUsd?: number;
  /** "per-message" once each reply's usage.costUsd is its own cost (older files stored Claude Code's running total). */
  costs?: "per-message";
};

/** Starts a Claude Code session. Tests swap in a scripted stand-in (lib/agent/testing/fakeClaude.ts). */
let startQuery: typeof query = query;
export function setQueryImplementation(next: typeof query | null) {
  startQuery = next ?? query;
}

export type SendInput = {
  text: string;
  documentId?: string | null;
  selection?: SelectionContext;
  attachments?: Attachment[];
  mentions?: DocumentMention[];
  /** Ids the panel already gave the message and the reply it shows right away, so the server's copies replace them in place. */
  ids?: { user: string; assistant: string };
  /** Sent from the home page: the folder the user is looking at (null for the top level). */
  home?: { folderId: string | null };
};

type TurnInput = Omit<SendInput, "documentId">;

class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(item: T) {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/**
 * " (lines 4-6)" for a selection, so Claude can target the right copy when the
 * selected text appears more than once. Only when the text is still there.
 */
function selectionLines(doc: LiveDocument, selection: SelectionContext) {
  try {
    const size = doc.doc.content.size;
    const from = Math.max(0, Math.min(size, selection.from));
    const to = Math.max(from, Math.min(size, selection.to));
    if (doc.doc.textBetween(from, to, "\n").trim() !== selection.text.trim()) return "";
    const lines = textblockLines(serializeDoc(doc.doc)).filter((entry) => entry.pos + entry.node.nodeSize > from && entry.pos < to);
    if (!lines.length) return "";
    const first = lines[0]!.startLine;
    const last = lines[lines.length - 1]!.endLine;
    const repeats = findText(doc.doc, selection.text.split("\n")[0]!.trim(), { caseSensitive: true }).length > 1;
    return ` (${first === last ? `line ${first}` : `lines ${first}-${last}`} of read_document${repeats ? "; this text appears more than once, so edit the copy on these lines" : ""})`;
  } catch {
    return "";
  }
}

/** Where the user's cursor is (for the inline prompt with nothing selected): the line and its text. */
function cursorContext(doc: LiveDocument, pos: number) {
  try {
    const at = Math.max(0, Math.min(doc.doc.content.size, pos));
    const entry = textblockLines(serializeDoc(doc.doc)).find((line) => line.pos <= at && at <= line.pos + line.node.nodeSize);
    if (!entry) return "";
    const offset = Math.max(0, at - entry.pos - 1);
    const text = entry.node.textContent;
    return `The user's cursor is on line ${entry.startLine} of read_document, ${offset >= text.length ? "at the end of" : `after "${text.slice(Math.max(0, offset - 60), offset)}" in`} this paragraph:\n"""\n${text.slice(0, 4000)}\n"""`;
  } catch {
    return "";
  }
}

/** Image types Claude accepts as images; others (SVG) are sent as their source text. */
const CLAUDE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function clip(text: string, max: number) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

const ASSISTANT_ERRORS: Record<string, string> = {
  authentication_failed: "Claude Code is not signed in. Run `claude` in a terminal and use /login, then try again.",
  oauth_org_not_allowed: "Your Claude organization does not allow Claude Code.",
  account_on_hold: "Your Claude account is on hold.",
  verification_required: "Your Claude account needs verification. Open Claude Code in a terminal to continue.",
  billing_error: "Claude reported a billing problem with your account.",
  rate_limit: "You've hit your Claude usage limit. Try again later or switch to a smaller model.",
  overloaded: "Claude is overloaded right now. Try again in a moment.",
  model_not_found: "The selected model isn't available to your account. Pick another model.",
  max_output_tokens: "The response hit the output limit.",
};

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (block && typeof block === "object" && "type" in block) {
          if (block.type === "text") return String((block as { text?: string }).text ?? "");
          if (block.type === "image") return "[image]";
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

class ChatRuntime {
  private seq = 0;
  private events: SequencedChatEvent[] = [];
  private listeners = new Set<(event: SequencedChatEvent) => void>();
  private query: Query | null = null;
  private input: AsyncQueue<SDKUserMessage> | null = null;
  private current: AssistantMessage | null = null;
  private partsByBlock = new Map<string, string>();
  private blocksDelivered = new Map<string, number>();
  /** Documents this turn has written to, with the version saved before the first write. */
  private wroteThisTurn = new Map<string, string>();
  private interrupted = false;
  private discarded = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private toolInputs = new Map<string, string>();
  lastUsed = Date.now();
  state: ChatState;
  private sessionStarted: boolean;
  private sessionId: string;
  private forkAt: string | null;
  private sessionCostUsd: number | null;
  /** The running cost total this query's replies are measured from; null until known. */
  private costBase: number | null = null;
  private resumedQuery = false;
  /** Set when Claude is stopped at the user's usage limit: the reason shown on the reply. */
  private limitStop: string | null = null;
  private lastLimitCheck = 0;
  /** Plan usage being fetched as a Claude Code session starts. */
  private usageReady: Promise<PlanUsage | null> | null = null;

  constructor(file: PersistedChat) {
    this.sessionStarted = file.sessionStarted;
    this.sessionId = file.sessionId ?? file.id;
    this.forkAt = file.forkAt ?? null;
    this.forkFrom = file.forkFrom ?? null;
    this.sessionCostUsd = file.sessionCostUsd ?? null;
    if (file.costs !== "per-message") perMessageCosts(file.messages);
    for (const message of file.messages) {
      if (message.role === "assistant" && message.status === "streaming") {
        message.status = "stopped";
        message.error = "Interrupted when Inline restarted.";
        for (const part of message.parts) if (part.type === "tool" && (part.status === "running" || part.status === "pending")) part.status = "error";
      }
    }
    this.state = {
      id: file.id,
      title: file.title,
      documentId: file.documentId,
      createdAt: file.createdAt,
      updatedAt: file.updatedAt,
      settings: file.settings,
      messages: file.messages,
      todos: file.todos,
      running: false,
      queue: [],
      ...(file.rewoundUsd ? { rewoundUsd: file.rewoundUsd } : {}),
    };
  }

  get live() {
    return this.query !== null;
  }

  get liveQuery() {
    return this.query;
  }

  /** Not running, not streaming to anyone and not holding a Claude Code session; safe to drop from memory. */
  get unloadable() {
    return !this.live && !this.state.running && this.listeners.size === 0 && !this.persistTimer;
  }

  summary(): ChatSummary {
    const lastAssistant = [...this.state.messages].reverse().find((message) => message.role === "assistant") as AssistantMessage | undefined;
    const lastText = lastAssistant?.parts.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join(" ");
    const firstUser = this.state.messages.find((message) => message.role === "user") as UserMessage | undefined;
    return {
      id: this.state.id,
      title: this.state.title,
      documentId: this.state.documentId,
      createdAt: this.state.createdAt,
      updatedAt: this.state.updatedAt,
      messageCount: this.state.messages.length,
      preview: clip(lastText || firstUser?.text || "", 120),
    };
  }

  // --- events -----------------------------------------------------------------

  subscribe(listener: (event: SequencedChatEvent) => void, after?: number) {
    // Replay buffered events when the client is reconnecting and none were dropped; otherwise send a snapshot.
    const oldest = this.events[0]?.seq ?? this.seq + 1;
    if (after != null && after >= oldest - 1 && after <= this.seq) {
      for (const event of this.events) if (event.seq > after) listener(event);
    } else {
      listener({ type: "snapshot", chat: this.state, seq: this.seq });
    }
    this.listeners.add(listener);
    this.lastUsed = Date.now();
    return () => {
      this.listeners.delete(listener);
      this.lastUsed = Date.now();
    };
  }

  private emit(event: ChatEvent) {
    this.seq += 1;
    const sequenced = { ...event, seq: this.seq } as SequencedChatEvent;
    this.events.push(sequenced);
    if (this.events.length > EVENT_BUFFER) this.events.splice(0, this.events.length - EVENT_BUFFER);
    for (const listener of this.listeners) {
      try {
        listener(sequenced);
      } catch {
        // A broken connection must not stop the run.
      }
    }
  }

  private setStatus(status: RunStatus | null) {
    this.state.status = status ?? undefined;
    this.emit({ type: "status", status });
  }

  private emitMeta() {
    this.emit({ type: "meta", title: this.state.title, documentId: this.state.documentId, settings: this.state.settings, updatedAt: this.state.updatedAt });
  }

  // --- persistence -------------------------------------------------------------

  toFile(): PersistedChat {
    return {
      format: 1,
      id: this.state.id,
      title: this.state.title,
      documentId: this.state.documentId,
      createdAt: this.state.createdAt,
      updatedAt: this.state.updatedAt,
      settings: this.state.settings,
      messages: this.state.messages,
      todos: this.state.todos,
      sessionStarted: this.sessionStarted,
      sessionId: this.sessionId,
      forkAt: this.forkAt,
      forkFrom: this.forkFrom,
      ...(this.sessionCostUsd != null ? { sessionCostUsd: this.sessionCostUsd } : {}),
      ...(this.state.rewoundUsd ? { rewoundUsd: this.state.rewoundUsd } : {}),
      costs: "per-message",
    };
  }

  persistSoon() {
    if (this.persistTimer || this.discarded) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistNow();
    }, PERSIST_DELAY_MS);
  }

  async persistNow() {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (this.discarded) return;
    const write = writeChatFile(this.state.id, this.toFile());
    this.writing = write.catch(() => undefined);
    await write;
  }

  private writing: Promise<void> = Promise.resolve();

  /** Stop persisting this chat (it is being deleted) and wait for any write in flight. */
  async discard() {
    this.discarded = true;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = null;
    await this.writing;
  }

  // --- settings ----------------------------------------------------------------

  async update(patch: { title?: string; documentId?: string | null; settings?: Partial<ChatSettings> }) {
    if (patch.title != null) this.state.title = clip(patch.title, 120) || this.state.title;
    if (patch.documentId !== undefined) this.state.documentId = patch.documentId;
    if (patch.settings) {
      const next = { ...this.state.settings, ...patch.settings };
      const query = this.query;
      if (query && next.model !== this.state.settings.model) await query.setModel(next.model ?? undefined).catch(() => this.close());
      if (query && next.effort !== this.state.settings.effort) await query.applyFlagSettings({ effortLevel: next.effort }).catch(() => this.close());
      // Limits are fixed when Claude Code starts; the session resumes with the new ones on the next message.
      if (query && !this.state.running && next.maxTurns !== this.state.settings.maxTurns) this.close();
      this.state.settings = next;
    }
    this.state.updatedAt = Date.now();
    this.emitMeta();
    this.persistSoon();
  }

  // --- turns -------------------------------------------------------------------

  async send(input: SendInput) {
    const text = input.text.trim();
    if (!text && !input.attachments?.length) throw new Error("Message is empty.");
    if (input.documentId !== undefined && input.documentId !== this.state.documentId) {
      this.state.documentId = input.documentId;
      this.emitMeta();
    }
    if (input.home) this.home = input.home;
    const ids = input.ids && !this.state.messages.some((message) => message.id === input.ids!.user || message.id === input.ids!.assistant) ? input.ids : undefined;
    if (this.state.running) {
      const queued: QueuedMessage = { id: ids?.user ?? randomUUID(), text, createdAt: Date.now(), selection: input.selection, attachments: input.attachments, mentions: input.mentions };
      this.state.queue.push(queued);
      this.emit({ type: "queue", queue: this.state.queue });
      return { queued: true, id: queued.id };
    }
    await this.startTurn({ text, selection: input.selection, attachments: input.attachments, mentions: input.mentions, ids });
    return { queued: false, id: this.state.messages[this.state.messages.length - 2]!.id };
  }

  removeQueued(id: string) {
    const before = this.state.queue.length;
    this.state.queue = this.state.queue.filter((item) => item.id !== id);
    if (this.state.queue.length !== before) this.emit({ type: "queue", queue: this.state.queue });
  }

  private async startTurn(input: TurnInput) {
    this.lastUsed = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const now = Date.now();
    const user: UserMessage = { id: input.ids?.user ?? randomUUID(), role: "user", text: input.text, createdAt: now, selection: input.selection, attachments: input.attachments, mentions: input.mentions };
    const assistant: AssistantMessage = { id: input.ids?.assistant ?? randomUUID(), role: "assistant", createdAt: now, parts: [], status: "streaming", model: this.state.settings.model ?? undefined };
    if (!this.state.messages.length || this.state.title === "New chat") {
      this.state.title = clip(input.text || input.attachments?.[0]?.name || "New chat", 60);
    }
    this.state.messages.push(user, assistant);
    this.state.updatedAt = now;
    this.state.running = true;
    this.current = assistant;
    this.interrupted = false;
    this.wroteThisTurn.clear();
    this.partsByBlock.clear();
    this.blocksDelivered.clear();
    this.toolInputs.clear();
    this.emit({ type: "message", message: user });
    this.emit({ type: "message", message: assistant });
    this.emit({ type: "running", running: true });
    this.emitMeta();
    this.setStatus({ kind: "starting" });
    this.setDocumentActivity("thinking", "Claude is working");

    let message: SDKUserMessage;
    try {
      message = await this.buildUserMessage(input);
      const live = this.live;
      this.ensureQuery();
      const over = await this.overUsageLimit(true);
      if (over) {
        this.finishTurn("error", over);
        return;
      }
      this.input!.push(message);
      // A session that is already running (warmed up, or from the last message) starts on it right away.
      if (live) this.setStatus({ kind: "thinking" });
    } catch (error) {
      this.finishTurn("error", errorText(error));
      return;
    }
    void this.persistNow();
  }

  /** The document version Claude last saw in full (sent with a message), so an unchanged document isn't sent again. */
  private listed: { id: string; version: number } | null = null;

  /**
   * The reason to stop when the plan usage is at or past the user's limit,
   * else null. Uses usage fetched in the last minute, or fetches it when
   * `fresh` is set (at the start of a reply) or 45 seconds have passed.
   */
  private async overUsageLimit(fresh = false): Promise<string | null> {
    const limit = this.state.settings.usageLimit;
    if (!limit) return null;
    const runtime = agentRuntime();
    let usage: PlanUsage | null = null;
    if (fresh && this.usageReady) {
      usage = await this.usageReady;
      this.usageReady = null;
    }
    usage ??= runtime.cachedPlanUsage(60_000);
    if (!usage && (fresh || Date.now() - this.lastLimitCheck > 45_000)) {
      this.lastLimitCheck = Date.now();
      usage = await runtime.planUsage({ query: this.query ?? undefined, maxAgeMs: 60_000 }).catch(() => null);
    }
    return usageLimitReason(usage, limit);
  }

  private stopAtLimit(reason: string) {
    if (!this.state.running || this.limitStop) return;
    this.limitStop = reason;
    void this.interrupt(true);
  }

  private async buildUserMessage(input: TurnInput): Promise<SDKUserMessage> {
    const context: string[] = [];
    context.push(
      this.state.settings.mode === "ask"
        ? "Mode: Ask. You can read documents but not change them."
        : "Mode: Agent. Make requested changes directly in the document.",
    );
    const doc = this.state.documentId ? await documentHub().get(this.state.documentId) : null;
    if (doc && !doc.meta.trashedAt) {
      const tabs = doc.meta.parentId || doc.meta.tabs?.length ? await documentHub().tabs(doc.id).catch(() => []) : [];
      if (tabs.length > 1) {
        const open = tabs.find((tab) => tab.id === doc.id);
        context.push(`Open document: "${doc.meta.title}", tab "${open?.title ?? ""}" (id ${doc.id}).`);
        context.push(`The document has ${tabs.length} tabs, each with its own content: ${tabs.map((tab) => `"${tab.title}" (id ${tab.id})`).join(", ")}. Document tools default to the open tab; pass another tab's id as document_id to read or edit it.`);
      } else {
        context.push(`Open document: "${doc.meta.title}" (id ${doc.id}).`);
      }
      const root = doc.meta.parentId ? await documentHub().get(doc.meta.parentId) : doc;
      if (root?.meta.folderId) {
        const folders = new Map((await listFolders()).map((folder) => [folder.id, folder]));
        const where = folderPathName(folders, root.meta.folderId);
        if (where) context.push(`It is filed in the folder "${where}".`);
      }
      const suggestions = doc.hunks.filter(isUserSuggestion).length;
      const pending = doc.hunks.length - suggestions;
      if (pending) context.push(`${pending} earlier change${pending === 1 ? "" : "s"} by Claude ${pending === 1 ? "is" : "are"} still awaiting the user's review.`);
      if (suggestions) context.push(`The user has ${suggestions} pending suggestion${suggestions === 1 ? "" : "s"} of their own (suggesting mode).`);
      if (doc.editorMode !== "editing") context.push(`The user's editor is in ${doc.editorMode} mode.`);
      // Small documents come with the message, saving Claude a read_document round trip before it can edit.
      if (!this.listed || this.listed.id !== doc.id || this.listed.version !== doc.version) {
        const listing = documentListing(doc);
        if (listing) {
          context.push(`The document as read_document would return it now (no need to read it again before editing, unless it changes):\n<document>\n${listing}\n</document>`);
          this.listed = { id: doc.id, version: doc.version };
        }
      } else {
        context.push("The document hasn't changed since you last saw it in full.");
      }
      const since = Math.max(this.eventsToldAt, this.previousReplyAt());
      this.eventsToldAt = Date.now();
      const events = doc.userEvents.filter((event) => event.at > since).map((event) => event.text);
      if (events.length) context.push(`Since your last reply, the user ${events.join("; ")}. The document may differ from what you last saw, so read it again before relying on earlier content.`);
    } else if (this.home && !this.state.documentId) {
      const { folders, documents } = await library();
      const unfiled = documents.filter((item) => !item.folderId || !folders.has(item.folderId)).length;
      const where = this.home.folderId && folders.has(this.home.folderId) ? `the folder "${folderPathName(folders, this.home.folderId)}" (id ${this.home.folderId})` : "all documents (the top level)";
      context.push(`The user is on the home page, not in a document, looking at ${where}. Their library has ${documents.length} document${documents.length === 1 ? "" : "s"} (${unfiled} unfiled) and ${folders.size} folder${folders.size === 1 ? "" : "s"}. Use list_library to see them.`);
    } else {
      context.push("No document is open.");
    }
    if (this.rewindNote) {
      context.push(this.rewindNote);
      this.rewindNote = null;
    }
    if (input.selection && !input.selection.text.trim() && doc && input.selection.documentId === doc.id) {
      const where = cursorContext(doc, input.selection.from);
      if (where) context.push(where);
    }
    if (input.selection?.text.trim()) {
      const where = doc && input.selection.documentId === doc.id ? selectionLines(doc, input.selection) : "";
      context.push(`The user selected this text in the document${where}:\n"""\n${input.selection.text.slice(0, 8000)}\n"""`);
    }
    if (input.mentions?.length) {
      context.push(
        `The user mentioned ${input.mentions.length === 1 ? "this document" : "these documents"}: ${input.mentions.map((item) => `"${item.title}" (id ${item.id})`).join(", ")}. Read ${input.mentions.length === 1 ? "it" : "them"} with read_document and the document_id when relevant.`,
      );
    }
    if (input.attachments?.length) {
      context.push(
        `Attached to this message: ${input.attachments.map((item) => `"${item.name}" (${item.kind}, id ${item.id})`).join(", ")}. Images can be placed in the document with insert_image; text files can be read again later with read_attachment.`,
      );
    }
    const blocks: Array<Record<string, unknown>> = [{ type: "text", text: `<inline-context>\n${context.join("\n")}\n</inline-context>` }];
    for (const attachment of input.attachments ?? []) {
      const upload = await findUpload(attachment.id);
      if (!upload) {
        blocks.push({ type: "text", text: `[Attachment "${attachment.name}" is no longer available.]` });
        continue;
      }
      const data = await readFile(upload.file);
      if (attachment.kind === "image" && CLAUDE_IMAGE_TYPES.has(attachment.mime)) {
        blocks.push({ type: "image", source: { type: "base64", media_type: attachment.mime, data: data.toString("base64") } });
      } else if (attachment.kind === "pdf") {
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: data.toString("base64") }, title: attachment.name });
      } else {
        blocks.push({ type: "text", text: `<attachment name="${attachment.name}">\n${(await attachmentText(upload.extension, data)).slice(0, 200_000)}\n</attachment>` });
      }
    }
    if (input.text) blocks.push({ type: "text", text: input.text });
    return { type: "user", message: { role: "user", content: blocks as never }, parent_tool_use_id: null };
  }

  /** For chats on the home page: what the user is looking at, from their latest message. */
  private home: { folderId: string | null } | null = null;

  /** When the user's events were last told to Claude, so each is told once. */
  private eventsToldAt = 0;

  /** When Claude's previous reply in this chat started (0 for the first message). */
  private previousReplyAt() {
    const messages = this.state.messages;
    for (let index = messages.length - 3; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "assistant") return message.createdAt;
    }
    return 0;
  }

  /**
   * Rewind the chat to just before the user message that led to `messageId`
   * (an assistant reply): that message and everything after it are removed,
   * and Claude Code's session forks from the end of the last reply kept, so
   * Claude forgets the rewound turns too. Returns the removed user message.
   */
  async rewind(messageId: string): Promise<UserMessage | null> {
    if (this.state.running) {
      await this.interrupt();
      for (let waited = 0; this.state.running && waited < 6000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
      if (this.state.running) throw new Error("Claude is still finishing its reply. Try again in a moment.");
    }
    const index = this.state.messages.findIndex((message) => message.id === messageId);
    if (index < 0) throw new Error("That message is no longer in this chat.");
    let start = index;
    while (start > 0 && this.state.messages[start]!.role !== "user") start -= 1;
    const removed = this.state.messages.slice(start);
    const user = removed[0]?.role === "user" ? removed[0] : null;
    const kept = this.state.messages.slice(0, start);
    const spent = removed.reduce((sum, message) => sum + (message.role === "assistant" ? (message.usage?.costUsd ?? 0) : 0), 0);
    if (spent) this.state.rewoundUsd = (this.state.rewoundUsd ?? 0) + spent;
    this.state.messages = kept;
    this.state.queue = [];
    // The forked session hasn't seen the document since; send it in full again.
    this.listed = null;
    this.state.todos = [];
    // Claude Code forgets the rewound turns too: the next message forks the session at the end of the
    // last reply kept, or starts a new session when nothing is kept.
    this.close();
    const lastKept = [...kept].reverse().find((message) => message.role === "assistant") as AssistantMessage | undefined;
    this.rewindNote = null;
    if (!kept.length || !this.sessionStarted) {
      this.sessionId = randomUUID();
      this.sessionStarted = false;
      this.forkAt = null;
      this.forkFrom = null;
      this.sessionCostUsd = null;
    } else if (lastKept?.sessionPoint) {
      // A fork still pending from an earlier rewind branches from the same original session.
      this.forkFrom = this.forkAt ? this.forkFrom : this.sessionId;
      this.forkAt = lastKept.sessionPoint;
      this.sessionId = randomUUID();
      this.sessionCostUsd = null;
    } else if (user) {
      // A reply from before rewinds were possible has no recorded point: keep the session and tell Claude.
      this.rewindNote = `The user rewound this chat to before their message "${clip(user.text, 200)}". Disregard that message and everything after it.`;
    }
    this.state.updatedAt = Date.now();
    this.emit({ type: "snapshot", chat: this.state });
    await this.persistNow();
    return user;
  }

  private forkFrom: string | null;
  /** Told to Claude with the next message after a rewind that couldn't fork the session. */
  private rewindNote: string | null = null;

  private toolContext(): ToolContext {
    return {
      author: this.state.id,
      turn: this.current?.id,
      attachments: () => this.state.messages.flatMap((message) => (message.role === "user" ? (message.attachments ?? []) : [])),
      documentId: this.state.documentId ?? undefined,
      readOnly: this.state.settings.mode === "ask",
      beforeWrite: async (doc) => {
        if (this.wroteThisTurn.has(doc.id)) return;
        this.wroteThisTurn.set(doc.id, await doc.checkpoint("Before Claude's edits"));
      },
      onChange: (change) => this.recordChange(change),
    };
  }

  private recordChange(change: DocumentChange) {
    const message = this.current;
    if (!message) return;
    message.changes ??= [];
    const existing = message.changes.find((item) => item.documentId === change.documentId);
    if (existing) {
      existing.added += change.added;
      existing.removed += change.removed;
      existing.title = change.title;
      existing.tool = change.tool;
    } else {
      const checkpoint = this.wroteThisTurn.get(change.documentId);
      message.changes.push(checkpoint ? { ...change, checkpoint } : { ...change });
    }
    this.emit({ type: "change", messageId: message.id, change });
  }

  private setDocumentActivity(status: "thinking" | "reading" | "editing" | "idle", label: string) {
    const id = this.state.documentId;
    if (!id) return;
    void documentHub()
      .get(id)
      .then((doc) => doc?.setActivity(status === "idle" ? null : { chatId: this.state.id, status, label }))
      .catch(() => undefined);
  }

  private ensureQuery() {
    if (this.query) return;
    const input = new AsyncQueue<SDKUserMessage>();
    const settings = this.state.settings;
    const date = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const fork = this.forkAt && this.forkFrom && this.sessionStarted ? { resume: this.forkFrom, resumeSessionAt: this.forkAt, forkSession: true, sessionId: this.sessionId } : null;
    this.costBase = null;
    this.resumedQuery = this.sessionStarted && !fork;
    const q = startQuery({
      prompt: input,
      options: {
        cwd: workspaceDirSync(),
        systemPrompt: systemPrompt(date),
        tools: BUILTIN_TOOLS,
        allowedTools: [mcpToolName("*"), ...BUILTIN_TOOLS],
        mcpServers: { inline: createInlineSdkServer(() => this.toolContext()) },
        // Only Inline's tools: none of the user's own MCP servers or claude.ai connectors (Google Drive and so on).
        strictMcpConfig: true,
        settings: { disableClaudeAiConnectors: true },
        env: { ...process.env, ENABLE_CLAUDEAI_MCP_SERVERS: "false" },
        settingSources: [],
        includePartialMessages: true,
        thinking: { type: "adaptive", display: "summarized" },
        effort: settings.effort,
        maxTurns: settings.maxTurns ?? DEFAULT_MAX_TURNS,
        ...(settings.model ? { model: settings.model } : {}),
        ...(fork ? fork : this.sessionStarted ? { resume: this.sessionId } : { sessionId: this.sessionId }),
        persistSession: true,
        stderr: (data) => {
          if (process.env.INLINE_DEBUG_AGENT) process.stderr.write(`[claude ${this.state.id.slice(0, 8)}] ${data}`);
        },
      },
    });
    this.query = q;
    this.input = input;
    agentRuntime().noteLive(this);
    void this.consume(q, input);
    // Plan usage for the usage meter and limit, and the running cost total replies are measured from.
    this.usageReady = agentRuntime()
      .planUsage({ query: q, force: true })
      .then((usage) => {
        if (this.query === q && this.costBase === null && usage.sessionCostUsd != null) this.costBase = usage.sessionCostUsd;
        return usage as PlanUsage;
      })
      .catch(() => null);
  }

  private async consume(q: Query, input: AsyncQueue<SDKUserMessage>) {
    // Only a query that is still this chat's own can end its turn; one closed on purpose is ignored.
    try {
      for await (const message of q) {
        if (this.query !== q) break;
        this.handle(message);
      }
      if (this.query === q && this.current) this.finishTurn(this.interrupted && !this.limitStop ? "stopped" : "error", this.limitStop ?? (this.interrupted ? undefined : "Claude Code exited unexpectedly."));
    } catch (error) {
      if (this.query === q && this.current) this.finishTurn(this.interrupted && !this.limitStop ? "stopped" : "error", this.limitStop ?? (this.interrupted ? undefined : describeFailure(errorText(error))));
    } finally {
      input.close();
      if (this.query === q) {
        this.query = null;
        this.input = null;
      }
    }
  }

  private handle(message: SDKMessage) {
    switch (message.type) {
      case "system":
        this.handleSystem(message as SDKMessage & { subtype: string });
        return;
      case "stream_event":
        if (message.parent_tool_use_id) return;
        this.handleStreamEvent(message.event as unknown as StreamEvent);
        return;
      case "assistant":
        if (message.parent_tool_use_id) return;
        if (this.current && message.uuid) this.current.sessionPoint = message.uuid;
        this.handleAssistant(message.message as unknown as { id: string; model?: string; content: Array<Record<string, unknown>> }, message.error);
        return;
      case "user":
        if (message.parent_tool_use_id) return;
        if (this.current && message.uuid && !("isReplay" in message && message.isReplay)) this.current.sessionPoint = message.uuid;
        this.handleToolResults(message.message.content);
        return;
      case "result":
        this.handleResult(message);
        return;
      case "rate_limit_event": {
        const info = message.rate_limit_info;
        this.emit({ type: "rate_limit", rateLimit: { status: info.status, resetsAt: info.resetsAt, type: info.rateLimitType, utilization: info.utilization } });
        agentRuntime().noteRateLimit(info);
        const limit = this.state.settings.usageLimit;
        const over = limit ? usageLimitReason(agentRuntime().cachedPlanUsage(Infinity), limit) : null;
        if (over) this.stopAtLimit(over);
        return;
      }
      default:
        return;
    }
  }

  private handleSystem(message: SDKMessage & { subtype: string }) {
    if (message.subtype === "init") {
      // A warmed-up session reports in before any message; only a turn creates a transcript to resume.
      if ((!this.sessionStarted || this.forkAt) && this.current) {
        this.sessionStarted = true;
        this.forkAt = null;
        this.forkFrom = null;
        this.persistSoon();
      }
      const model = (message as { model?: string }).model;
      if (this.current && model) this.current.model = model;
      // Claude Code is up; what remains is Claude thinking.
      if (this.current && this.state.status?.kind === "starting") this.setStatus({ kind: "thinking" });
    } else if (message.subtype === "api_retry") {
      const retry = message as unknown as { attempt: number; max_retries: number; retry_delay_ms: number; error: string };
      this.setStatus({ kind: "retrying", attempt: retry.attempt, maxRetries: retry.max_retries, delayMs: retry.retry_delay_ms, error: ASSISTANT_ERRORS[retry.error] ?? retry.error });
    } else if (message.subtype === "status") {
      const status = (message as { status?: string | null }).status;
      if (status === "compacting") this.setStatus({ kind: "compacting" });
    } else if (message.subtype === "compact_boundary") {
      // The summary may not keep the full text Claude was given.
      this.listed = null;
      this.setStatus({ kind: "thinking" });
    }
  }

  private addPart(part: AssistantPart) {
    const message = this.current;
    if (!message) return;
    message.parts.push(part);
    this.emit({ type: "part", messageId: message.id, part });
  }

  private findPart<T extends AssistantPart["type"]>(id: string, type: T) {
    return this.current?.parts.find((part) => part.id === id && part.type === type) as Extract<AssistantPart, { type: T }> | undefined;
  }

  private handleStreamEvent(event: StreamEvent) {
    const message = this.current;
    if (!message) return;
    if (event.type === "message_start") {
      this.streamMessageId = event.message.id;
      if (!this.state.status || this.state.status.kind === "starting" || this.state.status.kind === "retrying") this.setStatus({ kind: "thinking" });
      return;
    }
    const apiId = this.streamMessageId;
    if (event.type === "content_block_start") {
      const block = event.content_block;
      const key = `${apiId}:${event.index}`;
      if (block.type === "text") {
        const id = randomUUID();
        this.partsByBlock.set(key, id);
        this.addPart({ type: "text", id, text: block.text ?? "" });
        this.setStatus({ kind: "responding" });
      } else if (block.type === "thinking") {
        const id = randomUUID();
        this.partsByBlock.set(key, id);
        this.addPart({ type: "thinking", id, text: block.thinking ?? "" });
        this.thinkingStarted.set(id, Date.now());
        this.setStatus({ kind: "thinking" });
      } else if (block.type === "tool_use" && block.id && block.name) {
        this.partsByBlock.set(key, block.id);
        this.toolInputs.set(block.id, "");
        this.addPart({ type: "tool", id: block.id, name: block.name, input: null, status: "pending" });
        this.setStatus({ kind: "tool", name: block.name });
      }
      return;
    }
    if (event.type === "content_block_delta") {
      const partId = this.partsByBlock.get(`${apiId}:${event.index}`);
      if (!partId) return;
      const delta = event.delta;
      if (delta.type === "text_delta" && delta.text) {
        const part = this.findPart(partId, "text");
        if (!part) return;
        part.text += delta.text;
        this.emit({ type: "text_delta", messageId: message.id, partId, text: delta.text });
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        const part = this.findPart(partId, "thinking");
        if (!part) return;
        part.text += delta.thinking;
        this.emit({ type: "thinking_delta", messageId: message.id, partId, text: delta.thinking });
      } else if (delta.type === "input_json_delta" && delta.partial_json) {
        const json = (this.toolInputs.get(partId) ?? "") + delta.partial_json;
        this.toolInputs.set(partId, json);
        const part = this.findPart(partId, "tool");
        if (part) part.inputPreview = json;
        this.emit({ type: "tool_input_delta", messageId: message.id, partId, json: delta.partial_json });
      }
      return;
    }
    if (event.type === "content_block_stop") {
      const partId = this.partsByBlock.get(`${apiId}:${event.index}`);
      const part = partId ? this.findPart(partId, "thinking") : undefined;
      if (part && !part.done) {
        this.finishThinking(part);
        this.emit({ type: "part", messageId: message.id, part });
      }
    }
  }

  private streamMessageId = "";
  /** When each streamed thinking block began, to say how long Claude thought. */
  private thinkingStarted = new Map<string, number>();

  private finishThinking(part: ThinkingPart) {
    part.done = true;
    const started = this.thinkingStarted.get(part.id);
    if (started !== undefined && part.durationMs === undefined) part.durationMs = Date.now() - started;
    this.thinkingStarted.delete(part.id);
  }

  private handleAssistant(api: { id: string; model?: string; content: Array<Record<string, unknown>> }, error?: string) {
    const message = this.current;
    if (!message) return;
    if (api.model && !message.model) message.model = api.model;
    for (const block of api.content) {
      const index = this.blocksDelivered.get(api.id) ?? 0;
      this.blocksDelivered.set(api.id, index + 1);
      const key = `${api.id}:${index}`;
      const type = block.type as string;
      if (type === "text") {
        const text = String(block.text ?? "");
        const partId = this.partsByBlock.get(key);
        const part = partId ? this.findPart(partId, "text") : undefined;
        if (part) {
          if (part.text !== text) {
            part.text = text;
            this.emit({ type: "part", messageId: message.id, part });
          }
        } else if (text) {
          this.addPart({ type: "text", id: randomUUID(), text });
        }
      } else if (type === "thinking") {
        const text = String(block.thinking ?? "");
        const partId = this.partsByBlock.get(key);
        const part = partId ? this.findPart(partId, "thinking") : undefined;
        if (part) {
          part.text = text || part.text;
          this.finishThinking(part);
          this.emit({ type: "part", messageId: message.id, part });
        } else if (text) {
          this.addPart({ type: "thinking", id: randomUUID(), text, done: true });
        }
      } else if (type === "tool_use") {
        const id = String(block.id);
        const input = (block.input ?? {}) as Record<string, unknown>;
        let part = this.findPart(id, "tool");
        if (!part) {
          part = { type: "tool", id, name: String(block.name), input, status: "running" };
          this.addPart(part);
        } else {
          part.input = input;
          part.inputPreview = undefined;
          part.status = "running";
          this.emit({ type: "tool_update", messageId: message.id, part });
        }
        this.onToolStart(part);
      }
    }
    if (error) {
      message.error = ASSISTANT_ERRORS[error] ?? `Claude reported an error (${error}).`;
    }
  }

  private onToolStart(part: ToolPart) {
    this.setStatus({ kind: "tool", name: part.name });
    if (part.name === "TodoWrite" && Array.isArray(part.input?.todos)) {
      this.state.todos = (part.input.todos as Todo[]).map((todo) => ({ content: String(todo.content), activeForm: todo.activeForm, status: todo.status }));
      this.emit({ type: "todos", todos: this.state.todos });
    }
    const short = part.name.replace(/^mcp__inline__/, "");
    if (/^(edit|multi_edit|write|insert|format|set_paragraph|revert|update_document)/.test(short)) this.setDocumentActivity("editing", "Claude is editing");
    else if (/^(read|search|get_|list_|analyze)/.test(short)) this.setDocumentActivity("reading", "Claude is reading");
  }

  private handleToolResults(content: unknown) {
    const message = this.current;
    if (!message || !Array.isArray(content)) return;
    let changed = false;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result") continue;
      const part = this.findPart(String(block.tool_use_id), "tool");
      if (!part) continue;
      part.result = toolResultText(block.content).slice(0, 20_000);
      part.status = block.is_error ? "error" : "done";
      this.emit({ type: "tool_update", messageId: message.id, part });
      changed = true;
    }
    if (changed) {
      this.setStatus({ kind: "thinking" });
      this.persistSoon();
      if (this.state.settings.usageLimit) {
        void this.overUsageLimit().then((over) => {
          if (over && this.current === message) this.stopAtLimit(over);
        });
      }
    }
  }

  private handleResult(result: Extract<SDKMessage, { type: "result" }>) {
    const message = this.current;
    if (!message) return;
    // A warmed-up session may have reported in before this turn; either way it has a transcript now.
    if (!this.sessionStarted) {
      this.sessionStarted = true;
      this.persistSoon();
    }
    const usage = result.usage as unknown as Record<string, number>;
    // Claude Code reports the session's running total; a reply's own cost is the difference from the last one.
    const total = result.total_cost_usd ?? 0;
    const base = this.costBase ?? (this.resumedQuery && this.sessionCostUsd != null && total > this.sessionCostUsd ? this.sessionCostUsd : 0);
    this.costBase = total;
    this.sessionCostUsd = total;
    message.usage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      costUsd: Math.max(0, total - base),
      durationMs: result.duration_ms,
      numTurns: result.num_turns,
    };
    if (this.limitStop) {
      this.finishTurn("error", this.limitStop);
    } else if (this.interrupted) {
      this.finishTurn("stopped");
    } else if (result.subtype !== "success") {
      const reason =
        result.subtype === "error_max_turns"
          ? `Stopped after ${result.num_turns} steps, the limit for one message. Send "continue" to keep going.`
          : result.errors?.length
            ? describeFailure(result.errors.join("\n"))
            : "Claude stopped because of an error.";
      this.finishTurn("error", message.error ?? reason);
    } else if (result.is_error) {
      this.finishTurn("error", message.error ?? describeFailure(result.result));
    } else {
      this.finishTurn(message.error ? "error" : "done", message.error);
    }
    void this.refreshContextUsage();
    const q = this.query;
    if (q) void agentRuntime().planUsage({ query: q, force: true }).catch(() => undefined);
  }

  private finishTurn(status: AssistantMessage["status"], error?: string) {
    const message = this.current;
    if (!message) return;
    if (status === "error") log("warn", "a Claude turn ended with an error", { chatId: this.state.id, error: error ?? message.error });
    this.current = null;
    this.limitStop = null;
    message.status = status;
    if (error) message.error = error;
    if (status === "error" && this.forkAt && /resume/i.test(error ?? message.error ?? "")) {
      // The rewound session couldn't be forked: start a fresh one next time instead of failing forever.
      this.forkAt = null;
      this.forkFrom = null;
      this.sessionStarted = false;
      this.sessionId = randomUUID();
      this.close();
    }
    for (const part of message.parts) {
      if (part.type === "tool" && (part.status === "pending" || part.status === "running")) part.status = status === "done" ? "done" : "error";
      if (part.type === "thinking" && !part.done) this.finishThinking(part);
    }
    this.state.running = false;
    this.state.updatedAt = Date.now();
    this.emit({ type: "message_done", message });
    this.emit({ type: "running", running: false });
    this.setStatus(null);
    this.setDocumentActivity("idle", "");
    void this.persistNow();

    const next = this.state.queue.shift();
    if (next) {
      this.emit({ type: "queue", queue: this.state.queue });
      void this.startTurn(next);
    } else {
      this.scheduleIdleClose();
    }
  }

  private async refreshContextUsage() {
    const q = this.query;
    if (!q) return;
    try {
      const usage = await q.getContextUsage({ detail: "summary" });
      this.state.context = { tokens: usage.totalTokens, maxTokens: usage.rawMaxTokens || usage.maxTokens, percentage: usage.percentage };
      this.emit({ type: "context", context: this.state.context });
    } catch {
      // Older Claude Code builds don't report context usage.
    }
  }

  private scheduleIdleClose() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.state.running) this.close();
    }, IDLE_CLOSE_MS);
    // Housekeeping only: it must not keep the server process alive on shutdown.
    this.idleTimer.unref?.();
  }

  async interrupt(atLimit = false) {
    if (!this.state.running) return;
    if (!atLimit) this.limitStop = null;
    this.interrupted = true;
    this.state.queue = [];
    this.emit({ type: "queue", queue: [] });
    const q = this.query;
    if (!q) {
      if (this.limitStop) this.finishTurn("error", this.limitStop);
      else this.finishTurn("stopped");
      return;
    }
    try {
      await q.interrupt();
    } catch {
      this.close();
    }
    // If Claude Code doesn't finish the turn promptly, close it; the session resumes on the next message.
    setTimeout(() => {
      if (this.current && this.interrupted) {
        this.close();
        if (this.limitStop) this.finishTurn("error", this.limitStop);
        else this.finishTurn("stopped");
      }
    }, 5000);
  }

  /** Re-run the last user message (after an error). */
  async retry() {
    if (this.state.running) return;
    const lastUser = [...this.state.messages].reverse().find((message) => message.role === "user") as UserMessage | undefined;
    if (!lastUser) return;
    const last = this.state.messages[this.state.messages.length - 1];
    if (last?.role === "assistant" && last.status !== "done") {
      this.state.messages.splice(this.state.messages.length - 2, 2);
      this.emit({ type: "snapshot", chat: this.state });
    }
    await this.startTurn({ text: lastUser.text, selection: lastUser.selection, attachments: lastUser.attachments, mentions: lastUser.mentions });
  }

  /**
   * Start Claude Code now, while the user is still typing, so the message
   * doesn't wait for the process to start. Closes again if nothing is sent.
   */
  warm() {
    this.lastUsed = Date.now();
    if (this.query || this.state.running || this.discarded) return false;
    this.ensureQuery();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.state.running) this.close();
    }, WARM_CLOSE_MS);
    this.idleTimer.unref?.();
    return true;
  }

  close() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const q = this.query;
    this.query = null;
    this.input?.close();
    this.input = null;
    try {
      q?.close();
    } catch {
      // already closed
    }
  }
}

type StreamEvent =
  | { type: "message_start"; message: { id: string } }
  | { type: "content_block_start"; index: number; content_block: { type: string; id?: string; name?: string; text?: string; thinking?: string } }
  | {
      type: "content_block_delta";
      index: number;
      delta: { type: string; text?: string; thinking?: string; partial_json?: string };
    }
  | { type: "content_block_stop"; index: number }
  | { type: "message_delta" | "message_stop" | "ping" };

function describeFailure(text: string) {
  const lower = text.toLowerCase();
  if (/not logged in|login|authenticat|invalid api key|oauth/.test(lower)) return ASSISTANT_ERRORS.authentication_failed!;
  if (/enoent|spawn|not found.*claude/.test(lower)) return "Inline couldn't start Claude Code. Make sure it is installed on this machine.";
  return clip(text, 600) || "Claude stopped because of an error.";
}

/** Older chat files stored Claude Code's running cost total on each reply; turn those into each reply's own cost. */
function perMessageCosts(messages: ChatMessage[]) {
  let previous = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || !message.usage) continue;
    const total = message.usage.costUsd;
    // A total lower than the one before means Claude Code restarted and counted from zero again.
    message.usage.costUsd = total >= previous ? total - previous : total;
    previous = total;
  }
}

type SDKUsage = Awaited<ReturnType<Query["usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET"]>>;

const WINDOW_LABELS: Record<string, string> = {
  five_hour: "Session",
  seven_day: "Weekly · all models",
  seven_day_opus: "Weekly · Opus",
  seven_day_sonnet: "Weekly · Sonnet",
};

/** Claude Code's /usage answer as the panel shows it. */
export function planUsageFrom(answer: SDKUsage, now = Date.now()): PlanUsage {
  const limits = answer.rate_limits;
  if (!answer.rate_limits_available || !limits) return { available: false, plan: answer.subscription_type ?? null, checkedAt: now };
  const windows: UsageWindow[] = [];
  for (const id of ["five_hour", "seven_day", "seven_day_opus", "seven_day_sonnet"] as const) {
    const window = limits[id];
    if (window && window.utilization != null) windows.push({ id, label: WINDOW_LABELS[id]!, utilization: window.utilization, resetsAt: window.resets_at ? Date.parse(window.resets_at) || null : null });
  }
  for (const window of limits.model_scoped ?? []) {
    if (window.utilization != null) windows.push({ id: `model:${window.display_name}`, label: `Weekly · ${window.display_name}`, utilization: window.utilization, resetsAt: window.resets_at ? Date.parse(window.resets_at) || null : null });
  }
  return { available: true, plan: answer.subscription_type ?? null, windows, checkedAt: now };
}

function formatReset(at: number, now = Date.now()) {
  const minutes = Math.max(1, Math.round((at - now) / 60_000));
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `in ${hours} hr${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
  return `on ${new Date(at).toLocaleDateString("en-US", { weekday: "long" })} at ${new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/** Why Claude should stop when the 5-hour or weekly usage is at or past `limit` percent; null when it's under. */
export function usageLimitReason(usage: PlanUsage | null, limit: number, now = Date.now()): string | null {
  if (!usage?.available) return null;
  const over = usage.windows
    .filter((window) => (window.id === "five_hour" || window.id === "seven_day") && window.utilization >= limit && (!window.resetsAt || window.resetsAt > now))
    .sort((a, b) => b.utilization - a.utilization)[0];
  if (!over) return null;
  const name = over.id === "five_hour" ? "5-hour session" : "weekly";
  const resets = over.resetsAt ? ` It resets ${formatReset(over.resetsAt, now)}.` : "";
  return `Paused at your usage limit: your ${name} usage is at ${Math.round(over.utilization)}% and your limit is ${limit}%.${resets} Raise or turn off the limit from the usage meter below the message box to keep going.`;
}

let workspaceCache: string | null = null;
function workspaceDirSync() {
  if (!workspaceCache) throw new Error("Agent workspace not initialised.");
  return workspaceCache;
}

// ---------------------------------------------------------------------------
// Runtime registry
// ---------------------------------------------------------------------------

class AgentRuntime {
  private chats = new Map<string, ChatRuntime>();
  private summaries = new FileSummaryCache<ChatSummary>();
  private loading = new Map<string, Promise<ChatRuntime | null>>();
  private status: AgentStatus | null = null;
  private statusPromise: Promise<AgentStatus> | null = null;
  private usage: PlanUsage | null = null;
  private usagePromise: Promise<PlanUsage & { sessionCostUsd?: number }> | null = null;
  defaultSettings: ChatSettings = { model: null, effort: "medium", mode: "agent" };

  async init() {
    if (!workspaceCache) workspaceCache = await workspaceDir();
    // Browser tests run against a scripted Claude instead of a signed-in Claude Code.
    if (process.env.INLINE_FAKE_CLAUDE === "1" && startQuery === query) {
      setQueryImplementation((await import("@/lib/agent/testing/e2eModel")).e2eClaude().query);
    }
  }

  async get(id: string) {
    await this.init();
    this.scheduleSweep();
    const existing = this.chats.get(id);
    if (existing) return existing;
    let pending = this.loading.get(id);
    if (!pending) {
      pending = (async () => {
        const file = await readChatFile<PersistedChat>(id);
        if (!file) return null;
        const chat = new ChatRuntime(file);
        this.chats.set(id, chat);
        return chat;
      })().finally(() => this.loading.delete(id));
      this.loading.set(id, pending);
    }
    return pending;
  }

  async require(id: string) {
    const chat = await this.get(id);
    if (!chat) throw new Error(`Chat ${id} not found.`);
    return chat;
  }

  /** A new chat. With an id (the panel picks one so it can show the chat before the server answers), creating it again returns the same chat. */
  async create(input: { id?: string; documentId?: string | null; settings?: Partial<ChatSettings> } = {}) {
    await this.init();
    if (input.id) {
      const id = input.id;
      const existing = await this.get(id);
      if (existing) return existing;
      const inFlight = this.creating.get(id);
      if (inFlight) return inFlight;
      const pending = this.createNew({ ...input, id }).finally(() => this.creating.delete(id));
      this.creating.set(id, pending);
      return pending;
    }
    return this.createNew(input);
  }

  private creating = new Map<string, Promise<ChatRuntime>>();

  private async createNew(input: { id?: string; documentId?: string | null; settings?: Partial<ChatSettings> }) {
    const now = Date.now();
    const file: PersistedChat = {
      format: 1,
      id: input.id ?? randomUUID(),
      title: "New chat",
      documentId: input.documentId ?? null,
      createdAt: now,
      updatedAt: now,
      settings: { ...this.defaultSettings, ...input.settings },
      messages: [],
      todos: [],
      sessionStarted: false,
    };
    const chat = new ChatRuntime(file);
    this.chats.set(file.id, chat);
    await chat.persistNow();
    return chat;
  }

  async list(options: { documentId?: string } = {}): Promise<ChatSummary[]> {
    await this.init();
    this.scheduleSweep();
    const ids = await listChatIds();
    // A document's chats include those last used in any of its tabs.
    const family = options.documentId ? new Set(await documentHub().tabs(options.documentId).then((tabs) => tabs.map((tab) => tab.id)).catch(() => [options.documentId!])) : null;
    // Chats not already in memory are summarized from their files without being kept loaded, and only read again once they change.
    const summaries = await Promise.all(
      ids.map(async (id) => {
        const loaded = this.chats.get(id);
        if (loaded) return loaded.summary();
        return this.summaries.get(chatFilePath(id), async () => {
          const file = await readChatFile<PersistedChat>(id).catch(() => null);
          return file ? new ChatRuntime(file).summary() : null;
        });
      }),
    );
    return summaries
      .filter((summary): summary is ChatSummary => Boolean(summary))
      .filter((summary) => summary.messageCount > 0 && (!family || (summary.documentId !== null && family.has(summary.documentId))))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async remove(id: string) {
    const chat = await this.get(id);
    if (chat) {
      // Stop saving first, or a pending save would write the chat back after it is deleted.
      const discarded = chat.discard();
      await chat.interrupt();
      chat.close();
      await discarded;
    }
    this.chats.delete(id);
    await deleteChatFile(id);
  }

  /** Keep the number of running Claude Code processes bounded. */
  noteLive(chat: ChatRuntime) {
    chat.lastUsed = Date.now();
    const live = [...this.chats.values()].filter((item) => item.live && item !== chat && !item.state.running);
    const total = live.length + 1;
    if (total <= MAX_LIVE_SESSIONS) return;
    live.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const item of live.slice(0, total - MAX_LIVE_SESSIONS)) item.close();
  }

  private sweepTimer: ReturnType<typeof setInterval> | null = null;

  private scheduleSweep() {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.unloadIdle(), 5 * 60 * 1000);
    this.sweepTimer.unref?.();
  }

  /** Drop chats from memory that are idle; they're read back from disk when opened again. */
  unloadIdle(maxIdleMs = 30 * 60 * 1000, now = Date.now()) {
    let unloaded = 0;
    for (const [id, chat] of this.chats) {
      if (chat.unloadable && now - chat.lastUsed >= maxIdleMs) {
        this.chats.delete(id);
        unloaded += 1;
      }
    }
    return unloaded;
  }

  get loadedCount() {
    return this.chats.size;
  }

  setDefaults(patch: Partial<ChatSettings>) {
    this.defaultSettings = { ...this.defaultSettings, ...patch };
  }

  /** Plan usage seen within `maxAgeMs`, or null. */
  cachedPlanUsage(maxAgeMs: number) {
    return this.usage && Date.now() - this.usage.checkedAt <= maxAgeMs ? this.usage : null;
  }

  /**
   * The account's plan usage (5-hour and weekly windows), from Claude Code's
   * /usage. Asks through `query` when given (and reports that session's running
   * cost), else through any live chat, else a short-lived Claude Code process.
   */
  async planUsage(options: { query?: Query; force?: boolean; maxAgeMs?: number } = {}): Promise<PlanUsage & { sessionCostUsd?: number }> {
    const cached = this.cachedPlanUsage(options.maxAgeMs ?? 60_000);
    if (cached && !options.force) return cached;
    const ask = async (q: Query) => {
      const answer = await withTimeout(q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true }), 15_000, "Claude Code did not report usage in time.");
      const usage = planUsageFrom(answer);
      this.usage = usage;
      return { ...usage, sessionCostUsd: answer.session?.total_cost_usd };
    };
    if (options.query) return ask(options.query);
    if (!this.usagePromise) {
      const live = [...this.chats.values()].find((chat) => chat.live)?.liveQuery;
      this.usagePromise = (live ? ask(live) : withProbe((q) => ask(q))).finally(() => {
        this.usagePromise = null;
      });
    }
    return this.usagePromise;
  }

  /** Fold a rate-limit event from a running session into the cached usage. */
  noteRateLimit(info: { rateLimitType?: string; utilization?: number; resetsAt?: number }) {
    const usage = this.usage;
    if (!usage?.available || !info.rateLimitType || info.utilization == null) return;
    const utilization = info.utilization <= 1 ? info.utilization * 100 : info.utilization;
    const resetsAt = info.resetsAt ? info.resetsAt * 1000 : null;
    const windows = usage.windows.some((window) => window.id === info.rateLimitType)
      ? usage.windows.map((window) => (window.id === info.rateLimitType ? { ...window, utilization, resetsAt: resetsAt ?? window.resetsAt } : window))
      : [...usage.windows, { id: info.rateLimitType, label: WINDOW_LABELS[info.rateLimitType] ?? info.rateLimitType, utilization, resetsAt }];
    this.usage = { ...usage, windows };
  }

  /** Whether Claude Code is installed and signed in, and which models the account can use. Cached briefly. */
  async agentStatus(force = false): Promise<AgentStatus> {
    if (!force && this.status && Date.now() - this.status.checkedAt < (this.status.state === "ready" ? 5 * 60_000 : 10_000)) return this.status;
    if (!this.statusPromise) {
      this.statusPromise = probeClaudeCode()
        .then((status) => {
          this.status = status;
          if (status.state === "ready" && !this.defaultSettings.model && status.defaultModel) this.defaultSettings.model = status.defaultModel;
          return status;
        })
        .finally(() => {
          this.statusPromise = null;
        });
    }
    return this.statusPromise;
  }
}

/** Runs `use` against a short-lived Claude Code process that never sends a message. */
async function withProbe<T>(use: (q: Query) => Promise<T>): Promise<T> {
  await agentRuntime().init();
  const input = new AsyncQueue<SDKUserMessage>();
  const q = startQuery({
    prompt: input,
    options: { cwd: workspaceDirSync(), tools: [], settingSources: [], persistSession: false, systemPrompt: "", strictMcpConfig: true, settings: { disableClaudeAiConnectors: true } },
  });
  const drain = (async () => {
    try {
      for await (const message of q) void message;
    } catch {
      // surfaced through `use`
    }
  })();
  try {
    return await use(q);
  } finally {
    input.close();
    try {
      q.close();
    } catch {
      // ignore
    }
    await drain;
  }
}

async function probeClaudeCode(): Promise<AgentStatus> {
  await agentRuntime().init();
  const input = new AsyncQueue<SDKUserMessage>();
  const q = startQuery({
    prompt: input,
    options: { cwd: workspaceDirSync(), tools: [], settingSources: [], persistSession: false, systemPrompt: "" },
  });
  const drain = (async () => {
    try {
      for await (const message of q) void message;
    } catch {
      // surfaced through the init call below
    }
  })();
  try {
    const init = await withTimeout(q.initializationResult(), 30_000, "Claude Code did not start in time.");
    const account = init.account ?? {};
    // Hosted and third-party setups report little account detail, so only an empty account counts as signed out.
    const signedIn = Boolean(account.email || account.tokenSource || account.apiKeySource || account.subscriptionType || (account.apiProvider && account.apiProvider !== "firstParty"));
    const models: ModelOption[] = (init.models ?? []).map((model) => ({
      value: model.value,
      displayName: model.displayName,
      description: model.description,
      efforts: (model.supportedEffortLevels ?? (model.supportsEffort ? ["low", "medium", "high"] : [])) as Effort[],
    }));
    if (!signedIn) return { state: "signed_out", message: "Claude Code is installed but not signed in.", checkedAt: Date.now() };
    return {
      state: "ready",
      account: { email: account.email, organization: account.organization, plan: account.subscriptionType, provider: account.apiProvider, tokenSource: account.tokenSource },
      models,
      defaultModel: models.find((model) => model.value === "default")?.value ?? models[0]?.value ?? null,
      checkedAt: Date.now(),
    };
  } catch (error) {
    const message = errorText(error);
    if (/login|auth|credential/i.test(message)) return { state: "signed_out", message: "Claude Code is not signed in.", checkedAt: Date.now() };
    return { state: "unavailable", message: describeFailure(message), checkedAt: Date.now() };
  } finally {
    input.close();
    try {
      q.close();
    } catch {
      // ignore
    }
    await drain;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const GLOBAL_KEY = Symbol.for("inline.agentRuntime");

export function agentRuntime(): AgentRuntime {
  const globals = globalThis as unknown as Record<symbol, AgentRuntime | undefined>;
  let runtime = globals[GLOBAL_KEY];
  if (!runtime) {
    runtime = new AgentRuntime();
    globals[GLOBAL_KEY] = runtime;
  }
  return runtime;
}

export type { ChatRuntime };
