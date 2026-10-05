import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { z } from "zod";
import {
  EditError,
  LockedContentError,
  applyBlockStyle,
  applyFormat,
  applyStringEdits,
  blockLines,
  docPlainText,
  findText,
  insertMarkdown,
  lockedBetween,
  markdownLines,
  numberLines,
  searchLines,
  textblockRanges,
  wordCount,
  writeDocument,
  type FormatSpec,
} from "@/lib/doc/editing";
import { serializeDoc } from "@/lib/doc/markdown";
import { changedRanges, isUserSuggestion } from "@/lib/doc/review";
import { FONT_FAMILIES, PAPER_SIZES, type DocumentSettings } from "@/lib/doc/settings";
import { documentHub, type LiveDocument } from "@/lib/server/hub";
import { lintWriting } from "@/lib/writing/lint";
import { detectAiTropes } from "@/lib/writing/tropes";

/**
 * The tools Claude uses to work in Inline documents. They are transport
 * independent: lib/agent/mcp.ts exposes them to the in-app Claude Code
 * session (in-process MCP server) and to external MCP clients over HTTP.
 *
 * The document model presented to Claude is deliberately the one it already
 * knows best: a Markdown file with line numbers, edited with exact-string
 * replacements (the same contract as Claude Code's Read and Edit tools).
 */

export type ToolContext = {
  /** Chat id for in-app sessions, "external" for MCP clients. */
  author: string;
  /** The document a chat is attached to; tools default to it. */
  documentId?: string;
  /** Ask mode: write tools are refused. */
  readOnly?: boolean;
  /** Called once before the first write of a turn (used to checkpoint a version). */
  beforeWrite?: (doc: LiveDocument) => Promise<void>;
  /** Notified after a tool changes a document. */
  onChange?: (change: { documentId: string; title: string; tool: string; added: number; removed: number }) => void;
};

export type ToolResult = { text: string; isError?: boolean };

type Shape = z.ZodRawShape;

export type ToolDefinition<S extends Shape = Shape> = {
  name: string;
  title: string;
  description: string;
  shape: S;
  write: boolean;
  destructive?: boolean;
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<ToolResult>;
};

function defineTool<S extends Shape>(tool: ToolDefinition<S>): ToolDefinition<S> {
  return tool;
}

const ok = (text: string): ToolResult => ({ text });
const fail = (text: string): ToolResult => ({ text, isError: true });

const documentId = z
  .string()
  .optional()
  .describe("Document id. Defaults to the document the user is working in.");

async function resolveDocument(ctx: ToolContext, id?: string): Promise<LiveDocument> {
  const hub = documentHub();
  const target = id || ctx.documentId;
  if (target) {
    const doc = await hub.get(target);
    if (!doc || doc.meta.trashedAt) throw new EditError(`Document "${target}" was not found. Use list_documents to see available documents.`);
    return doc;
  }
  const active = await hub.active();
  if (!active) throw new EditError("No document is open. Use list_documents to find one or create_document to start one.");
  return active;
}

function estimatePages(doc: LiveDocument) {
  const words = wordCount(docPlainText(doc.doc));
  return Math.max(1, Math.ceil(words / 450));
}

function header(doc: LiveDocument, lines: number) {
  const words = wordCount(docPlainText(doc.doc));
  const pending = doc.hunks.length ? ` · ${doc.hunks.length} change${doc.hunks.length === 1 ? "" : "s"} awaiting the user's review` : "";
  return `Document "${doc.meta.title}" (id ${doc.id}) · ${words.toLocaleString()} words · ~${estimatePages(doc)} page${estimatePages(doc) === 1 ? "" : "s"} · ${lines} lines${pending}`;
}

/** Numbered lines around the ranges a transform changed, like Claude Code's edit feedback. */
function changedSnippet(before: PMNode, tr: Transform, context = 2) {
  const ranges = changedRanges(before, tr);
  const serialized = serializeDoc(tr.doc);
  const lines = markdownLines(serialized);
  const entries = blockLines(serialized);
  const touched = new Set<number>();
  for (const range of ranges) {
    for (const entry of entries) {
      const start = entry.block.pos;
      const end = start + entry.block.node.nodeSize;
      if (range.toB >= start && range.fromB <= end) {
        for (let line = entry.startLine; line <= entry.endLine; line += 1) touched.add(line);
      }
    }
  }
  if (!touched.size) return "";
  const sorted = [...touched].sort((a, b) => a - b);
  const windows: Array<[number, number]> = [];
  for (const line of sorted) {
    const from = Math.max(1, line - context);
    const to = Math.min(lines.length, line + context);
    const last = windows[windows.length - 1];
    if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else windows.push([from, to]);
  }
  const shown = windows.slice(0, 6).map(([from, to]) => numberLines(lines, from, to - from + 1));
  return shown.join("\n     …\n") + (windows.length > 6 ? `\n     … (${windows.length - 6} more changed regions)` : "");
}

function countWords(before: PMNode, tr: Transform) {
  let added = 0;
  let removed = 0;
  for (const range of changedRanges(before, tr)) {
    added += wordCount(tr.doc.textBetween(range.fromB, range.toB, " "));
    removed += wordCount(before.textBetween(range.fromA, range.toA, " "));
  }
  return { added, removed };
}

