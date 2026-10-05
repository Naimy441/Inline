import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { query, type Query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { createInlineSdkServer, mcpToolName } from "@/lib/agent/mcp";
import { systemPrompt } from "@/lib/agent/prompt";
import { type ToolContext } from "@/lib/agent/tools";
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
  QueuedMessage,
  RunStatus,
  SelectionContext,
  SequencedChatEvent,
  Todo,
  ToolPart,
  UserMessage,
} from "@/lib/agent/types";
import { documentHub } from "@/lib/server/hub";
import { deleteChatFile, findUpload, listChatIds, readChatFile, workspaceDir, writeChatFile } from "@/lib/server/store";
import { isUserSuggestion } from "@/lib/doc/review";
import { docxToDoc } from "@/lib/doc/docxImport";
import { docToMarkdown } from "@/lib/doc/markdown";
import { readZip } from "@/lib/server/unzip";

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
  /** Whether Claude Code has a transcript for this chat id, so it can be resumed. */
  sessionStarted: boolean;
};

/** Starts a Claude Code session. Tests swap in a scripted stand-in (lib/agent/testing/fakeClaude.ts). */
let startQuery: typeof query = query;
export function setQueryImplementation(next: typeof query | null) {
  startQuery = next ?? query;
}

export type SendInput = { text: string; documentId?: string | null; selection?: SelectionContext; attachments?: Attachment[] };

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

