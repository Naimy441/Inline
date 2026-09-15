import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { executeServerTool, runSandboxedJs, type AgentToolCall, type AgentToolName } from "@/lib/agent/tools";
import { CLIENT_TOOLS } from "@/lib/agent/toolCatalog";
import type { AgentCitation, AgentTask } from "@/lib/agent/types";
import { DocumentSession } from "@/lib/agent/mcp/session";
import { searchCitations, formatBibliography, formatInlineCite } from "@/lib/writing/citations";
import { ResearchBudget, webEnabled, webFetch, webSearch } from "@/lib/agent/webResearch";

export const WRITE_TOOLS = new Set(["replace_text", "insert_text", "delete_text"]);
export const CLIENT_MCP_TOOLS = new Set<string>(CLIENT_TOOLS);

export type DocumentMcpOptions = {
  allowWrites?: boolean;
  allowClient?: boolean;
  allowSeed?: boolean;
  allowRunCode?: boolean;
  allowWeb?: boolean;
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
  const allowRunCode = options.allowRunCode !== false;
  const allowWeb = options.allowWeb !== false && webEnabled();
  const researchBudget = new ResearchBudget();

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
        "Read the working draft on demand. Use page for a visual letter page, pages for several, paragraph ids for a range, or scope \"document\" for the whole draft (paged if longer than ~12k characters). Page results include a paragraphs array with the same P1, P2 ids as search_document.",
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
        description: "Insert prose after a paragraph or after existing text. Prefer paragraphId from search_document or read_document. afterFind must be unique existing text. If the draft is empty, this appends.",
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
      description: "Look up the local writing catalog only. For the open web use web_search. Do not invent sources.",
      inputSchema: z.object({ query: z.string() }),
    },
    async ({ query }) => {
      const works = searchCitations(query).map((work) => ({
        ...work,
        inline: formatInlineCite(work),
        bibliography: formatBibliography(work),
      }));
      return jsonResult({ works, source: "inline-catalog" });
    },
  );

  if (allowWeb) {
    server.registerTool(
      "web_search",
      {
        title: "Web search",
        description:
          "Search the live web. Use for current facts, news, and sources. Then web_fetch the best URLs before quoting. Optional recency: day, week, month, year. Optional site: example.org.",
        inputSchema: z.object({
          query: z.string().describe("Search query, under 400 characters"),
          recency: z.enum(["any", "day", "week", "month", "year"]).optional(),
          maxResults: z.number().int().min(1).max(8).optional(),
          topic: z.enum(["general", "news"]).optional(),
          site: z.string().optional(),
        }),
      },
      async (args) => jsonResult(await webSearch(args, researchBudget)),
    );
    server.registerTool(
      "web_fetch",
      {
        title: "Read web page",
        description:
          "Fetch a public http(s) page as clean text. Call after web_search. Do not invent the URL. Private, local, and credentialed URLs are blocked.",
        inputSchema: z.object({
          url: z.string().describe("Public http or https URL"),
          maxChars: z.number().int().min(800).max(12_000).optional(),
        }),
      },
      async (args) => jsonResult(await webFetch(args, researchBudget)),
    );
  }

  if (allowRunCode) {
    server.registerTool(
      "run_code",
      {
        title: "Run code",
        description: "Small JavaScript for counts or transforms. Isolated 80ms VM. No DOM, fetch, or Node APIs.",
        inputSchema: z.object({ code: z.string() }),
      },
      async ({ code }) => jsonResult(runSandboxedJs(code)),
    );
  }

  if (allowClient) {
    registerClientTool(server, "export_pdf", "Open the print / save as PDF dialog in the editor immediately.", z.object({}));
    registerClientTool(server, "undo", "Undo the last editor action immediately.", z.object({}));
    registerClientTool(server, "redo", "Redo the last undone editor action immediately.", z.object({}));
    registerClientTool(server, "insert_link", "Insert a link in the editor immediately.", z.object({ url: z.string(), text: z.string().optional(), find: z.string().optional() }));
    registerClientTool(server, "insert_image", "Insert an image from a URL immediately.", z.object({ url: z.string() }));
    registerClientTool(server, "highlight_text", "Highlight a passage immediately.", z.object({ find: z.string(), color: z.string().optional() }));
    registerClientTool(server, "set_font_size", "Set text size immediately. Pass find to target a passage.", z.object({ size: z.string(), find: z.string().optional() }));
    registerClientTool(server, "set_font_family", "Set the font family immediately.", z.object({ family: z.string(), find: z.string().optional() }));
    registerClientTool(server, "set_text_color", "Set text color immediately.", z.object({ color: z.string(), find: z.string().optional() }));
    registerClientTool(server, "toggle_list", "Turn the current blocks into a bulleted or numbered list.", z.object({ type: z.enum(["ul", "ol"]), variant: z.enum(["dash"]).optional(), find: z.string().optional() }));
    registerClientTool(server, "toggle_bold", "Bold a passage immediately.", z.object({ find: z.string().optional() }));
    registerClientTool(server, "toggle_italic", "Italicize a passage immediately.", z.object({ find: z.string().optional() }));
    registerClientTool(server, "toggle_underline", "Underline a passage immediately.", z.object({ find: z.string().optional() }));
    registerClientTool(server, "add_header", "Set the document header immediately.", z.object({ text: z.string() }));
    registerClientTool(server, "add_footer", "Set the document footer immediately.", z.object({ text: z.string() }));
    registerClientTool(server, "add_page_numbers", "Show page numbers immediately.", z.object({ location: z.enum(["header", "footer"]).optional() }));
    registerClientTool(server, "set_alignment", "Set paragraph alignment immediately.", z.object({ align: z.enum(["left", "center", "right", "justify"]), find: z.string().optional() }));
    registerClientTool(server, "set_line_spacing", "Set line spacing for the draft immediately.", z.object({ value: z.string() }));
    registerClientTool(server, "set_block_style", "Apply a heading or title style immediately. Pass find to target a passage. For a school-paper title, keep Normal text and center it with set_alignment; do not use Heading 1.", z.object({ style: z.enum(["normal", "title", "subtitle", "h1", "h2", "h3"]), find: z.string().optional() }));
    registerClientTool(server, "set_paragraph_indent", "Set first-line or hanging indent. Use first-line for essay body and hanging for bibliography. Call once with kind first-line and no find to indent every body paragraph. Call once with kind hanging and no find to hanging-indent the bibliography. Pass find plus following true to apply from that paragraph through the next heading. Never insert tab characters. indent_blocks is left margin only.", z.object({ kind: z.enum(["none", "first-line", "hanging"]), find: z.string().optional(), following: z.boolean().optional(), scope: z.enum(["body", "bibliography"]).optional() }));
    registerClientTool(
      server,
      "apply_paper_style",
      "Set document-level school-paper chrome: Times New Roman 12pt, double spacing, last-name header, page numbers in the header. Call this before writing an MLA or APA paper so new text inherits the style. Pass lastName if known.",
      z.object({
        preset: z.enum(["mla", "apa", "letter"]),
        lastName: z.string().optional(),
        header: z.string().optional(),
      }),
    );
    registerClientTool(
      server,
      "insert_table",
      "Insert a table immediately. Pass cells as a grid of strings so the table is filled in the same call. Empty cells cannot be filled later with replace_text. Insert the table before insert_page_break; never put a break inside the table.",
      z.object({
        rows: z.number().int().min(1).max(12).optional(),
        cols: z.number().int().min(1).max(8).optional(),
        find: z.string().optional(),
        cells: z.array(z.array(z.string())).optional(),
      }),
    );
    registerClientTool(server, "insert_page_break", "Insert a manual page break immediately. Call this after insert_table, not inside a table.", z.object({ find: z.string().optional() }));
    registerClientTool(server, "indent_blocks", "Indent or outdent the current blocks immediately.", z.object({ direction: z.enum(["in", "out"]).optional(), find: z.string().optional() }));
    registerClientTool(server, "insert_horizontal_line", "Insert a horizontal rule immediately.", z.object({}));
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
  if (name === "search_citations") {
    const works = Array.isArray(data?.works) ? data.works : Array.isArray(raw) ? raw : null;
    if (works) meta.citations = works.filter(isCitation);
  }
  if (name === "web_fetch" && data?.citation && isCitation(data.citation)) {
    meta.citations = [data.citation];
  }
  if (name === "propose_tasks" && data && Array.isArray(data.tasks)) {
    meta.tasks = data.tasks.filter(isTask);
  }
  if (name === "set_chat_title" && typeof data?.title === "string") {
    meta.chatTitle = data.title;
  }
  if (CLIENT_MCP_TOOLS.has(name)) {
    const rest = { ...args };
    delete rest.ok;
    delete rest.dispatched;
    delete rest.name;
    meta.args = rest;
    meta.clientTool = { id: crypto.randomUUID(), name: name as AgentToolName, args: rest, hidden: true };
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
    async (args) => jsonResult({ ok: true, dispatched: true, name, ...(args as Record<string, unknown>) }),
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