/** Apply an agent transform to the live document and describe the result. */
async function commitEdit(ctx: ToolContext, doc: LiveDocument, tool: string, build: (current: PMNode) => Transform, describe: string): Promise<ToolResult> {
  if (ctx.readOnly) return fail("You are in Ask mode, so documents can't be changed. Describe the change instead, or ask the user to switch to Agent mode.");
  await ctx.beforeWrite?.(doc);
  // Build and apply synchronously so no other change can interleave.
  const before = doc.doc;
  const tr = build(before);
  if (!tr.docChanged) return fail("The edit produced no change to the document.");
  doc.setActivity({ chatId: ctx.author, status: "editing", label: describe, range: rangeOf(tr) });
  doc.applyTransform(tr, { kind: "agent", author: ctx.author, tool });
  const { added, removed } = countWords(before, tr);
  ctx.onChange?.({ documentId: doc.id, title: doc.meta.title, tool, added, removed });
  const snippet = changedSnippet(before, tr);
  return ok(
    `${describe} in "${doc.meta.title}". The change is live in the editor and marked for the user's review.${snippet ? `\nEdited lines:\n${snippet}` : ""}`,
  );
}

function rangeOf(tr: Transform) {
  let from = Infinity;
  let to = -Infinity;
  for (const map of tr.mapping.maps) {
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      from = Math.min(from, newStart);
      to = Math.max(to, newEnd);
    });
  }
  if (!Number.isFinite(from)) return undefined;
  const size = tr.doc.content.size;
  return { from: Math.max(0, Math.min(from, size)), to: Math.max(0, Math.min(to, size)) };
}

function wrapErrors(handler: (...args: never[]) => Promise<ToolResult>) {
  return async (...args: never[]): Promise<ToolResult> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof EditError || error instanceof LockedContentError) return fail(error.message);
      const message = error instanceof Error ? error.message : String(error);
      return fail(`Tool failed: ${message}`);
    }
  };
}

const formatShape = {
  bold: z.boolean().optional(),
  italic: z.boolean().optional(),
  underline: z.boolean().optional(),
  strikethrough: z.boolean().optional(),
  code: z.boolean().optional().describe("Inline code (monospace)."),
  superscript: z.boolean().optional(),
  subscript: z.boolean().optional(),
  highlight: z.union([z.string(), z.boolean()]).optional().describe("true for yellow, a CSS color for another color, false to remove."),
  color: z.string().nullable().optional().describe("Text color as a CSS color (e.g. \"#c5221f\"), or null to reset."),
  font_family: z.string().nullable().optional().describe(`Font family, or null to reset. Available: ${FONT_FAMILIES.map((font) => font.label).join(", ")}.`),
  font_size: z.number().min(4).max(144).nullable().optional().describe("Font size in points, or null to reset."),
  link: z.string().nullable().optional().describe("Make the text a link to this URL, or null to remove the link."),
};

function toFormatSpec(args: Record<string, unknown>): FormatSpec {
  const spec: FormatSpec = {};
  if (typeof args.bold === "boolean") spec.bold = args.bold;
  if (typeof args.italic === "boolean") spec.italic = args.italic;
  if (typeof args.underline === "boolean") spec.underline = args.underline;
  if (typeof args.strikethrough === "boolean") spec.strike = args.strikethrough;
  if (typeof args.code === "boolean") spec.code = args.code;
  if (typeof args.superscript === "boolean") spec.superscript = args.superscript;
  if (typeof args.subscript === "boolean") spec.subscript = args.subscript;
  if (args.highlight !== undefined) spec.highlight = args.highlight as string | boolean;
  if (args.color !== undefined) spec.color = args.color as string | null;
  if (args.font_family !== undefined) {
    const value = args.font_family as string | null;
    spec.font_family = value ? FONT_FAMILIES.find((font) => font.label.toLowerCase() === value.toLowerCase())?.value ?? value : null;
  }
  if (args.font_size !== undefined) spec.font_size = args.font_size as number | null;
  if (args.link !== undefined) spec.link = args.link as string | null;
  return spec;
}

function lineRange(from?: number, to?: number) {
  if (from == null && to == null) return undefined;
  const start = Math.max(1, from ?? 1);
  return { from: start, to: Math.max(start, to ?? from ?? start) };
}

// ---------------------------------------------------------------------------

