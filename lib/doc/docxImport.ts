import type { Mark, Node as PMNode } from "prosemirror-model";
import { newId } from "@/lib/doc/ids";
import { defaultListNumbering, safeHref, sameBorders, schema, type Align, type BorderLine, type Borders, type ListMarker, type ListNumbering, type TabStop } from "@/lib/doc/schema";
import { primaryFamily } from "@/lib/doc/fontMetrics";
import { DEFAULT_SETTINGS, DEFAULT_TAB_STOP, FONT_FAMILIES, PAPER_SIZES, type CommentAuthor, type DocComment, type DocumentSettings, type HorizontalAlign, type PaperSize } from "@/lib/doc/settings";

/**
 * Reads a Word document (.docx, already unzipped into its parts) into Inline
 * documents: paragraphs and headings with their alignment, spacing and
 * indents, bold, italic, underline, strikethrough, super/subscript, fonts,
 * sizes, colors and highlights (worked out through Word's styles, the way
 * Word shows them), hyperlinks, bulleted and numbered lists, tables (with
 * merged cells and shading), line and page breaks, horizontal lines, images
 * (handed to `saveImage`, which returns the URL to use) and comments.
 *
 * The page setup, the body font, line spacing and paragraph spacing, and a
 * plain-text header and footer become the document's settings. A Google Doc
 * with tabs (Google writes each tab as a titled section) becomes one Inline
 * tab per Google tab.
 *
 * Anything Inline has no equivalent for (text boxes, footnotes) is read as
 * its plain text where it has any.
 *
 * Imported documents are laid out the way Word and Google Docs lay them out
 * (settings `lineModel: "font"`): line spacing in each font's own line
 * height, tab stops, paragraph borders, pictures set in lines of text, list
 * indents and bullets, and the size of each paragraph's own mark (which is
 * how tall an empty paragraph is). Fonts the file carries are handed to
 * `saveFont`, so the page can show them.
 */

export type DocxParts = Map<string, Uint8Array>;
export type SaveImage = (data: Uint8Array, mime: string) => Promise<string | null>;
/** A font the document carries, as TrueType or OpenType data. */
export type EmbeddedFont = { family: string; bold: boolean; italic: boolean; data: Uint8Array };
export type SaveFont = (font: EmbeddedFont) => Promise<void>;

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

const EMPTY: XmlElement = { name: "", attrs: {}, children: [] };
const elements = (node: XmlElement, name?: string) => node.children.filter((child): child is XmlElement => typeof child !== "string" && (!name || child.name === name));
const child = (node: XmlElement | undefined, name: string) => node?.children.find((item): item is XmlElement => typeof item !== "string" && item.name === name);
const val = (node: XmlElement | undefined) => node?.attrs["w:val"];

/** A boolean property: present means on, unless w:val says false. */
function flag(props: XmlElement | undefined, name: string) {
  const element = child(props, name);
  if (!element) return undefined;
  const value = val(element);
  return !(value === "0" || value === "false" || value === "none" || value === "off");
}

function textOf(node: XmlElement): string {
  return node.children.map((item) => (typeof item === "string" ? (node.name === "w:t" ? item : "") : textOf(item))).join("");
}

