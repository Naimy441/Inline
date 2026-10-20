import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { connectCodex, type CodexConnection, type RpcMessage } from "./codexRpc";
import { TOOLS, runTool, type ToolContext } from "./tools";
import { systemPrompt } from "./prompt";
import { PAGE_LAYOUT_PLUGIN_DIR } from "./skills";
import type { AssistantPart, ChatSettings, ContextUsage, Todo, TurnUsage } from "./types";
import { codexAccount } from "./codexAccount";

type Callbacks = {
  totals: (totals: CodexTokenTotals) => void;
  context: () => ToolContext;
  part: (part: AssistantPart) => void;
  delta: (id: string, type: "text" | "thinking", text: string) => void;
  todos: (todos: Todo[]) => void;
  usage: (usage: TurnUsage) => void;
  contextUsage: (context: ContextUsage) => void;
  thread: (id: string) => void;
  model: (model: string) => void;
  limits: () => Promise<string | null>;
  compact: () => void;
};
export type CodexTokenTotals = { inputTokens: number; outputTokens: number; cachedInputTokens: number };

export function codexTools() {
  return [...TOOLS.map((tool) => ({ type: "function", name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(z.object(tool.shape), { unrepresentable: "any" }) })),
    { type: "function", name: "TodoWrite", description: "Update the plan for this task.", inputSchema: z.toJSONSchema(z.object({ todos: z.array(z.object({ content: z.string(), activeForm: z.string().optional(), status: z.enum(["pending", "in_progress", "completed"]) })) })) }];
}

/** Converts Inline's multimodal input without silently dropping PDF attachments. */
export async function codexInput(message: SDKUserMessage) {
  const input: Array<Record<string, unknown>> = [];
  const content = message.message.content;
  for (const block of typeof content === "string" ? [{ type: "text", text: content }] : content as any[]) {
    if (block.type === "text") input.push({ type: "text", text: block.text, text_elements: [] });
    else if (block.type === "image" && block.source?.type === "base64") input.push({ type: "image", url: `data:${block.source.media_type};base64,${block.source.data}` });
    else if (block.type === "document" && block.source?.type === "base64") {
      // App-server doesn't accept PDF input items. Send both text and page images.
      const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
      const task = getDocument({ data: new Uint8Array(Buffer.from(block.source.data, "base64")), useSystemFonts: true });
      const pdf = await task.promise;
      try {
        for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
          const page = await pdf.getPage(pageNumber);
          const text = (await page.getTextContent()).items.map((item) => "str" in item ? item.str : "").join(" ");
          input.push({ type: "text", text: `<pdf-page file=${JSON.stringify(block.title ?? "Attachment")} page="${pageNumber}">\n${text}\n</pdf-page>`, text_elements: [] });
          const viewport = page.getViewport({ scale: Math.min(2, 1600 / page.getViewport({ scale: 1 }).width) });
          const factory = pdf.canvasFactory as { create: (width: number, height: number) => { canvas: any; context: any }; destroy: (target: unknown) => void };
          const target = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
          try {
            await page.render({ canvas: target.canvas, canvasContext: target.context, viewport }).promise;
            input.push({ type: "image", url: `data:image/png;base64,${target.canvas.toBuffer("image/png").toString("base64")}` });
          } finally { factory.destroy(target); page.cleanup(); }
        }
      } finally { await task.destroy(); }
    }
  }
  return input;
}

export class CodexSession {
  private rpc: CodexConnection | null = null;
  private ready: Promise<void> | null = null;
  private active: { resolve: () => void; reject: (error: Error) => void } | null = null;
  private turnId: string | null = null;
  private cancelled = false;
  private closed = false;
  private calls = 0;
  private startedAt = 0;
  private totalBefore = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  private total = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  private settings: ChatSettings | null = null;
  private parts = new Map<string, AssistantPart>();
  private toolChain: Promise<void> = Promise.resolve();
  private limitTimer: ReturnType<typeof setInterval> | null = null;
  private controller = new AbortController();
  private model: string | null = null;

  constructor(private threadId: string | null, private cwd: string, private callbacks: Callbacks, totals?: CodexTokenTotals) {
    if (totals) this.total = { ...totals };
  }

  private ensure(settings: ChatSettings) {
    return this.ready ??= this.open(settings).catch((error) => { this.ready = null; throw error; });
  }