/** Image types Claude accepts as images; others (SVG) are sent as their source text. */
const CLAUDE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** The text Claude reads for a non-image, non-PDF attachment. Word files are converted to Inline's Markdown. */
async function attachmentText(extension: string, data: Buffer) {
  if (extension === "docx") {
    try {
      const parts = readZip(new Uint8Array(data));
      return docToMarkdown(await docxToDoc(parts));
    } catch (error) {
      return `[This Word file couldn't be read: ${errorText(error)}]`;
    }
  }
  return data.toString("utf8");
}

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
  private wroteThisTurn = new Set<string>();
  private interrupted = false;
  private discarded = false;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private toolInputs = new Map<string, string>();
  lastUsed = Date.now();
  state: ChatState;
  private sessionStarted: boolean;

  constructor(file: PersistedChat) {
    this.sessionStarted = file.sessionStarted;
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
    };
  }

  get live() {
    return this.query !== null;
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
    return () => this.listeners.delete(listener);
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
    if (this.state.running) {
      const queued: QueuedMessage = { id: randomUUID(), text, createdAt: Date.now(), selection: input.selection, attachments: input.attachments };
      this.state.queue.push(queued);
      this.emit({ type: "queue", queue: this.state.queue });
      return { queued: true, id: queued.id };
    }
    await this.startTurn({ text, selection: input.selection, attachments: input.attachments });
    return { queued: false, id: this.state.messages[this.state.messages.length - 2]!.id };
  }

  removeQueued(id: string) {
    const before = this.state.queue.length;
    this.state.queue = this.state.queue.filter((item) => item.id !== id);
    if (this.state.queue.length !== before) this.emit({ type: "queue", queue: this.state.queue });
  }

  private async startTurn(input: { text: string; selection?: SelectionContext; attachments?: Attachment[] }) {
    this.lastUsed = Date.now();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const now = Date.now();
    const user: UserMessage = { id: randomUUID(), role: "user", text: input.text, createdAt: now, selection: input.selection, attachments: input.attachments };
    const assistant: AssistantMessage = { id: randomUUID(), role: "assistant", createdAt: now, parts: [], status: "streaming", model: this.state.settings.model ?? undefined };
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
      this.ensureQuery();
      this.input!.push(message);
    } catch (error) {
      this.finishTurn("error", errorText(error));
      return;
    }
    void this.persistNow();
  }

  private async buildUserMessage(input: { text: string; selection?: SelectionContext; attachments?: Attachment[] }): Promise<SDKUserMessage> {
    const context: string[] = [];
    context.push(
      this.state.settings.mode === "ask"
        ? "Mode: Ask. You can read documents but not change them."
        : "Mode: Agent. Make requested changes directly in the document.",
    );
    const doc = this.state.documentId ? await documentHub().get(this.state.documentId) : null;
    if (doc && !doc.meta.trashedAt) {
      context.push(`Open document: "${doc.meta.title}" (id ${doc.id}).`);
      const suggestions = doc.hunks.filter(isUserSuggestion).length;
      const pending = doc.hunks.length - suggestions;
      if (pending) context.push(`${pending} earlier change${pending === 1 ? "" : "s"} by Claude ${pending === 1 ? "is" : "are"} still awaiting the user's review.`);
      if (suggestions) context.push(`The user has ${suggestions} pending suggestion${suggestions === 1 ? "" : "s"} of their own (suggesting mode).`);
      if (doc.editorMode !== "editing") context.push(`The user's editor is in ${doc.editorMode} mode.`);
    } else {
      context.push("No document is open.");
    }
    if (input.selection?.text.trim()) {
      context.push(`The user selected this text in the document:\n"""\n${input.selection.text.slice(0, 8000)}\n"""`);
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

  private toolContext(): ToolContext {
    return {
      author: this.state.id,
      turn: this.current?.id,
      documentId: this.state.documentId ?? undefined,
      readOnly: this.state.settings.mode === "ask",
      beforeWrite: async (doc) => {
        if (this.wroteThisTurn.has(doc.id)) return;
        this.wroteThisTurn.add(doc.id);
        await doc.checkpoint("Before Claude's edits");
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
      message.changes.push({ ...change });
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
    const q = startQuery({
      prompt: input,
      options: {
        cwd: workspaceDirSync(),
        systemPrompt: systemPrompt(date),
        tools: BUILTIN_TOOLS,
        allowedTools: [mcpToolName("*"), ...BUILTIN_TOOLS],
        mcpServers: { inline: createInlineSdkServer(() => this.toolContext()) },
        settingSources: [],
        includePartialMessages: true,
        thinking: { type: "adaptive", display: "summarized" },
        effort: settings.effort,
        ...(settings.model ? { model: settings.model } : {}),
        ...(this.sessionStarted ? { resume: this.state.id } : { sessionId: this.state.id }),
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
  }

  private async consume(q: Query, input: AsyncQueue<SDKUserMessage>) {
    // Only a query that is still this chat's own can end its turn; one closed on purpose is ignored.
    try {
      for await (const message of q) {
        if (this.query !== q) break;
        this.handle(message);
      }
      if (this.query === q && this.current) this.finishTurn(this.interrupted ? "stopped" : "error", this.interrupted ? undefined : "Claude Code exited unexpectedly.");
    } catch (error) {
      if (this.query === q && this.current) this.finishTurn(this.interrupted ? "stopped" : "error", this.interrupted ? undefined : describeFailure(errorText(error)));
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
        this.handleAssistant(message.message as unknown as { id: string; model?: string; content: Array<Record<string, unknown>> }, message.error);
        return;
      case "user":
        if (message.parent_tool_use_id) return;
        this.handleToolResults(message.message.content);
        return;
      case "result":
        this.handleResult(message);
        return;
      case "rate_limit_event": {
        const info = message.rate_limit_info;
        this.emit({ type: "rate_limit", rateLimit: { status: info.status, resetsAt: info.resetsAt, type: info.rateLimitType, utilization: info.utilization } });
        return;
      }
      default:
        return;
    }
  }

  private handleSystem(message: SDKMessage & { subtype: string }) {
    if (message.subtype === "init") {
      if (!this.sessionStarted) {
        this.sessionStarted = true;
        this.persistSoon();
      }
      const model = (message as { model?: string }).model;
      if (this.current && model) this.current.model = model;
    } else if (message.subtype === "api_retry") {
      const retry = message as unknown as { attempt: number; max_retries: number; retry_delay_ms: number; error: string };
      this.setStatus({ kind: "retrying", attempt: retry.attempt, maxRetries: retry.max_retries, delayMs: retry.retry_delay_ms, error: ASSISTANT_ERRORS[retry.error] ?? retry.error });
    } else if (message.subtype === "status") {
      const status = (message as { status?: string | null }).status;
      if (status === "compacting") this.setStatus({ kind: "compacting" });
    } else if (message.subtype === "compact_boundary") {
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
        part.done = true;
        this.emit({ type: "part", messageId: message.id, part });
      }
    }
  }

  private streamMessageId = "";

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
          part.done = true;
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
    }
  }

  private handleResult(result: Extract<SDKMessage, { type: "result" }>) {
    const message = this.current;
    if (!message) return;
    const usage = result.usage as unknown as Record<string, number>;
    message.usage = {
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
      cacheReadTokens: usage.cache_read_input_tokens ?? 0,
      cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
      costUsd: result.total_cost_usd,
      durationMs: result.duration_ms,
      numTurns: result.num_turns,
    };
    if (this.interrupted) {
      this.finishTurn("stopped");
    } else if (result.subtype !== "success") {
      const reason =
        result.subtype === "error_max_turns"
          ? "Stopped after reaching the turn limit."
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
  }

  private finishTurn(status: AssistantMessage["status"], error?: string) {
    const message = this.current;
    if (!message) return;
    this.current = null;
    message.status = status;
    if (error) message.error = error;
    for (const part of message.parts) {
      if (part.type === "tool" && (part.status === "pending" || part.status === "running")) part.status = status === "done" ? "done" : "error";
      if (part.type === "thinking") part.done = true;
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

  async interrupt() {
    if (!this.state.running) return;
    this.interrupted = true;
    this.state.queue = [];
    this.emit({ type: "queue", queue: [] });
    const q = this.query;
    if (!q) {
      this.finishTurn("stopped");
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
        this.finishTurn("stopped");
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
    await this.startTurn({ text: lastUser.text, selection: lastUser.selection, attachments: lastUser.attachments });
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
  private loading = new Map<string, Promise<ChatRuntime | null>>();
  private status: AgentStatus | null = null;
  private statusPromise: Promise<AgentStatus> | null = null;
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

  async create(input: { documentId?: string | null; settings?: Partial<ChatSettings> } = {}) {
    await this.init();
    const now = Date.now();
    const file: PersistedChat = {
      format: 1,
      id: randomUUID(),
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
    const ids = await listChatIds();
    const chats = await Promise.all(ids.map((id) => this.get(id).catch(() => null)));
    return chats
      .filter((chat): chat is ChatRuntime => Boolean(chat))
      .map((chat) => chat.summary())
      .filter((summary) => summary.messageCount > 0 && (!options.documentId || summary.documentId === options.documentId))
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

  setDefaults(patch: Partial<ChatSettings>) {
    this.defaultSettings = { ...this.defaultSettings, ...patch };
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
