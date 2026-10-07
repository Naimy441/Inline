import MarkdownIt from "markdown-it";
type Token = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];
import markPlugin from "markdown-it-mark";
import { Fragment, type Mark, type Node as PMNode } from "prosemirror-model";
import { ALIGNMENTS, MARKDOWN_MARKS, MATH_LANGUAGE, MAX_INDENT, safeHref, schema, type Align } from "@/lib/doc/schema";

/**
 * Markdown is the agent's view of a document. Each top-level block becomes one
 * Markdown block (a single line for paragraphs and headings), blocks are
 * separated by a blank line, and the few things plain Markdown can't say are
 * written with small, well-known extensions:
 *
 *   # Annual report {.title}        title / subtitle styles, alignment, indent,
 *   Text {first-line=0.5}            first-line (or hanging=0.5) indent in inches
 *   ==highlight==  <u>underline</u>  <sup>sup</sup>  <sub>sub</sub>
 *   &nbsp;                           an intentionally empty paragraph
 *   \pagebreak                       a page break
 *   ![alt](src){width=50%}           image size and alignment
 *   $x^2$   $$ … $$                  LaTeX equations, inline and displayed
 *
 * Styling that Markdown can't express at all (colors, fonts, comments, locks)
 * is not shown; edits made through Markdown preserve it (see merge.ts).
 */

export type BlockSpan = {
  index: number;
  node: PMNode;
  /** Document position before the block. */
  pos: number;
  /** Character offsets of the block in the full Markdown text. */
  start: number;
  end: number;
  markdown: string;
};

export type SerializedDoc = {
  markdown: string;
  blocks: BlockSpan[];
};

export const BLOCK_SEPARATOR = "\n\n";
export const EMPTY_PARAGRAPH = "&nbsp;";
export const PAGE_BREAK = "\\pagebreak";

// ---------------------------------------------------------------------------
// Serializer
// ---------------------------------------------------------------------------

export function serializeDoc(doc: PMNode): SerializedDoc {
  const blocks: BlockSpan[] = [];
  let offset = 0;
  doc.forEach((node, pos, index) => {
    if (index > 0) offset += BLOCK_SEPARATOR.length;
    const markdown = serializeBlock(node);
    blocks.push({ index, node, pos, start: offset, end: offset + markdown.length, markdown });
    offset += markdown.length;
  });
  return { markdown: blocks.map((block) => block.markdown).join(BLOCK_SEPARATOR), blocks };
}

export function docToMarkdown(doc: PMNode): string {
  return serializeDoc(doc).markdown;
}

export function serializeBlocks(nodes: readonly PMNode[]): string {
  return nodes.map((node) => serializeBlock(node)).join(BLOCK_SEPARATOR);
}

export function serializeBlock(node: PMNode, context: BlockContext = {}): string {
  switch (node.type.name) {
    case "paragraph": {
      const text = serializeInline(node, { atLineStart: true });
      const suffix = attrSuffix(blockAttrTokens(node, context));
      if (!text) return suffix ? `${EMPTY_PARAGRAPH}${suffix}` : EMPTY_PARAGRAPH;
      if (text === PAGE_BREAK) return `\\${text}`;
      return `${text}${suffix}`;
    }
    case "title":
    case "subtitle": {
      const prefix = node.type.name === "title" ? "# " : "";
      const text = serializeInline(node, { atLineStart: !prefix }) || EMPTY_PARAGRAPH;
      return `${prefix}${text}${attrSuffix([`.${node.type.name}`, ...blockAttrTokens(node, context)])}`;
    }
    case "heading": {
      const level = Math.max(1, Math.min(6, Number(node.attrs.level) || 1));
      const text = serializeInline(node, { atLineStart: false });
      return `${"#".repeat(level)} ${text}${attrSuffix(blockAttrTokens(node, context))}`.trimEnd();
    }
    case "blockquote": {
      const inner: string[] = [];
      node.forEach((child) => inner.push(serializeBlock(child, context)));
      return prefixLines(inner.join(BLOCK_SEPARATOR), "> ", ">");
    }
    case "code_block": {
      const text = node.textContent;
      // A displayed equation, unless its LaTeX would end the block early.
      if (node.attrs.language === MATH_LANGUAGE && !/^\s*\$\$\s*$/m.test(text)) return `$$\n${text}\n$$`;
      const fence = longestRun(text, "`") >= 3 ? "`".repeat(longestRun(text, "`") + 1) : "```";
      return `${fence}${node.attrs.language || ""}\n${text}\n${fence}`;
    }
    case "horizontal_rule":
      return "---";
    case "page_break":
      return PAGE_BREAK;
    case "image":
      return serializeImage(node);
    case "bullet_list":
    case "ordered_list":
      return serializeList(node, context);
    case "table":
      return serializeTable(node);
    default:
      return serializeInline(node, { atLineStart: true });
  }
}

