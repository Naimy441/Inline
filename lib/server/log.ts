import { appendFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "@/lib/server/store";

/**
 * Server log: one JSON object per line, written to stderr and appended to
 * $INLINE_DATA_DIR/logs/inline.log (rotated at 5 MB), so a problem can be
 * traced from the reference id shown to the user.
 */

export type LogLevel = "info" | "warn" | "error";

const MAX_LOG_BYTES = 5 * 1024 * 1024;
let writing: Promise<void> = Promise.resolve();

function serializeError(error: unknown) {
  if (error instanceof Error) return { name: error.name, message: error.message, stack: error.stack?.split("\n").slice(0, 8).join("\n") };
  return { message: String(error) };
}

export function log(level: LogLevel, message: string, fields: Record<string, unknown> = {}) {
  const entry: Record<string, unknown> = { time: new Date().toISOString(), level, message };
  for (const [key, value] of Object.entries(fields)) entry[key] = key === "error" ? serializeError(value) : value;
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else if (process.env.INLINE_LOG_LEVEL === "info") console.log(line);
  if (process.env.INLINE_LOG_FILE === "0") return;
  writing = writing.then(() => appendLine(line)).catch(() => undefined);
}

async function appendLine(line: string) {
  const folder = path.join(dataDir(), "logs");
  const file = path.join(folder, "inline.log");
  await mkdir(folder, { recursive: true });
  const size = await stat(file).then((info) => info.size, () => 0);
  if (size > MAX_LOG_BYTES) await rename(file, `${file}.1`).catch(() => undefined);
  await appendFile(file, `${line}\n`, "utf8");
}

/** Wait for queued log lines to be written (tests). */
export function flushLog() {
  return writing;
}

/** A short id to show the user and find the matching log line. */
export function referenceId() {
  return Math.random().toString(36).slice(2, 10);
}