/** A number attribute (Google writes some as "863.9999999999999"). */
function numAttr(node: XmlElement | undefined, name: string) {
  const raw = node?.attrs[name];
  if (raw == null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function readPart(parts: DocxParts, name: string) {
  const data = parts.get(name);
  return data ? new TextDecoder().decode(data) : null;
}

// --- run and paragraph properties ------------------------------------------------------

/** Character formatting as Word shows it; colors are upper-case hex without "#", null for none. */
type RunProps = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  vertAlign?: "superscript" | "subscript" | null;
  color?: string | null;
  highlight?: string | null;
  size?: number;
  font?: string;
};

type ParaProps = {
  align?: Align;
  /** Twips. */
  left?: number;
  firstLine?: number;
  hanging?: number;
  before?: number;
  after?: number;
  /** 240ths of a line when lineRule is auto, else twips. */
  line?: number;
  lineRule?: string;
  /** Right-to-left. */
  bidi?: boolean;
  /** Tab stops this layer sets (twips from the margin) or clears; layers add up rather than replace. */
  tabs?: Array<{ pos: number; clear: boolean; align: TabStop["align"]; leader: TabStop["leader"] }>;
  /** Border sides this layer sets, or removes (null); also layered side by side. */
  borders?: Partial<Record<keyof Borders, BorderLine | null>>;
};

/** Word's highlight colors. */
const HIGHLIGHTS: Record<string, string> = {
  yellow: "FFFF00",
  green: "00FF00",
  cyan: "00FFFF",
  magenta: "FF00FF",
  blue: "0000FF",
  red: "FF0000",
  darkBlue: "000080",
  darkCyan: "008080",
  darkGreen: "008000",
  darkMagenta: "800080",
  darkRed: "800000",
  darkYellow: "808000",
  darkGray: "808080",
  lightGray: "C0C0C0",
  black: "000000",
  white: "FFFFFF",
};

const hex = (value: string | undefined) => (value && /^[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : undefined);

function readRunProps(rPr: XmlElement | undefined): RunProps {
  const props: RunProps = {};
  if (!rPr) return props;
  const bold = flag(rPr, "w:b");
  if (bold !== undefined) props.bold = bold;
  const italic = flag(rPr, "w:i");
  if (italic !== undefined) props.italic = italic;
  const underline = child(rPr, "w:u");
  if (underline) props.underline = val(underline) !== "none";
  const strike = flag(rPr, "w:strike");
  const double = flag(rPr, "w:dstrike");
  if (strike !== undefined || double !== undefined) props.strike = Boolean(strike || double);
  const vertical = child(rPr, "w:vertAlign");
  if (vertical) props.vertAlign = val(vertical) === "superscript" ? "superscript" : val(vertical) === "subscript" ? "subscript" : null;
  const color = child(rPr, "w:color");
  if (color) props.color = hex(val(color)) ?? null;
  const highlight = val(child(rPr, "w:highlight"));
  const shading = child(rPr, "w:shd")?.attrs["w:fill"];
  if (highlight && highlight !== "none") props.highlight = HIGHLIGHTS[highlight] ?? null;
  else if (shading) props.highlight = hex(shading) ?? null;
  else if (highlight === "none") props.highlight = null;
  const size = numAttr(child(rPr, "w:sz"), "w:val");
  if (size && size > 0) props.size = size / 2;
  const fonts = child(rPr, "w:rFonts");
  const font = fonts?.attrs["w:ascii"] || fonts?.attrs["w:hAnsi"];
  if (font) props.font = font;
  return props;
}

function readParaProps(pPr: XmlElement | undefined): ParaProps {
  const props: ParaProps = {};
  if (!pPr) return props;
  const bidi = flag(pPr, "w:bidi");
  if (bidi !== undefined) props.bidi = bidi;
  const jc = val(child(pPr, "w:jc"));
  if (jc) props.align = jc === "center" ? "center" : jc === "right" || jc === "end" ? "right" : jc === "both" || jc === "distribute" ? "justify" : "left";
  const ind = child(pPr, "w:ind");
  const left = numAttr(ind, "w:left") ?? numAttr(ind, "w:start");
  if (left !== undefined) props.left = left;
  const firstLine = numAttr(ind, "w:firstLine");
  const hanging = numAttr(ind, "w:hanging");
  if (firstLine !== undefined || hanging !== undefined) {
    props.firstLine = firstLine ?? 0;
    props.hanging = hanging ?? 0;
  }
  const spacing = child(pPr, "w:spacing");
  const before = numAttr(spacing, "w:before");
  if (before !== undefined) props.before = before;
  const after = numAttr(spacing, "w:after");
  if (after !== undefined) props.after = after;
  const line = numAttr(spacing, "w:line");
  if (line !== undefined) {
    props.line = line;
    props.lineRule = spacing?.attrs["w:lineRule"] ?? "auto";
  }
  const tabs = child(pPr, "w:tabs");
  if (tabs) {
    props.tabs = elements(tabs, "w:tab").flatMap((tab) => {
      const pos = numAttr(tab, "w:pos");
      const kind = val(tab) ?? "left";
      if (pos === undefined || kind === "bar") return [];
      const align: TabStop["align"] = kind === "right" || kind === "end" ? "right" : kind === "center" ? "center" : kind === "decimal" ? "decimal" : "left";
      const leader = tab.attrs["w:leader"];
      return [{ pos, clear: kind === "clear", align, leader: leader === "dot" || leader === "hyphen" || leader === "underscore" || leader === "middleDot" ? leader : null }];
    });
  }
  const pBdr = child(pPr, "w:pBdr");
  if (pBdr) {
    props.borders = {};
    for (const side of ["top", "bottom", "left", "right", "between"] as const) {
      const line = child(pBdr, `w:${side}`);
      if (line) props.borders[side] = borderLine(line);
    }
  }
  return props;
}

/** A Word border, or null for none. */
function borderLine(line: XmlElement): BorderLine | null {
  const kind = val(line) ?? "none";
  if (kind === "nil" || kind === "none") return null;
  const size = numAttr(line, "w:sz") ?? 4;
  const color = hex(line.attrs["w:color"]);
  const style: BorderLine["style"] = kind === "double" ? "double" : /dot/i.test(kind) ? "dotted" : /dash/i.test(kind) ? "dashed" : "solid";
  return { style, width: Math.max(0.25, size / 8), space: numAttr(line, "w:space") ?? 0, color: color && color !== "000000" ? `#${color.toLowerCase()}` : null };
}

const merge = <T extends object>(...layers: T[]): T => Object.assign({}, ...layers.map((layer) => Object.fromEntries(Object.entries(layer).filter(([, value]) => value !== undefined))));

/** Tab stops after every layer has added and cleared its own, in points from the margin. */
function layeredTabs(layers: ParaProps[]): TabStop[] | null {
  const stops = new Map<number, TabStop>();
  for (const layer of layers) {
    for (const tab of layer.tabs ?? []) {
      if (tab.clear) stops.delete(Math.round(tab.pos));
      else stops.set(Math.round(tab.pos), { pos: Number((tab.pos / 20).toFixed(2)), align: tab.align, ...(tab.leader ? { leader: tab.leader } : {}) });
    }
  }
  const list = [...stops.values()].sort((a, b) => a.pos - b.pos);
  return list.length ? list : null;
}

/** Borders after every layer has set or removed its sides. */
function layeredBorders(layers: ParaProps[]): Borders | null {
  const sides: Borders = {};
  for (const layer of layers) {
    for (const [side, line] of Object.entries(layer.borders ?? {}) as Array<[keyof Borders, BorderLine | null]>) {
      if (line) sides[side] = line;
      else delete sides[side];
    }
  }
  return Object.keys(sides).length ? sides : null;
}

// --- styles, numbering, relationships ------------------------------------------------

type Kind = "title" | "subtitle" | "heading" | "code" | "quote" | null;
type StyleInfo = { kind: Kind; level?: number; basedOn?: string; numId?: string; run: RunProps; para: ParaProps; type: string; isDefault: boolean; code?: boolean };

/** `abstract` is the definition the level comes from. */
type NumberingLevel = { bullet: boolean; start: number; para: ParaProps; numbering: ListNumbering; text: string; run: RunProps; abstract?: string };

type CommentInfo = { id: string; author: string; date: number; text: string; paraId?: string; parentParaId?: string; done: boolean };

type Context = {
  styles: Map<string, StyleInfo>;
  defaultParagraphStyle?: string;
  defaults: { run: RunProps; para: ParaProps };
  /** numId → level → list format. */
  numbering: Map<string, Map<number, NumberingLevel>>;
  /** numId → level → the number the next item shows, so a list interrupted by a paragraph carries on counting. */
  counters: Map<string, Map<number, number>>;
  rels: Map<string, { target: string; external: boolean }>;
  parts: DocxParts;
  saveImage?: SaveImage;
  settings: DocumentSettings;
  /** The settings' font, as Word names it. */
  bodyFont: string;
  /** Word comment id → the Inline comment its text is marked with (replies share their thread's); absent when the comment isn't kept. */
  commentMarks: Map<string, string>;
  /** Inline comment ids being marked right now. */
  activeComments: Set<string>;
  /** The text each Inline comment covers. */
  commentQuotes: Map<string, string>;
  /**
   * Written by Google Docs (its Normal style is named "normal"). Google's
   * export doesn't always describe what Google draws, so for these files two
   * details follow Google's own rendering rather than the file, to match a
   * Google PDF:
   * - Bullets take their item's font and size, not the list level's (Google
   *   writes Noto Sans Symbols 11pt but draws the text's font).
   * - Pictures in a line of text get 2px of space round them, not the file's
   *   distT/R/B/L (often an eighth of an inch).
   * Other files are read literally, as Word reads them.
   */
  google: boolean;
  /** Written by Inline. */
  inline: boolean;
};

/** Runs inside a paragraph (or part of one), wherever Word nests them. */
function forEachRun(node: XmlElement, visit: (run: XmlElement) => void) {
  for (const item of elements(node)) {
    if (item.name === "w:r") visit(item);
    else if (["w:hyperlink", "w:ins", "w:smartTag", "w:fldSimple", "w:sdt", "w:sdtContent"].includes(item.name)) forEachRun(item, visit);
  }
}

/** A run's character formatting as Word works it out: the paragraph's styles, the run's style, then the run's own. */
function runProps(run: XmlElement, ctx: Pick<Context, "styles">, base: RunProps) {
  const rPr = child(run, "w:rPr");
  return merge(base, ...styleChain(ctx, val(child(rPr, "w:rStyle"))).map((style) => style.run), readRunProps(rPr));
}

const runText = (run: XmlElement) => elements(run, "w:t").map(textOf).join("");

/**
 * The font, size and line spacing most of the body text is set in (weighed
 * by characters). Google Docs writes its own formatting on every run and an
 * unrelated default (Calibri 12) in the styles, so the document's own
 * "normal text" is what its text actually uses.
 */
function bodyStatistics(body: XmlElement, ctx: Pick<Context, "styles" | "defaults" | "defaultParagraphStyle">) {
  const fonts = new Map<string, number>();
  const sizes = new Map<number, number>();
  const lines = new Map<number, number>();
  const add = <K>(map: Map<K, number>, key: K, count: number) => map.set(key, (map.get(key) ?? 0) + count);
  const visit = (container: XmlElement) => {
    for (const item of elements(container)) {
      if (item.name === "w:tbl") for (const row of elements(item, "w:tr")) for (const cell of elements(row, "w:tc")) visit(cell);
      else if (item.name === "w:sdt") visit(child(item, "w:sdtContent") ?? EMPTY);
      else if (item.name === "w:p") {
        const pPr = child(item, "w:pPr");
        const styleId = val(child(pPr, "w:pStyle")) ?? ctx.defaultParagraphStyle;
        const kind = styleKind(ctx as Context, styleId).kind;
        if (kind && kind !== "quote") continue;
        const chain = styleChain(ctx, styleId);
        const para = merge(ctx.defaults.para, ...chain.map((style) => style.para), readParaProps(pPr));
        const base = merge(ctx.defaults.run, ...chain.map((style) => style.run));
        let chars = 0;
        forEachRun(item, (run) => {
          const length = runText(run).length;
          if (!length) return;
          const props = runProps(run, ctx, base);
          if (props.font) add(fonts, props.font, length);
          if (props.size) add(sizes, props.size, length);
          chars += length;
        });
        if (chars) add(lines, para.line && (para.lineRule ?? "auto") === "auto" ? round(para.line / 240, 0.01) : 1, chars);
      }
    }
  };
  visit(body);
  const top = <K>(map: Map<K, number>) => [...map].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { font: top(fonts), size: top(sizes), line: top(lines) };
}

function classifyStyle(id: string, name: string): Kind {
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
  const defaults = { run: {} as RunProps, para: {} as ParaProps };
  const xml = readPart(parts, "word/styles.xml");
  if (!xml) return { styles, defaults };
  const root = child(parseXml(xml), "w:styles") ?? EMPTY;
  const docDefaults = child(root, "w:docDefaults");
  defaults.run = readRunProps(child(child(docDefaults, "w:rPrDefault"), "w:rPr"));
  defaults.para = readParaProps(child(child(docDefaults, "w:pPrDefault"), "w:pPr"));
  for (const style of elements(root, "w:style")) {
    const id = style.attrs["w:styleId"];
    if (!id) continue;
    const type = style.attrs["w:type"] ?? "paragraph";
    const name = val(child(style, "w:name")) ?? id;
    const level = /heading\s*(\d)/i.exec(`${id} ${name}`)?.[1];
    const pPr = child(style, "w:pPr");
    const outline = val(child(pPr, "w:outlineLvl"));
    let kind = type === "paragraph" ? classifyStyle(id, name) : null;
    if (type === "paragraph" && !kind && outline != null && Number(outline) < 6) kind = "heading";
    styles.set(id, {
      type,
      isDefault: style.attrs["w:default"] === "1" || style.attrs["w:default"] === "true",
      kind,
      level: level ? Number(level) : outline != null ? Number(outline) + 1 : undefined,
      run: readRunProps(child(style, "w:rPr")),
      para: readParaProps(pPr),
      basedOn: val(child(style, "w:basedOn")),
      numId: val(child(child(pPr, "w:numPr"), "w:numId")),
      code: type === "character" && /^(html code|inline code|inlinecode)$/i.test(name),
    });
  }
  return { styles, defaults };
}

/** The style and the ones it's based on, the base first. */
function styleChain(ctx: Pick<Context, "styles">, id: string | undefined): StyleInfo[] {
  const chain: StyleInfo[] = [];
  const seen = new Set<string>();
  let current = id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const style = ctx.styles.get(current);
    if (!style) break;
    chain.unshift(style);
    current = style.basedOn;
  }
  return chain;
}

/** What kind of block a paragraph style makes: the nearest style in its chain that says. */
function styleKind(ctx: Context, id: string | undefined): { kind: Kind; level?: number; numId?: string } {
  const chain = styleChain(ctx, id);
  const numId = [...chain].reverse().find((style) => style.numId)?.numId;
  for (let i = chain.length - 1; i >= 0; i -= 1) if (chain[i]!.kind) return { kind: chain[i]!.kind, level: chain[i]!.level, numId };
  return { kind: null, numId };
}

/** Word's number formats as CSS list styles; anything else is shown as numbers. */
const NUMBER_FORMATS: Record<string, ListNumbering> = { decimal: "decimal", lowerLetter: "lower-alpha", upperLetter: "upper-alpha", lowerRoman: "lower-roman", upperRoman: "upper-roman" };

function readLevel(lvl: XmlElement): NumberingLevel {
  const format = val(child(lvl, "w:numFmt")) ?? "decimal";
  return {
    bullet: format === "bullet" || format === "none",
    start: Number(val(child(lvl, "w:start")) ?? 1) || 1,
    para: readParaProps(child(lvl, "w:pPr")),
    numbering: NUMBER_FORMATS[format] ?? "decimal",
    text: format === "none" ? "" : val(child(lvl, "w:lvlText")) ?? "",
    run: readRunProps(child(lvl, "w:rPr")),
  };
}

/** Word's bullets in symbol fonts (Symbol, Wingdings) are private-use characters; these are what they draw. */
const SYMBOL_BULLETS: Record<string, string> = { "": "•", "": "▪", "": "➢", "": "❖", "": "✓", "": "□", "": "o", "": "–" };
const SYMBOL_FONTS = /^(symbol|wingdings( \d)?|webdings|noto sans symbols2?)$/i;

function readNumbering(parts: DocxParts) {
  const result = new Map<string, Map<number, NumberingLevel>>();
  const xml = readPart(parts, "word/numbering.xml");
  if (!xml) return result;
  const root = child(parseXml(xml), "w:numbering");
  if (!root) return result;
  const abstract = new Map<string, Map<number, NumberingLevel>>();
  for (const def of elements(root, "w:abstractNum")) {
    const levels = new Map<number, NumberingLevel>();
    for (const lvl of elements(def, "w:lvl")) levels.set(Number(lvl.attrs["w:ilvl"] ?? 0), readLevel(lvl));
    abstract.set(def.attrs["w:abstractNumId"] ?? "", levels);
  }
  for (const num of elements(root, "w:num")) {
    const abstractId = val(child(num, "w:abstractNumId")) ?? "";
    const base = abstract.get(abstractId);
    if (!base) continue;
    const levels = new Map([...base].map(([level, info]) => [level, { ...info, abstract: abstractId }]));
    for (const override of elements(num, "w:lvlOverride")) {
      const index = Number(override.attrs["w:ilvl"] ?? 0);
      // An override can redefine the level outright.
      const redefined = child(override, "w:lvl");
      if (redefined) levels.set(index, { ...readLevel(redefined), abstract: abstractId });
      const level = levels.get(index);
      const start = Number(val(child(override, "w:startOverride")));
      if (level && start) level.start = start;
    }
    result.set(num.attrs["w:numId"] ?? "", levels);
  }
  return result;
}

function readRels(parts: DocxParts, part = "word/_rels/document.xml.rels") {
  const rels = new Map<string, { target: string; external: boolean }>();
  const xml = readPart(parts, part);
  if (!xml) return rels;
  for (const rel of elements(child(parseXml(xml), "Relationships") ?? EMPTY, "Relationship")) {
    rels.set(rel.attrs.Id ?? "", { target: rel.attrs.Target ?? "", external: rel.attrs.TargetMode === "External" });
  }
  return rels;
}

// --- document settings ---------------------------------------------------------------

const SERIF = /serif|times|georgia|garamond|cambria|bodoni|baskerville|palatino|book antiqua|merriweather|lora|playfair|cormorant|crimson|libre|caslon|didot|minion|spectral|alegreya|domine|noto serif|pt serif/i;
const MONO = /mono|courier|consolas|menlo|code|inconsolata|typewriter/i;

/** A CSS font-family list for a Word font: Inline's own entry when it has one, else the font with a fallback of the same kind. */
export function cssFontFamily(font: string) {
  const known = FONT_FAMILIES.find((entry) => entry.label.toLowerCase() === font.toLowerCase());
  if (known) return known.value;
  const generic = MONO.test(font) ? "monospace" : SERIF.test(font) && !/sans/i.test(font) ? "serif" : "sans-serif";
  return `${/^[\w-]+$/.test(font) ? font : `"${font.replace(/"/g, "")}"`}, ${generic}`;
}

