import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

/**
 * A stand-in for the Claude Agent SDK's `query()`: it consumes the runtime's
 * streaming input exactly like Claude Code does and answers with scripted
 * turns. Tool calls go through the real in-process MCP server the runtime
 * passes in `options.mcpServers.inline`, so tools run for real.
 *
 * A turn script is an async function that drives a `FakeTurn`: say text,
 * think, call tools, or fail. Scripts are taken from a queue, one per user
 * message.
 */

type Json = Record<string, unknown>;
type UserMessage = { type: "user"; message: { role: "user"; content: Array<Json> } };

export type TurnScript = (turn: FakeTurn) => Promise<void> | void;

export type QueryCall = { options: Json; inputs: UserMessage[]; query: FakeQuery };

export class FakeClaude {
  scripts: TurnScript[] = [];
  calls: QueryCall[] = [];
  /** What initializationResult() resolves with (used by the runtime's status probe). */
  init: Json | Error = { account: { email: "writer@example.com", subscriptionType: "max" }, models: [{ value: "default", displayName: "Default", description: "Recommended", supportedEffortLevels: ["low", "medium", "high"] }] };
  /** Make the next query() throw while iterating, as if Claude Code crashed or isn't installed. */
  crash: Error | null = null;

  /** Queue the scripts for the next user messages, in order. */
  script(...turns: TurnScript[]) {
    this.scripts.push(...turns);
  }

  /** The `query` export to install in place of the SDK's. */
  readonly query = (params: { prompt: AsyncIterable<UserMessage>; options: Json }) => {
    const call: QueryCall = { options: params.options, inputs: [], query: undefined as never };
    const q = new FakeQuery(this, params.prompt, params.options, call);
    call.query = q;
    this.calls.push(call);
    return q;
  };

  get lastCall() {
    return this.calls[this.calls.length - 1]!;
  }
}

export class FakeQuery implements AsyncIterable<Json> {
  private outbox: Json[] = [];
  private waiting: ((value: IteratorResult<Json>) => void) | null = null;
  private done = false;
  interrupted = false;
  closed = false;
  model: string | undefined;
  flagSettings: Json[] = [];
  private mcp: Client | null = null;

  constructor(
    private readonly claude: FakeClaude,
    private readonly prompt: AsyncIterable<UserMessage>,
    readonly options: Json,
    private readonly call: QueryCall,
  ) {
    void this.run();
  }

  private push(message: Json) {
    if (this.done) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
    } else {
      this.outbox.push(message);
    }
  }

  private end(error?: Error) {
    if (this.done) return;
    this.done = true;
    this.endError = error ?? null;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      if (error) this.rejectWaiting?.(error);
      else resolve({ value: undefined, done: true });
    }
  }

  private endError: Error | null = null;
  private rejectWaiting: ((error: Error) => void) | null = null;

  [Symbol.asyncIterator](): AsyncIterator<Json> {
    return {
      next: () => {
        if (this.outbox.length) return Promise.resolve({ value: this.outbox.shift()!, done: false });
        if (this.done) return this.endError ? Promise.reject(this.endError) : Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiting = resolve;
          this.rejectWaiting = reject;
        });
      },
    };
  }

  private async run() {
    if (this.claude.crash) {
      const error = this.claude.crash;
      this.claude.crash = null;
      await Promise.resolve();
      this.end(error);
      return;
    }
    const sessionId = String(this.options.sessionId ?? this.options.resume ?? randomUUID());
    let initialized = false;
    try {
      for await (const input of this.prompt) {
        if (this.closed) break;
        this.call.inputs.push(input);
        if (!initialized) {
          initialized = true;
          this.push({ type: "system", subtype: "init", session_id: sessionId, model: this.model ?? this.options.model ?? "claude-test-model", tools: [] });
        }
        const script = this.claude.scripts.shift() ?? ((turn: FakeTurn) => turn.say("OK."));
        const turn = new FakeTurn(this, input);
        this.interrupted = false;
        try {
          await script(turn);
          if (!turn.finished) turn.succeed();
        } catch (error) {
          if (error instanceof Crash) {
            this.end(error.cause as Error);
            return;
          }
          throw error;
        }
      }
      this.end();
    } catch (error) {
      this.end(error as Error);
    }
  }

  /** Emit a raw SDK message. */
  emit(message: Json) {
    this.push(message);
  }

  async tools() {
    if (this.mcp) return this.mcp;
    const servers = this.options.mcpServers as Record<string, { instance: { connect: (transport: unknown) => Promise<void> } }>;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await servers.inline!.instance.connect(serverTransport);
    const client = new Client({ name: "fake-claude-code", version: "1.0.0" });
    await client.connect(clientTransport);
    this.mcp = client;
    return client;
  }

  // --- the Query control surface the runtime uses ---------------------------------

  async interrupt() {
    this.interrupted = true;
    this.interruptListeners.forEach((listener) => listener());
  }

  interruptListeners = new Set<() => void>();

  close() {
    this.closed = true;
    void this.mcp?.close().catch(() => undefined);
    this.end();
  }

  async setModel(model?: string) {
    this.model = model;
  }

  async applyFlagSettings(settings: Json) {
    this.flagSettings.push(settings);
  }

  async getContextUsage() {
    return { totalTokens: 12_000, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 6 };
  }

  async initializationResult() {
    const init = this.claude.init;
    if (init instanceof Error) throw init;
    return init;
  }
}