type BlockContext = { inTable?: boolean };

function blockAttrTokens(node: PMNode, context: BlockContext): string[] {
  const tokens: string[] = [];
  const align = node.attrs.align as Align | undefined;
  if (!context.inTable && align && align !== "left") tokens.push(`align=${align}`);
  const indent = Number(node.attrs.indent) || 0;
  if (indent > 0) tokens.push(`indent=${indent}`);
  const textIndent = Number(node.attrs.textIndent) || 0;
  if (textIndent > 0) tokens.push(`first-line=${textIndent}`);
  if (textIndent < 0) tokens.push(`hanging=${-textIndent}`);
  if (node.attrs.dir === "rtl") tokens.push("dir=rtl");
  return tokens;
}

function attrSuffix(tokens: string[]) {
  return tokens.length ? ` {${tokens.join(" ")}}` : "";
}

function serializeImage(node: PMNode) {
  const alt = escapeLinkText(node.attrs.alt || "");
  const title = node.attrs.title ? ` "${String(node.attrs.title).replace(/"/g, '\\"')}"` : "";
  const tokens: string[] = [];
  if (node.attrs.width) tokens.push(`width=${node.attrs.width}`);
  if (node.attrs.align && node.attrs.align !== "center") tokens.push(`align=${node.attrs.align}`);
  return `![${alt}](${formatUrl(node.attrs.src || "")}${title})${tokens.length ? `{${tokens.join(" ")}}` : ""}`;
}

function serializeList(node: PMNode, context: BlockContext): string {
  const ordered = node.type.name === "ordered_list";
  const start = Number(node.attrs.order) || 1;
  const items: string[] = [];
  let tight = true;
  node.forEach((item, _offset, index) => {
    const marker = ordered ? `${start + index}. ` : "- ";
    const checkbox = item.attrs.checked == null ? "" : item.attrs.checked ? "[x] " : "[ ] ";
    let body = "";
    let textBlocks = 0;
    item.forEach((child, _o, childIndex) => {
      const isList = child.type.name === "bullet_list" || child.type.name === "ordered_list";
      if (!isList) textBlocks += 1;
      // A nested list directly under the item's text stays tight; other blocks need a blank line.
      if (childIndex > 0) body += isList ? "\n" : BLOCK_SEPARATOR;
      body += serializeBlock(child, context);
    });
    if (textBlocks > 1) tight = false;
    const indent = " ".repeat(marker.length);
    const lines = body.split("\n");
    const first = `${marker}${checkbox}${lines[0] === EMPTY_PARAGRAPH && checkbox ? "" : lines[0]}`;
    const rest = lines.slice(1).map((line) => (line ? `${indent}${line}` : ""));
    items.push([first, ...rest].join("\n"));
  });
  return items.join(tight ? "\n" : "\n\n");
}

function serializeTable(table: PMNode): string {
  const rows: string[][] = [];
  const aligns: Array<Align | null> = [];
  table.forEach((row) => {
    const cells: string[] = [];
    row.forEach((cell, _offset, column) => {
      const parts: string[] = [];
      cell.forEach((child) => {
        const text = child.isTextblock ? serializeInline(child, { atLineStart: false, inTable: true }) : serializeBlock(child, { inTable: true }).replace(/\n+/g, " ");
        parts.push(text);
      });
      cells.push(parts.filter((part, index) => part || index === 0).join("<br>"));
      const first = cell.firstChild;
      const align = (first?.attrs.align as Align | undefined) ?? "left";
      if (aligns[column] === undefined) aligns[column] = align;
      else if (aligns[column] !== align) aligns[column] = null;
    });
    rows.push(cells);
  });
  const columns = Math.max(1, ...rows.map((row) => row.length));
  const pad = (row: string[]) => [...row, ...Array(columns - row.length).fill("")];
  const line = (row: string[]) => `| ${pad(row).map((cell) => cell || " ").join(" | ")} |`.replace(/ {2,}\|/g, "  |");
  const divider = Array.from({ length: columns }, (_, column) => {
    const align = aligns[column];
    if (align === "center") return ":---:";
    if (align === "right") return "---:";
    return "---";
  });
  const [header = [], ...body] = rows;
  return [line(header), `| ${divider.join(" | ")} |`, ...body.map(line)].join("\n");
}

function prefixLines(text: string, prefix: string, blankPrefix: string) {
  return text
    .split("\n")
    .map((line) => (line ? `${prefix}${line}` : blankPrefix))
    .join("\n");
}

function longestRun(text: string, char: string) {
  let best = 0;
  let run = 0;
  for (const c of text) {
    run = c === char ? run + 1 : 0;
    best = Math.max(best, run);
  }
  return best;
}

// --- inline ---------------------------------------------------------------

