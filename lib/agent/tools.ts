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
  docWordCount,
  findText,
  insertMarkdown,
  lockedBetween,
  markdownLines,
  numberLines,
  searchLines,
  textblockLines,
  textblockRanges,
  wordCount,
  writeDocument,
  type FormatSpec,
} from "@/lib/doc/editing";
import { markdownToDoc, serializeDoc } from "@/lib/doc/markdown";
import { changedRanges, isUserSuggestion } from "@/lib/doc/review";
import { FONT_FAMILIES, PAPER_SIZES, type DocumentSettings } from "@/lib/doc/settings";
import { documentHub, type LiveDocument } from "@/lib/server/hub";
import { lintWriting } from "@/lib/writing/lint";
import { readFile } from "node:fs/promises";
import { attachmentText } from "@/lib/agent/attachments";
import { findUpload, readDictionary, updateDictionary } from "@/lib/server/store";
import { findMisspellings, speller, type Misspelling } from "@/lib/server/spellcheck";
import { normalizeWord } from "@/lib/doc/words";
import { detectAiTropes } from "@/lib/writing/tropes";
import { describePageStarts, pageCount, pageCountNow } from "@/lib/agent/pages";
import { FOLDER_COLORS } from "@/lib/doc/folders";
import { createFolder, deleteFolder, FolderError, folderPathName, updateFolder } from "@/lib/server/folders";
import { formatFolderTree, formatLibrary, library, MAX_EXCERPT_WORDS, moveDocuments, resolveFolder } from "@/lib/server/library";

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
  /** The chat message being written, so the changes it makes can be reviewed together. */
  turn?: string;
  /** Ask mode: write tools are refused. */
  readOnly?: boolean;
  /** Called once before the first write of a turn (used to checkpoint a version). */
  beforeWrite?: (doc: LiveDocument) => Promise<void>;
  /** Files attached to the chat's messages so far (in-app chats only). */
  attachments?: () => Array<{ id: string; name: string; kind: "image" | "text" | "pdf" }>;
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

function header(doc: LiveDocument, lines: number) {
  const words = docWordCount(doc.doc);
  const pages = pageCountNow(doc);
  const pending = doc.hunks.length ? ` · ${doc.hunks.length} change${doc.hunks.length === 1 ? "" : "s"} awaiting the user's review` : "";
  return `Document "${doc.meta.title}" (id ${doc.id}) · ${words.toLocaleString()} words · ${pages.measured ? "" : "~"}${pages.pages} page${pages.pages === 1 ? "" : "s"} · ${lines} lines${pending}`;
}

/** Words, characters, sentences and paragraphs of plain text, counted the way the editor counts. */
function textCounts(plain: string, words: number) {
  const lint = lintWriting(plain);
  const characters = plain.replace(/\n{2,}/g, "\n").length;
  return { words, characters, charactersNoSpaces: plain.replace(/\s/g, "").length, sentences: lint.sentences, paragraphs: lint.paragraphs };
}

function inches(value: number) {
  return `${Number(value.toFixed(2))}"`;
}

/**
 * A whole document as read_document returns it, or null when it is too long to
 * hand over unasked. The in-app chat sends this with a message so Claude can
 * start editing without first spending a round trip on read_document.
 */
export function documentListing(doc: LiveDocument, maxLines = 400, maxChars = 40_000) {
  const lines = markdownLines(serializeDoc(doc.doc));
  if (lines.length > maxLines) return null;
  const body = numberLines(lines, 1, lines.length);
  if (body.length > maxChars) return null;
  return `${header(doc, lines.length)}\n${body}`;
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
  doc.applyTransform(tr, { kind: "agent", author: ctx.author, tool, turn: ctx.turn });
  // After the transform: the range is in the new document, so it must carry the new version
  // (the editor only draws a range recorded at the version it's showing).
  showActivity(ctx, doc, { chatId: ctx.author, status: "editing", label: describe, range: rangeOf(tr) });
  const { added, removed } = countWords(before, tr);
  ctx.onChange?.({ documentId: doc.id, title: doc.meta.title, tool, added, removed });
  const snippet = changedSnippet(before, tr);
  return ok(
    `${describe} in "${doc.meta.title}". The change is live in the editor and marked for the user's review.${snippet ? `\nEdited lines:\n${snippet}` : ""}`,
  );
}

const fading = new WeakMap<LiveDocument, ReturnType<typeof setTimeout>>();

/**
 * Show what the agent is doing in the editor. In-app turns clear it when the run
 * ends; external MCP clients have no turn, so their activity fades on its own.
 */
