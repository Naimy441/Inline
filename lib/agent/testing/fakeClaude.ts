import { randomUUID } from "node:crypto";
import type { Options, Query, SDKMessage, SDKUserMessage, query } from "@anthropic-ai/claude-agent-sdk";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * A scripted stand-in for Claude Code, for testing the agent runtime without
 * a model or a login. It speaks the Agent SDK's message protocol (init,
 * streamed content blocks, assistant messages, tool results, a result) and
 * runs tool calls through the real Inline MCP server the runtime hands it, so
 * documents, review hunks and versions change exactly as they would live.
 */

export type FakeTurn = {
  /** What the user typed. */
  text: string;
  /** The <inline-context> block the runtime prepended. */
  context: string;
  blocks: Array<Record<string, unknown>>;
};

export type FakeModel = (turn: FakeTurn, claude: FakeSession) => Promise<void> | void;

type ResultOptions = { subtype?: "success" | "error_max_turns" | "error_during_execution"; isError?: boolean; result?: string; errors?: string[] };

class Channel<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiting: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: unknown) => void }> = [];
  private done = false;
  private error: unknown = null;

  push(item: T) {
    if (this.done) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve({ value: item, done: false });
    else this.items.push(item);
  }

  close() {
    this.done = true;
    for (const waiter of this.waiting.splice(0)) waiter.resolve({ value: undefined as never, done: true });
  }

  fail(error: unknown) {
    this.error = error;
    this.done = true;
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false });
        if (this.error) return Promise.reject(this.error);
        if (this.done) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
      },
    };
  }
}

export class FakeSession {
  readonly id: string;
  interrupted = false;
  private finished = false;
  private onInterrupt: Array<() => void> = [];
  usage = { input_tokens: 120, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 5 };
  /** What each reply costs; the result reports the session's running total, as Claude Code does. */
  turnCost = 0.0123;
  totalCost = 0;

  constructor(
    readonly options: Options,
    readonly tools: Client,
    private readonly out: Channel<SDKMessage>,
  ) {
    this.id = String(options.resume ?? options.sessionId ?? randomUUID());
  }

  get isFinished() {
    return this.finished;
  }

  startTurn() {
    this.finished = false;
    this.interrupted = false;
  }

  raw(message: Record<string, unknown>) {
    this.out.push({ uuid: randomUUID(), session_id: this.id, parent_tool_use_id: null, ...message } as unknown as SDKMessage);
  }

  private stream(event: Record<string, unknown>) {
    this.raw({ type: "stream_event", event });
  }

  /** Streams a text reply in small deltas, then delivers the complete message. */
  say(text: string) {
    const id = `msg_${randomUUID()}`;
    this.stream({ type: "message_start", message: { id } });
    this.stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    for (const chunk of text.match(/.{1,8}/gs) ?? []) this.stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: chunk } });
    this.stream({ type: "content_block_stop", index: 0 });
    this.raw({ type: "assistant", message: { id, model: "claude-test", role: "assistant", content: [{ type: "text", text }] } });
  }

  think(text: string) {
    const id = `msg_${randomUUID()}`;
    this.stream({ type: "message_start", message: { id } });
    this.stream({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } });
    this.stream({ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: text } });
    this.stream({ type: "content_block_stop", index: 0 });
    this.raw({ type: "assistant", message: { id, model: "claude-test", role: "assistant", content: [{ type: "thinking", thinking: text }] } });
  }

  private announceTool(id: string, name: string, input: Record<string, unknown>) {
    const messageId = `msg_${randomUUID()}`;
    const json = JSON.stringify(input);
    this.stream({ type: "message_start", message: { id: messageId } });
    this.stream({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name } });
    for (const chunk of json.match(/.{1,16}/gs) ?? []) this.stream({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: chunk } });
    this.stream({ type: "content_block_stop", index: 0 });
    this.raw({ type: "assistant", message: { id: messageId, model: "claude-test", role: "assistant", content: [{ type: "tool_use", id, name, input }] } });
  }

  private toolResult(id: string, text: string, isError: boolean) {
    this.raw({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }], is_error: isError }] } });
  }

  /** Calls an Inline MCP tool the way Claude Code does: announce the call, run it on the MCP server, report the result. */
  async call(tool: string, args: Record<string, unknown> = {}) {
    const id = `toolu_${randomUUID()}`;
    this.announceTool(id, `mcp__inline__${tool}`, args);
    const result = (await this.tools.callTool({ name: tool, arguments: args })) as { content: Array<{ type: string; text?: string }>; isError?: boolean };
    const text = result.content.map((block) => block.text ?? "").join("\n");
    const isError = Boolean(result.isError);
    this.toolResult(id, text, isError);
    return { text, isError };
  }

  /** A built-in tool call (TodoWrite, WebSearch…) that doesn't go through Inline's MCP server. */
  builtin(name: string, input: Record<string, unknown>, result = "ok") {
    const id = `toolu_${randomUUID()}`;
    this.announceTool(id, name, input);
    this.toolResult(id, result, false);
  }

  /** Starts a tool call and never answers it, as when a turn is cut short mid-tool. */
  hangingTool(name: string, input: Record<string, unknown> = {}) {
    this.announceTool(`toolu_${randomUUID()}`, name, input);
  }

  /** Resolves when the runtime interrupts the turn. */
  untilInterrupted() {
    return new Promise<void>((resolve) => (this.interrupted ? resolve() : this.onInterrupt.push(resolve)));
  }

  interrupt() {
    this.interrupted = true;
    for (const resolve of this.onInterrupt.splice(0)) resolve();
  }

  finish(options: ResultOptions = {}) {
    if (this.finished) return;
    this.finished = true;
    this.totalCost += this.turnCost;
    const subtype = options.subtype ?? "success";
    this.raw({
      type: "result",
      subtype,
      is_error: options.isError ?? subtype !== "success",
      result: options.result ?? "",
      errors: options.errors,
      duration_ms: 1234,
      duration_api_ms: 1000,
      num_turns: 2,
      total_cost_usd: this.totalCost,
      usage: this.usage,
      modelUsage: {},
      permission_denials: [],
    });
  }

  /** Claude Code's process ends without finishing the turn. */
  exit() {
    this.finished = true;
    this.out.close();
  }

  /** Claude Code's process fails with an error. */
  crash(message: string) {
    this.finished = true;
    this.out.fail(new Error(message));
  }
}