type InlineOptions = { atLineStart: boolean; inTable?: boolean };

const MARK_ORDER = ["link", "bold", "italic", "strike", "underline", "highlight", "superscript", "subscript", "code"];

function markRank(mark: Mark) {
  const index = MARK_ORDER.indexOf(mark.type.name);
  return index < 0 ? MARK_ORDER.length : index;
}

const PUNCTUATION = /[\p{P}\p{S}]/u;
const flanks = (before: string, after: string) => {
  const space = (char: string) => !char || /\s/.test(char);
  const punct = (char: string) => Boolean(char) && PUNCTUATION.test(char);
  // CommonMark: * opens when left-flanking and closes when right-flanking.
  return {
    left: !space(after) && (!punct(after) || space(before) || punct(before)),
    right: !space(before) && (!punct(before) || space(after) || punct(after)),
  };
};

/**
 * Whether a * delimiter can open a span starting at `pieces[index]` (whose
 * text is `text`) after what's written so far, and close it after `length`
 * pieces.
 */
function starFits(out: string, pieces: InlinePiece[], index: number, length: number, text: string) {
  const first = text.charAt(0) || (pieces[index]?.kind === "text" ? "" : "a");
  if (!flanks(out.slice(-1), first).left) return false;
  const last = pieces[index + length - 1];
  const lastText = last?.kind === "text" ? last.text.replace(/\s+$/, "") : "a";
  const trailingSpace = last?.kind === "text" && /\s$/.test(last.text);
  const after = pieces[index + length];
  const next = trailingSpace ? " " : after?.kind === "text" ? after.text.charAt(0) : after ? "a" : "";
  return flanks(lastText.slice(-1), next).right;
}

function openDelimiter(mark: Mark): string {
  switch (mark.type.name) {
    case "bold":
      return "**";
    case "italic":
      return "*";
    case "strike":
      return "~~";
    case "underline":
      return "<u>";
    case "highlight":
      return "==";
    case "superscript":
      return "<sup>";
    case "subscript":
      return "<sub>";
    case "link":
      return "[";
    default:
      return "";
  }
}

function closeDelimiter(mark: Mark): string {
  switch (mark.type.name) {
    case "bold":
      return "**";
    case "italic":
      return "*";
    case "strike":
      return "~~";
    case "underline":
      return "</u>";
    case "highlight":
      return "==";
    case "superscript":
      return "</sup>";
    case "subscript":
      return "</sub>";
    case "link": {
      const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : "";
      return `](${formatUrl(mark.attrs.href || "")}${title})`;
    }
    default:
      return "";
  }
}

type InlinePiece = { kind: "text"; text: string; marks: Mark[] } | { kind: "break"; marks: Mark[] } | { kind: "image"; markdown: string; marks: Mark[] };