const round = (value: number, step: number) => Number((Math.round(value / step) * step).toFixed(4));

function pageSettings(sectPr: XmlElement | undefined): Partial<DocumentSettings["pageSetup"]> {
  if (!sectPr) return {};
  const size = child(sectPr, "w:pgSz");
  const margins = child(sectPr, "w:pgMar");
  const setup: Partial<DocumentSettings["pageSetup"]> = {};
  const width = numAttr(size, "w:w");
  const height = numAttr(size, "w:h");
  if (width && height) {
    const landscape = size?.attrs["w:orient"] === "landscape" || width > height;
    const [short, long] = [Math.min(width, height) / 1440, Math.max(width, height) / 1440];
    let best: PaperSize = "letter";
    let distance = Infinity;
    for (const [key, paper] of Object.entries(PAPER_SIZES) as Array<[PaperSize, { width: number; height: number }]>) {
      const d = Math.abs(paper.width - short) + Math.abs(paper.height - long);
      if (d < distance) [best, distance] = [key, d];
    }
    setup.paperSize = best;
    setup.orientation = landscape ? "landscape" : "portrait";
  }
  const inches = (name: string) => {
    const value = numAttr(margins, name);
    return value === undefined ? undefined : Math.max(0, Math.min(3, round(value / 1440, 0.01)));
  };
  const m = { top: inches("w:top"), right: inches("w:right"), bottom: inches("w:bottom"), left: inches("w:left") };
  if (Object.values(m).every((value) => value !== undefined)) setup.margins = m as DocumentSettings["pageSetup"]["margins"];
  return setup;
}

/** A header or footer as Inline's one line of text: page fields become {page} and {pages}. */
function headerFooterText(parts: DocxParts, target: string | undefined): { text: string; align: HorizontalAlign } | null {
  if (!target) return null;
  const xml = readPart(parts, `word/${target.replace(/^\/?word\//, "")}`);
  if (!xml) return null;
  const root = elements(parseXml(xml))[0];
  if (!root) return null;
  const lines: string[] = [];
  let align: HorizontalAlign | null = null;
  const field = (instruction: string) => (/^\s*NUMPAGES\b/i.test(instruction) ? "{pages}" : /^\s*PAGE\b/i.test(instruction) ? "{page}" : null);
  for (const p of root.children.filter((item): item is XmlElement => typeof item !== "string" && (item.name === "w:p" || item.name === "w:sdt"))) {
    let text = "";
    // Complex fields: the result between "separate" and "end" is replaced by the field's token.
    let instruction = "";
    let inResult = false;
    const walk = (node: XmlElement) => {
      for (const item of elements(node)) {
        if (item.name === "w:fldSimple") {
          text += field(item.attrs["w:instr"] ?? "") ?? textOf(item);
        } else if (item.name === "w:fldChar") {
          const type = item.attrs["w:fldCharType"];
          if (type === "begin") instruction = "";
          else if (type === "separate") {
            const token = field(instruction);
            if (token) {
              text += token;
              inResult = true;
            }
          } else if (type === "end") inResult = false;
        } else if (item.name === "w:instrText") instruction += textOf({ ...item, name: "w:t" });
        else if (item.name === "w:t") {
          if (!inResult) text += textOf(item);
        } else if (item.name === "w:tab") {
          if (!inResult) text += " ";
        } else walk(item);
      }
    };
    walk(p);
    const line = text.replace(/\s+/g, " ").trim();
    if (!line) continue;
    lines.push(line);
    const jc = readParaProps(child(p, "w:pPr")).align;
    align ??= jc === "center" ? "center" : jc === "right" ? "right" : "left";
  }
  return lines.length ? { text: lines.join(" "), align: align ?? "left" } : null;
}

/** Written by Inline (its Word copies and downloads), and how Inline laid it out then. */
function inlineOrigin(parts: DocxParts) {
  const core = readPart(parts, "docProps/core.xml") ?? "";
  const ours = /<dc:creator>Inline<\/dc:creator>/.test(core);
  const model = /<w:docVar w:name="InlineLineModel" w:val="(\w+)"\/>/.exec(readPart(parts, "word/settings.xml") ?? "")?.[1];
  return { ours, lineModel: model === "font" || (!ours && model !== "css") ? ("font" as const) : null };
}

