import { Mark, type Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { BLOCK_SEPARATOR, parseMarkdown, serializeBlock, serializeDoc, type BlockSpan, type SerializedDoc } from "@/lib/doc/markdown";
import { LockedContentError, replaceTopLevelBlocks } from "@/lib/doc/merge";
import { ALIGNMENTS, MAX_INDENT, safeHref, cssSizeToPt, isTextblockType, schema, type Align } from "@/lib/doc/schema";

/**
 * Document operations in the vocabulary the agent uses: Markdown text with
 * line numbers, exact-string edits, and formatting by text or line range.
 * Every operation returns a Transform against the given document so the
 * caller (the document hub) can apply it as ordinary collaborative steps.
 */

export class EditError extends Error {}

export { LockedContentError };

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type LineInfo = { line: number; text: string };

export function markdownLines(serialized: SerializedDoc): string[] {
  return serialized.markdown.split("\n");
}

/** `cat -n` style rendering, the format Claude Code's own Read tool uses. */
export function numberLines(lines: string[], offset = 1, limit = 2000): string {
  const start = Math.max(1, offset);
  const slice = lines.slice(start - 1, start - 1 + limit);
  const width = Math.max(6, String(start + slice.length).length);
  return slice
    .map((line, index) => `${String(start + index).padStart(width, " ")}\t${line.length > 2000 ? `${line.slice(0, 2000)}… [line truncated]` : line}`)
    .join("\n");
}

export function lineOfOffset(markdown: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < markdown.length; i += 1) if (markdown.charCodeAt(i) === 10) line += 1;
  return line;
}

export function offsetOfLine(markdown: string, line: number): number {
  if (line <= 1) return 0;
  let current = 1;
  for (let i = 0; i < markdown.length; i += 1) {
    if (markdown.charCodeAt(i) === 10) {
      current += 1;
      if (current === line) return i + 1;
    }
  }
  return markdown.length;
}

export type BlockLines = { block: BlockSpan; startLine: number; endLine: number };

export function blockLines(serialized: SerializedDoc): BlockLines[] {
  const out: BlockLines[] = [];
  let line = 1;
  for (const block of serialized.blocks) {
    const count = block.markdown.split("\n").length;
    out.push({ block, startLine: line, endLine: line + count - 1 });
    line += count + 1; // blank separator line
  }
  return out;
}

export type TextblockLines = { node: PMNode; pos: number; startLine: number; endLine: number };

/**
 * Every textblock with the Markdown lines it occupies. List items, quoted
 * paragraphs and table rows get their own lines rather than the whole
 * block's, so "line 8" means the item a reader sees on line 8.
 */
export function textblockLines(serialized: SerializedDoc): TextblockLines[] {
  const out: TextblockLines[] = [];
  for (const entry of blockLines(serialized)) {
    const block = entry.block;
    if (block.node.isTextblock) {
      out.push({ node: block.node, pos: block.pos, startLine: entry.startLine, endLine: entry.endLine });
      continue;
    }
    if (block.node.type.name === "table") {
      // Rows are one line each, after the header row and the divider line.
      block.node.forEach((row, rowOffset, rowIndex) => {
        const line = entry.startLine + (rowIndex === 0 ? 0 : rowIndex + 1);
        row.descendants((node, pos) => {
          if (!node.isTextblock) return true;
          out.push({ node, pos: block.pos + 1 + rowOffset + 1 + pos, startLine: line, endLine: line });
          return false;
        });
      });
      continue;
    }
    // Lists and quotes: find each textblock's own Markdown, in order, among the block's lines.
    const lines = block.markdown.split("\n");
    let cursor = 0;
    block.node.descendants((node, pos) => {
      if (!node.isTextblock) return true;
      const own = serializeBlock(node).split("\n");
      const found = lines.findIndex((line, index) => index >= cursor && line.includes(own[0]!));
      const at = found >= 0 ? found : Math.min(cursor, lines.length - 1);
      const span = Math.max(1, Math.min(own.length, lines.length - at));
      out.push({ node, pos: block.pos + 1 + pos, startLine: entry.startLine + at, endLine: entry.startLine + at + span - 1 });
      cursor = at + span;
      return false;
    });
  }
  return out;
}