export function serializeInline(node: PMNode, options: InlineOptions): string {
  const pieces: InlinePiece[] = [];
  node.forEach((child) => {
    const marks = child.marks.filter((mark) => MARKDOWN_MARKS.has(mark.type.name));
    if (child.isText) pieces.push({ kind: "text", text: child.text ?? "", marks });
    else if (child.type.name === "hard_break") pieces.push({ kind: "break", marks });
    // A picture in a line of text (an icon) is written where it sits; its size and fade come back from the old one when Claude edits.
    else if (child.type.name === "inline_image") pieces.push({ kind: "image", markdown: `![${escapeLinkText(String(child.attrs.alt || ""))}](${formatUrl(String(child.attrs.src || ""))})`, marks });
  });
  // Markdown can't open or close emphasis at spaces alone, so a space formatted unlike the text around it (as
  // Google Docs often leaves one) keeps only the formatting it shares with the text on both sides.
  pieces.forEach((piece, index) => {
    if (piece.kind !== "text" || piece.text.trim() || piece.marks.some((mark) => mark.type.name === "code" || mark.type.name === "math")) return;
    const shared = (other: InlinePiece | undefined, mark: Mark) => Boolean(other?.marks.some((item) => item.eq(mark)));
    piece.marks = piece.marks.filter((mark) => shared(pieces[index - 1], mark) && shared(pieces[index + 1], mark));
  });

  // How far (in pieces) each mark keeps going from a given piece; longer-running marks open first.
  const runLength = (mark: Mark, from: number) => {
    let count = 0;
    for (let i = from; i < pieces.length; i += 1) {
      if (!pieces[i]!.marks.some((m) => m.eq(mark))) break;
      count += 1;
    }
    return count;
  };

  let out = "";
  const active: Mark[] = [];
  const tagged = new Set<Mark>();
  const close = (mark: Mark) => {
    if (!tagged.delete(mark)) return closeDelimiter(mark);
    return mark.type.name === "bold" ? "</strong>" : "</em>";
  };
  const closeMark = close;
  pieces.forEach((piece, index) => {
    const marks = piece.marks;
    const codeMark = marks.find((mark) => mark.type.name === "code" || mark.type.name === "math");
    let keep = 0;
    while (keep < active.length && marks.some((mark) => mark.eq(active[keep]!))) keep += 1;

    let text = piece.kind === "text" ? piece.text : "";
    let leading = "";
    if (piece.kind === "text" && !codeMark) {
      // Keep whitespace outside of emphasis delimiters (`** bold**` is not bold in Markdown).
      const match = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (match && (keep < active.length || marks.length > keep)) {
        leading = match[1] ?? "";
        text = `${match[2] ?? ""}${match[3] ?? ""}`;
      }
    }

    for (let i = active.length - 1; i >= keep; i -= 1) out += close(active[i]!);
    active.length = keep;
    out += leading;

    const opening = marks
      .filter((mark) => mark.type.name !== "code" && mark.type.name !== "math" && !active.some((m) => m.eq(mark)))
      .sort((a, b) => runLength(b, index) - runLength(a, index) || markRank(a) - markRank(b));
    for (const mark of opening) {
      // Bold or italic whose * couldn't open or close where it falls (between a letter and punctuation,
      // as in "HackDuke*: 1st*") is written as its HTML tag, which Markdown reads anywhere.
      if ((mark.type.name === "bold" || mark.type.name === "italic") && !starFits(out, pieces, index, runLength(mark, index), text)) {
        tagged.add(mark);
        out += mark.type.name === "bold" ? "<strong>" : "<em>";
      } else out += openDelimiter(mark);
      active.push(mark);
    }

    if (piece.kind === "break") {
      out += "<br>";
      return;
    }
    if (piece.kind === "image") {
      out += piece.markdown;
      return;
    }

    let trailing = "";
    if (!codeMark && active.length) {
      const next = pieces[index + 1];
      const closesAfter = active.some((mark) => !next || !next.marks.some((m) => m.eq(mark)));
      if (closesAfter) {
        const match = text.match(/^([\s\S]*?)(\s*)$/);
        text = match?.[1] ?? text;
        trailing = match?.[2] ?? "";
      }
    }

    if (codeMark?.type.name === "math") {
      // LaTeX goes between dollar signs as it is (a literal dollar sign in LaTeX is already \$).
      out += `$${text}$`;
    } else if (codeMark) {
      const fence = "`".repeat(longestRun(text, "`") + 1);
      const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
      out += `${fence}${pad}${text}${pad}${fence}`;
    } else {
      const atStart = options.atLineStart && out.length === 0;
      out += escapeText(text, { atLineStart: atStart, inTable: options.inTable });
    }

    if (trailing) {
      // Close every mark from the outermost one that ends here: an inner mark that carries on is reopened after the spaces.
      const next = pieces[index + 1];
      let close = active.findIndex((mark) => !next || !next.marks.some((m) => m.eq(mark)));
      if (close < 0) close = active.length;
      for (let i = active.length - 1; i >= close; i -= 1) out += closeMark(active[i]!);
      active.length = close;
      out += trailing;
    }
  });
  for (let i = active.length - 1; i >= 0; i -= 1) out += close(active[i]!);
  // Markdown drops spaces and tabs at either end of a paragraph (and a tab first makes it code), so those
  // are written as character references; a trailing "{...}" would be read back as block attributes.
  const ends = (text: string) => text.replace(/[ \t]/g, (char) => (char === "\t" ? "&#9;" : "&#32;"));
  return out
    .replace(/^[ \t]+/, (lead) => (options.atLineStart && lead.includes("\t") ? ends(lead) : lead))
    .replace(/(?<=\S)[ \t]+$/, (tail) => (tail.includes("\t") ? ends(tail) : tail))
    .replace(/\{([^{}]*)\}$/, "\\{$1}");
}