function readSettings(parts: DocxParts, body: XmlElement, styles: Map<string, StyleInfo>, defaults: Context["defaults"], defaultStyle: string | undefined): DocumentSettings {
  const sectPr = child(body, "w:sectPr");
  const normal = styleChain({ styles }, defaultStyle);
  const run = merge(defaults.run, ...normal.map((style) => style.run));
  const para = merge(defaults.para, ...normal.map((style) => style.para));
  const origin = inlineOrigin(parts);
  // Inline's own copies say their normal text outright; anyone else's is what the text uses.
  const stats: Partial<ReturnType<typeof bodyStatistics>> = origin.ours ? {} : bodyStatistics(body, { styles, defaults, defaultParagraphStyle: defaultStyle });
  const settings: DocumentSettings = structuredClone(DEFAULT_SETTINGS);
  settings.pageSetup = { ...settings.pageSetup, ...pageSettings(sectPr) };
  const font = stats.font ?? run.font;
  const size = stats.size ?? run.size;
  if (font) settings.fontFamily = cssFontFamily(font);
  if (size) settings.fontSize = Math.max(6, Math.min(96, size));
  // Word's own default is single spacing with no space after paragraphs.
  const normalLine = para.line && (para.lineRule ?? "auto") === "auto" ? round(para.line / 240, 0.01) : 1;
  settings.lineSpacing = Math.max(0.8, Math.min(4, stats.line ?? normalLine));
  settings.paragraphSpacing = Math.max(0, Math.min(72, round((para.after ?? 0) / 20, 0.5)));
  // Laid out as Word and Google Docs lay it out: lines as tall as their fonts make them (unless Inline wrote it otherwise).
  if (origin.lineModel) settings.lineModel = origin.lineModel;
  const tabStop = numAttr(child(child(parseXml(readPart(parts, "word/settings.xml") ?? ""), "w:settings"), "w:defaultTabStop"), "w:val");
  if (tabStop && tabStop >= 20 && Math.abs(tabStop / 20 - DEFAULT_TAB_STOP) > 0.01) settings.tabStop = round(tabStop / 20, 0.01);

  const rels = readRels(parts);
  const reference = (kind: "header" | "footer", type: string) => {
    const ref = elements(sectPr ?? EMPTY, `w:${kind}Reference`).find((item) => (item.attrs["w:type"] ?? "default") === type);
    const id = ref?.attrs["r:id"];
    return id ? rels.get(id)?.target : undefined;
  };
  const header = headerFooterText(parts, reference("header", "default"));
  const footer = headerFooterText(parts, reference("footer", "default"));
  const titlePage = flag(sectPr, "w:titlePg");
  const firstHeader = titlePage ? headerFooterText(parts, reference("header", "first")) : null;
  const firstFooter = titlePage ? headerFooterText(parts, reference("footer", "first")) : null;
  settings.headerFooter = {
    ...settings.headerFooter,
    header: header?.text ?? "",
    footer: footer?.text ?? "",
    headerAlign: header?.align ?? firstHeader?.align ?? settings.headerFooter.headerAlign,
    footerAlign: footer?.align ?? firstFooter?.align ?? settings.headerFooter.footerAlign,
    differentFirstPage: Boolean(titlePage && (firstHeader || firstFooter || header || footer)),
    firstHeader: firstHeader?.text ?? "",
    firstFooter: firstFooter?.text ?? "",
  };
  return settings;
}

// --- what Inline shows without any marks ------------------------------------------------

/** "cell" and "header" are paragraphs in table cells and header cells. */
type BlockKind = "paragraph" | "title" | "subtitle" | "heading" | "list" | "quote" | "code" | "cell" | "header";

/**
 * The formatting Inline's page gives each kind of block (app/styles/document.css),
 * which marks only need to differ from. `size` is the paragraph's own text size, when it has one.
 */
function baseline(ctx: Context, kind: BlockKind, level = 1, size?: number | null): Required<Omit<RunProps, "vertAlign" | "color" | "highlight">> & { color: string | null } {
  const body = { bold: false, italic: false, underline: false, strike: false, color: null as string | null, size: size ?? ctx.settings.fontSize, font: ctx.bodyFont };
  if (kind === "title") return { ...body, size: 26 };
  if (kind === "subtitle") return { ...body, size: 15, color: "666666" };
  if (kind === "heading") {
    const sizes = [20, 16, 14, 12, 11, 11];
    return { ...body, size: sizes[level - 1] ?? 11, color: level === 3 ? "434343" : level > 3 ? "666666" : null, italic: level === 6 };
  }
  if (kind === "quote") return { ...body, color: "555555" };
  if (kind === "header") return { ...body, bold: true };
  return body;
}

/** Space before and after (points) and line height that Inline gives each kind of block. */
function spacingBaseline(ctx: Context, kind: BlockKind, level = 1) {
  // Laid out as Word and Google Docs do, every kind of block takes the document's line spacing.
  const fontLines = ctx.settings.lineModel === "font";
  const line = ctx.settings.lineSpacing;
  if (kind === "title") return { before: 0, after: 3, line: fontLines ? line : 1.15 };
  if (kind === "subtitle") return { before: 0, after: 16, line };
  if (kind === "heading") {
    const before = [20, 18, 16, 14, 12, 12][level - 1] ?? 12;
    return { before, after: level <= 2 ? 6 : 4, line: fontLines ? line : 1.2 };
  }
  if (kind === "list") return { before: 0, after: 2, line };
  if (kind === "cell" || kind === "header") return { before: 0, after: 0, line };
  return { before: 0, after: ctx.settings.paragraphSpacing, line };
}

/** Link text in Word's or Google's link blue is shown in Inline's own link style instead. */
const LINK_BLUES = new Set(["1155CC", "0563C1", "0000FF", "1A73E8", "467886"]);

function marksFor(props: RunProps, ctx: Context, kind: BlockKind, level: number, link: Mark | null, size?: number | null): Mark[] {
  const base = baseline(ctx, kind, level, size);
  const marks: Mark[] = [];
  if (link) marks.push(link);
  if (props.bold && !base.bold) marks.push(schema.marks.bold!.create());
  if (props.italic && !base.italic) marks.push(schema.marks.italic!.create());
  const linkLook = link && (!props.color || LINK_BLUES.has(props.color));
  if (props.underline && !linkLook) marks.push(schema.marks.underline!.create());
  if (props.strike) marks.push(schema.marks.strike!.create());
  if (props.vertAlign === "superscript") marks.push(schema.marks.superscript!.create());
  else if (props.vertAlign === "subscript") marks.push(schema.marks.subscript!.create());
  // Black is left to the page, so text stays readable in dark mode.
  if (props.color && props.color !== "000000" && props.color !== base.color && !linkLook) marks.push(schema.marks.text_color!.create({ color: `#${props.color.toLowerCase()}` }));
  if (props.highlight && props.highlight !== "FFFFFF") marks.push(schema.marks.highlight!.create({ color: `#${props.highlight.toLowerCase()}` }));
  if (props.size && Math.abs(props.size - base.size) > 0.01) marks.push(schema.marks.font_size!.create({ size: `${props.size}pt` }));
  if (props.font && props.font.toLowerCase() !== base.font.toLowerCase()) marks.push(schema.marks.font_family!.create({ family: cssFontFamily(props.font) }));
  for (const id of ctx.activeComments) marks.push(schema.marks.comment!.create({ id }));
  let set: readonly Mark[] = [];
  for (const mark of marks) set = mark.addToSet(set);
  return [...set];
}

// --- body ------------------------------------------------------------------------------


const IMAGE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

const EMU_PER_PX = 9525;

/**
 * A picture or horizontal line. A picture set in a line of text (`inText`,
 * and placed inline rather than floating) stays in the line, at its size in
 * whole pixels as Google Docs draws it; otherwise it is a block of its own.
 */
