import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { executeServerTool, runSandboxedJs, type AgentToolCall, type AgentToolName } from "@/lib/agent/tools";
import type { AgentCitation, AgentTask } from "@/lib/agent/types";
import { DocumentSession } from "@/lib/agent/mcp/session";
import { searchCitations, formatBibliography, formatInlineCite } from "@/lib/writing/citations";

export const WRITE_TOOLS = new Set(["replace_text", "insert_text", "delete_text"]);
export const CLIENT_MCP_TOOLS = new Set([
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
]);

export type DocumentMcpOptions = {
  allowWrites?: boolean;
  allowClient?: boolean;
  allowSeed?: boolean;
};

export type ToolCallMeta = {
  name: string;
  args: Record<string, unknown>;
  edit?: import("@/lib/agent/types").AgentEditDraft;
  citations?: AgentCitation[];
  tasks?: AgentTask[];
  chatTitle?: string;
  clientTool?: AgentToolCall;
};

export function createDocumentMcpServer(session: DocumentSession, options: DocumentMcpOptions = {}) {
  const server = new McpServer({ name: "inline-document", version: "0.1.0" });
  registerDocumentTools(server, session, options);
  return server;
}

export function registerDocumentTools(server: McpServer, session: DocumentSession, options: DocumentMcpOptions = {}) {
  const allowWrites = options.allowWrites !== false;
  const allowClient = Boolean(options.allowClient);
  const allowSeed = Boolean(options.allowSeed);

  server.registerTool(
    "get_outline",
    {
      title: "Get outline",
      description: "Heading and first-line index of the working draft, with paragraph ids and page numbers.",
      inputSchema: z.object({}),
    },
    async () => jsonResult({
      title: session.title,
      pageCount: session.pageCount(),
      chars: session.text.length,
      items: session.outline().map((item) => ({
        ...item,
        text: item.text.slice(0, 180),
      })),
    }),
  );

  server.registerTool(
    "search_document",
    {
      title: "Search document",
      description: "Find snippets in the working draft. Returns paragraph ids, pages, and surrounding text.",
      inputSchema: z.object({
        query: z.string().describe("Text to search for"),
        limit: z.number().int().min(1).max(30).optional(),
      }),
    },
    async ({ query, limit }) => jsonResult({
      query,
      hits: session.search(query, limit ?? 8),
      pageCount: session.pageCount(),
    }),
  );

  server.registerTool(
    "read_document",
    {
      title: "Read document",
      description:
        "Read the working draft on demand. Use page for a visual letter page, pages for several, paragraph ids for a range, or scope \"document\" for the whole draft (paged if longer than ~12k characters).",
      inputSchema: z.object({
        page: z.number().int().min(1).optional(),
        pages: z.array(z.number().int().min(1)).optional(),
        paragraphId: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        start: z.number().int().min(0).optional(),
        end: z.number().int().min(0).optional(),
        query: z.string().optional(),
        scope: z.enum(["document"]).optional(),
      }),
    },
    async (args) => jsonResult(session.read(args)),
  );

  if (allowWrites) {
    server.registerTool(
      "replace_text",
      {
        title: "Replace text",
        description: "Replace an exact passage in the working draft. The find string must already exist.",
        inputSchema: z.object({
          find: z.string().describe("Exact existing text to replace"),
          replace: z.string().describe("Replacement text"),
          occurrence: z.number().int().min(0).optional().describe("Zero-based match if find appears more than once"),
          reason: z.string().optional(),
        }),
      },
      async ({ find, replace, occurrence, reason }) => jsonResult(session.replaceText(find, replace, occurrence ?? 0, reason)),
    );

    server.registerTool(
      "insert_text",
      {
        title: "Insert text",
        description: "Insert prose after a paragraph or after existing text. If the draft is empty, this appends.",
        inputSchema: z.object({
          text: z.string(),
          afterFind: z.string().optional(),
          paragraphId: z.string().optional(),
          reason: z.string().optional(),
        }),
      },
      async ({ text, afterFind, paragraphId, reason }) => jsonResult(session.insertText(text, afterFind, paragraphId, reason)),
    );

    server.registerTool(
      "delete_text",
      {
        title: "Delete text",
        description: "Delete an exact passage from the working draft.",
        inputSchema: z.object({
          find: z.string(),
          occurrence: z.number().int().min(0).optional(),
          reason: z.string().optional(),
        }),
      },
      async ({ find, occurrence, reason }) => jsonResult(session.deleteText(find, occurrence ?? 0, reason)),
    );
  }

  server.registerTool(
    "propose_tasks",
    {
      title: "Propose tasks",
      description: "Replace the visible task list for this job.",
      inputSchema: z.object({
        tasks: z.array(z.object({
          title: z.string(),
          status: z.enum(["pending", "in_progress", "done"]).optional(),
          kind: z.enum(["research", "draft", "edit", "cite", "review"]).optional(),
        })),
      }),
    },
    async ({ tasks }) => {
      session.tasks = tasks.map((task) => ({
        id: crypto.randomUUID(),
        title: task.title,
        status: task.status ?? "pending",
        kind: task.kind,
      }));
      return jsonResult({ tasks: session.tasks });
    },
  );

  server.registerTool(
    "set_chat_title",
    {
      title: "Set chat title",
      description: "Name this chat in 3–6 words.",
      inputSchema: z.object({ title: z.string() }),
    },
    async ({ title }) => {
      const next = title.replace(/\s+/g, " ").trim().replace(/^["']|["']$/g, "");
      if (next.length >= 2 && next.length <= 48) session.chatTitle = next;
      return jsonResult({ title: session.chatTitle ?? next });
    },
  );

  if (allowSeed) {
    server.registerTool(
      "seed_document",
      {
        title: "Seed document",
        description: "Load the working draft for this MCP session. Call this before other document tools when attaching over HTTP.",
        inputSchema: z.object({
          title: z.string().optional(),
          text: z.string(),
          pages: z.array(z.object({
            number: z.number().int().min(1),
            start: z.number().int().min(0),
            end: z.number().int().min(0),
            text: z.string(),
          })).optional(),
        }),
      },
      async ({ title, text, pages }) => {
        session.seed({ title: title ?? session.title, text, pages });
        return jsonResult({ ok: true, chars: session.text.length, pageCount: session.pageCount() });
      },
    );
  }

  server.registerTool(
    "lint_writing",
    {
      title: "Lint writing",
      description: "Word, sentence, paragraph, and page metrics for the working draft or provided text.",
      inputSchema: z.object({
        text: z.string().optional(),
        words: z.number().optional(),
        paragraphs: z.number().optional(),
        pages: z.number().optional(),
        sentences: z.number().optional(),
      }),
    },
    async (args) => jsonResult(executeNamed("lint_writing", args, session)),
  );

  server.registerTool(
    "count_words",
    {
      title: "Count words",
      description: "Count words, sentences, and paragraphs in the provided text.",
      inputSchema: z.object({ text: z.string() }),
    },
    async (args) => jsonResult(executeNamed("count_words", args, session)),
  );

  server.registerTool(
    "detect_ai_tropes",
    {
      title: "Detect AI tropes",
      description: "Flag stock AI-writing patterns in the working draft.",
      inputSchema: z.object({}),
    },
    async () => jsonResult(executeNamed("detect_ai_tropes", {}, session)),
  );

  server.registerTool(
    "retrieve_passages",
    {
      title: "Retrieve passages",
      description: "Find relevant chunks in a long draft.",
      inputSchema: z.object({ query: z.string() }),
    },
    async (args) => jsonResult(executeNamed("retrieve_passages", args, session)),
  );

  server.registerTool(
    "search_citations",
    {
      title: "Search citations",
      description: "Look up catalog works for bibliographies. Do not invent sources.",
      inputSchema: z.object({ query: z.string() }),
    },
    async ({ query }) => {
      const works = searchCitations(query).map((work) => ({
        ...work,
        inline: formatInlineCite(work),
        bibliography: formatBibliography(work),
      }));
      return jsonResult({ works });
    },
  );

  server.registerTool(
    "run_code",
    {
      title: "Run code",
      description: "Small JavaScript for counts or transforms. No DOM, fetch, or Node APIs.",
      inputSchema: z.object({ code: z.string() }),
    },
    async ({ code }) => jsonResult(runSandboxedJs(code)),
  );

  if (allowClient) {
    registerClientTool(server, "export_pdf", "Open the print / save as PDF dialog.", z.object({}));
    registerClientTool(server, "undo", "Undo the last editor action.", z.object({}));
    registerClientTool(server, "redo", "Redo the last undone editor action.", z.object({}));
    registerClientTool(server, "insert_link", "Insert a link.", z.object({ url: z.string(), text: z.string().optional() }));
    registerClientTool(server, "insert_image", "Insert an image from a URL.", z.object({ url: z.string() }));
    registerClientTool(server, "highlight_text", "Highlight a passage.", z.object({ find: z.string(), color: z.string().optional() }));
    registerClientTool(server, "set_font_size", "Set the selected text size.", z.object({ size: z.string() }));
    registerClientTool(server, "toggle_list", "Toggle a list.", z.object({ type: z.enum(["ul", "ol"]) }));
    registerClientTool(server, "add_header", "Set the document header.", z.object({ text: z.string() }));
    registerClientTool(server, "add_page_numbers", "Show page numbers.", z.object({}));
    registerClientTool(server, "set_alignment", "Set paragraph alignment.", z.object({ align: z.enum(["left", "center", "right", "justify"]) }));
    registerClientTool(server, "insert_horizontal_line", "Insert a horizontal rule.", z.object({}));
  }

  return server;
}

export function parseToolPayload(name: string, raw: unknown): ToolCallMeta {
  const data = asObject(raw);
  const args = data ?? {};
  const meta: ToolCallMeta = { name, args };

  if (WRITE_TOOLS.has(name) && data && data.ok === true && isEdit(data.edit)) {
    meta.edit = data.edit;
  }
  if (name === "search_citations" && data && Array.isArray(data.works)) {
    meta.citations = data.works.filter(isCitation);
  }
  if (name === "propose_tasks" && data && Array.isArray(data.tasks)) {
    meta.tasks = data.tasks.filter(isTask);
  }
  if (name === "set_chat_title" && typeof data?.title === "string") {
    meta.chatTitle = data.title;
  }
  if (CLIENT_MCP_TOOLS.has(name)) {
    meta.clientTool = { id: crypto.randomUUID(), name: name as AgentToolName, args, hidden: true };
  }
  return meta;
}

export function jsonFromToolResult(result: { content?: Array<{ type?: string; text?: string }>; structuredContent?: unknown; isError?: boolean }) {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = (result.content ?? []).filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

function registerClientTool(server: McpServer, name: string, description: string, inputSchema: z.ZodType) {
  server.registerTool(
    name,
    { title: name.replace(/_/g, " "), description, inputSchema },
    async (args) => jsonResult({ queued: true, name, args }),
  );
}

function executeNamed(name: AgentToolName, args: Record<string, unknown>, session: DocumentSession) {
  return executeServerTool(
    { id: name, name, args },
    { document: session.text, prompt: "", pageCount: session.pageCount() },
  ).result;
}

function jsonResult(data: unknown) {
  const error = Boolean(data && typeof data === "object" && "ok" in data && (data as { ok?: unknown }).ok === false);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: typeof data === "object" && data ? data as Record<string, unknown> : { value: data },
    isError: error,
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function isEdit(value: unknown): value is import("@/lib/agent/types").AgentEditDraft {
  if (!value || typeof value !== "object") return false;
  const row = value as { find?: unknown; replace?: unknown };
  return typeof row.replace === "string";
}

function isCitation(value: unknown): value is AgentCitation {
  if (!value || typeof value !== "object") return false;
  const row = value as AgentCitation;
  return typeof row.title === "string" && typeof row.author === "string" && typeof row.inline === "string";
}

function isTask(value: unknown): value is AgentTask {
  if (!value || typeof value !== "object") return false;
  const row = value as AgentTask;
  return typeof row.title === "string" && typeof row.id === "string";
}