function showActivity(ctx: ToolContext, doc: LiveDocument, activity: Parameters<LiveDocument["setActivity"]>[0]) {
  doc.setActivity(activity);
  if (ctx.author !== "external") return;
  clearTimeout(fading.get(doc));
  const timer = setTimeout(() => {
    if (doc.activity?.chatId === "external") doc.setActivity(null);
  }, EXTERNAL_ACTIVITY_MS);
  timer.unref?.();
  fading.set(doc, timer);
}

const EXTERNAL_ACTIVITY_MS = 4000;

function rangeOf(tr: Transform) {
  let from = Infinity;
  let to = -Infinity;
  // Each step's map is in that step's own coordinates; carry it through the later steps.
  tr.mapping.maps.forEach((map, index) => {
    const later = tr.mapping.slice(index + 1);
    map.forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      from = Math.min(from, later.map(newStart, -1));
      to = Math.max(to, later.map(newEnd, 1));
    });
  });
  if (!Number.isFinite(from)) return undefined;
  const size = tr.doc.content.size;
  from = Math.max(0, Math.min(from, size));
  to = Math.max(from, Math.min(to, size));
  // Whole words, like the review highlight: "Tuesday" → "Thursday" keeps its "T", but the change is the word.
  const $from = tr.doc.resolve(from);
  if ($from.parent.isTextblock) from -= WORD_END.exec($from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc"))?.[0].length ?? 0;
  const $to = tr.doc.resolve(to);
  if ($to.parent.isTextblock) to += WORD_START.exec($to.parent.textBetween($to.parentOffset, $to.parent.content.size, undefined, "\ufffc"))?.[0].length ?? 0;
  return { from, to };
}