  private async open(settings: ChatSettings) {
    if (this.closed) throw new Error("Codex session closed.");
    if (this.rpc) return;
    const rpc = await connectCodex();
    if (this.closed) { rpc.close(); throw new Error("Codex session closed."); }
    this.rpc = rpc;
    rpc.onMessage((message) => this.handle(message));
    rpc.onClose((error) => { this.rpc = null; this.active?.reject(error); this.active = null; });
    const skill = await readFile(path.join(PAGE_LAYOUT_PLUGIN_DIR, "skills/page-layout/SKILL.md"), "utf8");
    const options = {
      cwd: this.cwd, model: settings.model, approvalPolicy: "never", sandbox: "read-only",
      baseInstructions: systemPrompt(new Date().toLocaleDateString("en-US"), "Codex"),
      developerInstructions: `Work exclusively through Inline's document tools. Use run_command for commands in a document folder. Never edit Inline's storage or use local shell/file tools. The user can switch Claude and Codex in this same chat.\n\nPage layout skill:\n${skill}`,
      config: { "features.shell_tool": false, "features.unified_exec": false, "features.apps": false, "features.hooks": false, "features.multi_agent": false, "features.browser_use": false, "features.computer_use": false, "features.in_app_browser": false, "features.skip_host_skill_discovery": true, "mcp_servers": {}, "web_search": "live", "project_doc_max_bytes": 0 },
    };
    try {
      const result = this.threadId
        ? await rpc.request("thread/resume", { ...options, threadId: this.threadId })
        : await rpc.request("thread/start", { ...options, dynamicTools: codexTools() });
      this.threadId = result.thread.id;
      this.model = result.model;
      this.callbacks.thread(this.threadId!);
      this.callbacks.model(result.model);
    } catch (error) { this.close(); throw error; }
  }

  async warm(settings: ChatSettings) { await this.ensure(settings); }

  async send(message: SDKUserMessage, settings: ChatSettings) {
    this.cancelled = false;
    this.controller = new AbortController();
    this.settings = { ...settings };
    this.calls = 0;
    this.turnId = null;
    this.parts.clear();
    this.totalBefore = { ...this.total };
    this.startedAt = Date.now();
    await this.ensure(settings);
    this.callbacks.model(settings.model ?? this.model ?? "Codex");
    if (this.cancelled || this.closed) return;
    const input = await codexInput(message);
    if (this.cancelled || this.closed) return;
    const done = new Promise<void>((resolve, reject) => { this.active = { resolve, reject }; });
    // Attach a handler before turn/start: a process can fail before its response arrives.
    void done.catch(() => undefined);
    try {
      const response = await this.rpc!.request("turn/start", { threadId: this.threadId, input, model: settings.model, effort: settings.effort, summary: "auto" });
      this.turnId = response.turn.id;
      if (this.cancelled) await this.interrupt();
      this.limitTimer = setInterval(() => { void this.checkLimit(); }, 45_000);
      this.limitTimer.unref?.();
      await done;
    } catch (error) {
      this.controller.abort();
      throw error;
    } finally {
      if (this.limitTimer) clearInterval(this.limitTimer);
      this.limitTimer = null;
      await this.toolChain;
      this.active = null;
      this.turnId = null;
    }
  }

  private async checkLimit() {
    const reason = await this.callbacks.limits();
    if (reason && this.active) {
      await this.interrupt();
      this.active?.reject(new Error(reason));
    }
  }

