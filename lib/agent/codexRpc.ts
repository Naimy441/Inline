import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { code: number; message: string } };
export type CodexConnection = Pick<CodexRpc, "request" | "notify" | "respond" | "onMessage" | "onClose" | "close">;

export function codexExecutable() {
  if (process.env.INLINE_CODEX_PATH) return process.env.INLINE_CODEX_PATH;
  const triple = `${process.arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : process.platform === "win32" ? "pc-windows-msvc" : "unknown-linux-musl"}`;
  const candidate = path.join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "@openai", `codex-${process.platform}-${process.arch}`, "vendor", triple, "bin", process.platform === "win32" ? "codex.exe" : "codex");
  return existsSync(/* turbopackIgnore: true */ candidate) ? candidate : "codex";
}

/** Newline-delimited JSON-RPC over the official Codex app-server stdio transport. */
export class CodexRpc {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(message: RpcMessage) => void>();
  private closers = new Set<(error: Error) => void>();
  private ended: Error | null = null;

  constructor() {
    // Account credentials and model preferences stay with Codex; Inline supplies
    // its own tools and instructions, without running host hooks or connectors.
    this.child = spawn(/* turbopackIgnore: true */ codexExecutable(), ["app-server", "-c", "features.apps=false", "-c", "features.hooks=false", "-c", "features.skip_host_skill_discovery=true", "-c", "mcp_servers={}", "--listen", "stdio://"], { stdio: "pipe", windowsHide: true });
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", (line) => {
      let message: RpcMessage;
      try { message = JSON.parse(line); } catch { this.fail(new Error("Codex sent an invalid protocol message.")); this.child.kill(); return; }
      if (message.id != null && !message.method) {
        const pending = this.pending.get(Number(message.id));
        if (!pending) return;
        this.pending.delete(Number(message.id));
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
      } else for (const listener of this.listeners) listener(message);
    });
    this.child.stderr.on("data", (chunk) => { if (process.env.INLINE_DEBUG_AGENT) process.stderr.write(`[codex] ${chunk}`); });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.on("error", (error) => this.fail(new Error(`Couldn't start Codex. Install Codex or set INLINE_CODEX_PATH. ${error.message}`)));
    this.child.on("exit", () => { lines.close(); this.fail(new Error("Codex app-server exited.")); });
  }

  private fail(error: Error) {
    if (this.ended) return;
    this.ended = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const closer of this.closers) closer(error);
  }
  private write(message: RpcMessage) {
    if (this.ended) throw this.ended;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request<T = any>(method: string, params?: unknown, timeout = 30_000): Promise<T> {
    if (this.ended) return Promise.reject(this.ended);
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Codex ${method} timed out.`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  notify(method: string, params?: unknown) { this.write({ method, params }); }
  respond(id: number | string, result: unknown) { this.write({ id, result }); }
  onMessage(listener: (message: RpcMessage) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  onClose(listener: (error: Error) => void) { this.closers.add(listener); return () => { this.closers.delete(listener); }; }
  close() { this.fail(new Error("Codex connection closed.")); this.child.stdin.end(); this.child.kill(); }
}

let factory: () => CodexConnection = () => new CodexRpc();
/** Injectable transport: tests exercise the protocol and real tools without an account. */
export function setCodexConnectionFactory(next: (() => CodexConnection) | null) { factory = next ?? (() => new CodexRpc()); }
export async function connectCodex() {
  const rpc = factory();
  try {
    await rpc.request("initialize", { clientInfo: { name: "inline", title: "Inline", version: "0.3.2" }, capabilities: { experimentalApi: true } });
    rpc.notify("initialized");
    return rpc;
  } catch (error) { rpc.close(); throw error; }
}