export type FakeClaude = {
  query: typeof query;
  /** Options of every session started, in order. */
  sessions: FakeSession[];
  turns: FakeTurn[];
  modelChanges: Array<string | undefined>;
  effortChanges: string[];
  /** What /usage reports for the plan limits (percent used, 0-100); null when the sign-in has none. */
  planLimits: { five_hour?: number; seven_day?: number } | null;
};

/** Builds a `query` replacement that answers every user message with `model`. */
export function fakeClaude(model: FakeModel): FakeClaude {
  const fake: FakeClaude = { query: null as never, sessions: [], turns: [], modelChanges: [], effortChanges: [], planLimits: { five_hour: 34, seven_day: 61 } };

  fake.query = ((params: { prompt: AsyncIterable<SDKUserMessage> | string; options?: Options }) => {
    const options = params.options ?? {};
    const out = new Channel<SDKMessage>();
    const client = new Client({ name: "fake-claude-code", version: "0.0.0" });
    const server = (options.mcpServers?.inline as { instance?: McpServer } | undefined)?.instance;
    const connected = (async () => {
      if (!server) return;
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await server.connect(serverSide);
      await client.connect(clientSide);
    })();
    const session = new FakeSession(options, client, out);
    fake.sessions.push(session);

    const drive = async () => {
      await connected;
      session.raw({ type: "system", subtype: "init", model: "claude-test", tools: options.allowedTools ?? [], mcp_servers: [{ name: "inline", status: "connected" }] });
      if (typeof params.prompt === "string") return;
      for await (const message of params.prompt) {
        const blocks = message.message.content as unknown as Array<Record<string, unknown>>;
        const texts = blocks.filter((block) => block.type === "text").map((block) => String(block.text));
        const turn: FakeTurn = { context: texts[0] ?? "", text: texts.length > 1 ? texts[texts.length - 1]! : "", blocks };
        fake.turns.push(turn);
        session.startTurn();
        try {
          await model(turn, session);
        } catch (error) {
          session.crash(error instanceof Error ? error.message : String(error));
          return;
        }
        if (!session.isFinished) session.finish();
      }
    };
    void drive().catch((error) => out.fail(error));

    const iterator = out[Symbol.asyncIterator]();
    const q = {
      next: () => iterator.next(),
      return: async () => {
        out.close();
        return { value: undefined, done: true };
      },
      throw: async (error: unknown) => {
        out.fail(error);
        return { value: undefined, done: true };
      },
      [Symbol.asyncIterator]() {
        return q;
      },
      async interrupt() {
        session.interrupt();
      },
      close() {
        out.close();
        void client.close().catch(() => undefined);
      },
      async setModel(next?: string) {
        fake.modelChanges.push(next);
      },
      async applyFlagSettings(settings: { effortLevel?: string }) {
        if (settings.effortLevel) fake.effortChanges.push(settings.effortLevel);
      },
      async getContextUsage() {
        return { totalTokens: 24_000, maxTokens: 200_000, rawMaxTokens: 200_000, percentage: 12 };
      },
      async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET() {
        const limits = fake.planLimits;
        const window = (utilization: number | undefined, hours: number) => (utilization == null ? null : { utilization, resets_at: new Date(Date.now() + hours * 3_600_000).toISOString() });
        return {
          session: { total_cost_usd: session.totalCost, total_api_duration_ms: 0, total_duration_ms: 0, total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
          subscription_type: limits ? "max" : null,
          rate_limits_available: Boolean(limits),
          rate_limits: limits ? { five_hour: window(limits.five_hour, 3), seven_day: window(limits.seven_day, 72) } : null,
          behaviors: null,
        };
      },
      async initializationResult() {
        return { account: { email: "writer@example.com", subscriptionType: "max" }, models: [{ value: "default", displayName: "Default", description: "", supportedEffortLevels: ["low", "medium", "high"] }] };
      },
    };
    return q as unknown as Query;
  }) as typeof query;

  return fake;
}
