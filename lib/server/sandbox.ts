import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { dataDir } from "@/lib/server/store";

export type SandboxResult = {
  code: number;
  stdout: string;
  stderr: string;
  /** Set when the process was killed by a signal. */
  signal: string | null;
  /** False when Claude Code's sandbox stopped before the command started. */
  started: boolean;
  /** Claude Code's sandbox runtime (`@anthropic-ai/sandbox-runtime`). */
  backend: string;
};

const OUTPUT_CAP = 100_000;
const BACKEND = "sandbox-runtime";

/** What the command inherits. The working directory is the document folder. */
export function commandEnvironment() {
  const PATH = process.env.PATH ?? "";
  let python3 = "not found on this machine";
  for (const dir of PATH.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, process.platform === "win32" ? "python3.exe" : "python3");
    try {
      accessSync(candidate, constants.X_OK);
      python3 = candidate;
      break;
    } catch {
      // Try the next directory on PATH.
    }
  }
  return { PATH, HOME: process.env.HOME ?? "", python3 };
}

/**
 * Matplotlib, fontconfig and pip write a cache, and Python writes temp files.
 * All of that lives beside the document repositories, not inside one, so a
 * plot or a `pip install` does not leave `matplotlib-*`, `tmp*` or a pip
 * cache in that document's git repo. The sandbox may write there.
 */
function cacheRoot() {
  return path.join(dataDir(), "cache");
}