  private handle(message: RpcMessage) {
    const p = message.params ?? {};
    if (message.id != null && message.method) {
      if (message.method === "item/tool/call") {
        this.toolChain = this.toolChain.then(() => this.callTool(message)).catch((error) => { this.active?.reject(error); });
      } else {
        // No external permission escalation or unhandled interactive prompts.
        try { this.rpc?.respond(message.id, message.method.includes("requestApproval") ? { decision: "decline" } : message.method.includes("requestUserInput") ? { answers: {} } : { action: "decline" }); } catch { /* closed */ }
      }
      return;
    }
    if (message.method === "account/rateLimits/updated") { codexAccount().noteRateLimit(p.rateLimits); void this.checkLimit(); return; }
    if (p.threadId !== this.threadId || !this.active) return;
    const eventTurn = p.turnId ?? (message.method === "turn/completed" ? p.turn?.id : null);
    if (eventTurn && this.turnId && eventTurn !== this.turnId) return;
    if (message.method === "turn/started") this.turnId = p.turn.id;
    else if (message.method === "item/agentMessage/delta" || message.method === "item/reasoning/summaryTextDelta") {
      const type = message.method === "item/agentMessage/delta" ? "text" : "thinking";
      const id = `${p.itemId}:${type}`;
      if (!this.parts.has(id)) this.setPart(type === "text" ? { id, type, text: "" } : { id, type, text: "", done: false });
      const part = this.parts.get(id)!;
      if (part.type === "text" || part.type === "thinking") part.text += p.delta;
      this.callbacks.delta(id, type, p.delta);
    } else if (message.method === "item/started" || message.method === "item/completed") {
      const item = p.item;
      const completed = message.method === "item/completed";
      if (item.type === "agentMessage" && completed) this.setPart({ type: "text", id: `${item.id}:text`, text: item.text });
      else if (item.type === "reasoning" && completed) this.setPart({ type: "thinking", id: `${item.id}:thinking`, text: item.summary?.join("\n") || (this.parts.get(`${item.id}:thinking`) as { text?: string })?.text || "", done: true });
      else if (item.type === "webSearch") this.setPart({ type: "tool", id: item.id, name: "WebSearch", input: item.action ?? {}, status: completed ? "done" : "running", result: item.query });
      else if (item.type === "contextCompaction") this.callbacks.compact();
    } else if (message.method === "turn/plan/updated") this.callbacks.todos((p.plan ?? []).map((step: { step: string; status: string }) => ({ content: step.step, status: step.status === "inProgress" ? "in_progress" : step.status } as Todo)));
    else if (message.method === "thread/tokenUsage/updated") {
      this.total = p.tokenUsage.total;
      this.callbacks.totals(this.total);
      const last = p.tokenUsage.last;
      const max = p.tokenUsage.modelContextWindow;
      if (max > 0) this.callbacks.contextUsage({ tokens: last.totalTokens, maxTokens: max, percentage: last.totalTokens / max * 100 });
    } else if (message.method === "turn/completed") {
      const finish = this.active;
      void this.toolChain.then(() => {
        this.callbacks.usage({ inputTokens: Math.max(0, this.total.inputTokens - this.totalBefore.inputTokens), outputTokens: Math.max(0, this.total.outputTokens - this.totalBefore.outputTokens), cacheReadTokens: Math.max(0, this.total.cachedInputTokens - this.totalBefore.cachedInputTokens), cacheCreationTokens: 0, costUsd: 0, costUnavailable: true, durationMs: Date.now() - this.startedAt, numTurns: this.calls + 1 });
        if (p.turn.status === "failed") finish?.reject(new Error(p.turn.error?.message ?? "Codex could not finish this reply."));
        else finish?.resolve();
      });
    } else if (message.method === "error" && !p.willRetry) this.active?.reject(new Error(p.error?.message ?? "Codex reported an error."));
  }

  private setPart(part: AssistantPart) { if (this.closed || !this.active) return; this.parts.set(part.id, part); this.callbacks.part({ ...part }); }

  private async callTool(message: RpcMessage) {
    const p = message.params;
    const rpc = this.rpc;
    if (!rpc || message.id == null) return;
    const reply = (text: string, success = false, images: Array<{ data: string; mimeType: string }> = []) => {
      try { rpc.respond(message.id!, { success, contentItems: [...images.map((image) => ({ type: "inputImage", imageUrl: `data:${image.mimeType};base64,${image.data}` })), { type: "inputText", text }] }); } catch { /* interrupted connection */ }
    };
    if (!this.active || this.cancelled || p.threadId !== this.threadId) { reply("This turn is no longer active."); return; }
    if (++this.calls > (this.settings?.maxTurns ?? 100)) { reply("The step limit was reached. Stop and let the user continue."); this.active.reject(new Error(`Stopped at the ${this.settings?.maxTurns ?? 100} step limit. Send continue to keep going.`)); await this.interrupt(); return; }
    const reason = await this.callbacks.limits();
    if (this.cancelled || this.closed) { reply("This turn was cancelled."); return; }
    if (reason) { reply(reason); this.active?.reject(new Error(reason)); await this.interrupt(); return; }
    const part = { type: "tool" as const, id: p.callId, name: p.tool === "TodoWrite" ? p.tool : `mcp__inline__${p.tool}`, input: p.arguments, status: "running" as const };
    this.setPart(part);
    try {
      let result;
      if (p.tool === "TodoWrite") {
        const parsed = z.object({ todos: z.array(z.object({ content: z.string(), activeForm: z.string().optional(), status: z.enum(["pending", "in_progress", "completed"]) })) }).parse(p.arguments);
        this.callbacks.todos(parsed.todos);
        result = { text: "Plan updated." };
      } else result = await runTool(p.tool, p.arguments, { ...this.callbacks.context(), signal: this.controller.signal });
      this.setPart({ ...part, status: result.isError ? "error" : "done", result: result.text });
      reply(result.text, !result.isError, result.images);
    } catch (error) { const text = error instanceof Error ? error.message : String(error); this.setPart({ ...part, status: "error", result: text }); reply(text); }
  }

  async interrupt() {
    this.cancelled = true;
    this.controller.abort();
    if (this.rpc && this.turnId) await this.rpc.request("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }, 5000).catch(() => undefined);
  }
  close() { this.closed = true; this.controller.abort(); const rpc = this.rpc; this.rpc = null; this.active?.reject(new Error("Codex session closed.")); this.active = null; rpc?.close(); }
}
