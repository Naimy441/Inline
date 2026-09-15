import { runSandboxedJs } from "@/lib/agent/sandbox";
import type { AgentToolCall, AgentToolName, AgentToolResult } from "@/lib/agent/toolCatalog";
import { searchCitations, formatBibliography, formatInlineCite } from "@/lib/writing/citations";
import { lintWriting, summarizeLint } from "@/lib/writing/lint";
import { retrieveChunks, shouldRetrieve } from "@/lib/writing/retrieve";
import { countText, reviewProposedWriting, targetsFromToolArgs } from "@/lib/writing/review";
import { detectAiTropes, summarizeTropes } from "@/lib/writing/tropes";

export type { AgentToolCall, AgentToolName, AgentToolResult };
export {
  ALL_TOOL_NAMES,
  CLIENT_TOOLS,
  DOCUMENT_TOOLS,
  SERVER_TOOLS,
  isClientTool,
  isDocumentTool,
  isServerTool,
  isToolName,
} from "@/lib/agent/toolCatalog";
export { runSandboxedJs } from "@/lib/agent/sandbox";

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
      const works = searchCitations(String(args.query ?? ctx.prompt)).map((work) => ({
        ...work,
        inline: formatInlineCite(work),
        bibliography: formatBibliography(work),
      }));
      return {
        id: call.id,
        name: call.name,
        hidden: call.hidden,
        result: { works, source: "inline-catalog" },
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
