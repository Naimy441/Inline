import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CanvasOutput, CellLanguage } from "@/lib/doc/canvas";
import { assertSafeId, dataDir } from "@/lib/server/store";

/**
 * Run one notebook cell. The process's working directory, home and temp are
 * the canvas document's own notebook folder, never the project or another
 * document. JavaScript is also started with Node's permission model so it
 * cannot read or write outside that folder.
 */

const MAX_SOURCE = 100_000;
const MAX_OUTPUT = 100_000;
const TIMEOUT_MS = 15_000;

export function notebookDir(documentId: string) {
  return path.join(dataDir(), "documents", assertSafeId(documentId), "notebook");
}

export async function runNotebookSource(options: { documentId: string; cellId: string; language: CellLanguage; source: string; timeoutMs?: number }): Promise<CanvasOutput> {
  const cellId = assertSafeId(options.cellId);
  const dir = notebookDir(options.documentId);
  await mkdir(dir, { recursive: true });
  const source = options.source.slice(0, MAX_SOURCE);
  const timeout = options.timeoutMs ?? TIMEOUT_MS;
  if (options.language === "python") return runProcess(dir, "python3", [`cell-${cellId}.py`], source, timeout);
  const file = `cell-${cellId}.mjs`;
  const permitted = await runProcess(dir, process.execPath, ["--permission", `--allow-fs-read=${dir}`, `--allow-fs-write=${dir}`, file], source, timeout);
  // An old Node that doesn't know --permission fails before the script runs. A script
  // that the permission model stopped has already run; don't try again without it.
  if (permitted.error && /bad option|unknown option/i.test(`${permitted.error}\n${permitted.stderr}`)) {
    return runProcess(dir, process.execPath, [file], source, timeout);
  }
  return permitted;
}

async function runProcess(dir: string, command: string, args: string[], source: string | null, timeoutMs: number): Promise<CanvasOutput> {
  if (source !== null) await writeFile(path.join(dir, args[args.length - 1]!), source);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: dir,
    TMPDIR: dir,
    NODE_ENV: process.env.NODE_ENV,
    PYTHONNOUSERSITE: "1",
    PYTHONPYCACHEPREFIX: dir,
    PYTHONSAFEPATH: "1",
  };
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error: string | null) => {
      if (settled) return;
      settled = true;
      resolve({ stdout: clip(stdout), stderr: clip(stderr), error, ranAt: Date.now() });
    };
    let child;
    try {
      child = spawn(command, args, { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error));
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish("The cell ran for too long and was stopped.");
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > MAX_OUTPUT) {
        child.kill("SIGKILL");
        finish("The cell printed too much and was stopped.");
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish(error.message);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code && code !== 0) finish(stderr.trim() || `The cell exited with status ${code}.`);
      else finish(null);
    });
  });
}

function clip(text: string) {
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n…` : text;
}
