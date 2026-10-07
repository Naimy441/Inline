import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { log } from "@/lib/server/log";

/**
 * Signing in to Claude Code from inside Inline. Runs `claude auth login` with
 * the Claude Code CLI that ships inside the Agent SDK, which opens the
 * sign-in page in the browser and finishes on its own once the user approves.
 * When the browser can't reach this computer it shows a code instead, which
 * the user pastes back here and Inline passes on to the CLI.
 */

export type LoginState =
  | { state: "idle" }
  | { state: "waiting"; url: string | null; startedAt: number }
  | { state: "done" }
  | { state: "failed"; message: string };

/** The Claude Code CLI: the Agent SDK's own copy for this platform, else `claude` on the PATH. */
export function claudeExecutable() {
  const exe = process.platform === "win32" ? "claude.exe" : "claude";
  const base = `claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const name of [base, `${base}-musl`]) {
    const candidate = path.join(/* turbopackIgnore: true */ process.cwd(), "node_modules", "@anthropic-ai", name, exe);
    if (existsSync(/* turbopackIgnore: true */ candidate)) return candidate;
  }
  return "claude";
}

const URL_PATTERN = /https:\/\/\S+/;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

class ClaudeLogin {
  private child: ChildProcess | null = null;
  private current: LoginState = { state: "idle" };
  private output = "";

  status(): LoginState {
    return this.current;
  }

  /** Start signing in, or return the sign-in already under way. Resolves once the sign-in page's address is known. */
  async start(): Promise<LoginState> {
    if (this.child && this.current.state === "waiting") return this.current;
    this.output = "";
    this.current = { state: "waiting", url: null, startedAt: Date.now() };
    let child: ChildProcess;
    try {
      child = spawn(/* turbopackIgnore: true */ claudeExecutable(), ["auth", "login"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: process.env });
    } catch (error) {
      this.current = { state: "failed", message: error instanceof Error ? error.message : "Couldn't start Claude Code." };
      return this.current;
    }
    this.child = child;
    const timeout = setTimeout(() => child.kill(), LOGIN_TIMEOUT_MS);

    const ready = new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        this.output = (this.output + chunk.toString("utf8")).slice(-8000);
        const url = this.output.match(URL_PATTERN)?.[0];
        if (url && this.current.state === "waiting" && this.child === child) {
          this.current = { ...this.current, url };
          resolve();
        }
      };
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
      setTimeout(resolve, 15_000);
    });

    child.once("error", (error) => {
      if (this.child !== child) return;
      this.child = null;
      clearTimeout(timeout);
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      this.current = { state: "failed", message: missing ? "Claude Code isn't installed on this computer." : error.message };
    });
    child.once("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      clearTimeout(timeout);
      if (code === 0) {
        this.current = { state: "done" };
        return;
      }
      const lastLine = this.output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !URL_PATTERN.test(line) && !/paste code/i.test(line))
        .pop();
      log("warn", "claude auth login failed", { code, output: this.output.slice(-1000) });
      this.current = { state: "failed", message: lastLine || "Signing in didn't finish. Try again." };
    });

    await ready;
    return this.current;
  }

  /** The code the sign-in page shows when it can't hand the sign-in back to this computer. */
  submitCode(code: string) {
    if (!this.child?.stdin || this.current.state !== "waiting") return false;
    this.child.stdin.write(`${code.trim()}\n`);
    return true;
  }

  cancel() {
    const child = this.child;
    this.child = null;
    child?.kill();
    this.current = { state: "idle" };
  }
}

const globalForLogin = globalThis as unknown as { __inlineClaudeLogin?: ClaudeLogin };

export function claudeLogin() {
  globalForLogin.__inlineClaudeLogin ??= new ClaudeLogin();
  return globalForLogin.__inlineClaudeLogin;
}