async function imageFromDrawing(drawing: XmlElement, ctx: Context, inText = false): Promise<PMNode | null> {
  let embed: string | undefined;
  let widthEmu: number | undefined;
  let heightEmu: number | undefined;
  let widthPt: number | undefined;
  let alt = "";
  let rule = false;
  let inline = false;
  let opacity: number | null = null;
  let dist: [number, number, number, number] | null = null;
  const walk = (node: XmlElement) => {
    if (node.name === "a:blip") embed ??= node.attrs["r:embed"];
    if (node.name === "a:alphaModFix") {
      const amount = Number(node.attrs.amt);
      if (Number.isFinite(amount) && amount >= 0 && amount < 100000) opacity = Math.round(amount / 1000) / 100;
    }
    if (node.name === "v:imagedata") {
      embed ??= node.attrs["r:id"];
      alt ||= node.attrs["o:title"] || "";
    }
    if ((node.name === "v:shape" || node.name === "v:rect") && node.attrs.style) {
      const width = /(?:^|;)\s*width:\s*([\d.]+)pt/.exec(node.attrs.style)?.[1];
      if (width) widthPt ??= Number(width);
    }
    // Google Docs and Word draw a horizontal line as a VML rule.
    if (node.attrs["o:hr"] === "t") rule = true;
    if (node.name === "wp:inline") {
      inline = true;
      dist = (["distT", "distR", "distB", "distL"] as const).map((side) => Math.round((Number(node.attrs[side]) || 0) / EMU_PER_PX)) as [number, number, number, number];
    }
    if (node.name === "wp:extent" && !widthEmu) {
      widthEmu = Number(node.attrs.cx);
      heightEmu = Number(node.attrs.cy);
    }
    if (node.name === "wp:docPr") alt ||= node.attrs.descr || "";
    for (const item of elements(node)) walk(item);
  };
  walk(drawing);
  if (rule && !embed) return schema.nodes.horizontal_rule!.create();
  const rel = embed ? ctx.rels.get(embed) : undefined;
  if (!rel || rel.external || !ctx.saveImage) return null;
  const path = rel.target.startsWith("/") ? rel.target.slice(1) : `word/${rel.target}`;
  const data = ctx.parts.get(path.replace(/\/\.\//g, "/"));
  const mime = IMAGE_TYPES[path.split(".").pop()?.toLowerCase() ?? ""];
  if (!data || !mime) return null;
  const src = await ctx.saveImage(data, mime);
  if (!src) return null;
  if (inText && inline && widthEmu && heightEmu) {
    const px = (emu: number) => Math.max(1, Math.round(emu / EMU_PER_PX));
    // Google Docs keeps 2px clear around a picture in a line, whatever space its file records (often an eighth of an inch).
    const space = ctx.google ? [2, 2, 2, 2] : dist;
    return schema.nodes.inline_image!.create({ src, alt, width: px(widthEmu), height: px(heightEmu), opacity, dist: space && space.some(Boolean) ? space : null });
  }
  const width = widthEmu ? `${Math.round(widthEmu / EMU_PER_PX)}px` : widthPt ? `${Math.round((widthPt * 96) / 72)}px` : null;
  return schema.nodes.image!.create({ src, alt, width });
}

/** `breakOnly` while the paragraph has nothing but a page break in it. */
type ParagraphContent = { inline: PMNode[]; blocks: PMNode[]; pageBreakBefore: boolean; breakOnly?: boolean };

/** `size` is the paragraph's own text size; `inText` when pictures sit in its lines of text. */
type RunContext = { base: RunProps; kind: BlockKind; level: number; link: Mark | null; size: number | null; inText: boolean };

function commentRangeStart(ctx: Context, id: string | undefined) {
  const mark = id ? ctx.commentMarks.get(id) : undefined;
  if (mark && !ctx.activeComments.has(mark)) {
    ctx.activeComments.add(mark);
    if (!ctx.commentQuotes.has(mark)) ctx.commentQuotes.set(mark, "");
  }
}

function commentRangeEnd(ctx: Context, id: string | undefined) {
  const mark = id ? ctx.commentMarks.get(id) : undefined;
  if (mark) ctx.activeComments.delete(mark);
}

function pushText(out: ParagraphContent, ctx: Context, text: string, marks: readonly Mark[]) {
  out.inline.push(schema.text(text, marks));
  for (const id of ctx.activeComments) ctx.commentQuotes.set(id, (ctx.commentQuotes.get(id) ?? "") + text);
}

async function readInline(node: XmlElement, ctx: Context, run: RunContext, out: ParagraphContent) {
  for (const item of elements(node)) {
    switch (item.name) {
      case "w:r": {
        const rPr = child(item, "w:rPr");
        const styleId = val(child(rPr, "w:rStyle"));
        const runStyles = styleChain(ctx, styleId);
        const props = merge(run.base, ...runStyles.map((style) => style.run), readRunProps(rPr));
        // Word's code character style (Inline writes inline code with it) is code, not just a font.
        const code = runStyles.some((style) => style.code);
        const marks = () => (code ? [schema.marks.code!.create()] : marksFor(props, ctx, run.kind, run.level, run.link, run.size));
        for (const part of elements(item)) {
          if (part.name === "w:t") {
            const text = textOf(part);
            if (text) pushText(out, ctx, text, marks());
          } else if (part.name === "w:tab" || part.name === "w:ptab") {
            pushText(out, ctx, "\t", marks());
          } else if (part.name === "w:br" || part.name === "w:cr") {
            if (part.attrs["w:type"] === "page") {
              if (!out.inline.length) {
                out.breakOnly = !out.pageBreakBefore || out.breakOnly;
                out.pageBreakBefore = true;
              }
              else out.inline.push(schema.nodes.hard_break!.create());
            } else {
              out.inline.push(schema.nodes.hard_break!.create());
            }
          } else if (part.name === "w:drawing" || part.name === "w:pict" || part.name === "w:object") {
            const picture = await imageFromDrawing(part, ctx, run.inText);
            if (picture?.isInline) out.inline.push(run.link ? picture.mark([run.link]) : picture);
            else if (picture) out.blocks.push(picture);
          } else if (part.name === "w:sym") {
            const code = part.attrs["w:char"];
            if (code) pushText(out, ctx, String.fromCodePoint(parseInt(code, 16) & 0xffff || 0x20), marks());
          } else if (part.name === "w:noBreakHyphen") {
            pushText(out, ctx, "‑", marks());
          }
        }
        break;
      }
      case "w:hyperlink": {
        const rel = item.attrs["r:id"] ? ctx.rels.get(item.attrs["r:id"]) : undefined;
        const href = rel?.target ?? (item.attrs["w:anchor"] ? `#${item.attrs["w:anchor"]}` : "");
        // Web, mail and phone links, and links within the document.
        const safe = href.startsWith("#") ? href : safeHref(href);
        const link = safe ? schema.marks.link!.create({ href: safe }) : run.link;
        await readInline(item, ctx, { ...run, link }, out);
        break;
      }
      case "w:commentRangeStart":
        commentRangeStart(ctx, item.attrs["w:id"]);
        break;
      case "w:commentRangeEnd":
        commentRangeEnd(ctx, item.attrs["w:id"]);
        break;
      // Tracked insertions, smart tags, fields and content controls hold ordinary runs.
      case "w:ins":
      case "w:smartTag":
      case "w:fldSimple":
      case "w:sdt":
      case "w:sdtContent":
        await readInline(item, ctx, run, out);
        break;
      default:
        break;
    }
  }
}

/** Where a list's text starts and its marker hangs (twips), and how its marker looks. */
/** `plain` when it is how Inline itself writes a list, which then needs no indents or bullet of its own. */
type ListLayout = { left: number; hanging: number; marker: ListMarker | null; plain: boolean };
type ListEntry = { list: { numId: string; level: number; bullet: boolean; start: number; numbering: ListNumbering }; layout: ListLayout; checked?: boolean | null; paragraph: PMNode };
/** A paragraph with a border all round; neighbours with one share a box. */
type BoxEntry = { boxed: PMNode[] };
type Block = PMNode | ListEntry | BoxEntry;

/** Empty paragraphs with only a line under them, which are horizontal lines unless a neighbour shares the line. */
const ruleCandidates = new WeakSet<PMNode>();

const twipsToPt = (twips: number) => round(twips / 20, 0.5);

/** Spacing and indent attributes, where the paragraph differs from what Inline shows for its kind anyway. */
function blockLayout(ctx: Context, para: ParaProps, kind: BlockKind, level: number, skipIndent: boolean) {
  const attrs: Record<string, unknown> = {};
  const base = spacingBaseline(ctx, kind, level);
  // Laid out as Word does, small differences show; otherwise near enough is Inline's own spacing.
  const exact = ctx.settings.lineModel === "font";
  const before = twipsToPt(para.before ?? 0);
  const after = twipsToPt(para.after ?? 0);
  if (Math.abs(before - base.before) > (exact ? 0.01 : 1)) attrs.spaceBefore = before;
  if (Math.abs(after - base.after) > (exact ? 0.01 : 1)) attrs.spaceAfter = after;
  if (para.line && (para.lineRule ?? "auto") === "auto") {
    const line = round(para.line / 240, 0.01);
    if (Math.abs(line - base.line) > (exact ? 0.001 : 0.06)) attrs.lineHeight = String(Math.max(0.8, Math.min(4, line)));
  }
  if (!skipIndent) {
    const hanging = para.hanging ?? 0;
    const firstLine = para.firstLine ?? 0;
    // Word's left indent is where the lines after the first start; Inline's is where the first line starts.
    const left = (para.left ?? 0) - hanging;
    attrs.indent = Math.max(0, Math.min(8, exact ? Math.round((left / 720) * 1000) / 1000 : Math.round(left / 720)));
    const textIndent = hanging ? -hanging / 1440 : firstLine / 1440;
    const rounded = Math.round(Math.max(-3, Math.min(3, textIndent)) * 100) / 100;
    if (Math.abs(rounded) >= (exact ? 0.005 : 0.05)) attrs.textIndent = rounded;
  }
  if (para.bidi) attrs.dir = "rtl";
  return attrs;
}

/** How a bullet list level's marker looks: its character, and the formatting its level gives it. */
function listMarker(level: NumberingLevel, ctx: Context): ListMarker {
  const symbolFont = Boolean(level.run.font && SYMBOL_FONTS.test(level.run.font));
  const text = [...level.text].map((char) => SYMBOL_BULLETS[char] ?? char).join("").replace(/%\d/g, "") || "•";
  const marker: ListMarker = { text };
  // Google Docs draws a bullet in its item's font and size, whatever its file names (a symbol font, 11pt).
  if (!ctx.google) {
    if (level.run.font && !symbolFont) marker.font = cssFontFamily(level.run.font);
    if (level.run.size) marker.size = level.run.size;
  }
  if (level.run.bold !== undefined) marker.bold = level.run.bold;
  if (level.run.italic !== undefined) marker.italic = level.run.italic;
  if (level.run.color && level.run.color !== "000000") marker.color = `#${level.run.color.toLowerCase()}`;
  return marker;
}

async function readParagraph(p: XmlElement, ctx: Context, cell: "cell" | "header" | null): Promise<Block[]> {
  const pPr = child(p, "w:pPr");
  const styleId = val(child(pPr, "w:pStyle")) ?? ctx.defaultParagraphStyle;
  const style = styleKind(ctx, styleId);
  const chain = styleChain(ctx, styleId);

  const numPr = child(pPr, "w:numPr");
  const numId = val(child(numPr, "w:numId")) ?? style.numId;
  const level = Number(val(child(numPr, "w:ilvl")) ?? 0);
  const numbering = numId && numId !== "0" ? ctx.numbering.get(numId)?.get(level) : undefined;
  // A heading can be a list item too (Google shows its bullet); it keeps its look through marks.
  const isList = Boolean(numbering) && style.kind !== "code" && style.kind !== "quote";

  const kind: BlockKind = isList ? "list" : style.kind === "heading" || style.kind === "title" || style.kind === "subtitle" || style.kind === "quote" || style.kind === "code" ? style.kind : (cell ?? "paragraph");
  const headingLevel = Math.max(1, Math.min(6, style.level ?? 1));
  const layers = [ctx.defaults.para, ...chain.map((item) => item.para), numbering?.para ?? {}, readParaProps(pPr)];
  const para = merge(...layers);
  const runBase = merge(ctx.defaults.run, ...chain.map((item) => item.run));

  // The paragraph's own size: its mark's (all an empty paragraph has), but no larger than its largest text, since
  // a line is as tall as the largest text on it (the page sizes lines from it). Headings keep the size of their kind.
  let size: number | null = null;
  let hasText = false;
  if (kind === "paragraph" || kind === "list" || kind === "cell" || kind === "header" || kind === "quote") {
    const mark = merge(runBase, readRunProps(child(pPr, "w:rPr"))).size ?? ctx.settings.fontSize;
    let largest = -Infinity;
    forEachRun(p, (run) => {
      const text = runText(run);
      if (text.trim()) hasText = true;
      if (!text && !child(run, "w:tab")) return;
      largest = Math.max(largest, runProps(run, ctx, runBase).size ?? ctx.settings.fontSize);
    });
    const own = largest === -Infinity ? mark : Math.min(mark, largest);
    // Only a paragraph that would otherwise be too tall (empty, or all its text smaller than the document's)
    // needs a size of its own; the text's own sizes say the rest.
    if (own < ctx.settings.fontSize - 0.01 || (largest === -Infinity && Math.abs(own - ctx.settings.fontSize) > 0.01)) size = own;
  } else {
    forEachRun(p, (run) => {
      if (runText(run).trim()) hasText = true;
    });
  }

  const content: ParagraphContent = { inline: [], blocks: [], pageBreakBefore: Boolean(flag(pPr, "w:pageBreakBefore")) };
  await readInline(p, ctx, { base: runBase, kind, level: headingLevel, link: null, size, inText: hasText }, content);
  const blocks: Block[] = [];
  if (content.pageBreakBefore && !cell) blocks.push(schema.nodes.page_break!.create());
  // A paragraph holding only a page break is the break itself (Google Docs and Inline both write breaks so).
  if (content.breakOnly && !content.inline.length && !content.blocks.length) return blocks;

  const align = para.align ?? "left";
  // A quote's or code's border and tabs are its kind's look (Inline's Quote style draws a line), not the paragraph's own.
  const ownLayers = kind === "quote" || kind === "code" ? [numbering?.para ?? {}, readParaProps(pPr)] : layers;
  const borders = layeredBorders(ownLayers);
  const tabs = layeredTabs(ownLayers);
  const boxed = Boolean(borders?.top && borders.bottom && borders.left && borders.right);
  // Pictures sit where their paragraph aligns them.
  const placed = content.blocks.map((block) => (block.type === schema.nodes.image ? block.type.create({ ...block.attrs, align: align === "justify" ? "left" : align }) : block));
  const layout = blockLayout(ctx, para, kind, headingLevel, isList || kind === "quote");
  const own = { ...(size ? { fontSize: size } : {}), ...(tabs ? { tabs } : {}), ...(borders && !boxed ? { borders } : {}) };
  let inline = content.inline;
  // A checklist item, as Inline writes one.
  let checked: boolean | null = null;
  const box = isList && inline[0]?.isText ? /^([☐☑☒]) /.exec(inline[0].text!) : null;
  if (box) {
    checked = box[1] !== "☐";
    const rest = inline[0]!.text!.slice(2);
    inline = [...(rest ? [schema.text(rest, inline[0]!.marks)] : []), ...inline.slice(1)];
  }
  const hasContent = inline.length > 0 || !content.blocks.length;
  if (hasContent) {
    if (isList) {
      // Numbered items count on across interruptions, as Word numbers them.
      const levels = ctx.counters.get(numId!) ?? new Map<number, number>();
      ctx.counters.set(numId!, levels);
      const number = levels.get(level) ?? numbering!.start;
      levels.set(level, number + 1);
      for (const deeper of [...levels.keys()]) if (deeper > level) levels.delete(deeper);
      const hanging = para.hanging ?? (para.firstLine ? -para.firstLine : 0);
      const marker = numbering!.bullet ? listMarker(numbering!, ctx) : null;
      // Inline writes its own lists from definitions 1 and 2, and lists with indents of their own from 3 and 4.
      const plain = ctx.inline && (numbering!.abstract === "1" || numbering!.abstract === "2");
      blocks.push({
        list: { numId: numId!, level, bullet: numbering!.bullet, start: number, numbering: numbering!.numbering },
        layout: { left: para.left ?? 0, hanging, marker, plain },
        checked,
        paragraph: schema.nodes.paragraph!.create({ align, ...layout, ...own }, inline),
      });
    } else if (kind === "title") blocks.push(schema.nodes.title!.create({ align, ...layout, ...own }, inline));
    else if (kind === "subtitle") blocks.push(schema.nodes.subtitle!.create({ align, ...layout, ...own }, inline));
    else if (kind === "heading") blocks.push(schema.nodes.heading!.create({ align, ...layout, ...own, level: headingLevel }, inline));
    else if (kind === "code") blocks.push(schema.nodes.code_block!.create(null, inline.length ? schema.text(inline.map((item) => item.textContent || "\n").join("")) : undefined));
    else if (kind === "quote") blocks.push(schema.nodes.blockquote!.create(null, schema.nodes.paragraph!.create({ align, ...layout, ...own }, inline)));
    else {
      const paragraph = schema.nodes.paragraph!.create({ align, ...layout, ...own }, inline);
      if (!inline.length && !content.blocks.length && borders?.bottom && !borders.top && !borders.left && !borders.right) ruleCandidates.add(paragraph);
      blocks.push(paragraph);
    }
  }
  blocks.push(...placed);
  if (boxed && !isList && !cell) return [{ boxed: blocks.filter((block): block is PMNode => !("list" in block) && !("boxed" in block)) }];
  return blocks;
}

const HEADER_FILL = "#f3f4f6";

function cellShading(tcPr: XmlElement | undefined) {
  const fill = hex(child(tcPr, "w:shd")?.attrs["w:fill"]);
  return fill && fill !== "FFFFFF" ? `#${fill.toLowerCase()}` : null;
}

async function readTable(tbl: XmlElement, ctx: Context): Promise<PMNode | null> {
  type Cell = { col: number; colspan: number; rowspan: number; background: string | null; blocks: PMNode[]; header: boolean };
  const rows: Cell[][] = [];
  const rowElements = elements(tbl, "w:tr");
  // The cell that starts each column's vertical merge, by grid column.
  const merging = new Map<number, Cell>();
  // Header rows repeat at the top of the table; Google Docs marks every row so, which means none is a header.
  let headerRows = 0;
  while (headerRows < rowElements.length && flag(child(rowElements[headerRows], "w:trPr"), "w:tblHeader")) headerRows += 1;
  if (headerRows === rowElements.length) headerRows = 0;
  for (const [index, tr] of rowElements.entries()) {
    const cells: Cell[] = [];
    const header = index < headerRows;
    let col = Number(val(child(child(tr, "w:trPr"), "w:gridBefore")) ?? 0) || 0;
    for (const tc of elements(tr, "w:tc")) {
      const tcPr = child(tc, "w:tcPr");
      const colspan = Number(val(child(tcPr, "w:gridSpan")) ?? 1) || 1;
      const vMerge = child(tcPr, "w:vMerge");
      if (vMerge && val(vMerge) !== "restart" && merging.has(col)) {
        merging.get(col)!.rowspan += 1;
        col += colspan;
        continue;
      }
      const blocks = groupLists(await readBlocks(tc, ctx, header ? "header" : "cell")).filter((block) => block.type !== schema.nodes.page_break);
      // Inline writes header cells with their light grey; that's how a header cell looks anyway.
      const shading = cellShading(tcPr);
      const cell: Cell = { col, colspan, rowspan: 1, background: header && shading === HEADER_FILL ? null : shading, blocks, header };
      if (vMerge) merging.set(col, cell);
      else merging.delete(col);
      cells.push(cell);
      col += colspan;
    }
    rows.push(cells);
  }
  if (!rows.some((cells) => cells.length)) return null;
  // Each row's width counts the cells merged down into it from above.
  const occupied = rows.map(() => 0);
  rows.forEach((cells, r) => cells.forEach((cell) => {
    for (let k = 0; k < cell.rowspan && r + k < rows.length; k += 1) occupied[r + k]! += cell.colspan;
  }));
  const width = Math.max(...occupied);
  const nodes: PMNode[] = [];
  rows.forEach((cells, r) => {
    const made = cells.map((cell) =>
      (cell.header ? schema.nodes.table_header! : schema.nodes.table_cell!).create(
        { colspan: cell.colspan, rowspan: Math.min(cell.rowspan, rows.length - r), background: cell.background },
        cell.blocks.length ? cell.blocks : [schema.nodes.paragraph!.create()],
      ),
    );
    for (let i = occupied[r]!; i < width; i += 1) made.push(schema.nodes.table_cell!.create(null, schema.nodes.paragraph!.create()));
    if (made.length) nodes.push(schema.nodes.table_row!.create(null, made));
  });
  return nodes.length ? schema.nodes.table!.create(null, nodes) : null;
}

async function readBlocks(container: XmlElement, ctx: Context, cell: "cell" | "header" | null = null, items = elements(container)): Promise<Block[]> {
  const blocks: Block[] = [];
  for (const item of items) {
    if (item.name === "w:p") blocks.push(...(await readParagraph(item, ctx, cell)));
    else if (item.name === "w:tbl") {
      const table = await readTable(item, ctx);
      if (table) blocks.push(table);
    } else if (item.name === "w:sdt") {
      const inner = child(item, "w:sdtContent");
      if (inner) blocks.push(...(await readBlocks(inner, ctx, cell)));
    } else if (item.name === "w:commentRangeStart") commentRangeStart(ctx, item.attrs["w:id"]);
    else if (item.name === "w:commentRangeEnd") commentRangeEnd(ctx, item.attrs["w:id"]);
  }
  return blocks;
}

/** Turn runs of numbered paragraphs into (nested) list nodes. */
function groupLists(blocks: Block[]): PMNode[] {
  const out: PMNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i]!;
    if ("boxed" in block) {
      // Paragraphs boxed together are a one-cell table, which draws the box.
      const inside: PMNode[] = [];
      while (i < blocks.length && "boxed" in blocks[i]!) inside.push(...(blocks[i++] as BoxEntry).boxed);
      if (inside.length) out.push(schema.nodes.table!.create(null, schema.nodes.table_row!.create(null, schema.nodes.table_cell!.create(null, inside))));
      continue;
    }
    if (!("list" in block)) {
      // Word holds a code block as one paragraph per line.
      const previous = out[out.length - 1];
      if (block.type === schema.nodes.code_block && previous?.type === schema.nodes.code_block && !previous.attrs.language) {
        out[out.length - 1] = schema.nodes.code_block!.create(previous.attrs, schema.text(`${previous.textContent}\n${block.textContent}`));
      } else if (block.type === schema.nodes.blockquote && previous?.type === schema.nodes.blockquote) {
        // ...and a quote as one paragraph after another in the Quote style.
        out[out.length - 1] = schema.nodes.blockquote!.create(previous.attrs, [...childrenOf(previous), ...childrenOf(block)]);
      } else if (ruleCandidates.has(block as PMNode) && ![blocks[i - 1], blocks[i + 1]].some((other) => other && !("list" in other) && !("boxed" in other) && sameBorders(other.attrs.borders, (block as PMNode).attrs.borders))) {
        // An empty paragraph with a line under it is a horizontal line, unless its line is shared with a neighbour's.
        out.push(schema.nodes.horizontal_rule!.create());
      } else out.push(block as PMNode);
      i += 1;
      continue;
    }
    const run: ListEntry[] = [];
    while (i < blocks.length && "list" in blocks[i]!) {
      run.push(blocks[i] as ListEntry);
      i += 1;
    }
    out.push(...buildLists(run, Math.min(...run.map((item) => item.list.level)), 0, 0));
  }
  return out;
}

