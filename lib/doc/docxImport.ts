import type { Mark, Node as PMNode } from "prosemirror-model";
import { schema, type Align } from "@/lib/doc/schema";

/**
 * Reads a Word document (.docx, already unzipped into its parts) into an
 * Inline document: paragraphs and headings with their alignment, bold,
 * italic, underline, strikethrough, super/subscript, colors and highlights,
 * hyperlinks, bulleted and numbered lists, tables, line and page breaks,
 * and images (handed to `saveImage`, which returns the URL to use).
 *
 * Anything Inline has no equivalent for (text boxes, fields, footnotes) is
 * read as its plain text where it has any.
 */

export type DocxParts = Map<string, Uint8Array>;
export type SaveImage = (data: Uint8Array, mime: string) => Promise<string | null>;

// --- a tiny XML reader ---------------------------------------------------------

type XmlElement = { name: string; attrs: Record<string, string>; children: XmlNode[] };
type XmlNode = XmlElement | string;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decodeEntities(text: string) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

export function parseXml(xml: string): XmlElement {
  const root: XmlElement = { name: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>/g;
  let last = 0;
  for (let match = tag.exec(xml); match; match = tag.exec(xml)) {
    const text = xml.slice(last, match.index);
    if (text) stack[stack.length - 1]!.children.push(decodeEntities(text));
    last = tag.lastIndex;
    if (match[5] !== undefined) {
      stack[stack.length - 1]!.children.push(match[5]);
      continue;
    }
    if (!match[2]) continue;
    const [, closing, name, rawAttrs, selfClosing] = match;
    if (closing) {
      for (let i = stack.length - 1; i > 0; i -= 1) {
        if (stack[i]!.name === name) {
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const attr of rawAttrs!.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[attr[1]!] = decodeEntities(attr[2] ?? attr[3] ?? "");
    const element: XmlElement = { name: name!, attrs, children: [] };
    stack[stack.length - 1]!.children.push(element);
    if (!selfClosing) stack.push(element);
  }
  return root;
}

const elements = (node: XmlElement, name?: string) => node.children.filter((child): child is XmlElement => typeof child !== "string" && (!name || child.name === name));
const child = (node: XmlElement | undefined, name: string) => node?.children.find((item): item is XmlElement => typeof item !== "string" && item.name === name);
const val = (node: XmlElement | undefined) => node?.attrs["w:val"];

/** A boolean run property: present means on, unless w:val says false. */
function flag(props: XmlElement | undefined, name: string) {
  const element = child(props, name);
  if (!element) return undefined;
  const value = val(element);
  return !(value === "0" || value === "false" || value === "none");
}

function textOf(node: XmlElement): string {
  return node.children.map((item) => (typeof item === "string" ? (node.name === "w:t" ? item : "") : textOf(item))).join("");
}

// --- styles, numbering, relationships ------------------------------------------------

type StyleInfo = { kind: "title" | "subtitle" | "heading" | "code" | "quote" | null; level?: number; bold?: boolean; italic?: boolean; basedOn?: string; numId?: string };

type Context = {
  styles: Map<string, StyleInfo>;
  /** numId → level → is it a bullet list? */
  numbering: Map<string, Map<number, { bullet: boolean; start: number }>>;
  rels: Map<string, { target: string; external: boolean }>;
  parts: DocxParts;
  saveImage?: SaveImage;
};

function readPart(parts: DocxParts, name: string) {
  const data = parts.get(name);
  return data ? new TextDecoder().decode(data) : null;
}

function classifyStyle(id: string, name: string): StyleInfo["kind"] {
  const key = `${id} ${name}`.toLowerCase();
  if (/\bsubtitle\b/.test(key)) return "subtitle";
  if (/\btitle\b/.test(key)) return "title";
  if (/heading\s*\d|^heading/.test(key)) return "heading";
  if (/\b(code|source|preformatted|html ?pre)/.test(key)) return "code";
  if (/\b(quote|block ?text)\b/.test(key)) return "quote";
  return null;
}

function readStyles(parts: DocxParts) {
  const styles = new Map<string, StyleInfo>();
  const xml = readPart(parts, "word/styles.xml");
  if (!xml) return styles;
  for (const style of elements(child(parseXml(xml), "w:styles") ?? { name: "", attrs: {}, children: [] }, "w:style")) {
    const id = style.attrs["w:styleId"];
    if (!id) continue;
    const name = val(child(style, "w:name")) ?? id;
    const level = /heading\s*(\d)/i.exec(`${id} ${name}`)?.[1];
    const pPr = child(style, "w:pPr");
    const outline = val(child(pPr, "w:outlineLvl"));
    const rPr = child(style, "w:rPr");
    let kind = classifyStyle(id, name);
    if (!kind && outline != null && Number(outline) < 6) kind = "heading";
    styles.set(id, {
      kind,
      level: level ? Number(level) : outline != null ? Number(outline) + 1 : undefined,
      bold: flag(rPr, "w:b"),
      italic: flag(rPr, "w:i"),
      basedOn: val(child(style, "w:basedOn")),
      numId: val(child(child(pPr, "w:numPr"), "w:numId")),
    });
  }
  return styles;
}

function styleInfo(ctx: Context, id: string | undefined): StyleInfo {
  const seen = new Set<string>();
  let current = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const style = ctx.styles.get(current);
    if (!style) break;
    if (style.kind) return style;
    current = style.basedOn;
  }
  return (id && ctx.styles.get(id)) || { kind: null };
}

function readNumbering(parts: DocxParts) {
  const result = new Map<string, Map<number, { bullet: boolean; start: number }>>();
  const xml = readPart(parts, "word/numbering.xml");
  if (!xml) return result;
  const root = child(parseXml(xml), "w:numbering");
  if (!root) return result;
  const abstract = new Map<string, Map<number, { bullet: boolean; start: number }>>();
  for (const def of elements(root, "w:abstractNum")) {
    const levels = new Map<number, { bullet: boolean; start: number }>();
    for (const lvl of elements(def, "w:lvl")) {
      const format = val(child(lvl, "w:numFmt")) ?? "decimal";
      levels.set(Number(lvl.attrs["w:ilvl"] ?? 0), { bullet: format === "bullet" || format === "none", start: Number(val(child(lvl, "w:start")) ?? 1) || 1 });
    }
    abstract.set(def.attrs["w:abstractNumId"] ?? "", levels);
  }
  for (const num of elements(root, "w:num")) {
    const levels = abstract.get(val(child(num, "w:abstractNumId")) ?? "");
    if (levels) result.set(num.attrs["w:numId"] ?? "", levels);
  }
  return result;
}

function readRels(parts: DocxParts) {
  const rels = new Map<string, { target: string; external: boolean }>();
  const xml = readPart(parts, "word/_rels/document.xml.rels");
  if (!xml) return rels;
  for (const rel of elements(child(parseXml(xml), "Relationships") ?? { name: "", attrs: {}, children: [] }, "Relationship")) {
    rels.set(rel.attrs.Id ?? "", { target: rel.attrs.Target ?? "", external: rel.attrs.TargetMode === "External" });
  }
  return rels;
}

// --- body ------------------------------------------------------------------------------

const HIGHLIGHTS: Record<string, string> = {
  yellow: "#fff2a8",
  green: "#c8f7c5",
  cyan: "#c5f1f7",
  magenta: "#f7c5ef",
  blue: "#c5d5f7",
  red: "#f7c5c5",
  darkYellow: "#e6d36b",
  lightGray: "#e8e8e8",
  darkGray: "#bdbdbd",
};

const SAFE_LINK = /^(https?:|mailto:|#)/i;

function runMarks(rPr: XmlElement | undefined, base: readonly Mark[]): readonly Mark[] {
  let marks = base;
  const add = (mark: Mark) => {
    marks = mark.addToSet(marks);
  };
  const remove = (name: string) => {
    marks = marks.filter((mark) => mark.type.name !== name);
  };
  const bold = flag(rPr, "w:b");
  if (bold === true) add(schema.marks.bold!.create());
  else if (bold === false) remove("bold");
  const italic = flag(rPr, "w:i");
  if (italic === true) add(schema.marks.italic!.create());
  else if (italic === false) remove("italic");
  const underline = val(child(rPr, "w:u"));
  if (underline && underline !== "none") add(schema.marks.underline!.create());
  if (flag(rPr, "w:strike") || flag(rPr, "w:dstrike")) add(schema.marks.strike!.create());
  const vertical = val(child(rPr, "w:vertAlign"));
  if (vertical === "superscript") add(schema.marks.superscript!.create());
  else if (vertical === "subscript") add(schema.marks.subscript!.create());
  const color = val(child(rPr, "w:color"));
  if (color && /^[0-9a-f]{6}$/i.test(color) && color.toLowerCase() !== "000000") add(schema.marks.text_color!.create({ color: `#${color.toLowerCase()}` }));
  const highlight = val(child(rPr, "w:highlight"));
  if (highlight && HIGHLIGHTS[highlight]) add(schema.marks.highlight!.create({ color: HIGHLIGHTS[highlight] }));
  const size = val(child(rPr, "w:sz"));
  if (size && Number(size) > 0) add(schema.marks.font_size!.create({ size: `${Number(size) / 2}pt` }));
  const font = child(rPr, "w:rFonts")?.attrs["w:ascii"];
  if (font) add(schema.marks.font_family!.create({ family: font }));
  return marks;
}

type Inline = PMNode;

const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

async function imageFromDrawing(drawing: XmlElement, ctx: Context): Promise<PMNode | null> {
  let embed: string | undefined;
  let widthEmu: number | undefined;
  let alt = "";
  const walk = (node: XmlElement) => {
    if (node.name === "a:blip") embed ??= node.attrs["r:embed"];
    if (node.name === "wp:extent" && !widthEmu) widthEmu = Number(node.attrs.cx);
    if (node.name === "wp:docPr") alt ||= node.attrs.descr || "";
    for (const item of elements(node)) walk(item);
  };
  walk(drawing);
  const rel = embed ? ctx.rels.get(embed) : undefined;
  if (!rel || rel.external || !ctx.saveImage) return null;
  const path = rel.target.startsWith("/") ? rel.target.slice(1) : `word/${rel.target}`;
  const data = ctx.parts.get(path.replace(/\/\.\//g, "/"));
  const mime = IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
  if (!data || !mime) return null;
  const src = await ctx.saveImage(data, mime);
  if (!src) return null;
  const width = widthEmu ? `${Math.round(widthEmu / 9525)}px` : null;
  return schema.nodes.image!.create({ src, alt, width });
}

type ParagraphContent = { inline: Inline[]; images: PMNode[]; pageBreakBefore: boolean };

async function readInline(node: XmlElement, ctx: Context, marks: readonly Mark[], out: ParagraphContent) {
  for (const item of elements(node)) {
    switch (item.name) {
      case "w:r": {
        const runMarksSet = runMarks(child(item, "w:rPr"), marks);
        for (const part of elements(item)) {
          if (part.name === "w:t" || part.name === "w:delText") {
            if (part.name === "w:delText") continue; // tracked deletions aren't part of the text
            const text = textOf(part);
            if (text) out.inline.push(schema.text(text, runMarksSet));
          } else if (part.name === "w:tab") {
            out.inline.push(schema.text("\t", runMarksSet));
          } else if (part.name === "w:br" || part.name === "w:cr") {
            if (part.attrs["w:type"] === "page") {
              if (!out.inline.length) out.pageBreakBefore = true;
              else out.inline.push(schema.nodes.hard_break!.create());
            } else {
              out.inline.push(schema.nodes.hard_break!.create());
            }
          } else if (part.name === "w:drawing" || part.name === "w:pict") {
            const image = await imageFromDrawing(part, ctx);
            if (image) out.images.push(image);
          } else if (part.name === "w:sym") {
            const code = part.attrs["w:char"];
            if (code) out.inline.push(schema.text(String.fromCodePoint(parseInt(code, 16) & 0xffff || 0x20), runMarksSet));
          }
        }
        break;
      }
      case "w:hyperlink": {
        const rel = item.attrs["r:id"] ? ctx.rels.get(item.attrs["r:id"]) : undefined;
        const href = rel?.target ?? (item.attrs["w:anchor"] ? `#${item.attrs["w:anchor"]}` : "");
        const linkMarks = href && SAFE_LINK.test(href) ? schema.marks.link!.create({ href }).addToSet(marks) : marks;
        await readInline(item, ctx, linkMarks, out);
        break;
      }
      // Tracked insertions, smart tags, fields and content controls hold ordinary runs.
      case "w:ins":
      case "w:smartTag":
      case "w:fldSimple":
      case "w:sdt":
      case "w:sdtContent":
        await readInline(item, ctx, marks, out);
        break;
      default:
        break;
    }
  }
}

type Block = PMNode | { list: { numId: string; level: number; bullet: boolean; start: number }; paragraph: PMNode };

function alignOf(pPr: XmlElement | undefined): Align {
  const jc = val(child(pPr, "w:jc"));
  if (jc === "center") return "center";
  if (jc === "right" || jc === "end") return "right";
  if (jc === "both" || jc === "distribute") return "justify";
  return "left";
}

function indentOf(pPr: XmlElement | undefined) {
  const left = Number(child(pPr, "w:ind")?.attrs["w:left"] ?? child(pPr, "w:ind")?.attrs["w:start"] ?? 0);
  // Inline's indent steps are half an inch (720 twips).
  return Math.max(0, Math.min(8, Math.round(left / 720)));
}

async function readParagraph(p: XmlElement, ctx: Context): Promise<Block[]> {
  const pPr = child(p, "w:pPr");
  const styleId = val(child(pPr, "w:pStyle"));
  const style = styleInfo(ctx, styleId);
  const base: Mark[] = [];
  if (style.kind !== "heading" && style.kind !== "title" && style.kind !== "subtitle") {
    if (style.bold) base.push(schema.marks.bold!.create());
    if (style.italic) base.push(schema.marks.italic!.create());
  }
  const content: ParagraphContent = { inline: [], images: [], pageBreakBefore: Boolean(flag(pPr, "w:pageBreakBefore")) };
  await readInline(p, ctx, base, content);
  const blocks: Block[] = [];
  if (content.pageBreakBefore) blocks.push(schema.nodes.page_break!.create());

  const align = alignOf(pPr);
  const inline = content.inline;
  let node: PMNode;
  if (style.kind === "title") node = schema.nodes.title!.create({ align }, inline);
  else if (style.kind === "subtitle") node = schema.nodes.subtitle!.create({ align }, inline);
  else if (style.kind === "heading") node = schema.nodes.heading!.create({ align, level: Math.max(1, Math.min(6, style.level ?? 1)) }, inline);
  else if (style.kind === "code") node = schema.nodes.code_block!.create(null, inline.length ? schema.text(inline.map((item) => item.textContent || "\n").join("")) : undefined);
  else node = schema.nodes.paragraph!.create({ align, indent: indentOf(pPr) }, inline);

  const numPr = child(pPr, "w:numPr");
  const numId = val(child(numPr, "w:numId")) ?? style.numId;
  const level = Number(val(child(numPr, "w:ilvl")) ?? 0);
  const numbering = numId && numId !== "0" ? ctx.numbering.get(numId)?.get(level) : undefined;

  const hasContent = inline.length > 0 || !content.images.length;
  if (hasContent) {
    if (numbering && node.type === schema.nodes.paragraph) {
      blocks.push({ list: { numId: numId!, level, bullet: numbering.bullet, start: numbering.start }, paragraph: schema.nodes.paragraph!.create({ align }, inline) });
    } else if (style.kind === "quote") {
      blocks.push(schema.nodes.blockquote!.create(null, schema.nodes.paragraph!.create({ align }, inline)));
    } else {
      blocks.push(node);
    }
  }
  blocks.push(...content.images);
  return blocks;
}

async function readTable(tbl: XmlElement, ctx: Context): Promise<PMNode | null> {
  const rows: PMNode[] = [];
  let width = 0;
  const raw: PMNode[][] = [];
  for (const tr of elements(tbl, "w:tr")) {
    const cells: PMNode[] = [];
    for (const tc of elements(tr, "w:tc")) {
      const blocks = groupLists(await readBlocks(tc, ctx)).filter((block) => block.type !== schema.nodes.page_break);
      const span = Number(val(child(child(tc, "w:tcPr"), "w:gridSpan")) ?? 1) || 1;
      cells.push(schema.nodes.table_cell!.create({ colspan: span }, blocks.length ? blocks : [schema.nodes.paragraph!.create()]));
    }
    if (cells.length) raw.push(cells);
    width = Math.max(width, cells.reduce((sum, cell) => sum + (cell.attrs.colspan as number), 0));
  }
  if (!raw.length) return null;
  raw.forEach((cells, index) => {
    const used = cells.reduce((sum, cell) => sum + (cell.attrs.colspan as number), 0);
    const filled = [...cells];
    for (let i = used; i < width; i += 1) filled.push(schema.nodes.table_cell!.create(null, schema.nodes.paragraph!.create()));
    const isHeader = index === 0 && flag(child(elements(tbl, "w:tr")[0], "w:trPr"), "w:tblHeader");
    rows.push(schema.nodes.table_row!.create(null, isHeader ? filled.map((cell) => schema.nodes.table_header!.create(cell.attrs, cell.content)) : filled));
  });
  return schema.nodes.table!.create(null, rows);
}

async function readBlocks(container: XmlElement, ctx: Context): Promise<Block[]> {
  const blocks: Block[] = [];
  for (const item of elements(container)) {
    if (item.name === "w:p") blocks.push(...(await readParagraph(item, ctx)));
    else if (item.name === "w:tbl") {
      const table = await readTable(item, ctx);
      if (table) blocks.push(table);
    } else if (item.name === "w:sdt") {
      const inner = child(item, "w:sdtContent");
      if (inner) blocks.push(...(await readBlocks(inner, ctx)));
    }
  }
  return blocks;
}

/** Turn runs of numbered paragraphs into (nested) list nodes. */
function groupLists(blocks: Block[]): PMNode[] {
  const out: PMNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    if (!("list" in block)) {
      out.push(block as PMNode);
      i += 1;
      continue;
    }
    const run: Array<Extract<Block, { list: unknown }>> = [];
    while (i < blocks.length && "list" in blocks[i]!) {
      run.push(blocks[i] as Extract<Block, { list: unknown }>);
      i += 1;
    }
    out.push(...buildLists(run, Math.min(...run.map((item) => item.list.level))));
  }
  return out;
}

function buildLists(run: Array<{ list: { level: number; bullet: boolean; start: number }; paragraph: PMNode }>, level: number): PMNode[] {
  const lists: PMNode[] = [];
  let items: PMNode[] = [];
  let kind: { bullet: boolean; start: number } | null = null;
  const flush = () => {
    if (!items.length || !kind) return;
    lists.push(kind.bullet ? schema.nodes.bullet_list!.create(null, items) : schema.nodes.ordered_list!.create({ order: kind.start }, items));
    items = [];
  };
  let i = 0;
  while (i < run.length) {
    const entry = run[i]!;
    if (entry.list.level > level) {
      // Deeper entries nest inside the previous item (or a new empty one).
      const nested: typeof run = [];
      while (i < run.length && run[i]!.list.level > level) nested.push(run[i++]!);
      const sublists = buildLists(nested, Math.min(...nested.map((item) => item.list.level)));
      if (!kind) kind = { bullet: nested[0]!.list.bullet, start: 1 };
      const last = items.pop();
      items.push(last ? last.type.create(last.attrs, [...childrenOf(last), ...sublists]) : schema.nodes.list_item!.create(null, [schema.nodes.paragraph!.create(), ...sublists]));
      continue;
    }
    if (kind && kind.bullet !== entry.list.bullet) flush();
    if (!items.length) kind = { bullet: entry.list.bullet, start: entry.list.start };
    items.push(schema.nodes.list_item!.create(null, entry.paragraph));
    i += 1;
  }
  flush();
  return lists;
}

function childrenOf(node: PMNode) {
  const children: PMNode[] = [];
  node.forEach((item) => children.push(item));
  return children;
}

export class DocxImportError extends Error {}

/** Read a .docx package into an Inline document. */
export async function docxToDoc(parts: DocxParts, options: { saveImage?: SaveImage } = {}): Promise<PMNode> {
  const xml = readPart(parts, "word/document.xml");
  if (!xml) throw new DocxImportError("This isn't a Word document (word/document.xml is missing).");
  const body = child(child(parseXml(xml), "w:document"), "w:body");
  if (!body) throw new DocxImportError("This Word document has no body.");
  const ctx: Context = { styles: readStyles(parts), numbering: readNumbering(parts), rels: readRels(parts), parts, saveImage: options.saveImage };
  const blocks = groupLists(await readBlocks(body, ctx));
  // Word ends many documents with an empty paragraph; drop trailing empties.
  while (blocks.length > 1 && blocks[blocks.length - 1]!.type === schema.nodes.paragraph && blocks[blocks.length - 1]!.content.size === 0) blocks.pop();
  const doc = schema.nodes.doc!.create(null, blocks.length ? blocks : [schema.nodes.paragraph!.create()]);
  doc.check();
  return doc;
}

/** The document's title from its core properties, if it has one. */
export function docxTitle(parts: DocxParts): string | null {
  const xml = readPart(parts, "docProps/core.xml");
  if (!xml) return null;
  const match = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(xml);
  return match ? decodeEntities(match[1]!).trim() || null : null;
}
