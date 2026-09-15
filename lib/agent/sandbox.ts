import { createContext, Script } from "node:vm";

const BLOCKED = /\b(process|require|module|exports|fetch|XMLHttpRequest|document|window|globalThis|Function|eval|WebAssembly|AsyncFunction|constructor|__proto__|prototype|import|importScripts)\b/;

export function runSandboxedJs(code: string) {
  const trimmed = code.trim();
  if (!trimmed) return { error: "No code." };
  if (trimmed.length > 2_000) return { error: "Code is too long." };
  if (BLOCKED.test(trimmed)) return { error: "That code uses blocked APIs." };

  try {
    const script = new Script(
      `"use strict";\n(function () {\n${trimmed}\n})()`,
      { filename: "inline-run.js" },
    );
    const sandbox = {
      Math: Object.freeze({ ...Math }),
      console: Object.freeze({
        log() {},
        warn() {},
        info() {},
        error() {},
      }),
    };
    const context = createContext(sandbox, {
      name: "inline-run",
      codeGeneration: { strings: false, wasm: false },
    });
    const value = script.runInContext(context, { timeout: 80, breakOnSigint: true, displayErrors: true });
    return { result: formatResult(value) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Code failed." };
  }
}

function formatResult(value: unknown) {
  if (value == null) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