function escapeText(text: string, options: { atLineStart: boolean; inTable?: boolean }) {
  let out = "";
  // Two dollar signs could pair up as an equation; one alone ("$5") can't.
  const dollars = (text.match(/\$/g) ?? []).length > 1;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    const prev = text[i - 1] ?? "";
    const next = text[i + 1] ?? "";
    switch (ch) {
      case "\\":
      case "*":
      case "`":
        out += `\\${ch}`;
        break;
      case "_":
        out += /\w/.test(prev) && /\w/.test(next) ? ch : `\\${ch}`;
        break;
      case "~":
      case "=":
        out += prev === ch || next === ch ? `\\${ch}` : ch;
        break;
      case "[":
        out += /^\[[^\]]*\]\(/.test(text.slice(i)) || /^\[[^\]]*\]$/.test(text.slice(i)) ? "\\[" : ch;
        break;
      case "!":
        out += next === "[" ? "\\!" : ch;
        break;
      case "<":
        out += /[A-Za-z/!?]/.test(next) ? "\\<" : ch;
        break;
      case "&":
        out += /^&(#\d+|#x[\da-f]+|[a-z][a-z\d]*);/i.test(text.slice(i)) ? "\\&" : ch;
        break;
      case "|":
        out += options.inTable ? "\\|" : ch;
        break;
      case "$":
        out += dollars ? "\\$" : ch;
        break;
      case "\n":
        out += " ";
        break;
      default:
        out += ch;
    }
  }
  if (options.atLineStart) {
    out = out
      .replace(/^(#{1,6})(\s|$)/, "\\$1$2")
      .replace(/^([>+-])(\s|$)/, "\\$1$2")
      .replace(/^(\d+)([.)])(\s|$)/, "$1\\$2$3")
      .replace(/^(-{3,}|_{3,})\s*$/, "\\$1")
      .replace(/^(\s+)/, (spaces) => spaces.replace(/ /g, "&#32;"));
  }
  return out;
}

function escapeLinkText(text: string) {
  return text.replace(/([\\[\]])/g, "\\$1");
}