/** Blocks touched by the 1-based inclusive line range. */
export function blocksInLines(serialized: SerializedDoc, from: number, to: number): BlockLines[] {
  return blockLines(serialized).filter((entry) => entry.endLine >= from && entry.startLine <= to);
}

export function docPlainText(doc: PMNode): string {
  return doc.textBetween(0, doc.content.size, "\n\n", (node) => (node.type.name === "hard_break" ? "\n" : node.type.name === "image" ? "" : ""));
}

export function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
}

const blockWords = new WeakMap<PMNode, number>();

/**
 * wordCount(docPlainText(doc)), counted per top-level block and cached by
 * node. Blocks an edit didn't touch are the same objects in the new document,
 * so a keystroke recounts one paragraph instead of the whole document.
 */
export function docWordCount(doc: PMNode): number {
  let total = 0;
  doc.forEach((child) => {
    let count = blockWords.get(child);
    if (count === undefined) {
      count = child.isText ? wordCount(child.text ?? "") : wordCount(child.textBetween(0, child.content.size, "\n\n", (node) => (node.type.name === "hard_break" ? "\n" : "")));
      blockWords.set(child, count);
    }
    total += count;
  });
  return total;
}

// ---------------------------------------------------------------------------
// String edits
// ---------------------------------------------------------------------------

export type StringEdit = { old_string: string; new_string: string; replace_all?: boolean };

type Match = { start: number; end: number; normalized: boolean };

const QUOTE_MAP: Record<string, string> = { "‘": "'", "’": "'", "‚": "'", "‛": "'", "“": '"', "”": '"', "„": '"', "‟": '"', " ": " " };

function normalizeQuotes(text: string) {
  return text.replace(/[‘’‚‛“”„‟ ]/g, (ch) => QUOTE_MAP[ch] ?? ch);
}

/** Strip `cat -n` prefixes if the model copied them into old_string. */
function stripLinePrefixes(text: string) {
  const lines = text.split("\n");
  if (lines.length && lines.every((line) => /^\s*\d+\t/.test(line) || line === "")) {
    return lines.map((line) => line.replace(/^\s*\d+\t/, "")).join("\n");
  }
  return text;
}

function findAll(haystack: string, needle: string): number[] {
  const hits: number[] = [];
  if (!needle) return hits;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return hits;
    hits.push(at);
    from = at + needle.length;
  }
}

export function locate(markdown: string, oldString: string): Match[] {
  const exact = findAll(markdown, oldString);
  if (exact.length) return exact.map((start) => ({ start, end: start + oldString.length, normalized: false }));
  const stripped = stripLinePrefixes(oldString);
  if (stripped !== oldString) {
    const hits = findAll(markdown, stripped);
    if (hits.length) return hits.map((start) => ({ start, end: start + stripped.length, normalized: false }));
  }
  // Quote-insensitive match (normalization keeps string length, so offsets carry over).
  const normalizedDoc = normalizeQuotes(markdown);
  const needle = normalizeQuotes(stripped);
  const hits = findAll(normalizedDoc, needle);
  if (hits.length) return hits.map((start) => ({ start, end: start + needle.length, normalized: true }));
  // Trailing-whitespace-insensitive per line.
  const trimmedNeedle = needle
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n");
  if (trimmedNeedle !== needle) {
    const trimmedHits = findAll(normalizedDoc, trimmedNeedle);
    if (trimmedHits.length) return trimmedHits.map((start) => ({ start, end: start + trimmedNeedle.length, normalized: true }));
  }
  return [];
}