/**
 * `depth` counts the numbered lists these sit inside, which decides their usual marker style (1., a., i.);
 * `parentLeft` is where the text of the item they sit in starts (twips from the margin).
 */
function buildLists(run: ListEntry[], level: number, depth: number, parentLeft: number): PMNode[] {
  const lists: PMNode[] = [];
  let items: PMNode[] = [];
  let kind: { bullet: boolean; start: number; numId?: string; numbering?: ListNumbering; layout: ListLayout } | null = null;
  const flush = () => {
    if (!items.length || !kind) return;
    const numbering = kind.numbering && kind.numbering !== defaultListNumbering(depth) ? kind.numbering : null;
    // Where the text starts and the marker hangs, as Word and Google Docs indent the list.
    const geometry = kind.layout.plain ? {} : { indent: Math.max(0, round((kind.layout.left - parentLeft) / 20, 0.01)), hanging: Math.max(0, round(kind.layout.hanging / 20, 0.01)), marker: kind.layout.marker };
    lists.push(kind.bullet ? schema.nodes.bullet_list!.create(geometry, items) : schema.nodes.ordered_list!.create({ ...geometry, marker: null, order: kind.start, numbering }, items));
    items = [];
  };
  let i = 0;
  while (i < run.length) {
    const entry = run[i]!;
    if (entry.list.level > level) {
      const nested: ListEntry[] = [];
      while (i < run.length && run[i]!.list.level > level) nested.push(run[i++]!);
      const inner = Math.min(...nested.map((item) => item.list.level));
      const last = items.pop();
      if (!last) {
        // Sub-items before any item at this level have no item to sit in; they're a list of their own
        // (an empty parent would take a number of its own and its style would leak to this list).
        flush();
        lists.push(...buildLists(nested, inner, depth, parentLeft));
        continue;
      }
      // Deeper entries nest inside the previous item.
      const sublists = buildLists(nested, inner, depth + (kind!.bullet ? 0 : 1), kind!.layout.left);
      items.push(last.type.create(last.attrs, [...childrenOf(last), ...sublists]));
      continue;
    }
    // A different Word list (a lettered list after a numbered one, say) is a list of its own.
    if (kind && (kind.bullet !== entry.list.bullet || (kind.numId && kind.numId !== entry.list.numId))) flush();
    if (!items.length) kind = { bullet: entry.list.bullet, start: entry.list.start, numId: entry.list.numId, numbering: entry.list.numbering, layout: entry.layout };
    items.push(schema.nodes.list_item!.create({ checked: entry.checked ?? null }, entry.paragraph));
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

// --- comments --------------------------------------------------------------------------

function readComments(parts: DocxParts): CommentInfo[] {
  const xml = readPart(parts, "word/comments.xml");
  if (!xml) return [];
  const extended = new Map<string, { parent?: string; done: boolean }>();
  const extXml = readPart(parts, "word/commentsExtended.xml");
  if (extXml) {
    for (const ex of elements(child(parseXml(extXml), "w15:commentsEx") ?? EMPTY, "w15:commentEx")) {
      const paraId = ex.attrs["w15:paraId"];
      if (paraId) extended.set(paraId, { parent: ex.attrs["w15:paraIdParent"], done: ex.attrs["w15:done"] === "1" });
    }
  }
  return elements(child(parseXml(xml), "w:comments") ?? EMPTY, "w:comment").map((comment) => {
    const paragraphs = elements(comment, "w:p");
    const paraId = paragraphs[paragraphs.length - 1]?.attrs["w14:paraId"];
    const ex = paraId ? extended.get(paraId) : undefined;
    const date = Date.parse(comment.attrs["w:date"] ?? "");
    return {
      id: comment.attrs["w:id"] ?? "",
      author: comment.attrs["w:author"] ?? "",
      date: Number.isFinite(date) ? date : Date.now(),
      text: paragraphs.map((p) => textOf(p)).join("\n").replace(/\n{3,}/g, "\n\n").trim(),
      paraId,
      parentParaId: ex?.parent,
      done: Boolean(ex?.done),
    };
  });
}

/** Where each comment's range starts and ends, in characters of document text, so comments on the same text become one thread. */
function commentRanges(body: XmlElement) {
  const ranges = new Map<string, { start: number; end: number }>();
  let offset = 0;
  const walk = (node: XmlElement) => {
    for (const item of elements(node)) {
      if (item.name === "w:t") offset += textOf(item).length;
      else if (item.name === "w:commentRangeStart") ranges.set(item.attrs["w:id"] ?? "", { start: offset, end: offset });
      else if (item.name === "w:commentRangeEnd") {
        const range = ranges.get(item.attrs["w:id"] ?? "");
        if (range) range.end = offset;
      } else walk(item);
    }
  };
  walk(body);
  return ranges;
}

/**
 * Inline comments from Word's: replies (marked as such, or Google's way, a
 * second comment on exactly the same text) join their thread. Inline shows
 * every comment as yours, so the original author leads each one.
 */
function buildThreads(comments: CommentInfo[], ranges: Map<string, { start: number; end: number }>) {
  const marks = new Map<string, string>();
  const threads = new Map<string, DocComment>();
  const byParaId = new Map(comments.filter((c) => c.paraId).map((c) => [c.paraId!, c]));
  const byRange = new Map<string, string>();
  // Inline's own files name its comments "You" and "Claude"; anyone else's name leads the comment.
  const author = (comment: CommentInfo): CommentAuthor => (comment.author === "Claude" ? "claude" : "user");
  const body = (comment: CommentInfo) => (comment.author && comment.author !== "You" && comment.author !== "Claude" ? `${comment.author}: ${comment.text}` : comment.text);
  // Thread starters first, then replies, each in the order they were written.
  const order = [...comments].sort((a, b) => Number(Boolean(a.parentParaId)) - Number(Boolean(b.parentParaId)) || a.date - b.date || Number(a.id) - Number(b.id));
  for (const comment of order) {
    const range = ranges.get(comment.id);
    const parent = comment.parentParaId ? byParaId.get(comment.parentParaId) : undefined;
    const rangeKey = range ? `${range.start}:${range.end}` : null;
    const rootWordId = parent ? parent.id : rangeKey && !comment.parentParaId ? byRange.get(rangeKey) : undefined;
    const rootMark = rootWordId ? marks.get(rootWordId) : undefined;
    if (rootMark && threads.has(rootMark)) {
      threads.get(rootMark)!.replies.push({ id: newId(10), author: author(comment), body: body(comment), createdAt: comment.date });
      marks.set(comment.id, rootMark);
      continue;
    }
    const id = newId(10);
    threads.set(id, { id, author: author(comment), body: body(comment), quote: "", createdAt: comment.date, resolved: comment.done, replies: [] });
    marks.set(comment.id, id);
    if (rangeKey) byRange.set(rangeKey, comment.id);
  }
  return { marks, threads };
}

function commentIdsIn(doc: PMNode) {
  const ids = new Set<string>();
  doc.descendants((node) => {
    for (const mark of node.marks) if (mark.type === schema.marks.comment) ids.add(mark.attrs.id as string);
  });
  return ids;
}

// --- Google Docs tabs ------------------------------------------------------------------------

const sectionEnd = (item: XmlElement | undefined) => item?.name === "w:p" && Boolean(child(child(item, "w:pPr"), "w:sectPr"));

/**
 * Google Docs writes each tab as a section. Takeout starts each with the tab's
 * name in the Title style; File › Download leaves the names out, so there each
 * section is a tab with no name. Splits the body there, or returns null for a
 * document without tabs.
 */
function googleTabs(body: XmlElement, ctx: Context): Array<{ title: string | null; items: XmlElement[] }> | null {
  const items = elements(body).filter((item) => item.name !== "w:sectPr");
  const starts: number[] = [];
  items.forEach((item, index) => {
    if (!sectionEnd(item) || (index > 0 && !sectionEnd(items[index - 1]))) return;
    if (styleKind(ctx, val(child(child(item, "w:pPr"), "w:pStyle"))).kind !== "title") return;
    starts.push(index);
  });
  // One tab still gets its name written at the top; it isn't part of the text.
  if (starts.length && starts[0] === 0) {
    return starts.map((start, n) => ({
      title: textOf(items[start]!).replace(/\s+/g, " ").trim(),
      items: items.slice(start + 1, starts[n + 1] ?? items.length),
    }));
  }
  if (!ctx.google || ctx.inline) return null;
  // A section ends with its last paragraph, which is still part of its text.
  const ends = items.flatMap((item, index) => (sectionEnd(item) && index < items.length - 1 ? [index + 1] : []));
  if (!ends.length) return null;
  return [0, ...ends].map((start, n) => ({ title: null, items: items.slice(start, ends[n] ?? items.length) }));
}

// --- reading a whole document --------------------------------------------------------------

export class DocxImportError extends Error {}

/** The longest header or footer text Inline keeps (see normalizeSettings). */
const MAX_HEADER_LENGTH = 500;

export type ImportedTab = { title: string | null; doc: PMNode; comments: DocComment[] };
export type ImportedDocx = { settings: DocumentSettings; tabs: ImportedTab[] };

function finishDoc(blocks: PMNode[]) {
  // Word ends many documents with an empty paragraph; drop trailing empties.
  while (blocks.length > 1 && blocks[blocks.length - 1]!.type === schema.nodes.paragraph && blocks[blocks.length - 1]!.content.size === 0) blocks.pop();
  const doc = schema.nodes.doc!.create(null, blocks.length ? blocks : [schema.nodes.paragraph!.create()]);
  doc.check();
  return doc;
}

/** Read a .docx package: its settings and its content, one entry per Google Docs tab (or just one). */
/**
 * The fonts the document carries (Google Docs carries every font that isn't
 * one of Windows'), undoing Word's obfuscation: the first 32 bytes are XORed
 * with the font's key.
 */
export function embeddedFonts(parts: DocxParts): EmbeddedFont[] {
  const xml = readPart(parts, "word/fontTable.xml");
  if (!xml) return [];
  const rels = readRels(parts, "word/_rels/fontTable.xml.rels");
  const fonts: EmbeddedFont[] = [];
  for (const font of elements(child(parseXml(xml), "w:fonts") ?? EMPTY, "w:font")) {
    const family = font.attrs["w:name"]?.trim();
    if (!family) continue;
    for (const [name, bold, italic] of [["w:embedRegular", false, false], ["w:embedBold", true, false], ["w:embedItalic", false, true], ["w:embedBoldItalic", true, true]] as const) {
      const embed = child(font, name);
      const target = embed ? rels.get(embed.attrs["r:id"] ?? "")?.target : undefined;
      if (!embed || !target) continue;
      const stored = parts.get(target.startsWith("/") ? target.slice(1) : `word/${target}`);
      if (!stored || stored.length < 64) continue;
      const data = stored.slice();
      const key = (embed.attrs["w:fontKey"] ?? "").replace(/[^0-9a-f]/gi, "");
      if (key.length === 32 && /[1-9a-f]/i.test(key)) {
        const bytes = key.match(/../g)!.map((pair) => parseInt(pair, 16)).reverse();
        for (let i = 0; i < 32; i += 1) data[i]! ^= bytes[i % 16]!;
      }
      const tag = String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!);
      if (tag === "\u0000\u0001\u0000\u0000" || tag === "OTTO" || tag === "true") fonts.push({ family, bold, italic, data });
    }
  }
  return fonts;
}

export async function readDocx(parts: DocxParts, options: { saveImage?: SaveImage; saveFont?: SaveFont; tabs?: boolean } = {}): Promise<ImportedDocx> {
  const xml = readPart(parts, "word/document.xml");
  if (!xml) throw new DocxImportError("This isn't a Word document (word/document.xml is missing).");
  const body = child(child(parseXml(xml), "w:document"), "w:body");
  if (!body) throw new DocxImportError("This Word document has no body.");
  const { styles, defaults } = readStyles(parts);
  // Google Docs names its normal style in lower case.
  const google = /<w:style\b[^>]*w:styleId="Normal"[^>]*>\s*<w:name w:val="normal"\/>/.test(readPart(parts, "word/styles.xml") ?? "");
  // Google draws text with no size as its Normal text, 11pt, even when the file keeps another default (one first made in Word says 12pt).
  const ours = inlineOrigin(parts).ours;
  if (google && !ours) defaults.run.size = 11;
  const defaultParagraphStyle = [...styles].find(([, style]) => style.type === "paragraph" && style.isDefault)?.[0];
  const settings = readSettings(parts, body, styles, defaults, defaultParagraphStyle);
  const normalRun = merge(defaults.run, ...styleChain({ styles }, defaultParagraphStyle).map((style) => style.run));
  const { marks: commentMarks, threads } = buildThreads(readComments(parts), commentRanges(body));
  const ctx: Context = {
    styles,
    defaultParagraphStyle,
    defaults,
    numbering: readNumbering(parts),
    counters: new Map(),
    rels: readRels(parts),
    parts,
    saveImage: options.saveImage,
    settings,
    bodyFont: primaryFamily(settings.fontFamily) || normalRun.font || "Arial",
    commentMarks,
    activeComments: new Set(),
    commentQuotes: new Map(),
    inline: ours,
    google,
  };
  if (options.saveFont) for (const font of embeddedFonts(parts)) await options.saveFont(font);

  const sections = (options.tabs !== false && googleTabs(body, ctx)) || [{ title: null, items: elements(body) }];
  const tabs: ImportedTab[] = [];
  for (const section of sections) {
    const blocks = groupLists(await readBlocks(body, ctx, null, section.items));
    // A lone tab's name is never shown, so a document with one tab has none.
    tabs.push({ title: sections.length > 1 ? section.title : null, doc: finishDoc(blocks), comments: [] });
  }
  // Inline's header and footer are a line of text; a whole note kept there goes at the top of the page instead of being cut off.
  const moved: PMNode[] = [];
  for (const key of ["header", "firstHeader", "footer", "firstFooter"] as const) {
    if (settings.headerFooter[key].length <= MAX_HEADER_LENGTH) continue;
    moved.push(schema.nodes.paragraph!.create(null, schema.text(settings.headerFooter[key])));
    settings.headerFooter[key] = "";
  }
  if (moved.length) tabs[0]!.doc = finishDoc([...moved, ...childrenOf(tabs[0]!.doc)]);
  // Each thread goes with the tab its text is in; one whose text is gone stays with the first tab.
  for (const thread of threads.values()) {
    thread.quote = (ctx.commentQuotes.get(thread.id) ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
    const tab = tabs.find((item) => commentIdsIn(item.doc).has(thread.id)) ?? tabs[0]!;
    tab.comments.push(thread);
  }
  return { settings, tabs };
}

/** Read a .docx package into one Inline document (tabs and all, in order). */
export async function docxToDoc(parts: DocxParts, options: { saveImage?: SaveImage } = {}): Promise<PMNode> {
  return (await readDocx(parts, { ...options, tabs: false })).tabs[0]!.doc;
}

/** The document's title from its core properties, if it has one. */
export function docxTitle(parts: DocxParts): string | null {
  const xml = readPart(parts, "docProps/core.xml");
  if (!xml) return null;
  const match = /<dc:title>([\s\S]*?)<\/dc:title>/.exec(xml);
  return match ? decodeEntities(match[1]!).trim() || null : null;
}
