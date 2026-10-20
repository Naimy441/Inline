import { randomUUID } from "node:crypto";
import type { CodexConnection, RpcMessage } from "../codexRpc";

export type FakeCodexTurn = { input: Array<{ type: string; text?: string; url?: string }>; threadId: string; model: string; effort: string };
export type FakeCodexModel = (turn: FakeCodexTurn, agent: { say: (text: string) => void; think: (text: string) => void; call: (tool: string, args: Record<string, unknown>) => Promise<{ success: boolean; contentItems: Array<{ type: string; text?: string; imageUrl?: string }> }>; untilInterrupted: () => Promise<void> }) => void | Promise<void>;

/** Scripted app-server protocol, with all tool requests executed by Inline's real tool registry. */
export function fakeCodex(model: FakeCodexModel = async (turn, agent) => {
  const text = turn.input.filter((item) => item.type === "text").map((item) => item.text).join("\n");
  const replace = text.match(/(?:slowly )?replace "([^"]+)" with "([^"]+)"\s*$/i);
  if (replace) {
    agent.think("I'll read the document and make the requested change.");
    await agent.call("read_document", {});
    const result = await agent.call("edit_document", { old_string: replace[1], new_string: replace[2] });
    agent.say(result.success ? `Replaced ${replace[1]} with ${replace[2]}.` : result.contentItems.map((item) => item.text ?? "").join("\n"));
    if (/slowly replace/i.test(text)) await agent.untilInterrupted();
  } else if (/wait for stop/i.test(text)) { agent.say("Working until stopped."); await agent.untilInterrupted(); }
  else agent.say("Codex can see this conversation and the current document.");
}) {
  const turns: FakeCodexTurn[] = [];
  const requests: Array<{ method: string; params: any }> = [];
  const threads = new Map<string, { tools: any[] }>();
  let usagePercent = 24;
  let failResume = false;
  let failTurn = false;
  let accountSignedIn = true;
  const observers = new Set<(method: string, params: any) => void>();
  const limits = () => ({ rateLimits: { limitId: "codex", planType: "pro", primary: { usedPercent: usagePercent, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 }, secondary: { usedPercent: 12, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 86400 } } });

  const factory = (): CodexConnection => {
    const listeners = new Set<(message: RpcMessage) => void>();
    const closers = new Set<(error: Error) => void>();
    const pending = new Map<string, (value: any) => void>();
    let stopped: (() => void) | null = null;
    let closed = false;
    let nextId = 1000;
    const emit = (method: string, params: any) => { if (!closed) for (const listener of listeners) listener({ method, params }); };
    observers.add(emit);
    return {
      onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
      onClose(listener) { closers.add(listener); return () => { closers.delete(listener); }; },
      notify() {},
      respond(id, value) { pending.get(String(id))?.(value); pending.delete(String(id)); },
      close() { if (closed) return; closed = true; observers.delete(emit); stopped?.(); for (const resolve of pending.values()) resolve({ success: false, contentItems: [{ type: "inputText", text: "Cancelled" }] }); for (const closer of closers) closer(new Error("Codex connection closed.")); },
      async request(method, params) {
        const p = params as any;
        requests.push({ method, params: p });
        if (method === "initialize") return {} as any;
        if (method === "account/read") return { account: accountSignedIn ? { type: "chatgpt", email: "test@example.com", planType: "pro" } : null, requiresOpenaiAuth: true } as any;
        if (method === "model/list") return { data: [{ model: "codex-test", displayName: "Codex Test", supportedReasoningEfforts: [{ reasoningEffort: "medium" }, { reasoningEffort: "high" }], isDefault: true }], nextCursor: null } as any;
        if (method === "account/rateLimits/read") return limits() as any;
        if (method === "thread/start") { const id = randomUUID(); threads.set(id, { tools: p.dynamicTools }); return { thread: { id }, model: p.model ?? "codex-test" } as any; }
        if (method === "thread/resume") { if (failResume || !threads.has(p.threadId)) throw new Error("Unable to resume thread"); return { thread: { id: p.threadId }, model: p.model ?? "codex-test" } as any; }
        if (method === "turn/interrupt") { stopped?.(); return {} as any; }
        if (method === "account/login/start") return { type: "chatgpt", loginId: "test-login", authUrl: "https://auth.openai.com/test-login" } as any;
        if (method === "account/login/cancel") return {} as any;
        if (method !== "turn/start") throw new Error(`Unhandled fake method ${method}`);
        const id = randomUUID();
        turns.push(p);
        setTimeout(() => {
          void (async () => {
            const base = { threadId: p.threadId, turnId: id };
            emit("turn/started", { ...base, turn: { id } });
            const stream = (type: "agentMessage" | "reasoning", text: string) => {
              const itemId = randomUUID();
              for (const delta of text.match(/.{1,12}/gs) ?? []) emit(type === "agentMessage" ? "item/agentMessage/delta" : "item/reasoning/summaryTextDelta", { ...base, itemId, delta });
              emit("item/completed", { ...base, item: { type, id: itemId, text, summary: [text] } });
            };
            try {
              if (failTurn) throw new Error("Test Codex turn failed");
              await model(p, {
                say: (text) => stream("agentMessage", text), think: (text) => stream("reasoning", text),
                call: async (tool, args) => {
                  const callId = randomUUID();
                  const requestId = ++nextId;
                  const result = new Promise<any>((resolve) => pending.set(String(requestId), resolve));
                  for (const listener of listeners) listener({ id: requestId, method: "item/tool/call", params: { ...base, callId, tool, arguments: args } });
                  return result;
                },
                untilInterrupted: () => new Promise<void>((resolve) => { stopped = resolve; }),
              });
              emit("thread/tokenUsage/updated", { ...base, tokenUsage: { total: { inputTokens: turns.length * 100, outputTokens: turns.length * 20, cachedInputTokens: turns.length * 10 }, last: { totalTokens: 120 }, modelContextWindow: 200_000 } });
              emit("turn/completed", { ...base, turn: { id, status: "completed" } });
            } catch (error) { emit("turn/completed", { ...base, turn: { id, status: "failed", error: { message: String(error) } } }); }
          })();
        }, 5);
        return { turn: { id } } as any;
      },
    };
  };
  return { factory, turns, requests, threads, completeLogin: (success: boolean) => { accountSignedIn = success; for (const emit of observers) emit("account/login/completed", { loginId: "test-login", success }); }, setUsage: (value: number) => { usagePercent = value; }, setFailResume: (value: boolean) => { failResume = value; }, setFailTurn: (value: boolean) => { failTurn = value; }, setSignedIn: (value: boolean) => { accountSignedIn = value; } };
}