export const TOOLS = [
  defineTool({
    name: "read_document",
    title: "Read document",
    description:
      "Read a document as Markdown with line numbers (cat -n format), like the Read tool. Read before editing so edit_document's old_string matches exactly.\n\n" +
      "Markdown conventions in Inline documents: one paragraph per line, blank line between blocks; `# Text {.title}` is the document title style and `Text {.subtitle}` the subtitle; `{align=center|right|justify}` and `{indent=N}` set paragraph alignment and indent; ==highlight==, <u>underline</u>, <sup>x</sup>, <sub>x</sub>; `&nbsp;` is an intentionally empty paragraph; `\\pagebreak` is a page break; images are `![alt](url){width=50%}`. Colors, fonts, comments and locked passages are not shown but are preserved when you edit around them.",
    shape: {
      document_id: documentId,
      offset: z.number().int().min(1).optional().describe("Line number to start reading from."),
      limit: z.number().int().min(1).max(5000).optional().describe("Number of lines to read (default 2000)."),
    },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const lines = markdownLines(serializeDoc(doc.doc));
      const offset = args.offset ?? 1;
      const limit = args.limit ?? 2000;
      doc.setActivity({ chatId: ctx.author, status: "reading", label: "Reading" });
      const body = numberLines(lines, offset, limit);
      const end = Math.min(lines.length, offset + limit - 1);
      const more = end < lines.length ? `\n(Showing lines ${offset}-${end} of ${lines.length}. Pass offset to read further.)` : "";
      const empty = lines.length === 1 && !lines[0] ? "\n(The document is empty.)" : "";
      return ok(`${header(doc, lines.length)}\n${body}${more}${empty}`);
    },
  }),

  defineTool({
    name: "edit_document",
    title: "Edit document",
    description:
      "Replace exact text in a document, like the Edit tool: old_string must match the Markdown from read_document exactly (excluding the line-number prefix) and be unique unless replace_all is true. new_string may contain any Markdown (headings, lists, tables, emphasis, new paragraphs). Formatting that Markdown can't show (colors, fonts, comments) is kept on unchanged words. Changes go live immediately and are shown to the user as reviewable suggestions. Prefer several small, precise edits over rewriting large passages.",
    shape: {
      document_id: documentId,
      old_string: z.string().describe("The exact Markdown to replace."),
      new_string: z.string().describe("The replacement Markdown (empty string deletes)."),
      replace_all: z.boolean().optional().describe("Replace every occurrence of old_string (default false)."),
    },
    write: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      return commitEdit(ctx, doc, "edit_document", (current) => applyStringEdits(current, [args]), args.replace_all ? "Replaced all occurrences" : "Edited");
    },
  }),

  defineTool({
    name: "multi_edit_document",
    title: "Multi-edit document",
    description:
      "Make several exact-string edits to one document in a single atomic operation, like MultiEdit. Edits apply in order, each to the result of the previous one; if any edit fails, none are applied. Use this for multiple changes to the same document.",
    shape: {
      document_id: documentId,
      edits: z
        .array(
          z.object({
            old_string: z.string(),
            new_string: z.string(),
            replace_all: z.boolean().optional(),
          }),
        )
        .min(1)
        .describe("Edits to apply in sequence."),
    },
    write: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      return commitEdit(ctx, doc, "multi_edit_document", (current) => applyStringEdits(current, args.edits), `Applied ${args.edits.length} edit${args.edits.length === 1 ? "" : "s"}`);
    },
  }),

  defineTool({
    name: "write_document",
    title: "Write document",
    description:
      "Replace the entire content of a document with new Markdown, like the Write tool. Unchanged paragraphs keep their formatting and only real differences become review suggestions. Use for drafting a new document or a full restructure; for targeted changes use edit_document. Read the document first unless it is empty.",
    shape: {
      document_id: documentId,
      content: z.string().describe("The full new document as Markdown."),
    },
    write: true,
    destructive: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      return commitEdit(ctx, doc, "write_document", (current) => writeDocument(current, args.content), "Rewrote the document");
    },
  }),

  defineTool({
    name: "insert_content",
    title: "Insert content",
    description:
      "Insert new Markdown blocks into a document without replacing anything: at the start, at the end, or before/after a given line. Good for appending sections or adding a paragraph between existing ones.",
    shape: {
      document_id: documentId,
      content: z.string().describe("Markdown to insert (one or more blocks)."),
      position: z.enum(["start", "end", "after_line", "before_line"]).describe("Where to insert."),
      line: z.number().int().min(1).optional().describe("Line number for after_line / before_line."),
    },
    write: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      if ((args.position === "after_line" || args.position === "before_line") && !args.line) {
        return fail("line is required when position is after_line or before_line.");
      }
      const position =
        args.position === "start" || args.position === "end"
          ? { at: args.position }
          : args.position === "after_line"
            ? { afterLine: args.line! }
            : { beforeLine: args.line! };
      return commitEdit(ctx, doc, "insert_content", (current) => insertMarkdown(current, args.content, position), "Inserted content");
    },
  }),

  defineTool({
    name: "search_document",
    title: "Search document",
    description: "Find lines in a document's Markdown that contain a string or match a regular expression, like Grep. Returns matching lines with line numbers.",
    shape: {
      document_id: documentId,
      pattern: z.string().describe("Text or regular expression to find."),
      regex: z.boolean().optional().describe("Treat pattern as a JavaScript regular expression."),
      case_sensitive: z.boolean().optional(),
    },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const { hits, total } = searchLines(doc.doc, args.pattern, { regex: args.regex, caseSensitive: args.case_sensitive, limit: 100 });
      if (!hits.length) return ok(`No lines match "${args.pattern}" in "${doc.meta.title}".`);
      const width = 6;
      const body = hits.map((hit) => `${String(hit.line).padStart(width, " ")}\t${hit.text.length > 400 ? `${hit.text.slice(0, 400)}…` : hit.text}`).join("\n");
      return ok(`${total} matching line${total === 1 ? "" : "s"} in "${doc.meta.title}"${total > hits.length ? ` (showing ${hits.length})` : ""}:\n${body}`);
    },
  }),

  defineTool({
    name: "get_outline",
    title: "Get outline",
    description: "Heading structure of a document with line numbers and word counts per section. Use it to orient in long documents before reading specific ranges.",
    shape: { document_id: documentId },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const serialized = serializeDoc(doc.doc);
      const entries = blockLines(serialized);
      const rows: string[] = [];
      let current: { label: string; line: number; words: number } | null = { label: "(start)", line: 1, words: 0 };
      const flush = () => {
        if (current && (current.words || current.label !== "(start)")) rows.push(`${String(current.line).padStart(6, " ")}\t${current.label} — ${current.words} words`);
      };
      for (const entry of entries) {
        const node = entry.block.node;
        const isHeading = node.type.name === "heading" || node.type.name === "title" || node.type.name === "subtitle";
        if (isHeading) {
          flush();
          const level = node.type.name === "heading" ? Number(node.attrs.level) : node.type.name === "title" ? 0 : 1;
          current = { label: `${"  ".repeat(Math.max(0, level - 1))}${node.type.name === "heading" ? "#".repeat(level) : `[${node.type.name}]`} ${node.textContent}`, line: entry.startLine, words: 0 };
        } else if (current) {
          current.words += wordCount(node.textContent);
        }
      }
      flush();
      const total = wordCount(docPlainText(doc.doc));
      return ok(`${header(doc, markdownLines(serialized).length)}\n${rows.length ? rows.join("\n") : "(No headings.)"}\nTotal: ${total} words.`);
    },
  }),

  defineTool({
    name: "format_text",
    title: "Format text",
    description:
      "Apply character formatting (bold, italic, underline, color, highlight, font, size, links…) to text in a document. Target either `text` (exact plain text as it appears to a reader, not Markdown) or a line range from read_document, or both to restrict the search. If `text` appears more than once, pass occurrence (1-based) or all: true. Set a property to false/null to remove it.",
    shape: {
      document_id: documentId,
      text: z.string().optional().describe("Exact plain text to format."),
      occurrence: z.number().int().min(1).optional().describe("Which match of `text` to format (1-based)."),
      all: z.boolean().optional().describe("Format every match of `text`."),
      from_line: z.number().int().min(1).optional(),
      to_line: z.number().int().min(1).optional(),
      ...formatShape,
    },
    write: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const spec = toFormatSpec(args);
      if (!Object.keys(spec).length) return fail("No formatting given. Set at least one property such as bold, color or font_size.");
      const lines = lineRange(args.from_line, args.to_line);
      if (!args.text && !lines) return fail("Pass `text`, a line range (from_line/to_line), or both.");
      return commitEdit(
        ctx,
        doc,
        "format_text",
        (current) => {
          let targets: Array<{ from: number; to: number }>;
          if (args.text) {
            const hits = findText(current, args.text, { lines, caseSensitive: true });
            const found = hits.length ? hits : findText(current, args.text, { lines });
            if (!found.length) throw new EditError(`Text not found${lines ? ` between lines ${lines.from} and ${lines.to}` : ""}: "${args.text}". Match the text as a reader sees it (without Markdown syntax).`);
            if (found.length > 1 && !args.all && !args.occurrence) {
              throw new EditError(`"${args.text}" appears ${found.length} times (lines ${[...new Set(found.map((hit) => hit.line))].slice(0, 8).join(", ")}). Pass occurrence or all: true, or narrow with from_line/to_line.`);
            }
            if (args.occurrence && args.occurrence > found.length) throw new EditError(`Only ${found.length} matches of "${args.text}".`);
            targets = args.all ? found : [found[(args.occurrence ?? 1) - 1]!];
          } else {
            targets = textblockRanges(current, lines!).filter((range) => range.to > range.from);
            if (!targets.length) throw new EditError(`No text between lines ${lines!.from} and ${lines!.to}.`);
          }
          const tr = new Transform(current);
          for (const target of targets) {
            if (lockedBetween(current, target.from, target.to)) throw new LockedContentError();
            applyFormat(tr, target.from, target.to, spec);
          }
          return tr;
        },
        "Formatted text",
      );
    },
  }),

  defineTool({
    name: "set_paragraph_style",
    title: "Set paragraph style",
    description:
      "Change the paragraph style of the blocks on the given lines: type (paragraph, heading with level 1-6, title, subtitle), alignment, indent level, line spacing and space before/after. Lists, tables and quotes are changed with edit_document instead.",
    shape: {
      document_id: documentId,
      from_line: z.number().int().min(1),
      to_line: z.number().int().min(1).optional(),
      type: z.enum(["paragraph", "heading", "title", "subtitle"]).optional(),
      level: z.number().int().min(1).max(6).optional().describe("Heading level when type is heading."),
      align: z.enum(["left", "center", "right", "justify"]).optional(),
      indent: z.number().int().min(0).max(8).optional().describe("Indent level in half-inch steps."),
      line_spacing: z.number().min(0.8).max(4).nullable().optional().describe("Line spacing multiple (e.g. 1.15, 1.5, 2), or null for the document default."),
      space_before: z.number().min(0).max(144).nullable().optional().describe("Points of space before, or null for default."),
      space_after: z.number().min(0).max(144).nullable().optional().describe("Points of space after, or null for default."),
    },
    write: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const lines = lineRange(args.from_line, args.to_line)!;
      return commitEdit(
        ctx,
        doc,
        "set_paragraph_style",
        (current) => {
          const tr = new Transform(current);
          applyBlockStyle(tr, lines, args);
          return tr;
        },
        `Restyled lines ${lines.from}${lines.to !== lines.from ? `-${lines.to}` : ""}`,
      );
    },
  }),

  defineTool({
    name: "get_document_settings",
    title: "Get document settings",
    description: "Page setup (paper size, orientation, margins), default font, size, line and paragraph spacing, header, footer and page numbers of a document.",
    shape: { document_id: documentId },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      return ok(JSON.stringify({ title: doc.meta.title, ...doc.meta.settings }, null, 2));
    },
  }),

  defineTool({
    name: "update_document_settings",
    title: "Update document settings",
    description:
      "Change document-level settings: title, default font and size, line/paragraph spacing, page setup, header and footer text (supports {page}, {pages}, {title}, {date}), and page numbers. Only the fields you pass change.",
    shape: {
      document_id: documentId,
      title: z.string().optional(),
      font_family: z.string().optional().describe(`Default font. Available: ${FONT_FAMILIES.map((font) => font.label).join(", ")}.`),
      font_size: z.number().min(6).max(96).optional().describe("Default size in points."),
      line_spacing: z.number().min(0.8).max(4).optional(),
      paragraph_spacing: z.number().min(0).max(72).optional().describe("Points after each paragraph."),
      paper_size: z.enum(Object.keys(PAPER_SIZES) as ["letter", "a4", "legal"]).optional(),
      orientation: z.enum(["portrait", "landscape"]).optional(),
      margins: z
        .object({ top: z.number().optional(), right: z.number().optional(), bottom: z.number().optional(), left: z.number().optional() })
        .optional()
        .describe("Margins in inches."),
      header: z.string().optional(),
      footer: z.string().optional(),
      header_align: z.enum(["left", "center", "right"]).optional(),
      footer_align: z.enum(["left", "center", "right"]).optional(),
      different_first_page: z.boolean().optional(),
      first_page_header: z.string().optional(),
      first_page_footer: z.string().optional(),
      page_numbers: z
        .object({
          enabled: z.boolean().optional(),
          position: z.enum(["header", "footer"]).optional(),
          align: z.enum(["left", "center", "right"]).optional(),
          skip_first: z.boolean().optional(),
        })
        .optional(),
    },
    write: true,
    async handler(args, ctx) {
      if (ctx.readOnly) return fail("You are in Ask mode, so documents can't be changed.");
      const doc = await resolveDocument(ctx, args.document_id);
      const settings: Record<string, unknown> = {};
      if (args.font_family) settings.fontFamily = FONT_FAMILIES.find((font) => font.label.toLowerCase() === args.font_family!.toLowerCase())?.value ?? args.font_family;
      if (args.font_size !== undefined) settings.fontSize = args.font_size;
      if (args.line_spacing !== undefined) settings.lineSpacing = args.line_spacing;
      if (args.paragraph_spacing !== undefined) settings.paragraphSpacing = args.paragraph_spacing;
      const pageSetup: Record<string, unknown> = {};
      if (args.paper_size) pageSetup.paperSize = args.paper_size;
      if (args.orientation) pageSetup.orientation = args.orientation;
      if (args.margins) pageSetup.margins = args.margins;
      if (Object.keys(pageSetup).length) settings.pageSetup = pageSetup;
      const headerFooter: Record<string, unknown> = {};
      if (args.header !== undefined) headerFooter.header = args.header;
      if (args.footer !== undefined) headerFooter.footer = args.footer;
      if (args.header_align) headerFooter.headerAlign = args.header_align;
      if (args.footer_align) headerFooter.footerAlign = args.footer_align;
      if (args.different_first_page !== undefined) headerFooter.differentFirstPage = args.different_first_page;
      if (args.first_page_header !== undefined) headerFooter.firstHeader = args.first_page_header;
      if (args.first_page_footer !== undefined) headerFooter.firstFooter = args.first_page_footer;
      if (Object.keys(headerFooter).length) settings.headerFooter = headerFooter;
      if (args.page_numbers) {
        const pn = args.page_numbers;
        settings.pageNumbers = {
          ...(pn.enabled !== undefined ? { enabled: pn.enabled } : {}),
          ...(pn.position ? { position: pn.position } : {}),
          ...(pn.align ? { align: pn.align } : {}),
          ...(pn.skip_first !== undefined ? { skipFirst: pn.skip_first } : {}),
        };
      }
      if (!Object.keys(settings).length && args.title === undefined) return fail("No settings given.");
      const meta = doc.updateMeta({ title: args.title, settings: Object.keys(settings).length ? (settings as Partial<DocumentSettings>) : undefined });
      ctx.onChange?.({ documentId: doc.id, title: meta.title, tool: "update_document_settings", added: 0, removed: 0 });
      return ok(`Updated settings of "${meta.title}":\n${JSON.stringify({ title: meta.title, ...meta.settings }, null, 2)}`);
    },
  }),

  defineTool({
    name: "get_editor_context",
    title: "Get editor context",
    description:
      "What the user is looking at right now: the open document, their current selection (text and line numbers), open comments and pending suggestions. Call this when the user refers to \"this\", \"the selection\" or \"here\" without quoting text.",
    shape: { document_id: documentId },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const parts: string[] = [header(doc, markdownLines(serializeDoc(doc.doc)).length)];
      const selection = doc.selection;
      if (selection && selection.to > selection.from) {
        const text = doc.doc.textBetween(selection.from, selection.to, "\n");
        const serialized = serializeDoc(doc.doc);
        const lines = blockLines(serialized).filter((entry) => entry.block.pos + entry.block.node.nodeSize > selection.from && entry.block.pos < selection.to);
        const range = lines.length ? `lines ${lines[0]!.startLine}-${lines[lines.length - 1]!.endLine}` : "";
        parts.push(`Selection (${range}):\n"""\n${text.slice(0, 4000)}${text.length > 4000 ? "\n…" : ""}\n"""`);
      } else if (selection) {
        const serialized = serializeDoc(doc.doc);
        const entry = blockLines(serialized).find((item) => item.block.pos <= selection.from && item.block.pos + item.block.node.nodeSize >= selection.from);
        parts.push(entry ? `Cursor is on line ${entry.startLine}; nothing is selected.` : "Nothing is selected.");
      } else {
        parts.push("The user has no active selection.");
      }
      const open = doc.commentsWithAnchors().filter((comment) => !comment.resolved);
      parts.push(open.length ? `${open.length} open comment${open.length === 1 ? "" : "s"} (use list_comments).` : "No open comments.");
      const userSuggestions = doc.hunks.filter(isUserSuggestion).length;
      const claudeChanges = doc.hunks.length - userSuggestions;
      const pending = [
        claudeChanges ? `${claudeChanges} change${claudeChanges === 1 ? "" : "s"} by Claude` : "",
        userSuggestions ? `${userSuggestions} suggestion${userSuggestions === 1 ? "" : "s"} by the user` : "",
      ].filter(Boolean);
      parts.push(pending.length ? `${pending.join(" and ")} awaiting review (use get_pending_changes).` : "No pending changes.");
      if (doc.editorMode !== "editing") parts.push(`The user's editor is in ${doc.editorMode} mode.`);
      return ok(parts.join("\n"));
    },
  }),

  defineTool({
    name: "get_pending_changes",
    title: "Get pending changes",
    description:
      "List the pending changes in a document that have not yet been kept or undone, with their ids, author, location and before/after text. Changes come from Claude's edits and from the user's own edits in suggesting mode.",
    shape: { document_id: documentId },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      if (!doc.hunks.length) return ok("No pending changes.");
      const serialized = serializeDoc(doc.doc);
      const entries = blockLines(serialized);
      const rows = doc.hunksJSON().map((hunk) => {
        const entry = entries.find((item) => item.block.pos + item.block.node.nodeSize > hunk.from);
        const author = isUserSuggestion(hunk) ? "suggested by the user" : "by Claude";
        return `- ${hunk.id} (line ${entry?.startLine ?? "?"}, ${author}): "${clip(hunk.deletedText)}" → "${clip(hunk.insertedText ?? "")}"`;
      });
      return ok(`${doc.hunks.length} pending change${doc.hunks.length === 1 ? "" : "s"} in "${doc.meta.title}":\n${rows.join("\n")}`);
    },
  }),

  defineTool({
    name: "revert_changes",
    title: "Revert changes",
    description: "Undo suggested changes that are still pending review (for example to retract a mistaken edit of yours). Pass change ids from get_pending_changes, or all: true.",
    shape: {
      document_id: documentId,
      change_ids: z.array(z.string()).optional(),
      all: z.boolean().optional(),
    },
    write: true,
    async handler(args, ctx) {
      if (ctx.readOnly) return fail("You are in Ask mode, so documents can't be changed.");
      const doc = await resolveDocument(ctx, args.document_id);
      if (!args.all && !args.change_ids?.length) return fail("Pass change_ids or all: true.");
      const count = args.all ? doc.hunks.length : doc.hunks.filter((hunk) => args.change_ids!.includes(hunk.id)).length;
      if (!count) return fail("No matching pending changes.");
      doc.review("reject", args.all ? "all" : args.change_ids!);
      return ok(`Reverted ${count} change${count === 1 ? "" : "s"} in "${doc.meta.title}".`);
    },
  }),

  defineTool({
    name: "keep_changes",
    title: "Keep changes",
    description:
      "Keep (accept) pending changes so they become part of the document, for example when the user asks you to accept their suggestions or the edits you made. Never keep the user's suggestions unless they asked. Pass change ids from get_pending_changes, or all: true.",
    shape: {
      document_id: documentId,
      change_ids: z.array(z.string()).optional(),
      all: z.boolean().optional(),
    },
    write: true,
    async handler(args, ctx) {
      if (ctx.readOnly) return fail("You are in Ask mode, so documents can't be changed.");
      const doc = await resolveDocument(ctx, args.document_id);
      if (!args.all && !args.change_ids?.length) return fail("Pass change_ids or all: true.");
      const count = args.all ? doc.hunks.length : doc.hunks.filter((hunk) => args.change_ids!.includes(hunk.id)).length;
      if (!count) return fail("No matching pending changes.");
      doc.review("accept", args.all ? "all" : args.change_ids!);
      return ok(`Kept ${count} change${count === 1 ? "" : "s"} in "${doc.meta.title}".`);
    },
  }),

  defineTool({
    name: "list_comments",
    title: "List comments",
    description: "List comments in a document with their ids, the text they're anchored to, and replies. Use this when the user asks you to address or respond to comments.",
    shape: { document_id: documentId, include_resolved: z.boolean().optional() },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const comments = doc.commentsWithAnchors().filter((comment) => args.include_resolved || !comment.resolved);
      if (!comments.length) return ok(args.include_resolved ? "No comments." : "No open comments.");
      const rows = comments.map((comment) => {
        const anchor = comment.anchor ? `on "${clip(comment.anchor.text, 200)}"` : `(anchor text was deleted; originally "${clip(comment.quote, 120)}")`;
        const replies = comment.replies.map((reply) => `    ↳ ${reply.author === "claude" ? "Claude" : "User"}: ${reply.body}`).join("\n");
        return `- [${comment.id}]${comment.resolved ? " (resolved)" : ""} ${comment.author === "claude" ? "Claude" : "User"} ${anchor}: ${comment.body}${replies ? `\n${replies}` : ""}`;
      });
      return ok(rows.join("\n"));
    },
  }),

  defineTool({
    name: "add_comment",
    title: "Add comment",
    description: "Attach a comment to text in a document (as a reader sees it, not Markdown). Use comments to give feedback the user can act on without changing their text.",
    shape: {
      document_id: documentId,
      text: z.string().describe("Exact text to anchor the comment to."),
      occurrence: z.number().int().min(1).optional(),
      comment: z.string().describe("The comment."),
    },
    write: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const hits = findText(doc.doc, args.text, { caseSensitive: true });
      const found = hits.length ? hits : findText(doc.doc, args.text);
      if (!found.length) return fail(`Text not found: "${args.text}".`);
      if (found.length > 1 && !args.occurrence) return fail(`"${args.text}" appears ${found.length} times. Pass occurrence (1-based) or quote more text.`);
      const target = found[(args.occurrence ?? 1) - 1];
      if (!target) return fail(`Only ${found.length} matches.`);
      const comment = doc.addComment({ from: target.from, to: target.to, body: args.comment, author: "claude" }, { kind: "agent", author: ctx.author });
      return ok(`Added comment ${comment.id} on line ${target.line}.`);
    },
  }),

  defineTool({
    name: "reply_to_comment",
    title: "Reply to comment",
    description: "Reply to a comment, optionally resolving it. When you address a comment by editing the document, reply briefly with what you changed and resolve it.",
    shape: {
      document_id: documentId,
      comment_id: z.string(),
      reply: z.string(),
      resolve: z.boolean().optional(),
    },
    write: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      doc.replyToComment(args.comment_id, args.reply, "claude");
      if (args.resolve) doc.setCommentResolved(args.comment_id, true);
      return ok(`Replied to ${args.comment_id}${args.resolve ? " and resolved it" : ""}.`);
    },
  }),

  defineTool({
    name: "resolve_comment",
    title: "Resolve comment",
    description: "Mark a comment resolved (or reopen it with resolved: false).",
    shape: { document_id: documentId, comment_id: z.string(), resolved: z.boolean().optional() },
    write: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      doc.setCommentResolved(args.comment_id, args.resolved ?? true);
      return ok(`${args.resolved === false ? "Reopened" : "Resolved"} ${args.comment_id}.`);
    },
  }),

  defineTool({
    name: "analyze_writing",
    title: "Analyze writing",
    description:
      "Writing diagnostics for a document or a line range: word, sentence and paragraph counts, reading ease, grade level, vocabulary diversity, long sentences, and common AI-writing tropes (em-dash overuse, clichés like \"delve\", hidden watermark characters).",
    shape: { document_id: documentId, from_line: z.number().int().min(1).optional(), to_line: z.number().int().min(1).optional() },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const lines = lineRange(args.from_line, args.to_line);
      const text = lines
        ? textblockRanges(doc.doc, lines)
            .map((range) => doc.doc.textBetween(range.from, range.to, "\n"))
            .join("\n\n")
        : docPlainText(doc.doc);
      const lint = lintWriting(text, estimatePages(doc));
      const tropes = detectAiTropes(text);
      const stats = [
        `Words: ${lint.words} · Sentences: ${lint.sentences} · Paragraphs: ${lint.paragraphs} · ~${lint.pages} page(s)`,
        `Average sentence: ${lint.avgSentence.toFixed(1)} words · Reading ease: ${lint.readingEase.toFixed(0)} · Grade level: ${Math.max(1, Math.round(lint.gradeLevel))} (${lint.vocabularyLevel})`,
        `Vocabulary diversity: ${(lint.diversity * 100).toFixed(0)}% unique words`,
      ];
      const issues = lint.issues.map((issue) => `- ${issue.title}: ${issue.detail}${issue.find ? ` (e.g. "${clip(issue.find, 160)}")` : ""}`);
      const trope = tropes.map((hit) => `- ${hit.title}${hit.find ? ` — "${clip(hit.find, 80)}"` : ""}${hit.replace !== undefined ? ` → consider "${hit.replace}"` : ""}`);
      return ok(
        [`Writing analysis of "${doc.meta.title}"${lines ? ` (lines ${lines.from}-${lines.to})` : ""}:`, ...stats, issues.length ? `Issues:\n${issues.join("\n")}` : "No structural issues.", trope.length ? `AI-writing tropes:\n${trope.join("\n")}` : "No common AI-writing tropes found."].join("\n"),
      );
    },
  }),

  defineTool({
    name: "list_documents",
    title: "List documents",
    description: "List the user's documents with ids, titles, word counts and last-edited times. The document the user has open is marked.",
    shape: { include_trashed: z.boolean().optional() },
    write: false,
    async handler(args, ctx) {
      const hub = documentHub();
      const metas = await hub.list({ trashed: Boolean(args.include_trashed) });
      if (!metas.length) return ok("No documents yet.");
      const current = ctx.documentId ?? hub.activeDocumentId;
      return ok(
        metas
          .slice(0, 100)
          .map((meta) => `- ${meta.id}${meta.id === current ? " (open)" : ""}: "${meta.title}" · ${meta.wordCount} words · edited ${new Date(meta.updatedAt).toISOString()}`)
          .join("\n"),
      );
    },
  }),

  defineTool({
    name: "create_document",
    title: "Create document",
    description: "Create a new document, optionally with initial Markdown content, and open it in the user's editor.",
    shape: {
      title: z.string(),
      content: z.string().optional().describe("Initial content as Markdown."),
      open: z.boolean().optional().describe("Open it in the editor (default true)."),
    },
    write: true,
    async handler(args, ctx) {
      if (ctx.readOnly) return fail("You are in Ask mode, so documents can't be created.");
      const hub = documentHub();
      const created = await hub.create({ title: args.title, markdown: args.content });
      if (args.open !== false) {
        const current = ctx.documentId ? await hub.get(ctx.documentId) : await hub.active();
        current?.sendCommand({ kind: "open_document", documentId: created.id });
      }
      ctx.onChange?.({ documentId: created.id, title: created.meta.title, tool: "create_document", added: created.meta.wordCount, removed: 0 });
      return ok(`Created "${created.meta.title}" (id ${created.id}). Pass document_id: "${created.id}" to edit it.`);
    },
  }),

  defineTool({
    name: "open_document",
    title: "Open document",
    description: "Show a document in the user's editor.",
    shape: { document_id: z.string() },
    write: false,
    async handler(args, ctx) {
      const hub = documentHub();
      const target = await hub.get(args.document_id);
      if (!target || target.meta.trashedAt) return fail(`Document "${args.document_id}" was not found.`);
      const current = ctx.documentId ? await hub.get(ctx.documentId) : await hub.active();
      const viewers = (current ?? target).sendCommand({ kind: "open_document", documentId: target.id });
      return ok(viewers ? `Opened "${target.meta.title}" in the editor.` : `"${target.meta.title}" is ready; the user has no editor open to show it in.`);
    },
  }),

  defineTool({
    name: "save_version",
    title: "Save version",
    description: "Save a named snapshot of a document to its version history so the user can return to it.",
    shape: { document_id: documentId, label: z.string() },
    write: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const version = await doc.saveVersion(args.label, "claude");
      return ok(`Saved version "${version.label}" (${version.id}).`);
    },
  }),

  defineTool({
    name: "list_versions",
    title: "List versions",
    description: "List saved versions of a document (named versions, checkpoints taken before your edits, and autosaves).",
    shape: { document_id: documentId },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const versions = await doc.versions();
      if (!versions.length) return ok("No saved versions.");
      return ok(versions.slice(0, 50).map((version) => `- ${version.id}: "${version.label}" · ${version.author} · ${new Date(version.createdAt).toISOString()} · ${version.wordCount} words`).join("\n"));
    },
  }),

  defineTool({
    name: "restore_version",
    title: "Restore version",
    description: "Replace a document's content with a saved version. The current content is saved as a version first, so this can be undone.",
    shape: { document_id: documentId, version_id: z.string() },
    write: true,
    destructive: true,
    async handler(args, ctx) {
      if (ctx.readOnly) return fail("You are in Ask mode, so documents can't be changed.");
      const doc = await resolveDocument(ctx, args.document_id);
      const version = await doc.restoreVersion(args.version_id);
      return ok(`Restored "${doc.meta.title}" to "${version.label}" from ${new Date(version.createdAt).toISOString()}.`);
    },
  }),

  defineTool({
    name: "export_document",
    title: "Export document",
    description:
      "Export a document as Word (.docx), PDF, Markdown, HTML or plain text. The file is downloaded in the user's browser. docx/md/html/txt are also available at a returned URL; PDF is drawn from the editor's page layout, so the document must be open in Inline.",
    shape: { document_id: documentId, format: z.enum(["docx", "pdf", "md", "html", "txt"]) },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      if (args.format === "pdf") {
        const viewers = doc.sendCommand({ kind: "export_pdf" });
        return viewers
          ? ok(`Started the download of "${doc.meta.title}.pdf" in the user's editor.`)
          : fail("PDF export needs the document open in the Inline editor. Ask the user to open it, or export docx/html instead.");
      }
      const url = `/api/documents/${doc.id}/export?format=${args.format}`;
      const filename = `${doc.meta.title.replace(/[\\/:*?"<>|]+/g, "-")}.${args.format}`;
      const viewers = doc.sendCommand({ kind: "download", url, filename });
      return ok(`${viewers ? `Started the download of "${filename}" in the user's browser.` : "No editor is open to download into."} The file is available at ${url} on the Inline server.`);
    },
  }),
];

function clip(text: string, max = 160) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

export const READ_ONLY_TOOL_NAMES = TOOLS.filter((tool) => !tool.write).map((tool) => tool.name);
export const WRITE_TOOL_NAMES = TOOLS.filter((tool) => tool.write).map((tool) => tool.name);

export async function runTool(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = TOOLS.find((item) => item.name === name);
  if (!tool) return fail(`Unknown tool ${name}.`);
  const parsed = z.object(tool.shape).safeParse(args);
  if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`);
  const run = wrapErrors(tool.handler as unknown as (...args: never[]) => Promise<ToolResult>);
  return run(...([parsed.data, ctx] as never[]));
}