function formatUrl(url: string) {
  if (/[\s()<>]/.test(url)) return `<${url.replace(/[<>]/g, encodeURIComponent)}>`;
  return url;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

let parser: InstanceType<typeof MarkdownIt> | null = null;

function markdownParser() {
  if (!parser) {
    parser = new MarkdownIt("commonmark", { html: true, linkify: false, typographer: false });
    parser.enable(["table", "strikethrough"]);
    parser.use(markPlugin);
    parser.use(mathPlugin);
  }
  return parser;
}

/**
 * LaTeX math: $inline$ and $$display$$, with pandoc's rules so prices don't
 * turn into equations: the opening $ is followed by a non-space, the closing
 * one follows a non-space and isn't followed by a digit. A $$ line, the LaTeX
 * and a closing $$ line (or $$…$$ alone on a line) is a displayed equation.
 */
function mathPlugin(md: InstanceType<typeof MarkdownIt>) {
  md.inline.ruler.after("escape", "math_inline", (state, silent) => {
    const src = state.src;
    const start = state.pos;
    if (src.charCodeAt(start) !== 0x24) return false;
    const double = src.charCodeAt(start + 1) === 0x24;
    const open = double ? 2 : 1;
    const first = src[start + open];
    if (!first || /\s/.test(first) || first === "$") return false;
    let pos = start + open;
    while (pos < src.length) {
      const ch = src[pos];
      if (ch === "\\") pos += 2;
      else if (ch === "$" && (!double || src[pos + 1] === "$")) break;
      else pos += 1;
    }
    if (pos >= src.length) return false;
    const content = src.slice(start + open, pos);
    if (/\s$/.test(content) || (!double && /\d/.test(src[pos + 1] ?? ""))) return false;
    if (!silent) {
      const token = state.push("math_inline", "math", 0);
      token.content = content;
      token.markup = double ? "$$" : "$";
    }
    state.pos = pos + open;
    return true;
  });
  md.block.ruler.before(
    "fence",
    "math_block",
    (state, startLine, endLine, silent) => {
      if (state.sCount[startLine]! - state.blkIndent >= 4) return false;
      const lineText = (line: number) => state.src.slice(state.bMarks[line]! + state.tShift[line]!, state.eMarks[line]).trim();
      const first = lineText(startLine);
      if (!first.startsWith("$$")) return false;
      let content: string;
      let next: number;
      if (first !== "$$" && first.length > 4 && first.endsWith("$$") && !first.slice(2, -2).includes("$$")) {
        content = first.slice(2, -2).trim();
        next = startLine + 1;
      } else if (first === "$$") {
        let line = startLine + 1;
        while (line < endLine && lineText(line) !== "$$") line += 1;
        if (line >= endLine) return false;
        const lines: string[] = [];
        for (let i = startLine + 1; i < line; i += 1) lines.push(state.src.slice(state.bMarks[i]! + Math.min(state.tShift[i]!, state.blkIndent), state.eMarks[i]));
        content = lines.join("\n");
        next = line + 1;
      } else return false;
      if (silent) return true;
      const token = state.push("math_block", "math", 0);
      token.block = true;
      token.content = content;
      token.map = [startLine, next];
      state.line = next;
      return true;
    },
    { alt: ["paragraph", "reference", "blockquote", "list"] },
  );
}

export class MarkdownParseError extends Error {}

/** Parse Markdown (in the dialect `serializeDoc` writes) into document blocks. */
export function parseMarkdown(markdown: string): PMNode[] {
  const tokens = markdownParser().parse(markdown.replace(/\r\n?/g, "\n"), {});
  const builder = new BlockBuilder(tokens);
  return builder.build();
}

export function markdownToDoc(markdown: string): PMNode {
  const blocks = parseMarkdown(markdown);
  return schema.node("doc", null, blocks.length ? blocks : [schema.node("paragraph")]);
}

type AttrSpec = { classes: string[]; values: Record<string, string> };

const ATTR_SUFFIX = /\s*\{((?:\s*(?:\.[A-Za-z][\w-]*|[A-Za-z][\w-]*=(?:"[^"]*"|[^\s{}]+)))+)\s*\}\s*$/;

function parseAttrSpec(raw: string): AttrSpec {
  const spec: AttrSpec = { classes: [], values: {} };
  for (const match of raw.matchAll(/\.([A-Za-z][\w-]*)|([A-Za-z][\w-]*)=("[^"]*"|[^\s{}]+)/g)) {
    if (match[1]) spec.classes.push(match[1].toLowerCase());
    else if (match[2]) spec.values[match[2].toLowerCase()] = (match[3] ?? "").replace(/^"|"$/g, "");
  }
  return spec;
}

class BlockBuilder {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  build(): PMNode[] {
    return this.blocksUntil(null);
  }

  private blocksUntil(closeType: string | null): PMNode[] {
    const blocks: PMNode[] = [];
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index]!;
      if (closeType && token.type === closeType) {
        this.index += 1;
        return blocks;
      }
      const block = this.block(token);
      if (block) blocks.push(...(Array.isArray(block) ? block : [block]));
    }
    return blocks;
  }

  private block(token: Token): PMNode | PMNode[] | null {
    switch (token.type) {
      case "paragraph_open": {
        const inline = this.tokens[this.index + 1];
        this.index += 3;
        return this.paragraph(inline?.children ?? []);
      }
      case "heading_open": {
        const inline = this.tokens[this.index + 1];
        this.index += 3;
        const level = Number(token.tag.slice(1)) || 1;
        return this.textblock("heading", inline?.children ?? [], { level });
      }
      case "blockquote_open": {
        this.index += 1;
        const children = this.blocksUntil("blockquote_close");
        return schema.node("blockquote", null, children.length ? children : [schema.node("paragraph")]);
      }
      case "bullet_list_open":
      case "ordered_list_open": {
        this.index += 1;
        const ordered = token.type === "ordered_list_open";
        const items = this.listItems(ordered ? "ordered_list_close" : "bullet_list_close");
        if (!items.length) return null;
        return ordered
          ? schema.node("ordered_list", { order: Number(token.attrGet("start") ?? 1) || 1 }, items)
          : schema.node("bullet_list", null, items);
      }
      case "math_block":
        this.index += 1;
        return schema.node("code_block", { language: MATH_LANGUAGE }, token.content ? schema.text(token.content) : undefined);
      case "fence":
      case "code_block": {
        this.index += 1;
        const text = token.content.replace(/\n$/, "");
        const language = token.info.trim().split(/\s+/)[0] ?? "";
        return schema.node("code_block", { language }, text ? schema.text(text) : undefined);
      }
      case "hr":
        this.index += 1;
        return schema.node("horizontal_rule");
      case "table_open": {
        this.index += 1;
        return this.table();
      }
      case "html_block": {
        this.index += 1;
        const content = token.content.trim();
        if (!content) return null;
        const inline = markdownParser().parseInline(content, {})[0]?.children ?? [];
        return this.paragraph(inline);
      }
      default:
        this.index += 1;
        return null;
    }
  }

  private listItems(closeType: string): PMNode[] {
    const items: PMNode[] = [];
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index]!;
      if (token.type === closeType) {
        this.index += 1;
        break;
      }
      if (token.type !== "list_item_open") {
        this.index += 1;
        continue;
      }
      this.index += 1;
      let children = this.blocksUntil("list_item_close");
      let checked: boolean | null = null;
      const first = children[0];
      if (first && first.type.name === "paragraph") {
        const text = first.textContent;
        const task = text.match(/^\[([ xX])\](\s|$)/);
        if (task) {
          checked = task[1] !== " ";
          const strip = task[0].length;
          const rest = first.content.cut(Math.min(strip, first.content.size));
          children = [first.type.create(first.attrs, rest), ...children.slice(1)];
        }
      }
      if (!children.length || children[0]!.type.name !== "paragraph") {
        children = [schema.node("paragraph"), ...children];
      }
      items.push(schema.node("list_item", { checked }, children));
    }
    return items;
  }

  private table(): PMNode | null {
    const rows: PMNode[] = [];
    let current: PMNode[] = [];
    while (this.index < this.tokens.length) {
      const token = this.tokens[this.index]!;
      this.index += 1;
      if (token.type === "table_close") break;
      if (token.type === "tr_open") current = [];
      else if (token.type === "tr_close") rows.push(schema.nodes.table_row!.create(null, current));
      else if (token.type === "th_open" || token.type === "td_open") {
        const inline = this.tokens[this.index];
        this.index += 2; // inline + close
        const style = String(token.attrGet("style") ?? "");
        const align = (style.match(/text-align:\s*(\w+)/)?.[1] ?? "left") as Align;
        const paragraphs = splitOnBreaks(inline?.children ?? []).map((part) => {
          const content = trimFragment(this.inline(part));
          return schema.node("paragraph", { align: ALIGNMENTS.includes(align) ? align : "left" }, content);
        });
        const type = token.type === "th_open" ? schema.nodes.table_header! : schema.nodes.table_cell!;
        current.push(type.create(null, paragraphs.length ? paragraphs : [schema.node("paragraph")]));
      }
    }
    if (!rows.length) return null;
    const width = Math.max(...rows.map((row) => row.childCount));
    const normalized = rows.map((row) => {
      if (row.childCount >= width) return row;
      const cells: PMNode[] = [];
      row.forEach((cell) => cells.push(cell));
      while (cells.length < width) cells.push(schema.nodes.table_cell!.create(null, [schema.node("paragraph")]));
      return row.type.create(row.attrs, cells);
    });
    return schema.node("table", null, normalized);
  }

  private paragraph(children: Token[]): PMNode {
    const nonEmpty = children.filter((token) => !(token.type === "text" && !token.content.trim()));
    // A paragraph that is only an image (plus optional {attrs}) is an image block.
    if (nonEmpty[0]?.type === "image" && (nonEmpty.length === 1 || (nonEmpty.length === 2 && nonEmpty[1]!.type === "text" && ATTR_SUFFIX.test(nonEmpty[1]!.content) && !nonEmpty[1]!.content.replace(ATTR_SUFFIX, "").trim()))) {
      const image = nonEmpty[0]!;
      const spec = nonEmpty[1] ? parseAttrSpec(nonEmpty[1].content.match(ATTR_SUFFIX)?.[1] ?? "") : { classes: [], values: {} };
      const align = spec.values.align as Align | undefined;
      return schema.node("image", {
        src: image.attrGet("src") ?? "",
        alt: image.children?.map((child) => child.content).join("") || image.content || "",
        title: image.attrGet("title") ?? "",
        width: spec.values.width ?? null,
        align: align && ALIGNMENTS.includes(align) ? align : "center",
      });
    }
    const text = children.map((token) => (token.type === "text" ? token.content : "")).join("").trim();
    if (children.length === 1 && children[0]!.type === "text" && text === PAGE_BREAK) {
      return schema.node("page_break");
    }
    return this.textblock("paragraph", children, {});
  }

  private textblock(type: "paragraph" | "heading", children: Token[], attrs: Record<string, unknown>): PMNode {
    const { tokens, spec } = stripAttrSuffix(children);
    let nodeType: string = type;
    const nodeAttrs: Record<string, unknown> = { ...attrs };
    if (spec) {
      if (spec.classes.includes("title")) nodeType = "title";
      else if (spec.classes.includes("subtitle")) nodeType = "subtitle";
      const align = spec.values.align as Align | undefined;
      if (align && ALIGNMENTS.includes(align)) nodeAttrs.align = align;
      const indent = Number(spec.values.indent);
      if (Number.isFinite(indent) && indent > 0) nodeAttrs.indent = Math.min(MAX_INDENT, Math.round(indent));
      const firstLine = Number(spec.values["first-line"]);
      const hanging = Number(spec.values.hanging);
      if (Number.isFinite(firstLine) && firstLine > 0) nodeAttrs.textIndent = Math.min(3, firstLine);
      else if (Number.isFinite(hanging) && hanging > 0) nodeAttrs.textIndent = -Math.min(3, hanging);
      if (spec.values.dir === "rtl") nodeAttrs.dir = "rtl";
    }
    if (nodeType !== "heading") delete nodeAttrs.level;
    let content = this.inline(tokens);
    if (content.childCount === 1 && content.firstChild!.isText && /^ +$/.test(content.firstChild!.text ?? "")) {
      content = Fragment.empty;
    }
    return schema.nodes[nodeType]!.create(nodeAttrs, content);
  }

  private inline(tokens: Token[]): Fragment {
    const nodes: PMNode[] = [];
    const marks: Mark[] = [];
    const add = (mark: Mark) => {
      const index = marks.findIndex((m) => m.type === mark.type);
      if (index >= 0) marks.splice(index, 1);
      marks.push(mark);
    };
    const remove = (name: string) => {
      for (let i = marks.length - 1; i >= 0; i -= 1) {
        if (marks[i]!.type.name === name) {
          marks.splice(i, 1);
          return;
        }
      }
    };
    const pushText = (text: string, extra: Mark[] = []) => {
      if (!text) return;
      let set = schema.text(text).marks;
      for (const mark of [...marks, ...extra]) set = mark.addToSet(set);
      nodes.push(schema.text(text, set));
    };
    for (const token of tokens) {
      switch (token.type) {
        case "text":
          pushText(token.content);
          break;
        case "softbreak":
          pushText(" ");
          break;
        case "hardbreak":
          nodes.push(schema.node("hard_break"));
          break;
        case "code_inline":
          pushText(token.content, [schema.mark("code")]);
          break;
        case "math_inline":
          pushText(token.content, [schema.mark("math")]);
          break;
        case "strong_open":
          add(schema.mark("bold"));
          break;
        case "strong_close":
          remove("bold");
          break;
        case "em_open":
          add(schema.mark("italic"));
          break;
        case "em_close":
          remove("italic");
          break;
        case "s_open":
          add(schema.mark("strike"));
          break;
        case "s_close":
          remove("strike");
          break;
        case "mark_open":
          add(schema.mark("highlight"));
          break;
        case "mark_close":
          remove("highlight");
          break;
        case "link_open":
          {
            const href = safeHref(token.attrGet("href"));
            if (href) add(schema.mark("link", { href, title: token.attrGet("title") || null }));
          }
          break;
        case "link_close":
          remove("link");
          break;
        case "image": {
          // A picture in a line of text stays in the line.
          const alt = token.children?.map((child) => child.content).join("") || token.content;
          const src = token.attrGet("src") ?? "";
          if (src) nodes.push(schema.nodes.inline_image!.create({ src, alt }, null, marks.filter((mark) => mark.type.name === "link")));
          else pushText(alt);
          break;
        }
        case "html_inline": {
          const tag = token.content.trim().toLowerCase();
          const open = tag.match(/^<(u|ins|sup|sub|mark|s|del|strike|b|strong|i|em)(\s[^>]*)?>$/);
          const close = tag.match(/^<\/(u|ins|sup|sub|mark|s|del|strike|b|strong|i|em)\s*>$/);
          if (/^<br\s*\/?>$/.test(tag)) nodes.push(schema.node("hard_break"));
          else if (open) add(schema.mark(htmlMarkName(open[1]!)));
          else if (close) remove(htmlMarkName(close[1]!));
          else pushText(token.content);
          break;
        }
        default:
          if (token.content) pushText(token.content);
      }
    }
    return Fragment.fromArray(mergeAdjacentText(nodes));
  }
}

function htmlMarkName(tag: string) {
  switch (tag) {
    case "u":
    case "ins":
      return "underline";
    case "sup":
      return "superscript";
    case "sub":
      return "subscript";
    case "mark":
      return "highlight";
    case "s":
    case "del":
    case "strike":
      return "strike";
    case "b":
    case "strong":
      return "bold";
    default:
      return "italic";
  }
}

function stripAttrSuffix(children: Token[]): { tokens: Token[]; spec: AttrSpec | null } {
  const last = children[children.length - 1];
  if (!last || last.type !== "text") return { tokens: children, spec: null };
  const match = last.content.match(ATTR_SUFFIX);
  if (!match) return { tokens: children, spec: null };
  const stripped = last.content.slice(0, match.index);
  const copy = Object.assign(Object.create(Object.getPrototypeOf(last)), last) as Token;
  copy.content = stripped;
  return { tokens: [...children.slice(0, -1), copy], spec: parseAttrSpec(match[1] ?? "") };
}

function splitOnBreaks(tokens: Token[]): Token[][] {
  const parts: Token[][] = [[]];
  for (const token of tokens) {
    if (token.type === "html_inline" && /^<br\s*\/?>$/i.test(token.content.trim())) parts.push([]);
    else parts[parts.length - 1]!.push(token);
  }
  return parts;
}

function trimFragment(fragment: Fragment): Fragment {
  const nodes: PMNode[] = [];
  fragment.forEach((node) => nodes.push(node));
  const first = nodes[0];
  if (first?.isText) {
    const text = (first.text ?? "").replace(/^\s+/, "");
    if (text) nodes[0] = schema.text(text, first.marks);
    else nodes.shift();
  }
  const last = nodes[nodes.length - 1];
  if (last?.isText) {
    const text = (last.text ?? "").replace(/\s+$/, "");
    if (text) nodes[nodes.length - 1] = schema.text(text, last.marks);
    else nodes.pop();
  }
  return Fragment.fromArray(nodes);
}

function mergeAdjacentText(nodes: PMNode[]): PMNode[] {
  const out: PMNode[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.isText && node.isText && prev.sameMarkup(node)) {
      out[out.length - 1] = schema.text((prev.text ?? "") + (node.text ?? ""), prev.marks);
    } else {
      out.push(node);
    }
  }
  return out;
}