class Crash extends Error {}

let apiMessages = 0;

/** One scripted assistant turn, emitting messages in the shapes Claude Code streams. */
export class FakeTurn {
  finished = false;
  private messageId = "";
  private blockIndex = 0;
  private content: Json[] = [];

  constructor(
    private readonly q: FakeQuery,
    readonly input: UserMessage,
  ) {}

  /** The text blocks of the user message (the inline-context block, then the user's text). */
  get texts(): string[] {
    return this.input.message.content.filter((block) => block.type === "text").map((block) => String(block.text));
  }

  get blocks() {
    return this.input.message.content;
  }

  private startMessage() {
    if (this.messageId) return;
    this.messageId = `msg_${++apiMessages}`;
    this.blockIndex = 0;
    this.content = [];
    this.q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "message_start", message: { id: this.messageId } } });
  }

  private flushMessage(error?: string) {
    if (!this.messageId) return;
    this.q.emit({
      type: "assistant",
      parent_tool_use_id: null,
      message: { id: this.messageId, model: "claude-test-model", content: this.content },
      ...(error ? { error } : {}),
    });
    this.messageId = "";
  }

  /** Stream a text block in chunks. */
  say(text: string, chunks = 3) {
    this.startMessage();
    const index = this.blockIndex++;
    this.q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index, content_block: { type: "text", text: "" } } });
    const size = Math.max(1, Math.ceil(text.length / chunks));
    for (let i = 0; i < text.length; i += size) {
      this.q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index, delta: { type: "text_delta", text: text.slice(i, i + size) } } });
    }
    this.q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index } });
    this.content.push({ type: "text", text });
  }

  think(text: string) {
    this.startMessage();
    const index = this.blockIndex++;
    this.q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index, content_block: { type: "thinking", thinking: "" } } });
    this.q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: text } } });
    this.q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index } });
    this.content.push({ type: "thinking", thinking: text });
  }

  /**
   * Call a tool the way Claude Code does: stream the tool_use block, finish the
   * assistant message, run the tool, then report the tool_result. Inline's
   * tools run for real through the in-process MCP server; built-in tools
   * (TodoWrite, WebSearch) get `builtinResult`.
   */
  async tool(name: string, input: Json, builtinResult = "Done.") {
    this.startMessage();
    const index = this.blockIndex++;
    const id = `toolu_${randomUUID().slice(0, 8)}`;
    const json = JSON.stringify(input);
    this.q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_start", index, content_block: { type: "tool_use", id, name, input: {} } } });
    const half = Math.ceil(json.length / 2);
    this.q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, half) } } });
    this.q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(half) } } });
    this.q.emit({ type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_stop", index } });
    this.content.push({ type: "tool_use", id, name, input });
    this.flushMessage();

    let text = builtinResult;
    let isError = false;
    const prefix = "mcp__inline__";
    if (name.startsWith(prefix)) {
      const client = await this.q.tools();
      const result = (await client.callTool({ name: name.slice(prefix.length), arguments: input })) as { content: Array<{ text?: string }>; isError?: boolean };
      text = result.content.map((block) => block.text ?? "").join("\n");
      isError = Boolean(result.isError);
    }
    this.q.emit({
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] },
    });
    return { text, isError };
  }

  /** Wait until the runtime interrupts this turn (or a timeout passes). */
  waitForInterrupt(timeoutMs = 2000) {
    return new Promise<boolean>((resolve) => {
      if (this.q.interrupted) return resolve(true);
      const timer = setTimeout(() => {
        this.q.interruptListeners.delete(listener);
        resolve(false);
      }, timeoutMs);
      const listener = () => {
        clearTimeout(timer);
        this.q.interruptListeners.delete(listener);
        resolve(true);
      };
      this.q.interruptListeners.add(listener);
    });
  }

  /** End the turn successfully. */
  succeed(text = "") {
    this.flushMessage();
    this.finished = true;
    this.q.emit({
      type: "result",
      subtype: "success",
      is_error: false,
      result: text,
      duration_ms: 1200,
      num_turns: 2,
      total_cost_usd: 0.0123,
      usage: { input_tokens: 900, output_tokens: 150, cache_read_input_tokens: 4000, cache_creation_input_tokens: 100 },
    });
  }

  /** End the turn with an error result (e.g. subtype "error_during_execution"). */
  fail(subtype: string, errors: string[] = []) {
    this.flushMessage();
    this.finished = true;
    this.q.emit({ type: "result", subtype, is_error: true, errors, duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {} });
  }

  /** An assistant message that carries an API error, like an auth failure or rate limit. */
  apiError(error: string, text = "") {
    this.startMessage();
    if (text) this.content.push({ type: "text", text });
    this.flushMessage(error);
  }

  /** Report the turn as interrupted, the way Claude Code does after interrupt(). */
  stopped() {
    this.flushMessage();
    this.finished = true;
    this.q.emit({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["Request was aborted."], duration_ms: 10, num_turns: 1, total_cost_usd: 0, usage: {} });
  }

  /** Crash the Claude Code process mid-turn. */
  crash(error: Error): never {
    throw new Crash("crash", { cause: error });
  }

  emit(message: Json) {
    this.q.emit(message);
  }
}