const WORD_END = /[\p{L}\p{N}_'’]+$/u;
const WORD_START = /^[\p{L}\p{N}_'’]+/u;

function wrapErrors(handler: (...args: never[]) => Promise<ToolResult>) {
  return async (...args: never[]): Promise<ToolResult> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof EditError || error instanceof LockedContentError || error instanceof FolderError) return fail(error.message);
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
      showActivity(ctx, doc, { chatId: ctx.author, status: "reading", label: "Reading" });
      const body = numberLines(lines, offset, limit);
      const end = Math.min(lines.length, offset + limit - 1);
      const more = end < lines.length ? `\n(Showing lines ${offset}-${end} of ${lines.length}. Pass offset to read further.)` : "";
      const first = doc.doc.firstChild;
      const empty = doc.doc.childCount === 1 && first?.isTextblock && first.content.size === 0 ? "\n(The document is empty.)" : "";
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
          current.words += wordCount(node.textBetween(0, node.content.size, " ", " "));
        }
      }
      flush();
      const total = docWordCount(doc.doc);
      return ok(`${header(doc, markdownLines(serialized).length)}\n${rows.length ? rows.join("\n") : "(No headings.)"}\nTotal: ${total} words.`);
    },
  }),

  defineTool({
    name: "count_words",
    title: "Count words",
    description:
      "Count words exactly as Inline's word count does, in any text you choose: a draft you are about to write (pass text; Markdown is fine, its syntax isn't counted), a line range of a document, or a whole document. Also returns characters, sentences and paragraphs, and with target_words how far off the target it is.\n\n" +
      "Use it whenever the user asks for a length in words (\"exactly 500 words\", \"under 200 words\", \"cut this in half\"): count your draft before you insert it, then count the passage in the document after editing and adjust until it matches. Don't count words in your head.",
    shape: {
      text: z.string().max(1_000_000).optional().describe("Text or Markdown to count. Leave it out to count the document or a line range of it."),
      document_id: documentId,
      from_line: z.number().int().min(1).optional().describe("First line to count (from read_document). Leave out from_line and to_line to count the whole document."),
      to_line: z.number().int().min(1).optional().describe("Last line to count (inclusive)."),
      target_words: z.number().int().min(1).optional().describe("The length the user asked for, to report how far off it is."),
    },
    write: false,
    async handler(args, ctx) {
      let scope: string;
      let plain: string;
      let words: number;
      if (args.text !== undefined) {
        if (args.from_line !== undefined || args.to_line !== undefined) return fail("Pass either text or a line range, not both.");
        scope = "The text";
        try {
          const parsed = markdownToDoc(args.text);
          plain = docPlainText(parsed);
          words = docWordCount(parsed);
        } catch {
          plain = args.text;
          words = wordCount(args.text);
        }
      } else {
        const doc = await resolveDocument(ctx, args.document_id);
        const lines = lineRange(args.from_line, args.to_line);
        if (lines) {
          const ranges = textblockRanges(doc.doc, lines);
          if (!ranges.length) return fail(`Lines ${lines.from}-${lines.to} hold no text. ${header(doc, markdownLines(serializeDoc(doc.doc)).length)}`);
          plain = ranges.map((range) => doc.doc.textBetween(range.from, range.to, "\n", (node) => (node.type.name === "hard_break" ? "\n" : ""))).join("\n\n");
          words = wordCount(plain);
          scope = `Lines ${lines.from}-${lines.to} of "${doc.meta.title}"`;
        } else {
          plain = docPlainText(doc.doc);
          words = docWordCount(doc.doc);
          scope = `"${doc.meta.title}"`;
        }
      }
      const counts = textCounts(plain, words);
      const target = args.target_words;
      const off = target === undefined ? "" : words === target ? ` (exactly the ${target} asked for)` : ` (${Math.abs(words - target).toLocaleString()} ${words < target ? "short of" : "over"} the ${target.toLocaleString()} asked for)`;
      return ok(
        [
          `${scope}: ${counts.words.toLocaleString()} word${counts.words === 1 ? "" : "s"}${off}.`,
          `Characters: ${counts.characters.toLocaleString()} (${counts.charactersNoSpaces.toLocaleString()} without spaces) · Sentences: ${counts.sentences.toLocaleString()} · Paragraphs: ${counts.paragraphs.toLocaleString()}`,
        ].join("\n"),
      );
    },
  }),

  defineTool({
    name: "get_page_count",
    title: "Get page count",
    description:
      "How many pages a document fills in the user's editor with its current page size, margins, fonts, spacing and images; where each page starts (line numbers); and how full the last page is. When no editor has the document open, the count is an estimate from the word count.\n\n" +
      "Use it whenever the user asks for a length in pages (\"write 5 pages\", \"keep it to one page\", \"cut a page\"): check before writing to plan how much to add, then check again after each round of edits and keep adjusting until the page count is right. Don't guess pages from word counts.\n\n" +
      "Counts are for the document once your pending changes are kept: deleted text still showing struck through for review is not counted. Fit the length by changing the text. Don't change margins, page size, font, font size or spacing to make it fit unless the user asks for that.",
    shape: { document_id: documentId },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const count = await pageCount(doc);
      const settings = doc.meta.settings;
      const margins = settings.pageSetup.margins;
      const sameMargins = margins.top === margins.bottom && margins.left === margins.right && margins.top === margins.left;
      const setup = `${PAPER_SIZES[settings.pageSetup.paperSize].label.replace(/\s*\(.*\)$/, "")} ${settings.pageSetup.orientation}, ${sameMargins ? `${inches(margins.top)} margins` : `margins ${inches(margins.top)} top, ${inches(margins.bottom)} bottom, ${inches(margins.left)} left, ${inches(margins.right)} right`}, ${settings.fontFamily.split(",")[0]!.replace(/["']/g, "").trim()} ${settings.fontSize}pt, line spacing ${settings.lineSpacing}`;
      const words = docWordCount(doc.doc);
      const plural = count.pages === 1 ? "" : "s";
      const lines: string[] = [];
      if (count.measured) {
        const pending = doc.hunks.some((hunk) => hunk.deleted.size > 0);
        lines.push(`"${doc.meta.title}" (id ${doc.id}) fills ${count.pages} page${plural}${pending ? " once the pending changes are kept" : ""}, as laid out in the user's editor (${setup}).`);
        if (count.showing) lines.push(`The editor shows ${count.showing} pages until then, because deleted text awaiting review stays on the page struck through. That is not part of the length; don't cut more to make up for it.`);
        lines.push(...describePageStarts(doc, count.starts ?? []));
        const fill = Math.round((count.lastPageFill ?? 0) * 100);
        const room = Math.round((1 - (count.lastPageFill ?? 0)) * count.wordsPerPage);
        lines.push(`The last page is about ${fill}% full${room >= 10 ? ` (roughly ${room.toLocaleString()} more words would fill it)` : ""}.`);
      } else {
        lines.push(`"${doc.meta.title}" (id ${doc.id}) fills about ${count.pages} page${plural} (${setup}). No editor has measured the current text, so this is estimated from the word count.`);
      }
      lines.push(`${words.toLocaleString()} words; about ${count.wordsPerPage.toLocaleString()} words fit on a full page of paragraphs with this formatting. Headings, lists, tables, images and page breaks change that.`);
      return ok(lines.join("\n"));
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
      "Change the paragraph style of the blocks on the given lines: type (paragraph, heading with level 1-6, title, subtitle), alignment, indent level, first-line or hanging indent, line spacing and space before/after. Lists, tables and quotes are changed with edit_document instead.",
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
      text_indent: z.number().min(-3).max(3).nullable().optional().describe("First-line indent in inches (0.5 for essays); negative for a hanging indent (-0.5 for works cited); null for none."),
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
      if (args.font_family) {
        const known = FONT_FAMILIES.find((font) => font.label.toLowerCase() === args.font_family!.toLowerCase().replace(/["']/g, "").trim());
        // Any other installed font works too; keep only a plain family name and add a fallback.
        const name = args.font_family.replace(/[^\p{L}\p{N} -]/gu, "").trim();
        if (!known && !name) return fail(`"${args.font_family}" isn't a font name.`);
        settings.fontFamily = known?.value ?? `"${name}", sans-serif`;
      }
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
        const lines = textblockLines(serializeDoc(doc.doc)).filter((entry) => entry.pos + entry.node.nodeSize > selection.from && entry.pos < selection.to);
        const range = lines.length ? `lines ${lines[0]!.startLine}-${lines[lines.length - 1]!.endLine}` : "";
        parts.push(`Selection (${range}):\n"""\n${text.slice(0, 4000)}${text.length > 4000 ? "\n…" : ""}\n"""`);
      } else if (selection) {
        const entry = textblockLines(serializeDoc(doc.doc)).find((item) => item.pos <= selection.from && item.pos + item.node.nodeSize >= selection.from);
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
      const entries = textblockLines(serializeDoc(doc.doc));
      const rows = doc.hunksJSON().map((hunk) => {
        const entry = entries.find((item) => item.pos + item.node.nodeSize > hunk.from);
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
    name: "delete_comment",
    title: "Delete comment",
    description: "Delete a comment and its replies. Prefer resolve_comment when a comment has been addressed; delete only when the user asks or the comment is yours and no longer relevant.",
    shape: { document_id: documentId, comment_id: z.string() },
    write: true,
    destructive: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      if (!doc.comments.some((comment) => comment.id === args.comment_id)) return fail(`No comment with id ${args.comment_id}. Use list_comments to see the ids.`);
      doc.deleteComment(args.comment_id);
      return ok(`Deleted comment ${args.comment_id}.`);
    },
  }),

  defineTool({
    name: "lock_text",
    title: "Lock or unlock text",
    description:
      "Lock text so it can't be changed by AI edits (yours included), or unlock it. Use only when the user asks to protect or release a passage. Target exact text as a reader sees it; pass occurrence when it appears more than once, or all: true.",
    shape: {
      document_id: documentId,
      text: z.string().min(1).describe("Exact text to lock or unlock."),
      occurrence: z.number().int().min(1).optional(),
      all: z.boolean().optional(),
      locked: z.boolean().optional().describe("false to unlock (default true)."),
    },
    write: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const found = findText(doc.doc, args.text, { caseSensitive: true });
      const hits = found.length ? found : findText(doc.doc, args.text);
      if (!hits.length) return fail(`Text not found: "${args.text}".`);
      if (hits.length > 1 && !args.occurrence && !args.all) return fail(`"${args.text}" appears ${hits.length} times. Pass occurrence (1-based), all: true, or quote more text.`);
      const targets = args.all ? hits : [hits[(args.occurrence ?? 1) - 1]];
      if (!targets[0]) return fail(`Only ${hits.length} matches.`);
      const locked = args.locked !== false;
      // Apply from the end so earlier positions stay valid.
      for (const target of [...targets].sort((a, b) => b!.from - a!.from)) doc.setLocked(target!.from, target!.to, locked);
      return ok(`${locked ? "Locked" : "Unlocked"} ${targets.length === 1 ? `"${clip(args.text, 80)}"` : `${targets.length} passages`}.`);
    },
  }),

  defineTool({
    name: "list_locked_text",
    title: "List locked text",
    description: "List the passages the user has locked from AI edits. Edits that touch them fail, so plan around them.",
    shape: { document_id: documentId },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const ranges = doc.lockedRanges();
      if (!ranges.length) return ok("Nothing is locked.");
      const lines = textblockLines(serializeDoc(doc.doc));
      return ok(
        ranges
          .map((range) => {
            const line = lines.find((entry) => entry.pos + entry.node.nodeSize > range.from)?.startLine;
            return `- line ${line ?? "?"}: "${clip(range.text, 200)}"`;
          })
          .join("\n"),
      );
    },
  }),

  defineTool({
    name: "insert_image",
    title: "Insert image",
    description:
      "Insert an image as its own block: an image the user attached in this chat (attachment_id), an Inline upload URL (/api/uploads/...), or a web image URL (https://...). Place it at the start, end, or before/after a line.",
    shape: {
      document_id: documentId,
      attachment_id: z.string().optional().describe("Id of an image the user attached to a chat message."),
      url: z.string().optional().describe("Image URL, when not using attachment_id."),
      alt: z.string().optional().describe("Alternative text describing the image."),
      width: z.number().int().min(16).max(2000).optional().describe("Width in pixels."),
      align: z.enum(["left", "center", "right"]).optional(),
      position: z.enum(["start", "end", "after_line", "before_line"]),
      line: z.number().int().min(1).optional(),
    },
    write: true,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      let src = args.url?.trim() ?? "";
      if (args.attachment_id) {
        const upload = await findUpload(args.attachment_id).catch(() => null);
        if (!upload) return fail(`No attachment with id ${args.attachment_id}.`);
        if (!/^(png|jpg|gif|webp|svg)$/.test(upload.extension)) return fail("That attachment isn't an image.");
        src = `/api/uploads/${args.attachment_id}.${upload.extension}`;
      }
      if (!src) return fail("Pass attachment_id or url.");
      if (!/^(https?:\/\/|\/api\/uploads\/)/i.test(src)) return fail("The image URL must start with https:// or /api/uploads/.");
      if ((args.position === "after_line" || args.position === "before_line") && !args.line) return fail("line is required when position is after_line or before_line.");
      const attrs = [args.width ? `width=${args.width}` : "", `align=${args.align ?? "center"}`].filter(Boolean).join(" ");
      const markdown = `![${(args.alt ?? "").replace(/[\[\]]/g, "")}](${src.replace(/[()\s]/g, encodeURIComponent)}){${attrs}}`;
      const position =
        args.position === "start" || args.position === "end" ? { at: args.position } : args.position === "after_line" ? { afterLine: args.line! } : { beforeLine: args.line! };
      return commitEdit(ctx, doc, "insert_image", (current) => insertMarkdown(current, markdown, position), "Inserted an image");
    },
  }),

  defineTool({
    name: "read_attachment",
    title: "Read attachment",
    description: "Read the text of a file the user attached earlier in this chat (text, Markdown, CSV, JSON or Word), for example after older messages were summarized. Pass the attachment id from list in the chat context.",
    shape: { attachment_id: z.string() },
    write: false,
    async handler(args, ctx) {
      const known = ctx.attachments?.().find((item) => item.id === args.attachment_id);
      if (!known) return fail(`No attachment ${args.attachment_id} in this chat.${ctx.attachments?.().length ? ` Attachments: ${ctx.attachments().map((item) => `${item.id} (${item.name})`).join(", ")}.` : ""}`);
      if (known.kind !== "text") return fail(`"${known.name}" is ${known.kind === "image" ? "an image" : "a PDF"}; ask the user to attach it again so you can see it.`);
      const upload = await findUpload(known.id).catch(() => null);
      if (!upload) return fail(`"${known.name}" is no longer available.`);
      const text = await attachmentText(upload.extension, await readFile(upload.file));
      return ok(`<attachment name="${known.name}">\n${text.slice(0, 200_000)}\n</attachment>`);
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
      const lint = lintWriting(text, pageCountNow(doc).pages);
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
    name: "check_spelling",
    title: "Check spelling",
    description:
      "Find the words the editor underlines in red as misspelled: each word with its line, the text around it and suggested corrections. Code, equations and words in the user's dictionary are skipped. Fix real typos with edit_document; for names, places and invented words that are spelled as intended (a character or a fictional town), use add_to_dictionary so the user stops seeing the underline. The editor's underlines come from the user's browser, so a few may differ from this list.",
    shape: { document_id: documentId, from_line: z.number().int().min(1).optional(), to_line: z.number().int().min(1).optional() },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const lines = lineRange(args.from_line, args.to_line);
      showActivity(ctx, doc, { chatId: ctx.author, status: "reading", label: "Checking spelling" });
      const [check, dictionary] = await Promise.all([speller(), readDictionary()]);
      const found = findMisspellings(doc.doc, check, new Set(dictionary), lines ?? undefined);
      const where = lines ? ` (lines ${lines.from}-${lines.to})` : "";
      if (!found.length) return ok(`No misspelled words in "${doc.meta.title}"${where}.`);
      // One entry per word, with every line it's on; suggestions for the first few dozen words (they are slow to compute).
      const groups = new Map<string, Misspelling[]>();
      for (const item of found) {
        const key = normalizeWord(item.word);
        groups.set(key, [...(groups.get(key) ?? []), item]);
      }
      const entries = [...groups.values()].slice(0, 80).map((items, index) => {
        const first = items[0]!;
        const suggestions = index < 30 ? check.suggest(first.word).slice(0, 4) : [];
        const lineList = [...new Set(items.map((item) => item.line))];
        return `- "${first.word}"${items.length > 1 ? ` ×${items.length}` : ""}, line${lineList.length > 1 ? "s" : ""} ${lineList.slice(0, 8).join(", ")}${lineList.length > 8 ? "…" : ""}: "${clip(first.context, 90)}"${suggestions.length ? ` → ${suggestions.map((word) => `"${word}"`).join(", ")}` : " (no suggestions)"}`;
      });
      return ok(
        `${groups.size} misspelled word${groups.size === 1 ? "" : "s"} (${found.length} underline${found.length === 1 ? "" : "s"}) in "${doc.meta.title}"${where}:\n${entries.join("\n")}${groups.size > 80 ? `\n… and ${groups.size - 80} more words.` : ""}`,
      );
    },
  }),

  defineTool({
    name: "add_to_dictionary",
    title: "Add to dictionary",
    description:
      "Add words to the user's spelling dictionary so the editor stops underlining them, in every document. Use it for names, places and invented words that are spelled as intended, never to hide real typos. Ask the user first unless they asked you to deal with the underlines.",
    shape: { document_id: documentId, words: z.array(z.string().min(1).max(100)).min(1).max(200).describe("The words, as spelled in the document.") },
    write: true,
    async handler(args, ctx) {
      if (ctx.readOnly) return fail("You are in Ask mode, so the dictionary can't be changed. Suggest the words to add instead.");
      const doc = await resolveDocument(ctx, args.document_id);
      const words = [...new Set(args.words.map(normalizeWord).filter(Boolean))];
      if (!words.length) return fail("None of those are words.");
      await updateDictionary(words);
      doc.sendCommand({ kind: "dictionary", words });
      return ok(`Added ${words.map((word) => `"${word}"`).join(", ")} to the dictionary. The editor no longer underlines ${words.length === 1 ? "it" : "them"}.`);
    },
  }),

  defineTool({
    name: "list_library",
    title: "List library",
    description:
      "The user's document library for organizing it: the folder tree, then each document's id, title, folder and the first few words of its text. Cheap: it reads no document bodies, so use it (not read_document on every document) to decide where documents belong. Large libraries come in pages; pass offset to continue.",
    shape: {
      folder: z.string().optional().describe('Only documents in this folder and the folders inside it: an id or a path like "Work/Q3".'),
      unfiled_only: z.boolean().optional().describe("Only documents that aren't in any folder yet."),
      excerpt_words: z.number().int().min(0).max(MAX_EXCERPT_WORDS).optional().describe(`Words of each document's opening text to include (default 15, max ${MAX_EXCERPT_WORDS}; 0 for titles only, best for a first pass over hundreds of documents).`),
      limit: z.number().int().min(1).max(500).optional().describe("Documents per page (default 200)."),
      offset: z.number().int().min(0).optional(),
    },
    write: false,
    async handler(args, ctx) {
      const { folders, documents } = await library();
      const folderId = args.unfiled_only ? null : args.folder ? (await resolveFolder(args.folder, { create: false })).id : undefined;
      const offset = args.offset ?? 0;
      const listing = formatLibrary(folders, documents, { folderId, excerptWords: args.excerpt_words ?? 15, limit: args.limit ?? 200, offset, openId: ctx.documentId ?? null });
      return ok(offset ? listing : `Folders:\n${formatFolderTree(folders, documents)}\n\nDocuments: ${listing}`);
    },
  }),

  defineTool({
    name: "list_folders",
    title: "List folders",
    description: "The user's folders as a tree, with ids, colors and how many documents each holds.",
    shape: {},
    write: false,
    async handler() {
      const { folders, documents } = await library();
      const unfiled = documents.filter((doc) => !doc.folderId || !folders.has(doc.folderId)).length;
      return ok(`${formatFolderTree(folders, documents)}\n${unfiled} of ${documents.length} documents are unfiled (at the top level).`);
    },
  }),

  defineTool({
    name: "move_documents",
    title: "Move documents",
    description:
      'File documents in folders, many at once. Each move names a folder by id or by path of names ("Work/Q3"); folders on the path that don\'t exist yet are created (new top-level folders get their own color). Use "" for the top level. A tab moves with its document.',
    shape: {
      moves: z
        .array(
          z.object({
            document_id: z.string().optional().describe("Defaults to the document the user is working in."),
            folder: z.string().describe('Folder id, path like "Work/Q3", or "" for the top level.'),
          }),
        )
        .min(1)
        .max(500),
      create_missing: z.boolean().optional().describe("Create folders on paths that don't exist (default true)."),
    },
    write: true,
    async handler(args, ctx) {
      const moves = [];
      for (const move of args.moves) {
        const id = move.document_id || ctx.documentId;
        if (!id) return fail("Pass document_id for each move; no document is open.");
        moves.push({ documentId: id, folder: move.folder });
      }
      const result = await moveDocuments(moves, { create: args.create_missing !== false });
      const { folders } = await library();
      const byFolder = new Map<string, string[]>();
      for (const item of result.moved) {
        const name = item.to ? folderPathName(folders, item.to) : "the top level";
        byFolder.set(name, [...(byFolder.get(name) ?? []), item.title]);
      }
      const lines = [...byFolder].map(([name, titles]) => `- ${name}: ${titles.length > 6 ? `${titles.slice(0, 6).map((title) => `"${title}"`).join(", ")} and ${titles.length - 6} more` : titles.map((title) => `"${title}"`).join(", ")}`);
      const parts = [result.moved.length ? `Moved ${result.moved.length} document${result.moved.length === 1 ? "" : "s"}:\n${lines.join("\n")}` : "No documents moved."];
      if (result.created.length) parts.push(`Created folder${result.created.length === 1 ? "" : "s"}: ${result.created.map((folder) => `"${folderPathName(folders, folder.id)}" (id ${folder.id})`).join(", ")}.`);
      if (result.unchanged) parts.push(`${result.unchanged} already in place.`);
      if (result.problems.length) parts.push(`Skipped: ${result.problems.join("; ")}.`);
      return { text: parts.join("\n"), isError: !result.moved.length && Boolean(result.problems.length) };
    },
  }),

  defineTool({
    name: "create_folder",
    title: "Create folder",
    description: "Create a folder, at the top level or inside another. (move_documents also creates folders named by path.)",
    shape: {
      name: z.string().min(1).max(120),
      parent: z.string().optional().describe('Folder id or path to create it in; omit for the top level.'),
      color: z.enum(FOLDER_COLORS).optional(),
    },
    write: true,
    async handler(args) {
      const parentId = (await resolveFolder(args.parent, { create: false })).id;
      const folder = await createFolder({ name: args.name, parentId, color: args.color ?? (parentId ? (await library()).folders.get(parentId)?.color : undefined) });
      const { folders } = await library();
      return ok(`Created the folder "${folderPathName(folders, folder.id)}" (id ${folder.id}).`);
    },
  }),

  defineTool({
    name: "update_folder",
    title: "Update folder",
    description: "Rename a folder, change its color, or move it into another folder (parent: \"\" for the top level).",
    shape: {
      folder: z.string().describe("Folder id or path."),
      name: z.string().min(1).max(120).optional(),
      color: z.enum(FOLDER_COLORS).optional(),
      parent: z.string().optional().describe('New parent folder id or path; "" for the top level.'),
    },
    write: true,
    async handler(args) {
      const id = (await resolveFolder(args.folder, { create: false })).id;
      if (!id) return fail("Name a folder to update.");
      const parentId = args.parent === undefined ? undefined : (await resolveFolder(args.parent, { create: false })).id;
      const folder = await updateFolder(id, { name: args.name, color: args.color, parentId });
      const { folders } = await library();
      return ok(`Updated the folder: now "${folderPathName(folders, folder.id)}" (${folder.color}).`);
    },
  }),

  defineTool({
    name: "delete_folder",
    title: "Delete folder",
    description:
      "Delete a folder and everything in it: the folders inside are deleted and its documents move to the trash, where the user can restore them until they empty it. To keep the documents, move them out first with move_documents. Only delete when the user asks.",
    shape: { folder: z.string().describe("Folder id or path.") },
    write: true,
    destructive: true,
    async handler(args) {
      const id = (await resolveFolder(args.folder, { create: false })).id;
      if (!id) return fail("Name a folder to delete.");
      const { folders } = await library();
      const name = folderPathName(folders, id);
      const result = await deleteFolder(id);
      const inner = result.folders.length - 1;
      return ok(
        `Deleted the folder "${name}"${inner ? ` and ${inner} folder${inner === 1 ? "" : "s"} inside it` : ""}. ${result.trashed.length} document${result.trashed.length === 1 ? "" : "s"} moved to the trash, where the user can restore them.`,
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
      const { folders } = await library();
      return ok(
        metas
          .slice(0, 100)
          .map((meta) => {
            const where = meta.folderId && folders.has(meta.folderId) ? ` · in ${folderPathName(folders, meta.folderId)}` : "";
            return `- ${meta.id}${meta.id === current ? " (open)" : ""}: "${meta.title}"${where} · ${meta.wordCount} words · edited ${new Date(meta.updatedAt).toISOString()}`;
          })
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
      folder: z.string().optional().describe('Folder to file it in: an id or a path like "Work/Q3" (created if missing).'),
    },
    write: true,
    async handler(args, ctx) {
      if (ctx.readOnly) return fail("You are in Ask mode, so documents can't be created.");
      const hub = documentHub();
      const folderId = args.folder ? (await resolveFolder(args.folder, { create: true })).id : null;
      const created = await hub.create({ title: args.title, markdown: args.content, folderId });
      if (args.open !== false) {
        const current = ctx.documentId ? await hub.get(ctx.documentId) : await hub.active();
        current?.sendCommand({ kind: "open_document", documentId: created.id });
      }
      ctx.onChange?.({ documentId: created.id, title: created.meta.title, tool: "create_document", added: created.meta.wordCount, removed: 0 });
      return ok(`Created "${created.meta.title}" (id ${created.id}). Pass document_id: "${created.id}" to edit it.`);
    },
  }),

  defineTool({
    name: "list_tabs",
    title: "List tabs",
    description: "List a document's tabs with their ids. Each tab is its own page of content: pass a tab's id as document_id to read or edit that tab.",
    shape: { document_id: documentId },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const tabs = await documentHub().tabs(doc.id);
      return ok(
        `"${doc.meta.title}" has ${tabs.length} tab${tabs.length === 1 ? "" : "s"}:\n${tabs.map((tab) => `- ${tab.id}${tab.id === doc.id ? " (this one)" : ""}: "${tab.title}"`).join("\n")}`,
      );
    },
  }),

  defineTool({
    name: "create_tab",
    title: "Create tab",
    description: "Add a tab to a document, optionally with initial Markdown content. Returns the new tab's id, to pass as document_id when editing it.",
    shape: {
      document_id: documentId,
      title: z.string().optional().describe("The tab's name."),
      content: z.string().optional().describe("Initial content as Markdown."),
    },
    write: true,
    async handler(args, ctx) {
      if (ctx.readOnly) return fail("You are in Ask mode, so tabs can't be added.");
      const doc = await resolveDocument(ctx, args.document_id);
      const hub = documentHub();
      const tab = await hub.createTab(doc.id, { title: args.title, markdown: args.content });
      const title = (await hub.tabs(tab.id)).find((item) => item.id === tab.id)?.title ?? "New tab";
      ctx.onChange?.({ documentId: tab.id, title: `${tab.meta.title} · ${title}`, tool: "create_tab", added: tab.meta.wordCount, removed: 0 });
      return ok(`Added the tab "${title}" (id ${tab.id}) to "${doc.meta.title}". Pass document_id: "${tab.id}" to edit it.`);
    },
  }),

  defineTool({
    name: "rename_tab",
    title: "Rename tab",
    description: "Rename one of a document's tabs. The tab to rename is the one passed as document_id.",
    shape: { document_id: documentId, title: z.string().min(1).describe("The tab's new name.") },
    write: true,
    async handler(args, ctx) {
      if (ctx.readOnly) return fail("You are in Ask mode, so tabs can't be renamed.");
      const doc = await resolveDocument(ctx, args.document_id);
      await documentHub().renameTab(doc.id, args.title);
      return ok(`Renamed the tab to "${doc.meta.tabTitle}".`);
    },
  }),

  defineTool({
    name: "open_document",
    title: "Open document",
    description: "Show a document in the user's editor, switching the editor to it. Use it after create_document, or when the user asks to see another document.",
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
      "Export a document as Word (.docx), PDF, Markdown, HTML or plain text. The file is downloaded in the user's browser. docx/md/html/txt are also available at a returned URL; PDF is drawn from the editor's page layout, so the document must be open in Inline. A document with tabs exports all of them in order, each starting on a new page, unless all_tabs is false.",
    shape: {
      document_id: documentId,
      format: z.enum(["docx", "pdf", "md", "html", "txt"]),
      all_tabs: z.boolean().optional().describe("For a document with tabs: export every tab (default true) or only this one."),
    },
    write: false,
    async handler(args, ctx) {
      const doc = await resolveDocument(ctx, args.document_id);
      const tabs = args.all_tabs === false ? "tab" : "all";
      if (args.format === "pdf") {
        const viewers = doc.sendCommand({ kind: "export_pdf", tabs });
        return viewers
          ? ok(`Started the download of "${doc.meta.title}.pdf" in the user's editor.`)
          : fail("PDF export needs the document open in the Inline editor. Ask the user to open it, or export docx/html instead.");
      }
      const url = `/api/documents/${doc.id}/export?format=${args.format}${tabs === "all" && (doc.meta.parentId || doc.meta.tabs?.length) ? "&tabs=all" : ""}`;
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
  // Every write tool is refused in Ask mode, including ones that only touch comments or versions.
  if (tool.write && ctx.readOnly) return fail("You are in Ask mode, so documents can't be changed. Describe the change instead, or ask the user to switch to Agent mode.");
  const parsed = z.object(tool.shape).safeParse(args);
  if (!parsed.success) return fail(`Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ")}`);
  const run = wrapErrors(tool.handler as unknown as (...args: never[]) => Promise<ToolResult>);
  return run(...([parsed.data, ctx] as never[]));
}