function closestLineHint(markdown: string, oldString: string) {
  const target = oldString.split("\n").find((line) => line.trim()) ?? "";
  if (!target.trim()) return "";
  const words = new Set(target.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
  if (!words.size) return "";
  let best = { score: 0, line: 0, text: "" };
  markdown.split("\n").forEach((line, index) => {
    const lineWords = line.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
    if (!lineWords.length) return;
    let shared = 0;
    for (const word of lineWords) if (words.has(word)) shared += 1;
    const score = shared / Math.max(words.size, lineWords.length);
    if (score > best.score) best = { score, line: index + 1, text: line };
  });
  if (best.score < 0.3) return "";
  const preview = best.text.length > 300 ? `${best.text.slice(0, 300)}…` : best.text;
  return ` The closest line is ${best.line}:\n${preview}`;
}

/** Apply typographic quotes to `text` when the document text it replaces used them. */
function smartenQuotes(text: string) {
  return text
    .replace(/(^|[\s([{—-])"/g, "$1“")
    .replace(/"/g, "”")
    .replace(/(^|[\s([{—-])'/g, "$1‘")
    .replace(/'/g, "’");
}

/**
 * Apply one exact-string edit to the Markdown view of `tr.doc`. The smallest
 * run of whole blocks containing each match is re-parsed and merged back.
 */
export function applyStringEdit(tr: Transform, edit: StringEdit): number {
  if (edit.old_string === edit.new_string) {
    throw new EditError("No changes to make: old_string and new_string are exactly the same.");
  }
  if (!edit.old_string) {
    throw new EditError("old_string is empty. To add content use insert_content, or write_document to replace the whole document.");
  }
  const serialized = serializeDoc(tr.doc);
  const matches = locate(serialized.markdown, edit.old_string);
  if (!matches.length) {
    throw new EditError(
      `String to replace not found in the document. old_string must match the Markdown shown by read_document exactly (without the line-number prefix).${closestLineHint(serialized.markdown, edit.old_string)}`,
    );
  }
  if (matches.length > 1 && !edit.replace_all) {
    const lines = matches.slice(0, 8).map((match) => lineOfOffset(serialized.markdown, match.start));
    throw new EditError(
      `Found ${matches.length} matches of old_string (lines ${lines.join(", ")}), but replace_all is false. To replace every occurrence set replace_all to true. To replace one, include more surrounding text so it is unique.`,
    );
  }

  // Group matches into block regions; overlapping regions are merged.
  type Region = { from: number; to: number; matches: Match[] };
  const regions: Region[] = [];
  for (const match of matches) {
    const touched = serialized.blocks.filter((block) => block.end >= match.start && block.start <= match.end);
    // A match that lies entirely in a separator touches the blocks on both sides.
    const from = touched.length ? touched[0]!.index : serialized.blocks.findIndex((block) => block.start > match.start);
    const to = touched.length ? touched[touched.length - 1]!.index + 1 : from + 1;
    const last = regions[regions.length - 1];
    if (last && from < last.to) {
      last.to = Math.max(last.to, to);
      last.matches.push(match);
    } else {
      regions.push({ from, to, matches: [match] });
    }
  }

  for (let r = regions.length - 1; r >= 0; r -= 1) {
    const region = regions[r]!;
    const first = serialized.blocks[region.from]!;
    const last = serialized.blocks[region.to - 1]!;
    let text = "";
    let cursor = first.start;
    for (const match of region.matches) {
      text += serialized.markdown.slice(cursor, match.start);
      const original = serialized.markdown.slice(match.start, match.end);
      text += match.normalized && /[‘’“”]/.test(original) ? smartenQuotes(edit.new_string) : edit.new_string;
      cursor = match.end;
    }
    text += serialized.markdown.slice(cursor, last.end);
    replaceTopLevelBlocks(tr, region.from, region.to, parseMarkdown(text));
  }
  return matches.length;
}

export function applyStringEdits(doc: PMNode, edits: StringEdit[]): Transform {
  const tr = new Transform(doc);
  edits.forEach((edit, index) => {
    try {
      applyStringEdit(tr, edit);
    } catch (error) {
      if (edits.length > 1 && error instanceof EditError) {
        throw new EditError(`Edit ${index + 1} of ${edits.length} failed, so no edits were applied: ${error.message}`);
      }
      throw error;
    }
  });
  return tr;
}

/** Replace the entire document with new Markdown, keeping unchanged blocks and their styling. */
export function writeDocument(doc: PMNode, markdown: string): Transform {
  const tr = new Transform(doc);
  replaceTopLevelBlocks(tr, 0, doc.childCount, parseMarkdown(markdown));
  return tr;
}

export type InsertPosition = { at: "start" | "end" } | { afterLine: number } | { beforeLine: number };

export function insertMarkdown(doc: PMNode, markdown: string, position: InsertPosition): Transform {
  const blocks = parseMarkdown(markdown);
  if (!blocks.length) throw new EditError("Nothing to insert: the Markdown parsed to no content.");
  const tr = new Transform(doc);
  const serialized = serializeDoc(doc);
  let index: number;
  const entries = blockLines(serialized);
  // Inserting at the start or end next to a list is inserting before its first or after its last line.
  if ("at" in position && entries.length) {
    const edge = position.at === "start" ? entries[0]! : entries[entries.length - 1]!;
    if (blocks.length === 1 && blocks[0]!.type === edge.block.node.type && /_list$/.test(blocks[0]!.type.name)) {
      position = position.at === "start" ? { beforeLine: edge.startLine } : { afterLine: edge.endLine };
    }
  }
  if ("at" in position) {
    index = position.at === "start" ? 0 : doc.childCount;
  } else {
    const line = "afterLine" in position ? position.afterLine : position.beforeLine;
    const containing = entries.find((item) => item.endLine >= line && item.startLine <= line);
    // New items for a list go into that list rather than starting a second one beside it.
    if (containing && blocks.length === 1 && blocks[0]!.type === containing.block.node.type && /_list$/.test(blocks[0]!.type.name)) {
      const lines = containing.block.markdown.split("\n");
      const at = ("afterLine" in position ? line + 1 : line) - containing.startLine;
      lines.splice(at, 0, ...markdown.trim().split("\n"));
      replaceTopLevelBlocks(tr, containing.block.index, containing.block.index + 1, parseMarkdown(lines.join("\n")));
      return tr;
    }
    const entry = containing ?? entries.find((item) => item.startLine > line);
    if (!entry) index = doc.childCount;
    else index = "afterLine" in position ? entry.block.index + 1 : entry.block.index;
  }
  // Inserting into an empty document replaces its single empty paragraph.
  if (doc.childCount === 1 && doc.firstChild!.isTextblock && doc.firstChild!.content.size === 0) {
    replaceTopLevelBlocks(tr, 0, 1, blocks);
    return tr;
  }
  let pos = 0;
  for (let i = 0; i < index && i < doc.childCount; i += 1) pos += doc.child(i).nodeSize;
  tr.insert(pos, blocks);
  return tr;
}

// ---------------------------------------------------------------------------
// Text search and formatting
// ---------------------------------------------------------------------------

type TextIndex = { text: string; positions: number[]; line: number };

/** Plain text of each textblock with the document position of every character. */
function textIndex(doc: PMNode, lineFilter?: { from: number; to: number }): TextIndex[] {
  const out: TextIndex[] = [];
  for (const entry of textblockLines(serializeDoc(doc))) {
    if (lineFilter && (entry.endLine < lineFilter.from || entry.startLine > lineFilter.to)) continue;
    const base = entry.pos + 1;
    let text = "";
    const positions: number[] = [];
    entry.node.forEach((child, offset) => {
      if (child.isText) {
        for (let i = 0; i < (child.text ?? "").length; i += 1) {
          text += child.text![i];
          positions.push(base + offset + i);
        }
      } else {
        text += "\n";
        positions.push(base + offset);
      }
    });
    out.push({ text, positions, line: entry.startLine });
  }
  return out;
}

export type TextRange = { from: number; to: number; line: number; text: string };

export function findText(doc: PMNode, query: string, options: { lines?: { from: number; to: number }; caseSensitive?: boolean } = {}): TextRange[] {
  const ranges: TextRange[] = [];
  if (!query) return ranges;
  const needle = options.caseSensitive ? normalizeQuotes(query) : normalizeQuotes(query).toLowerCase();
  for (const entry of textIndex(doc, options.lines)) {
    const hay = options.caseSensitive ? normalizeQuotes(entry.text) : normalizeQuotes(entry.text).toLowerCase();
    for (const at of findAll(hay, needle)) {
      const from = entry.positions[at]!;
      const to = entry.positions[at + needle.length - 1]! + 1;
      ranges.push({ from, to, line: entry.line, text: entry.text.slice(at, at + needle.length) });
    }
  }
  return ranges;
}

export function searchLines(doc: PMNode, pattern: string, options: { regex?: boolean; caseSensitive?: boolean; limit?: number } = {}) {
  const serialized = serializeDoc(doc);
  const lines = markdownLines(serialized);
  let test: (line: string) => boolean;
  if (options.regex) {
    let re: RegExp;
    try {
      re = new RegExp(pattern, options.caseSensitive ? "u" : "iu");
    } catch (error) {
      throw new EditError(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    test = (line) => re.test(line);
  } else {
    const needle = options.caseSensitive ? pattern : pattern.toLowerCase();
    test = (line) => (options.caseSensitive ? line : line.toLowerCase()).includes(needle);
  }
  const hits: LineInfo[] = [];
  lines.forEach((text, index) => {
    if (hits.length < (options.limit ?? 100) && test(text)) hits.push({ line: index + 1, text });
  });
  const total = lines.filter((line) => test(line)).length;
  return { hits, total };
}

export type FormatSpec = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  code?: boolean;
  superscript?: boolean;
  subscript?: boolean;
  highlight?: string | null | boolean;
  color?: string | null;
  font_family?: string | null;
  font_size?: number | null;
  link?: string | null;
};

const BOOLEAN_MARKS: Array<[keyof FormatSpec, string]> = [
  ["bold", "bold"],
  ["italic", "italic"],
  ["underline", "underline"],
  ["strike", "strike"],
  ["code", "code"],
  ["superscript", "superscript"],
  ["subscript", "subscript"],
];

export function applyFormat(tr: Transform, from: number, to: number, spec: FormatSpec) {
  if (from >= to) return;
  for (const [key, name] of BOOLEAN_MARKS) {
    const value = spec[key];
    if (value === true) tr.addMark(from, to, schema.mark(name));
    else if (value === false) tr.removeMark(from, to, schema.marks[name]);
  }
  if (spec.highlight !== undefined) {
    tr.removeMark(from, to, schema.marks.highlight);
    if (spec.highlight) tr.addMark(from, to, schema.mark("highlight", { color: spec.highlight === true ? "#fff2a8" : spec.highlight }));
  }
  if (spec.color !== undefined) {
    tr.removeMark(from, to, schema.marks.text_color);
    if (spec.color && !/^(auto|inherit|default)$/i.test(spec.color)) tr.addMark(from, to, schema.mark("text_color", { color: spec.color }));
  }
  if (spec.font_family !== undefined) {
    tr.removeMark(from, to, schema.marks.font_family);
    if (spec.font_family) tr.addMark(from, to, schema.mark("font_family", { family: spec.font_family }));
  }
  if (spec.font_size !== undefined) {
    tr.removeMark(from, to, schema.marks.font_size);
    if (spec.font_size) {
      const pt = cssSizeToPt(`${spec.font_size}pt`);
      if (pt) tr.addMark(from, to, schema.mark("font_size", { size: `${pt}pt` }));
    }
  }
  if (spec.link !== undefined) {
    tr.removeMark(from, to, schema.marks.link);
    if (spec.link) {
      const href = safeHref(spec.link);
      if (!href) throw new EditError(`"${spec.link}" isn't a link Inline allows. Use an http, https, mailto or tel URL.`);
      tr.addMark(from, to, schema.mark("link", { href }));
    }
  }
}

export function lockedBetween(doc: PMNode, from: number, to: number): boolean {
  let locked = false;
  doc.nodesBetween(from, to, (node) => {
    if (locked) return false;
    if (node.marks.some((mark) => mark.type.name === "locked")) locked = true;
    return true;
  });
  return locked;
}

/** Content range of every textblock within the given lines. */
export function textblockRanges(doc: PMNode, lines: { from: number; to: number }): Array<{ from: number; to: number; pos: number; node: PMNode }> {
  return textblockLines(serializeDoc(doc))
    .filter((entry) => entry.endLine >= lines.from && entry.startLine <= lines.to)
    .map((entry) => ({ from: entry.pos + 1, to: entry.pos + entry.node.nodeSize - 1, pos: entry.pos, node: entry.node }));
}

// ---------------------------------------------------------------------------
// Block styles
// ---------------------------------------------------------------------------

export type BlockStyle = {
  type?: "paragraph" | "heading" | "title" | "subtitle";
  level?: number;
  align?: Align;
  indent?: number;
  line_spacing?: number | null;
  space_before?: number | null;
  space_after?: number | null;
};

export function applyBlockStyle(tr: Transform, lines: { from: number; to: number }, style: BlockStyle): number {
  const ranges = textblockRanges(tr.doc, lines);
  if (!ranges.length) throw new EditError(`No text blocks between lines ${lines.from} and ${lines.to}.`);
  for (const range of ranges) {
    const node = tr.doc.nodeAt(range.pos);
    if (!node || !isTextblockType(node.type.name)) continue;
    const typeName = style.type ?? (style.level ? "heading" : node.type.name);
    const type = schema.nodes[typeName]!;
    const attrs: Record<string, unknown> = { ...node.attrs };
    if (typeName === "heading") attrs.level = Math.max(1, Math.min(6, style.level ?? (node.type.name === "heading" ? node.attrs.level : 1)));
    else delete attrs.level;
    if (style.align) {
      if (!ALIGNMENTS.includes(style.align)) throw new EditError(`align must be one of ${ALIGNMENTS.join(", ")}.`);
      attrs.align = style.align;
    }
    if (style.indent !== undefined) attrs.indent = Math.max(0, Math.min(MAX_INDENT, Math.round(style.indent)));
    if (style.line_spacing !== undefined) attrs.lineHeight = style.line_spacing ? String(style.line_spacing) : null;
    if (style.space_before !== undefined) attrs.spaceBefore = style.space_before;
    if (style.space_after !== undefined) attrs.spaceAfter = style.space_after;
    tr.setNodeMarkup(range.pos, type, attrs, node.marks);
  }
  return ranges.length;
}

// ---------------------------------------------------------------------------
// Range marks (comments, locks)
// ---------------------------------------------------------------------------

export function addRangeMark(tr: Transform, from: number, to: number, mark: Mark) {
  tr.addMark(from, to, mark);
}

export function removeRangeMarkById(tr: Transform, name: "comment" | "locked", id: string) {
  const type = schema.marks[name]!;
  tr.doc.descendants((node, pos) => {
    const mark = node.marks.find((m) => m.type === type && m.attrs.id === id);
    if (mark) tr.removeMark(pos, pos + node.nodeSize, mark);
  });
}

/** Text currently anchored by each comment/lock id. */
export function rangeMarkTexts(doc: PMNode, name: "comment" | "locked"): Map<string, { text: string; from: number; to: number }> {
  const out = new Map<string, { text: string; from: number; to: number }>();
  const type = schema.marks[name]!;
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    for (const mark of node.marks) {
      if (mark.type !== type) continue;
      const id = String(mark.attrs.id);
      const current = out.get(id);
      if (current) {
        if (pos > current.to) current.text += pos - current.to > 1 ? " … " : "";
        current.text += node.text ?? "";
        current.to = pos + node.nodeSize;
      } else {
        out.set(id, { text: node.text ?? "", from: pos, to: pos + node.nodeSize });
      }
    }
    return false;
  });
  return out;
}

export { BLOCK_SEPARATOR };
