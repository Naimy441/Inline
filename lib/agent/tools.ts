import { searchCitations, formatBibliography, formatInlineCite } from "@/lib/writing/citations";
import { lintWriting, summarizeLint } from "@/lib/writing/lint";
import { retrieveChunks, shouldRetrieve } from "@/lib/writing/retrieve";
import { countText, reviewProposedWriting, targetsFromToolArgs } from "@/lib/writing/review";
import { detectAiTropes, summarizeTropes } from "@/lib/writing/tropes";

export type AgentToolName =
  | "lint_writing"
  | "count_words"
  | "detect_ai_tropes"
  | "retrieve_passages"
  | "search_citations"
  | "run_code"
  | "export_pdf"
  | "undo"
  | "redo"
  | "insert_link"
  | "insert_image"
  | "highlight_text"
  | "set_font_size"
  | "toggle_list"
  | "add_header"
  | "add_page_numbers"
  | "set_alignment"
  | "insert_horizontal_line";

export type AgentToolCall = {
  id: string;
  name: AgentToolName;
  args: Record<string, unknown>;
  hidden?: boolean;
};

export type AgentToolResult = {
  id: string;
  name: AgentToolName;
  result: unknown;
  hidden?: boolean;
};

export const SERVER_TOOLS: AgentToolName[] = [
  "lint_writing",
  "count_words",
  "detect_ai_tropes",
  "retrieve_passages",
  "search_citations",
  "run_code",
];

export const CLIENT_TOOLS: AgentToolName[] = [
  "export_pdf",
  "undo",
  "redo",
  "insert_link",
  "insert_image",
  "highlight_text",
  "set_font_size",
  "toggle_list",
  "add_header",
  "add_page_numbers",
  "set_alignment",
  "insert_horizontal_line",
];

export const TOOL_GUIDE = [
  "lint_writing { text?, words?, paragraphs?, pages?, sentences? } — metrics on a draft (or the proposed document). Pass targets to get pass/fail. Call this when the user asked for a length or you want a diagnosis.",
  "count_words { text } — word, sentence, and paragraph counts for text you provide. Call this when the user wants a specific number of words in a sentence or passage.",
  "detect_ai_tropes — em dashes, stock phrases, watermarks",
  "retrieve_passages { query } — relevant chunks from long documents",
  "search_citations { query } — catalog works for bibliographies",
  "run_code { code } — small JavaScript for counts or transforms; no DOM",
  "export_pdf — print / save as PDF",
  "undo / redo — document history",
  "insert_link { url, text? }",
  "insert_image { url }",
  "highlight_text { find, color? }",
  "set_font_size { size }",
  "toggle_list { type: ul|ol }",
  "add_header { text }",
  "add_page_numbers",
  "set_alignment { align: left|center|right|justify }",
  "insert_horizontal_line",
].join("\n");

export function isToolName(value: unknown): value is AgentToolName {
  return typeof value === "string" && (SERVER_TOOLS.includes(value as AgentToolName) || CLIENT_TOOLS.includes(value as AgentToolName));
}

export function isServerTool(name: AgentToolName) {
  return SERVER_TOOLS.includes(name);
}

export function isClientTool(name: AgentToolName) {
  return CLIENT_TOOLS.includes(name);
}

export function executeServerTool(
  call: AgentToolCall,
  ctx: { document: string; prompt: string; pageCount?: number },
): AgentToolResult {
  const args = call.args ?? {};
  try {
    if (call.name === "lint_writing") {
      const source = typeof args.text === "string" && args.text.trim() ? args.text : ctx.document;
      const lint = lintWriting(source, ctx.pageCount ?? 1);
      const targets = targetsFromToolArgs(args);
      const review = targets
        ? reviewProposedWriting(ctx.document, source === ctx.document ? [] : [{ find: "", replace: source }], targets, ctx.pageCount)
        : null;
      return {
        id: call.id,
        name: call.name,
        hidden: call.hidden,
        result: {
          summary: review?.summary ?? summarizeLint(lint),
          lint,
          ok: review ? review.ok : true,
          misses: review?.misses ?? [],
        },
      };
    }
    if (call.name === "count_words") {
      const source = typeof args.text === "string" ? args.text : "";
      const counts = countText(source);
      const targets = targetsFromToolArgs(args);
      const review = targets
        ? reviewProposedWriting("", [{ find: "", replace: source }], { ...targets, scope: targets.scope || "chunk" })
        : null;
      return {
        id: call.id,
        name: call.name,
        hidden: call.hidden,
        result: {
          ...counts,
          ok: review ? review.ok : true,
          misses: review?.misses ?? [],
        },
      };
    }
    if (call.name === "detect_ai_tropes") {
      const hits = detectAiTropes(ctx.document);
      return { id: call.id, name: call.name, hidden: call.hidden, result: { summary: summarizeTropes(hits), hits } };
    }
    if (call.name === "retrieve_passages") {
      const query = String(args.query ?? ctx.prompt);
      const chunks = retrieveChunks(ctx.document, query, 6);
      return {
        id: call.id,
        name: call.name,
        hidden: call.hidden,
        result: { used: shouldRetrieve(ctx.document) || chunks.length > 0, chunks },
      };
    }
    if (call.name === "search_citations") {
      const works = searchCitations(String(args.query ?? ctx.prompt));
      return {
        id: call.id,
        name: call.name,
        hidden: call.hidden,
        result: works.map((work) => ({
          ...work,
          inline: formatInlineCite(work),
          bibliography: formatBibliography(work),
        })),
      };
    }
    if (call.name === "run_code") {
      return { id: call.id, name: call.name, hidden: call.hidden, result: runSandboxedJs(String(args.code ?? "")) };
    }
  } catch (error) {
    return {
      id: call.id,
      name: call.name,
      hidden: call.hidden,
      result: { error: error instanceof Error ? error.message : "Tool failed." },
    };
  }
  return { id: call.id, name: call.name, hidden: call.hidden, result: { error: "Unknown server tool." } };
}

export function runSandboxedJs(code: string) {
  const trimmed = code.trim();
  if (!trimmed) return { error: "No code." };
  if (trimmed.length > 4000) return { error: "Code is too long." };
  if (/\b(process|require|fetch|XMLHttpRequest|document|window|globalThis|Function|eval)\b/.test(trimmed)) {
    return { error: "That code uses blocked APIs." };
  }
  try {
    const fn = new Function(
      "Math",
      `"use strict"; const console = { log: () => undefined }; ${trimmed}`,
    );
    const value = fn(Math);
    return { result: formatResult(value) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Code failed." };
  }
}

function formatResult(value: unknown) {
  if (value == null) return "undefined";
  if (typeof value === "string") return value.slice(0, 4000);
  try {
    return JSON.stringify(value).slice(0, 4000);
  } catch {
    return String(value);
  }
}

export function parseToolCalls(raw: unknown): AgentToolCall[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item): AgentToolCall | null => {
      if (!item || typeof item !== "object") return null;
      const row = item as { name?: unknown; args?: unknown; hidden?: unknown };
      if (!isToolName(row.name)) return null;
      const args = row.args && typeof row.args === "object" && !Array.isArray(row.args)
        ? (row.args as Record<string, unknown>)
        : {};
      return {
        id: crypto.randomUUID(),
        name: row.name,
        args,
        hidden: row.hidden !== false,
      };
    })
    .filter((item): item is AgentToolCall => item !== null)
    .slice(0, 8);
}