async function commandCacheEnv(): Promise<Record<string, string> & { TMPDIR: string }> {
  const dirs = { XDG_CACHE_HOME: "xdg", MPLCONFIGDIR: "matplotlib", PIP_CACHE_DIR: "pip", TMPDIR: "tmp" };
  const env: Record<string, string> = {};
  for (const [name, dir] of Object.entries(dirs)) {
    env[name] = path.join(cacheRoot(), dir);
    await mkdir(env[name]!, { recursive: true });
  }
  // No window can open from the sandbox. Without Agg, pyplot on macOS starts
  // Python.app and prints sandbox and XPC errors, though the file is written.
  return { ...env, TMPDIR: env.TMPDIR!, MPLBACKEND: "Agg", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
}

let userTemp: string | null | undefined;

/**
 * macOS's per-user temp folder (/var/folders/…/T/). xcrun, behind
 * /usr/bin/python3 and the other developer-tool shims, keeps its lookup cache
 * there whatever TMPDIR says, and reports every refused write on stderr.
 */
function darwinUserTemp() {
  if (userTemp === undefined) {
    userTemp = null;
    if (process.platform === "darwin") {
      try {
        userTemp = execFileSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim() || null;
      } catch {
        // No such folder; xcrun then has nowhere to cache either.
      }
    }
  }
  return userTemp;
}

/** Text Claude should see for a command: the exit reason, both streams, and where it ran. */
export function formatCommandReport(command: string, result: SandboxResult) {
  const reason = !result.started
    ? "the command never started; the sandbox stopped during setup"
    : result.code === 130
      ? `cancelled${result.signal ? ` by ${result.signal}` : ""}`
      : result.code === 124
        ? "killed because it ran too long or wrote too much"
        : result.signal
          ? `killed by ${result.signal}`
          : result.code === 0
            ? "finished"
            : "finished with an error";
  const env = commandEnvironment();
  const text = [
    `exit ${result.code} (${reason})`,
    `command: ${command}`,
    "working directory: the document folder",
    `sandbox: Claude Code (${result.backend})`,
    `environment: HOME=${env.HOME || "(unset)"}; python3 is ${env.python3}`,
    "stdout:",
    result.stdout.replace(/\s+$/, "") || "(empty)",
    "stderr:",
    result.stderr.replace(/\s+$/, "") || "(empty)",
  ].join("\n");
  return { text, isError: result.code !== 0 || !result.started };
}

/**
 * Run a shell command in the document folder using Claude Code's sandbox
 * (`@anthropic-ai/sandbox-runtime`). The folder is the working directory.
 * The sandbox's own rules apply; Inline does not add any of its own.
 */
export async function runInFolder(folder: string, command: string, timeoutMs: number, signal?: AbortSignal): Promise<SandboxResult> {
  const root = path.resolve(folder);
  if (signal?.aborted) {
    return { code: 130, stdout: "", stderr: "The command was cancelled before it started.\n", signal: "SIGTERM", started: false, backend: BACKEND };
  }
  try {
    await ensureSandbox();
    const cache = await commandCacheEnv();
    // The runtime sets TMPDIR=/tmp/claude in the wrapper, after the spawn
    // environment. That folder may not exist, and Python's tempfile then falls
    // back to the working directory, which is the document folder.
    const sandboxed = `export TMPDIR=${shellQuote(cache.TMPDIR)}\n${command}`;
    const wrapped = await SandboxManager.wrapWithSandboxArgv(sandboxed, undefined, folderConfig(root), signal, root);
    const captured = await capture(wrapped.argv[0]!, wrapped.argv.slice(1), timeoutMs, { cwd: root, env: { ...wrapped.env, ...cache }, signal });
    const stderr = SandboxManager.annotateStderrWithSandboxFailures(sandboxed, captured.stderr);
    return { ...captured, stderr, started: true, backend: BACKEND };
  } catch (error) {
    const stderr = errorText(error);
    return { code: 1, stdout: "", stderr: stderr.endsWith("\n") ? stderr : `${stderr}\n`, signal: null, started: false, backend: BACKEND };
  }
}

/**
 * Claude Code's sandbox, with this folder as the place commands may write.
 * Network is left unset, which is the runtime's "no allow list" mode: it does
 * not add a block list of our own.
 */
function folderConfig(folder: string): SandboxRuntimeConfig {
  const temp = darwinUserTemp();
  return {
    network: { deniedDomains: [] },
    filesystem: { denyRead: [], allowWrite: [folder, cacheRoot(), ...(temp ? [path.join(temp, "xcrun_db*")] : [])], denyWrite: [] },
  } as unknown as SandboxRuntimeConfig;
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

let ready: Promise<void> | null = null;

type Unrefable = { unref?: () => void };

function activeHandles(): Unrefable[] {
  const proc = process as NodeJS.Process & { _getActiveHandles?: () => Unrefable[]; _getActiveRequests?: () => Unrefable[] };
  return [...(proc._getActiveHandles?.() ?? []), ...(proc._getActiveRequests?.() ?? [])];
}

function ensureSandbox() {
  if (!ready) {
    const before = new Set(activeHandles());
    ready = SandboxManager.initialize({
      network: { deniedDomains: [] },
      filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
    } as unknown as SandboxRuntimeConfig).then(() => {
      // The runtime's proxy stays up for later commands. It must not keep a
      // finished test process alive.
      for (const handle of activeHandles()) {
        if (!before.has(handle)) handle.unref?.();
      }
      process.once("beforeExit", () => {
        void SandboxManager.reset();
      });
    });
  }
  return ready;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

type Captured = { code: number; stdout: string; stderr: string; signal: string | null };

function killGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // The child is not a process-group leader.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // Already gone.
  }
}

function capture(
  command: string,
  args: string[],
  timeoutMs: number,
  extra: { cwd?: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<Captured> {
  return new Promise((resolve, reject) => {
    if (extra.signal?.aborted) {
      resolve({ code: 130, stdout: "", stderr: "The command was cancelled before it started.\n", signal: "SIGTERM" });
      return;
    }
    let child: ChildProcess;
    try {
      child = spawn(command, args, {
        cwd: extra.cwd,
        env: extra.env ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch (error) {
      reject(error);
      return;
    }
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let settled = false;
    const finish = (result: Captured) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      extra.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      extra.signal?.removeEventListener("abort", onAbort);
      reject(error);
    };
    child.stdout?.on("data", (chunk: Buffer) => {
      if (outBytes < 1_000_000) {
        stdout.push(chunk);
        outBytes += chunk.length;
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (errBytes < 1_000_000) {
        stderr.push(chunk);
        errBytes += chunk.length;
      }
    });
    const onAbort = () => {
      killGroup(child, "SIGTERM");
      const kill = setTimeout(() => killGroup(child, "SIGKILL"), 200);
      kill.unref?.();
    };
    extra.signal?.addEventListener("abort", onAbort);
    const timer = setTimeout(() => killGroup(child, "SIGKILL"), timeoutMs);
    child.on("error", (error) => fail(error));
    child.on("close", (code, signal) => {
      const out = Buffer.concat(stdout).toString("utf8");
      const err = Buffer.concat(stderr).toString("utf8");
      if (extra.signal?.aborted) {
        finish({ code: 130, stdout: clip(out), stderr: clip(`${err}${err && !err.endsWith("\n") ? "\n" : ""}The command was cancelled.`), signal: signal ?? "SIGTERM" });
        return;
      }
      if (signal === "SIGKILL") {
        finish({ code: 124, stdout: clip(out), stderr: clip(`${err}\nThe command was stopped because it ran too long or wrote too much.`), signal: "SIGKILL" });
        return;
      }
      finish({ code: code ?? 1, stdout: clip(out), stderr: clip(err), signal });
    });
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      stream?.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
        fail(error);
      });
    }
    try {
      child.stdin?.end();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EPIPE" && code !== "ERR_STREAM_DESTROYED") fail(error);
    }
  });
}

function clip(text: string) {
  const value = String(text ?? "");
  return value.length > OUTPUT_CAP ? `${value.slice(0, OUTPUT_CAP)}\n…[output truncated]` : value;
}
