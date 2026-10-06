import MarkdownIt from "markdown-it";
type Token = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];
import markPlugin from "markdown-it-mark";
import { Fragment, type Mark, type Node as PMNode } from "prosemirror-model";
import { ALIGNMENTS, MARKDOWN_MARKS, MAX_INDENT, safeHref, schema, type Align } from "@/lib/doc/schema";

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

type InlinePiece = { kind: "text"; text: string; marks: Mark[] } | { kind: "break"; marks: Mark[] };

export function serializeInline(node: PMNode, options: InlineOptions): string {
  const pieces: InlinePiece[] = [];
  node.forEach((child) => {
    const marks = child.marks.filter((mark) => MARKDOWN_MARKS.has(mark.type.name));
    if (child.isText) pieces.push({ kind: "text", text: child.text ?? "", marks });
    else if (child.type.name === "hard_break") pieces.push({ kind: "break", marks });
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
  pieces.forEach((piece, index) => {
    const marks = piece.marks;
    const codeMark = marks.find((mark) => mark.type.name === "code");
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

    for (let i = active.length - 1; i >= keep; i -= 1) out += closeDelimiter(active[i]!);
    active.length = keep;
    out += leading;

    const opening = marks
      .filter((mark) => mark.type.name !== "code" && !active.some((m) => m.eq(mark)))
      .sort((a, b) => runLength(b, index) - runLength(a, index) || markRank(a) - markRank(b));
    for (const mark of opening) {
      out += openDelimiter(mark);
      active.push(mark);
    }

    if (piece.kind === "break") {
      out += "<br>";
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

    if (codeMark) {
      const fence = "`".repeat(longestRun(text, "`") + 1);
      const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
      out += `${fence}${pad}${text}${pad}${fence}`;
    } else {
      const atStart = options.atLineStart && out.length === 0;
      out += escapeText(text, { atLineStart: atStart, inTable: options.inTable });
    }

    if (trailing) {
      const next = pieces[index + 1];
      let close = active.length;
      while (close > 0 && (!next || !next.marks.some((m) => m.eq(active[close - 1]!)))) close -= 1;
      for (let i = active.length - 1; i >= close; i -= 1) out += closeDelimiter(active[i]!);
      active.length = close;
      out += trailing;
    }
  });
  for (let i = active.length - 1; i >= 0; i -= 1) out += closeDelimiter(active[i]!);
  // A trailing "{...}" would be read back as block attributes.
  return out.replace(/\{([^{}]*)\}$/, "\\{$1}");
}

function escapeText(text: string, options: { atLineStart: boolean; inTable?: boolean }) {
  let out = "";
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
  }
  return parser;
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
    if (nonEmpty[0]?.type === "image" && (nonEmpty.length === 1 || (nonEmpty.length === 2 && nonEmpty[1]!.type === "text" && ATTR_SUFFIX.test(nonEmpty[1]!.content)))) {
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
          // Inline images are not supported inside text; keep the alt text.
          const alt = token.children?.map((child) => child.content).join("") || token.content;
          pushText(alt);
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
