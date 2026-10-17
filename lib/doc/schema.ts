import { Schema, type DOMOutputSpec, type Mark, type Node as PMNode, type NodeSpec, type MarkSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";
import { lineVars } from "@/lib/doc/fontMetrics";
import { cropToken, parseCropToken, pictureCrop, pictureRotate, pictureWrap, type PictureCrop, type PictureWrap } from "@/lib/doc/picture";
import { nodeStyleId, safeStyleId } from "@/lib/doc/styles";

/**
 * The Inline document schema. It is shared by the browser editor, the server
 * document authority and the agent's MCP tools, so every part of the system
 * agrees on what a document can contain.
 *
 * Block nodes that can appear at the top level carry a stable `id` attribute
 * (assigned by `ensureBlockIds`) so the UI and the agent can refer to blocks
 * across edits.
 */

export type Align = "left" | "center" | "right" | "justify";

/**
 * Link targets Inline allows: web, mail and phone links, local and UNC file
 * links (`file://`, or a Windows path written as one), in-document anchors
 * and relative paths. Script and data URLs are refused wherever a link enters
 * a document (paste, import, Markdown, Claude's tools) and never rendered.
 * A file link has to name a file (`file://` with a path, no sign-in) so the
 * stored target is one Word, a PDF reader, or the desktop app can open.
 */
export function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  // Browsers ignore control characters and whitespace inside a scheme ("java\tscript:").
  const scheme = /^([^:/?#]+):/.exec(trimmed.replace(/[\u0000-\u0020\u007f]+/g, ""))?.[1]?.toLowerCase();
  if (scheme === "file") {
    const normalized = trimmed.replace(/\\/g, "/");
    return acceptableFileHref(normalized) ? normalized : null;
  }
  if (scheme && !["http", "https", "mailto", "tel"].includes(scheme)) return null;
  return trimmed;
}

/**
 * A file URL, a drive path (`C:\Docs\a.docx`) or a UNC path (`\\server\share\a.docx`)
 * written as a `file://` URL. Other text is left for `safeHref`.
 */
export function fileLinkHref(value: string): string | null {
  const trimmed = value.trim();
  if (/^file:/i.test(trimmed)) return trimmed.replace(/\\/g, "/");
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return `file:///${trimmed.replace(/\\/g, "/")}`;
  if (/^\\\\[^\\]+\\[^\\]+/.test(trimmed)) return `file://${trimmed.slice(2).replace(/\\/g, "/")}`;
  return null;
}

/** `file://` with a real path and no embedded sign-in. Empty and script-like targets are refused. */
function acceptableFileHref(href: string): boolean {
  if (!/^file:\/\//i.test(href)) return false;
  if (/[\u0000-\u001f\u007f]/.test(href)) return false;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== "file:") return false;
  if (url.username || url.password) return false;
  return Boolean(url.pathname && url.pathname !== "/");
}

/** A footnote label Markdown can round-trip inside `[^label]`: a short token, no spaces. */
export function footnoteLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(value) ? value : null;
}

export const ALIGNMENTS: Align[] = ["left", "center", "right", "justify"];

/** Numbered-list marker styles, as CSS names them. */
export const LIST_NUMBERINGS = ["decimal", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman"] as const;
export type ListNumbering = (typeof LIST_NUMBERINGS)[number];

/** The marker style a numbered list gets by default at a depth (0 for the top), as app/styles/document.css numbers them. */
export function defaultListNumbering(depth: number): ListNumbering {
  return depth === 0 ? "decimal" : depth === 1 ? "lower-alpha" : "lower-roman";
}
/** Left indent, in half-inch steps. High enough to cross a landscape page. */
export const MAX_INDENT = 24;

/** A tab stop: `pos` in points from the left margin. */
export type TabStop = { pos: number; align: "left" | "center" | "right" | "decimal"; leader?: "dot" | "hyphen" | "underscore" | "middleDot" | null };

/** A line drawn along one side of a paragraph: its width and its distance from the text in points, and its color (#rrggbb, null for the text's). */
export type BorderLine = { style: "solid" | "double" | "dotted" | "dashed"; width: number; space: number; color: string | null };
/** `between` is drawn between neighbouring paragraphs with the same borders, which otherwise share one box. */
export type Borders = Partial<Record<"top" | "bottom" | "left" | "right" | "between", BorderLine>>;

/** A table or cell edge. `nil` is an edge the user turned off. Width is in points; color is `#rrggbb` or null for the text's. */
export type TableLineStyle = "solid" | "double" | "dotted" | "dashed" | "nil";
export type TableLine = { style: TableLineStyle; width: number; color: string | null };
export type TableBorders = Partial<Record<"top" | "left" | "bottom" | "right" | "insideH" | "insideV", TableLine>>;
export type CellBorders = Partial<Record<"top" | "right" | "bottom" | "left", TableLine>>;
export type RowHeightRule = "atLeast" | "exact";

/** The smallest text Google Docs draws (3px); smaller sizes are drawn at this size. */
export const MIN_FONT_PT = 2.25;

const blockAttrs = {
  id: { default: null as string | null },
  align: { default: "left" as Align },
  /** Left indent in half inches (fractions for indents that came from elsewhere). */
  indent: { default: 0 },
  lineHeight: { default: null as string | null },
  spaceBefore: { default: null as number | null },
  spaceAfter: { default: null as number | null },
  /** Keep this paragraph on the same page as the next one. */
  keepNext: { default: null as boolean | null },
  /** Don't split this paragraph across pages when it fits on one page. */
  keepLines: { default: null as boolean | null },
  /**
   * Widow and orphan control. Null leaves it on, which is how Google Docs
   * starts a document ("Prevent single lines"). False turns it off.
   */
  widowControl: { default: null as boolean | null },
  /** Start this paragraph on a new page. */
  pageBreakBefore: { default: null as boolean | null },
  /** First-line indent in inches; negative is a hanging indent (works cited, bibliographies). */
  textIndent: { default: null as number | null },
  /** Right indent in inches, in from the far margin. */
  rightIndent: { default: null as number | null },
  /** A works-cited entry. The hanging indent is `textIndent` (half an inch when the entry doesn't say otherwise). */
  bibliography: { default: false },
  /** When set, this paragraph is the text of the footnote with this label. The marker in the text is a `footnote_ref`. */
  footnote: { default: null as string | null },
  /**
   * "rtl" for right-to-left text (Arabic, Hebrew). As in Word, "left" and
   * "right" alignment then mean the paragraph's start and end: a right-to-left
   * paragraph aligned "left" sits at the right.
   */
  dir: { default: null as "rtl" | null },
  /**
   * The paragraph's own text size in points, when it isn't the document's: an
   * empty paragraph is a line of this size (Word's and Google's paragraph
   * mark), and text without a size of its own takes it.
   */
  fontSize: { default: null as number | null },
  /** Tab stops, in order; tabs past the last go to the document's default stops. */
  tabs: { default: null as TabStop[] | null },
  borders: { default: null as Borders | null },
  /** Where the lines broke in the PDF the paragraph was rebuilt from, kept until its text changes (lib/doc/lineBreaks.ts). */
  lineBreaks: { default: null as string | null },
  /**
   * Named paragraph style (lib/doc/styles.ts). Null means the style the block
   * type already is: Normal, Title, a heading, Quote or Code.
   */
  style: { default: null as string | null },
};

const BORDER_SIDES = ["top", "bottom", "left", "right"] as const;

const TABLE_LINE_STYLES = new Set<TableLineStyle>(["solid", "double", "dotted", "dashed", "nil"]);

function tableLineFrom(value: unknown): TableLine | null {
  if (!value || typeof value !== "object") return null;
  const line = value as TableLine;
  if (!TABLE_LINE_STYLES.has(line.style)) return null;
  const width = Number(line.width);
  if (!Number.isFinite(width) || width < 0 || width > 48) return null;
  if (line.color != null && (typeof line.color !== "string" || !/^#[0-9a-f]{6}$/i.test(line.color))) return null;
  return { style: line.style, width, color: line.color ? line.color.toLowerCase() : null };
}

function linesFrom<K extends string>(value: unknown, sides: readonly K[]): Partial<Record<K, TableLine>> | null {
  if (!value || typeof value !== "object") return null;
  const out: Partial<Record<K, TableLine>> = {};
  for (const side of sides) {
    if (!(side in (value as object))) continue;
    const line = tableLineFrom((value as Record<string, unknown>)[side]);
    if (!line) return null;
    out[side] = line;
  }
  return Object.keys(out).length ? out : null;
}

export function tableBordersFrom(value: unknown): TableBorders | null {
  return linesFrom(value, ["top", "left", "bottom", "right", "insideH", "insideV"]);
}

export function cellBordersFrom(value: unknown): CellBorders | null {
  return linesFrom(value, ["top", "right", "bottom", "left"]);
}

/** A table edge as CSS. `nil` draws nothing; a hairline is still a pixel, as the page draws paragraph borders. */
export function tableLineCss(line: TableLine | undefined): string {
  if (!line || line.style === "nil") return "none";
  const px = Math.max(1, Math.round((line.width * 96) / 72));
  return `${px}px ${line.style} ${line.color ?? "currentColor"}`;
}

export function cellBorderCss(borders: CellBorders): string {
  return (["top", "right", "bottom", "left"] as const)
    .filter((side) => borders[side])
    .map((side) => `border-${side}: ${tableLineCss(borders[side])}`)
    .join("; ");
}

/** A formula Inline evaluates in a table cell: SUM of a rectangle or of the cells above, below, left or right. */
export function normalizeFormula(raw: string): string | null {
  const match = /^\s*=?\s*SUM\s*\(\s*([A-Za-z]+\d+\s*:\s*[A-Za-z]+\d+|[A-Za-z]+\d+|above|below|left|right)\s*\)\s*$/i.exec(raw.trim());
  if (!match) return null;
  return `SUM(${match[1]!.toUpperCase().replace(/\s+/g, "")})`;
}

/** A border as CSS: whole pixels, as Google Docs draws them, at least one wide. */
function borderCss(line: BorderLine) {
  const width = Math.max(1, Math.round((line.width * 4) / 3));
  const style = line.style === "double" && width < 3 ? "solid" : line.style;
  return { border: `${width}px ${style} ${line.color ?? "currentColor"}`, width, space: Math.round((line.space * 4) / 3) };
}

/** A font size as CSS, no smaller than Google Docs draws text. */
export function fontSizeCss(pt: number) {
  return `${Math.max(MIN_FONT_PT, pt)}pt`;
}

function blockStyle(node: PMNode, extra = ""): string {
  const parts: string[] = [];
  const { align, indent, lineHeight, spaceBefore, spaceAfter, textIndent, rightIndent, dir, fontSize } = node.attrs;
  const borders = node.attrs.borders as Borders | null;
  const rtl = dir === "rtl";
  // Right-to-left blocks align and indent from their start, the right.
  if (align && align !== "left") parts.push(`text-align: ${rtl && align === "right" ? "left" : align}`);
  const side = rtl ? "right" : "left";
  const end = rtl ? "left" : "right";
  // A side border sits outside the text, as in Word: the margin makes room for it and its space.
  const start = borders?.[side] ? borderCss(borders[side]!) : null;
  const finish = borders?.[end] ? borderCss(borders[end]!) : null;
  const margin = (Number(indent) || 0) * 0.5;
  if (start) parts.push(`margin-${side}: calc(${margin}in - ${start.width + start.space}px)`);
  else if (margin) parts.push(`margin-${side}: ${margin}in`);
  const right = Number(rightIndent) || 0;
  if (finish && right) parts.push(`margin-${end}: calc(${right}in - ${finish.width + finish.space}px)`);
  else if (finish) parts.push(`margin-${end}: -${finish.width + finish.space}px`);
  else if (right) parts.push(`margin-${end}: ${right}in`);
  if (textIndent) parts.push(`text-indent: ${textIndent}in`);
  const padStart = (textIndent < 0 ? -textIndent : 0) * 96 + (start?.space ?? 0);
  if (padStart) parts.push(`padding-${side}: ${textIndent < 0 && !start ? `${-textIndent}in` : `${padStart}px`}`);
  if (fontSize) parts.push(`font-size: ${fontSizeCss(fontSize)}`);
  if (lineHeight) parts.push(`line-height: ${lineHeight}`, `--ls: ${lineHeight}`);
  if (spaceBefore != null) parts.push(`margin-top: ${spaceBefore}pt`);
  if (spaceAfter != null) parts.push(`margin-bottom: ${spaceAfter}pt`);
  if (borders) {
    for (const edge of BORDER_SIDES) {
      const line = borders[edge];
      if (!line) continue;
      const css = borderCss(line);
      parts.push(`border-${edge}: ${css.border}`);
      if ((edge === "top" || edge === "bottom") && css.space) parts.push(`padding-${edge}: ${css.space}px`);
      if (edge === end && css.space) parts.push(`padding-${edge}: ${css.space}px`);
    }
    if (borders.between) {
      const css = borderCss(borders.between);
      parts.push(`--border-between: ${css.border}`, `--border-between-space: ${css.space}px`);
    }
  }
  if (extra) parts.push(extra);
  return parts.join("; ");
}

/** A block's own space above and below as CSS margins ("" for the usual). */
export function blockSpacing(node: PMNode) {
  const parts: string[] = [];
  if (node.attrs.spaceBefore != null) parts.push(`margin-top: ${node.attrs.spaceBefore}pt`);
  if (node.attrs.spaceAfter != null) parts.push(`margin-bottom: ${node.attrs.spaceAfter}pt`);
  return parts.join("; ");
}

/** A code block's own size, leading and spacing. Null attrs keep the usual CSS. */
function codeBlockStyle(node: PMNode) {
  const parts: string[] = [];
  if (node.attrs.fontSize) parts.push(`font-size: ${fontSizeCss(node.attrs.fontSize)}`);
  if (node.attrs.lineHeight) parts.push(`line-height: ${node.attrs.lineHeight}`, `--ls: ${node.attrs.lineHeight}`);
  const spacing = blockSpacing(node);
  if (spacing) parts.push(spacing);
  return parts.join("; ");
}

/** Whether two paragraphs' borders are the same, so they share one box (as Word and Google Docs draw them). */
export function sameBorders(a: Borders | null | undefined, b: Borders | null | undefined) {
  if (!a || !b) return false;
  return (["top", "bottom", "left", "right", "between"] as const).every((edge) => {
    const x = a[edge];
    const y = b[edge];
    if (!x || !y) return !x && !y;
    return x.style === y.style && x.width === y.width && x.space === y.space && (x.color ?? null) === (y.color ?? null);
  });
}

function blockDomAttrs(node: PMNode, extra: Record<string, string> = {}) {
  const attrs: Record<string, string> = { ...extra };
  const classes = [extra.class, node.attrs.bibliography ? "doc-bibliography" : "", node.attrs.footnote ? "doc-footnote" : ""].filter(Boolean);
  if (classes.length) attrs.class = classes.join(" ");
  if (node.attrs.footnote) attrs["data-footnote"] = String(node.attrs.footnote);
  if (node.attrs.id) attrs["data-id"] = node.attrs.id;
  attrs["data-style"] = nodeStyleId(node);
  if (node.attrs.dir === "rtl") attrs.dir = "rtl";
  // What a style can't say exactly travels with the paragraph when it is copied and pasted.
  if (node.attrs.fontSize) attrs["data-font-size"] = String(node.attrs.fontSize);
  if (node.attrs.tabs) attrs["data-tabs"] = JSON.stringify(node.attrs.tabs);
  if (node.attrs.borders) attrs["data-borders"] = JSON.stringify(node.attrs.borders);
  if (node.attrs.lineBreaks) attrs["data-line-breaks"] = String(node.attrs.lineBreaks);
  if (node.attrs.keepNext) attrs["data-keep-next"] = "true";
  if (node.attrs.keepLines) attrs["data-keep-lines"] = "true";
  if (node.attrs.widowControl === false) attrs["data-widow"] = "false";
  else if (node.attrs.widowControl === true) attrs["data-widow"] = "true";
  if (node.attrs.pageBreakBefore) attrs["data-page-break-before"] = "true";
  if (node.attrs.indent && !Number.isInteger(Number(node.attrs.indent))) attrs["data-indent"] = String(node.attrs.indent);
  if (node.attrs.textIndent) attrs["data-text-indent"] = String(node.attrs.textIndent);
  if (node.attrs.rightIndent) attrs["data-right-indent"] = String(node.attrs.rightIndent);
  const style = blockStyle(node);
  if (style) attrs.style = style;
  return attrs;
}

function jsonAttr<T>(dom: HTMLElement, name: string, valid: (value: unknown) => boolean): T | null {
  const raw = dom.getAttribute(name);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return valid(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

const isTabs = (value: unknown) => Array.isArray(value) && value.every((tab) => tab && typeof tab === "object" && Number.isFinite((tab as TabStop).pos));
const isBorders = (value: unknown) =>
  Boolean(value) && typeof value === "object" && Object.values(value as object).every((line) => line && typeof line === "object" && Number.isFinite((line as BorderLine).width));

/** An inch measurement from a data attribute. Zero and anything past `limit` are none. */
function readSignedInches(raw: string | null, limit: number): number | null {
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value === 0 || Math.abs(value) > limit) return null;
  return Math.round(value * 1000) / 1000;
}

/** "0.5in" as a positive length. The negative margins a border writes are ignored. */
function parseLengthInches(value: string | undefined, limit: number): number | null {
  const match = value?.trim().match(/^([\d.]+)in$/);
  if (!match) return null;
  const inches = Math.round(Number(match[1]) * 1000) / 1000;
  return inches > 0 && inches <= limit ? inches : null;
}

/** "0.5in", "36pt" or "48px" in inches, rounded to a hundredth; null for none. */
export function parseTextIndent(value: string): number | null {
  const match = value.trim().match(/^(-?[\d.]+)(in|pt|px)$/);
  if (!match) return null;
  const amount = Number(match[1]) / (match[2] === "in" ? 1 : match[2] === "pt" ? 72 : 96);
  const rounded = Math.round(Math.max(-3, Math.min(3, amount)) * 100) / 100;
  return Number.isFinite(rounded) && rounded !== 0 ? rounded : null;
}

/** Space above or below a block given in points ("12pt", as Google Docs, Word and Inline's own copies write it); null otherwise. */
function parseSpace(value: string | undefined): number | null {
  const match = value?.trim().match(/^([\d.]+)pt$/);
  if (!match) return null;
  const pt = Number(match[1]);
  return Number.isFinite(pt) && pt <= 400 ? pt : null;
}

function parseBlockAttrs(dom: HTMLElement) {
  const style = dom.style;
  const rtl = dom.getAttribute("dir") === "rtl";
  let align = (style?.textAlign || dom.getAttribute("align") || "left") as Align;
  // A right-to-left block's "right" is its start; its far edge, the left, is "right".
  if (rtl && (align === "left" || align === "right")) align = align === "left" ? "right" : "left";
  const marginLeft = (rtl ? style?.marginRight : style?.marginLeft) || "";
  let indent = 0;
  const inches = marginLeft.match(/^([\d.]+)in$/);
  const px = marginLeft.match(/^([\d.]+)px$/);
  const exact = Number(dom.getAttribute("data-indent"));
  if (exact > 0) indent = exact;
  else if (inches) indent = Math.round(Number(inches[1]) / 0.5);
  else if (px) indent = Math.round(Number(px[1]) / 48);
  const fontSize = Number(dom.getAttribute("data-font-size"));
  const storedRight = readSignedInches(dom.getAttribute("data-right-indent"), 12);
  return {
    id: dom.getAttribute("data-id") || null,
    align: ALIGNMENTS.includes(align) ? align : "left",
    indent: Math.max(0, Math.min(MAX_INDENT, indent)),
    lineHeight: style?.lineHeight && /^[\d.]+$/.test(style.lineHeight) ? style.lineHeight : null,
    spaceBefore: parseSpace(style?.marginTop),
    spaceAfter: parseSpace(style?.marginBottom),
    keepNext: dom.getAttribute("data-keep-next") === "true" ? true : null,
    keepLines: dom.getAttribute("data-keep-lines") === "true" ? true : null,
    widowControl: dom.getAttribute("data-widow") === "false" ? false : dom.getAttribute("data-widow") === "true" ? true : null,
    pageBreakBefore: dom.getAttribute("data-page-break-before") === "true" ? true : null,
    textIndent: readSignedInches(dom.getAttribute("data-text-indent"), 3) ?? parseTextIndent(style?.textIndent || ""),
    rightIndent: storedRight != null && storedRight > 0 ? storedRight : parseLengthInches(rtl ? style?.marginLeft : style?.marginRight, 12),
    dir: rtl ? ("rtl" as const) : null,
    fontSize: fontSize > 0 && fontSize <= 400 ? fontSize : null,
    tabs: jsonAttr<TabStop[]>(dom, "data-tabs", isTabs),
    lineBreaks: dom.getAttribute("data-line-breaks") || null,
    borders: jsonAttr<Borders>(dom, "data-borders", isBorders),
    bibliography: (typeof dom.className === "string" ? dom.className : "").split(/\s+/).includes("doc-bibliography"),
    footnote: footnoteLabel(dom.getAttribute("data-footnote")),
    style: storedStyleFromDom(dom),
  };
}

/** A style id worth storing: not the one the element type already implies. */
function storedStyleFromDom(dom: HTMLElement) {
  const id = safeStyleId(dom.getAttribute("data-style") ?? "");
  if (!id) return null;
  const tag = dom.tagName;
  const implied = tag === "P" && dom.classList.contains("doc-title") ? "Title" : tag === "P" && dom.classList.contains("doc-subtitle") ? "Subtitle" : /^H[1-6]$/.test(tag) ? `Heading${tag.slice(1)}` : tag === "BLOCKQUOTE" ? "Quote" : tag === "PRE" ? "Code" : "Normal";
  return id === implied ? null : id;
}

/**
 * How a list's markers look when they aren't the page's usual ones: the
 * bullet's character, and its font (a CSS list), size in points, weight,
 * slant and color (#rrggbb). Unset parts follow the item's text.
 */
export type ListMarker = { text?: string; font?: string; size?: number; bold?: boolean; italic?: boolean; color?: string };

const listAttrs = {
  id: { default: null as string | null },
  /** Points from the edge of what holds the list to its text, when not the page's usual 0.375in. */
  indent: { default: null as number | null },
  /** Points the marker starts before the text, with `marker`. */
  hanging: { default: null as number | null },
  marker: { default: null as ListMarker | null },
};

const isMarker = (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

function parseListAttrs(dom: HTMLElement) {
  const indent = Number(dom.getAttribute("data-indent"));
  const hanging = Number(dom.getAttribute("data-hanging"));
  return {
    indent: indent > 0 && indent < 1000 ? indent : null,
    hanging: hanging > 0 && hanging < 1000 ? hanging : null,
    marker: jsonAttr<ListMarker>(dom, "data-marker", isMarker),
  };
}

/** A CSS string literal. */
const cssString = (text: string) => `"${text.replace(/["\\]/g, "\\$&").replace(/[\n\r]/g, " ")}"`;

function listDomAttrs(node: PMNode, extra: Record<string, string> = {}, styles: string[] = []) {
  const attrs: Record<string, string> = { ...extra };
  const style = [...styles];
  const { indent, hanging } = node.attrs as { indent: number | null; hanging: number | null };
  const marker = node.attrs.marker as ListMarker | null;
  if (indent != null) {
    attrs["data-indent"] = String(indent);
    style.push(`padding-left: ${indent}pt`);
  }
  if (hanging != null) attrs["data-hanging"] = String(hanging);
  // A bullet list's own marker is drawn by the page (document.css), hanging before the text.
  if (marker && node.type.name === "bullet_list") {
    attrs["data-marker"] = JSON.stringify(marker);
    // Every part is set ("initial" for the item's own), so a list inside another doesn't take the outer list's.
    style.push(
      `--marker-text: ${cssString(marker.text ?? "•")}`,
      `--marker-hanging: ${hanging ?? 18}pt`,
      `--marker-font: ${marker.font ? marker.font.replace(/[;{}<>\\]/g, "") : "initial"}`,
      `--marker-size: ${marker.size ? fontSizeCss(marker.size) : "initial"}`,
      `--marker-weight: ${marker.bold == null ? "initial" : marker.bold ? 700 : 400}`,
      `--marker-style: ${marker.italic == null ? "initial" : marker.italic ? "italic" : "normal"}`,
      `--marker-color: ${marker.color && /^#[0-9a-f]{6}$/i.test(marker.color) ? marker.color : "initial"}`,
    );
  }
  if (node.attrs.id) attrs["data-id"] = node.attrs.id;
  if (style.length) attrs.style = style.join("; ");
  return attrs;
}

function inlineImageAttrs(el: HTMLImageElement) {
  const px = (value: string) => (/^[\d.]+px$/.test(value) ? Number.parseFloat(value) : null);
  const opacity = Number.parseFloat(el.style.opacity);
  const widthAttr = el.getAttribute("width");
  const heightAttr = el.getAttribute("height");
  const fromAttr = (value: string | null) => {
    const n = value ? Number(value.replace(/px$/, "")) : Number.NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    src: el.getAttribute("src") || "",
    alt: el.getAttribute("alt") || "",
    width: px(el.style.width) ?? fromAttr(widthAttr),
    height: px(el.style.height) ?? fromAttr(heightAttr),
    opacity: Number.isFinite(opacity) && opacity < 1 ? opacity : null,
    dist: (() => {
      const values = (el.getAttribute("data-dist") ?? "").split(",").map(Number);
      return values.length === 4 && values.every((value) => Number.isFinite(value) && value >= 0) ? (values as [number, number, number, number]) : null;
    })(),
    ...readPictureDom(el),
  };
}

/** Crop and rotation carried on a picture element (`data-crop` is percents). */
function readPictureDom(el: HTMLElement) {
  const host = el.closest("[data-wrap], [data-crop], [data-rotate]");
  const read = (name: string) => el.getAttribute(name) || host?.getAttribute(name) || "";
  const fromClass = el.closest("figure")?.className.match(/\bwrap-(square|behind|front)\b/)?.[1];
  return {
    wrap: pictureWrap(read("data-wrap") || fromClass),
    crop: parseCropToken(read("data-crop")),
    rotate: pictureRotate(read("data-rotate")),
  };
}

/** Static paint for a picture outside the editor (clip hides the crop; the editor shrinks the frame). */
function pictureDom(crop: unknown, rotate: unknown) {
  const cropped = pictureCrop(crop);
  const turned = pictureRotate(rotate);
  const style = [
    cropped ? `clip-path: inset(${cropped.t * 100}% ${cropped.r * 100}% ${cropped.b * 100}% ${cropped.l * 100}%)` : "",
    turned != null ? `transform: rotate(${turned}deg)` : "",
  ]
    .filter(Boolean)
    .join("; ");
  const data: Record<string, string> = {};
  if (cropped) data["data-crop"] = cropToken(cropped);
  if (turned != null) data["data-rotate"] = String(turned);
  return { style, data };
}

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+", attrs: { canvas: { default: null } } },

  paragraph: {
    content: "inline*",
    group: "block",
    attrs: blockAttrs,
    parseDOM: [{ tag: "p", getAttrs: (dom) => parseBlockAttrs(dom as HTMLElement) }],
    toDOM: (node): DOMOutputSpec => ["p", blockDomAttrs(node), 0],
  },

  title: {
    content: "inline*",
    group: "block",
    defining: true,
    attrs: blockAttrs,
    parseDOM: [{ tag: "p.doc-title", priority: 60, getAttrs: (dom) => parseBlockAttrs(dom as HTMLElement) }],
    toDOM: (node): DOMOutputSpec => ["p", blockDomAttrs(node, { class: "doc-title" }), 0],
  },

  subtitle: {
    content: "inline*",
    group: "block",
    defining: true,
    attrs: blockAttrs,
    parseDOM: [{ tag: "p.doc-subtitle", priority: 60, getAttrs: (dom) => parseBlockAttrs(dom as HTMLElement) }],
    toDOM: (node): DOMOutputSpec => ["p", blockDomAttrs(node, { class: "doc-subtitle" }), 0],
  },

  heading: {
    content: "inline*",
    group: "block",
    defining: true,
    attrs: { ...blockAttrs, level: { default: 1 } },
    parseDOM: [1, 2, 3, 4, 5, 6].map((level) => ({
      tag: `h${level}`,
      getAttrs: (dom: HTMLElement | string) => ({ ...parseBlockAttrs(dom as HTMLElement), level }),
    })),
    toDOM: (node): DOMOutputSpec => [`h${node.attrs.level}`, blockDomAttrs(node), 0],
  },

  blockquote: {
    content: "block+",
    group: "block",
    defining: true,
    attrs: { id: { default: null }, style: { default: null as string | null } },
    parseDOM: [{ tag: "blockquote", getAttrs: (dom) => ({ style: storedStyleFromDom(dom as HTMLElement) }) }],
    toDOM: (node): DOMOutputSpec => ["blockquote", { ...(node.attrs.id ? { "data-id": node.attrs.id } : {}), "data-style": nodeStyleId(node) }, 0],
  },

  code_block: {
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    /** Space above and below in points, when not the usual (a displayed equation placed as in an imported PDF). fontSize and lineHeight stay null unless a fit writes them, so the Code style and the document font are unchanged. */
    attrs: {
      id: { default: null },
      language: { default: "" },
      spaceBefore: { default: null as number | null },
      spaceAfter: { default: null as number | null },
      fontSize: { default: null as number | null },
      lineHeight: { default: null as string | null },
      style: { default: null as string | null },
    },
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          const fontSize = Number(el.getAttribute("data-font-size"));
          const lineHeight = el.style?.lineHeight;
          return {
            language: el.getAttribute("data-language") || "",
            style: storedStyleFromDom(el),
            fontSize: fontSize > 0 && fontSize <= 400 ? fontSize : null,
            lineHeight: lineHeight && /^[\d.]+$/.test(lineHeight) ? lineHeight : null,
            spaceBefore: parseSpace(el.style?.marginTop),
            spaceAfter: parseSpace(el.style?.marginBottom),
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      const style = codeBlockStyle(node);
      return [
        "pre",
        {
          ...(node.attrs.id ? { "data-id": node.attrs.id } : {}),
          "data-language": node.attrs.language || "",
          "data-style": nodeStyleId(node),
          ...(node.attrs.fontSize ? { "data-font-size": String(node.attrs.fontSize) } : {}),
          ...(style ? { style } : {}),
        },
        ["code", 0],
      ];
    },
  },

  horizontal_rule: {
    group: "block",
    attrs: { id: { default: null } },
    parseDOM: [{ tag: "hr" }],
    toDOM: (node): DOMOutputSpec => ["hr", node.attrs.id ? { "data-id": node.attrs.id } : {}],
  },

  page_break: {
    group: "block",
    atom: true,
    selectable: true,
    attrs: { id: { default: null } },
    parseDOM: [{ tag: "div.page-break", priority: 60 }, { tag: "div[data-page-break]" }],
    toDOM: (node): DOMOutputSpec => [
      "div",
      { class: "page-break", "data-page-break": "true", ...(node.attrs.id ? { "data-id": node.attrs.id } : {}) },
    ],
  },

  /**
   * A table of contents. One field: its entries are generated from the
   * headings (lib/doc/toc.ts) and are not edited by hand. The heading is
   * ordinary text, so it can be renamed. Page numbers are painted from the
   * page layout, not stored. No gap cursor: a click or an arrow stays a text caret.
   */
  toc: {
    content: "toc_title toc_entry*",
    group: "block",
    defining: true,
    isolating: true,
    selectable: true,
    allowGapCursor: false,
    attrs: { id: { default: null as string | null }, depth: { default: 3 } },
    parseDOM: [
      {
        tag: "nav.doc-toc",
        priority: 60,
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          const depth = Number(el.getAttribute("data-depth"));
          return { id: el.getAttribute("data-id"), depth: Number.isInteger(depth) && depth >= 1 && depth <= 6 ? depth : 3 };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      "nav",
      {
        class: "doc-toc",
        "data-toc": "true",
        "data-depth": String(node.attrs.depth ?? 3),
        ...(node.attrs.id ? { "data-id": node.attrs.id } : {}),
      },
      0,
    ],
  },

  /**
   * The contents heading. `text` is only the old stored heading, from when
   * this node was an atom; new headings are the node's content.
   */
  toc_title: {
    content: "inline*",
    defining: true,
    attrs: { text: { default: null as string | null } },
    parseDOM: [{ tag: "p.doc-toc-title", priority: 60 }],
    toDOM: (): DOMOutputSpec => ["p", { class: "doc-toc-title" }, 0],
  },

  toc_entry: {
    atom: true,
    selectable: false,
    attrs: {
      level: { default: 1 },
      text: { default: "" },
      href: { default: null as string | null },
      placeholder: { default: false },
    },
    parseDOM: [
      {
        tag: "a.doc-toc-entry, p.doc-toc-entry",
        priority: 60,
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          const level = Number(el.getAttribute("data-level"));
          return {
            level: Number.isInteger(level) && level >= 1 && level <= 6 ? level : 1,
            text: el.querySelector(".doc-toc-label")?.textContent || "",
            href: el.getAttribute("href"),
            placeholder: el.hasAttribute("data-placeholder") || el.classList.contains("is-placeholder"),
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      const placeholder = Boolean(node.attrs.placeholder);
      const href = node.attrs.href as string | null;
      const attrs: Record<string, string> = {
        class: `doc-toc-entry${placeholder ? " is-placeholder" : ""}`,
        "data-level": String(node.attrs.level ?? 1),
      };
      if (placeholder) attrs["data-placeholder"] = "true";
      if (href) attrs.href = href;
      const label: DOMOutputSpec = ["span", { class: "doc-toc-label" }, String(node.attrs.text ?? "")];
      if (placeholder) return ["p", attrs, label];
      return ["a", attrs, label, ["span", { class: "doc-toc-leader", "aria-hidden": "true" }], ["span", { class: "doc-toc-page" }]];
    },
  },

  image: {
    group: "block",
    atom: true,
    draggable: true,
    attrs: {
      id: { default: null },
      src: { default: "" },
      alt: { default: "" },
      title: { default: "" },
      width: { default: null as string | null },
      /** Set when a side handle squishes the picture. Null keeps the aspect ratio. */
      height: { default: null as string | null },
      align: { default: "center" as Align },
      /** null keeps today's block picture: text above and below it. */
      wrap: { default: null as PictureWrap | null },
      crop: { default: null as PictureCrop | null },
      /** Degrees clockwise. */
      rotate: { default: null as number | null },
    },
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (dom) => {
          const el = dom as HTMLImageElement;
          const width = el.style.width || el.getAttribute("width") || null;
          const height = el.style.height || el.getAttribute("height") || null;
          const picture = readPictureDom(el);
          const length = (value: string | null) => (value ? (/^\d+$/.test(value) ? `${value}px` : value) : null);
          return {
            src: el.getAttribute("src") || "",
            alt: el.getAttribute("alt") || "",
            title: el.getAttribute("title") || "",
            width: length(width),
            height: length(height),
            ...picture,
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      const wrap = pictureWrap(node.attrs.wrap);
      const picture = pictureDom(node.attrs.crop, node.attrs.rotate);
      const style = [node.attrs.width ? `width: ${node.attrs.width}` : "", node.attrs.height ? `height: ${node.attrs.height}` : "", picture.style].filter(Boolean).join("; ");
      return [
        "figure",
        {
          class: `doc-image align-${node.attrs.align}${wrap ? ` wrap-${wrap}` : ""}`,
          ...(node.attrs.id ? { "data-id": node.attrs.id } : {}),
          ...(wrap ? { "data-wrap": wrap } : {}),
          ...picture.data,
        },
        [
          "img",
          {
            src: node.attrs.src,
            alt: node.attrs.alt,
            ...(node.attrs.title ? { title: node.attrs.title } : {}),
            ...(style ? { style } : {}),
            ...(wrap ? { "data-wrap": wrap } : {}),
            ...picture.data,
            draggable: "false",
          },
        ],
      ];
    },
  },

  bullet_list: {
    content: "list_item+",
    group: "block",
    attrs: listAttrs,
    parseDOM: [{ tag: "ul", getAttrs: (dom) => parseListAttrs(dom as HTMLElement) }],
    toDOM: (node): DOMOutputSpec => ["ul", listDomAttrs(node), 0],
  },

  ordered_list: {
    content: "list_item+",
    group: "block",
    /** `numbering` is the marker style when it isn't the usual one for the list's depth (1., a., i.). */
    attrs: { ...listAttrs, order: { default: 1 }, numbering: { default: null as ListNumbering | null } },
    parseDOM: [
      {
        tag: "ol",
        getAttrs: (dom) => {
          const el = dom as HTMLElement;
          const type = el.style.listStyleType || ({ "1": "decimal", a: "lower-alpha", A: "upper-alpha", i: "lower-roman", I: "upper-roman" } as Record<string, string>)[el.getAttribute("type") ?? ""] || "";
          return { ...parseListAttrs(el), order: Number(el.getAttribute("start") || 1) || 1, numbering: (LIST_NUMBERINGS as readonly string[]).includes(type) ? type : null };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      "ol",
      listDomAttrs(node, node.attrs.order !== 1 ? { start: String(node.attrs.order) } : {}, node.attrs.numbering ? [`list-style-type: ${node.attrs.numbering}`] : []),
      0,
    ],
  },

  list_item: {
    content: "paragraph block*",
    defining: true,
    attrs: { checked: { default: null as boolean | null } },
    parseDOM: [
      {
        tag: "li",
        getAttrs: (dom) => {
          const value = (dom as HTMLElement).getAttribute("data-checked");
          return { checked: value === "true" ? true : value === "false" ? false : null };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec =>
      node.attrs.checked == null
        ? ["li", 0]
        : ["li", { class: "task-item", "data-checked": String(node.attrs.checked) }, 0],
  },

  ...tableNodes({
    tableGroup: "block",
    cellContent: "block+",
    cellAttributes: {
      background: {
        default: null,
        getFromDOM: (dom) => (dom as HTMLElement).style.backgroundColor || null,
        setDOMAttr: (value, attrs) => {
          if (value) attrs.style = `${attrs.style || ""}background-color: ${value};`;
        },
      },
      /** Edges of this cell, when they aren't the table's. */
      borders: {
        default: null as CellBorders | null,
        getFromDOM: (dom) => {
          const raw = (dom as HTMLElement).getAttribute("data-cell-borders");
          if (!raw) return null;
          try {
            return cellBordersFrom(JSON.parse(raw));
          } catch {
            return null;
          }
        },
        setDOMAttr: (value, attrs) => {
          const borders = cellBordersFrom(value);
          if (!borders) return;
          attrs["data-cell-borders"] = JSON.stringify(borders);
          const css = cellBorderCss(borders);
          if (css) attrs.style = attrs.style ? `${attrs.style}; ${css}` : css;
        },
      },
      /** `SUM(A1:B2)` or `SUM(ABOVE)`. The cell's text is the result. */
      formula: {
        default: null as string | null,
        getFromDOM: (dom) => normalizeFormula((dom as HTMLElement).getAttribute("data-formula") ?? "") ?? null,
        setDOMAttr: (value, attrs) => {
          const formula = typeof value === "string" ? normalizeFormula(value) : null;
          if (formula) attrs["data-formula"] = formula;
        },
      },
    },
  }),

  text: { group: "inline" },

  hard_break: {
    inline: true,
    group: "inline",
    selectable: false,
    parseDOM: [{ tag: "br" }],
    toDOM: (): DOMOutputSpec => ["br"],
  },

  /**
   * A footnote marker. The note's words live in the paragraph whose `footnote`
   * attribute is this label, written in Markdown as `[^label]` and `[^label]: text`.
   */
  footnote_ref: {
    inline: true,
    group: "inline",
    atom: true,
    selectable: true,
    attrs: { label: { default: "1" } },
    leafText: () => "",
    parseDOM: [
      {
        tag: "sup.footnote-ref",
        priority: 60,
        getAttrs: (dom) => {
          const label = footnoteLabel((dom as HTMLElement).getAttribute("data-footnote") || (dom as HTMLElement).textContent);
          return label ? { label } : false;
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => ["sup", { class: "footnote-ref", "data-footnote": node.attrs.label }, String(node.attrs.label || "1")],
  },

  /**
   * A picture set in a line of text, like a character (an icon beside a
   * phone number). Its size is in CSS pixels; `opacity` fades it (Word's and
   * Google's picture transparency).
   */
  inline_image: {
    inline: true,
    group: "inline",
    atom: true,
    draggable: true,
    attrs: {
      src: { default: "" },
      alt: { default: "" },
      width: { default: null as number | null },
      height: { default: null as number | null },
      opacity: { default: null as number | null },
      /** Space kept clear around it, in CSS pixels: top, right, bottom, left (only the sides move text). */
      dist: { default: null as [number, number, number, number] | null },
      crop: { default: null as PictureCrop | null },
      /** Degrees clockwise. The picture stays in the line. */
      rotate: { default: null as number | null },
    },
    leafText: () => "",
    parseDOM: [
      {
        tag: "img.doc-inline-image[src]",
        priority: 60,
        getAttrs: (dom) => inlineImageAttrs(dom as HTMLImageElement),
      },
      {
        tag: "span.doc-inline-image",
        priority: 60,
        getAttrs: (dom) => {
          const img = (dom as HTMLElement).querySelector("img");
          if (!img) return false;
          const frame = dom as HTMLElement;
          const px = (value: string) => (/^[\d.]+px$/.test(value) ? Number.parseFloat(value) : null);
          return { ...inlineImageAttrs(img), width: px(frame.style.width), height: px(frame.style.height), ...readPictureDom(frame) };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      const crop = pictureCrop(node.attrs.crop);
      const rotate = pictureRotate(node.attrs.rotate);
      const picture = pictureDom(node.attrs.crop, node.attrs.rotate);
      const dist = node.attrs.dist ? { "data-dist": (node.attrs.dist as number[]).join(",") } : {};
      // A crop with a known size is a window: the frame is the visible part and the image spills out of it.
      if (crop && node.attrs.width && node.attrs.height) {
        const visW = 1 - crop.l - crop.r;
        const visH = 1 - crop.t - crop.b;
        const frame = [
          `width: ${node.attrs.width}px`,
          `height: ${node.attrs.height}px`,
          "display: inline-block",
          "overflow: hidden",
          "vertical-align: baseline",
          "line-height: 0",
          node.attrs.opacity != null ? `opacity: ${node.attrs.opacity}` : "",
          rotate != null ? `transform: rotate(${rotate}deg)` : "",
        ].filter(Boolean);
        const imgStyle = [
          `width: ${(100 / visW).toFixed(4)}%`,
          `height: ${(100 / visH).toFixed(4)}%`,
          `margin-left: ${((-100 * crop.l) / visW).toFixed(4)}%`,
          `margin-top: ${((-100 * crop.t) / visH).toFixed(4)}%`,
          "max-width: none",
          "display: block",
        ];
        return [
          "span",
          { class: "doc-inline-image", ...dist, ...picture.data, style: frame.join("; ") },
          ["img", { src: node.attrs.src, alt: node.attrs.alt, draggable: "false", style: imgStyle.join("; ") }],
        ];
      }
      const style = [
        node.attrs.width ? `width: ${node.attrs.width}px` : "",
        node.attrs.height ? `height: ${node.attrs.height}px` : "",
        node.attrs.opacity != null ? `opacity: ${node.attrs.opacity}` : "",
        node.attrs.dist ? `margin: 0 ${node.attrs.dist[1]}px 0 ${node.attrs.dist[3]}px` : "",
        picture.style,
      ].filter(Boolean);
      return ["img", { class: "doc-inline-image", src: node.attrs.src, alt: node.attrs.alt, draggable: "false", ...dist, ...picture.data, ...(style.length ? { style: style.join("; ") } : {}) }];
    },
  },
};

// prosemirror-tables' table has no id, and its rows have no height. Both are addressable here:
// borders live on the table (Word's tblBorders), a row's height in points, an id so the table is a block.
nodes.table = {
  ...nodes.table,
  attrs: { ...(nodes.table.attrs ?? {}), id: { default: null }, borders: { default: null as TableBorders | null } },
  parseDOM: [
    {
      tag: "table",
      getAttrs: (dom) => {
        const el = dom as HTMLElement;
        const raw = el.getAttribute("data-borders");
        let borders: TableBorders | null = null;
        if (raw) {
          try {
            borders = tableBordersFrom(JSON.parse(raw));
          } catch {
            borders = null;
          }
        }
        return { id: el.getAttribute("data-id"), borders };
      },
    },
  ],
  toDOM: (node): DOMOutputSpec => {
    const attrs: Record<string, string> = {};
    if (node.attrs.id) attrs["data-id"] = node.attrs.id;
    if (node.attrs.borders) attrs["data-borders"] = JSON.stringify(node.attrs.borders);
    return ["table", attrs, ["tbody", 0]];
  },
};

nodes.table_row = {
  ...nodes.table_row,
  attrs: { height: { default: null as number | null }, heightRule: { default: null as RowHeightRule | null } },
  parseDOM: [
    {
      tag: "tr",
      getAttrs: (dom) => {
        const el = dom as HTMLElement;
        const raw = el.style.height;
        const px = raw.endsWith("px") ? Number.parseFloat(raw) : raw.endsWith("pt") ? (Number.parseFloat(raw) * 96) / 72 : Number.NaN;
        const points = Number.isFinite(px) && px > 0 ? Math.round(((px * 72) / 96) * 100) / 100 : null;
        const rule = el.getAttribute("data-height-rule");
        return { height: points, heightRule: rule === "exact" || rule === "atLeast" ? rule : points ? "atLeast" : null };
      },
    },
  ],
  toDOM: (node): DOMOutputSpec => {
    const height = Number(node.attrs.height);
    const rule = node.attrs.heightRule === "exact" ? "exact" : node.attrs.heightRule === "atLeast" ? "atLeast" : null;
    if (!height || height <= 0) return ["tr", 0];
    return ["tr", { style: `height: ${height}pt`, "data-height-rule": rule ?? "atLeast" }, 0];
  },
};

const marks: Record<string, MarkSpec> = {
  link: {
    attrs: { href: {}, title: { default: null } },
    inclusive: false,
    parseDOM: [
      {
        tag: "a[href]",
        getAttrs: (dom) => {
          const href = safeHref((dom as HTMLElement).getAttribute("href"));
          return href ? { href, title: (dom as HTMLElement).getAttribute("title") } : false;
        },
      },
    ],
    toDOM: (mark): DOMOutputSpec => [
      "a",
      { href: safeHref(mark.attrs.href) ?? "#", ...(mark.attrs.title ? { title: mark.attrs.title } : {}), rel: "noopener noreferrer" },
      0,
    ],
  },

  bold: {
    parseDOM: [
      { tag: "strong" },
      { tag: "b", getAttrs: (node) => (node as HTMLElement).style.fontWeight !== "normal" && null },
      {
        style: "font-weight",
        getAttrs: (value) => /^(bold(er)?|[6-9]\d{2,})$/.test(value as string) && null,
      },
    ],
    toDOM: (): DOMOutputSpec => ["strong", 0],
  },

  italic: {
    parseDOM: [{ tag: "i" }, { tag: "em" }, { style: "font-style=italic" }],
    toDOM: (): DOMOutputSpec => ["em", 0],
  },

  underline: {
    parseDOM: [{ tag: "u" }, { style: "text-decoration=underline" }, { style: "text-decoration-line=underline" }],
    toDOM: (): DOMOutputSpec => ["u", 0],
  },

  strike: {
    parseDOM: [{ tag: "s" }, { tag: "del" }, { tag: "strike" }, { style: "text-decoration=line-through" }],
    toDOM: (): DOMOutputSpec => ["s", 0],
  },

  code: {
    excludes: "_",
    parseDOM: [{ tag: "code" }],
    toDOM: (): DOMOutputSpec => ["code", 0],
  },

  /**
   * An inline equation: the text is its LaTeX source, which the editor shows
   * typeset (lib/editor/math.ts) until the cursor goes into it. Displayed
   * equations are code blocks with the language "math".
   */
  math: {
    inclusive: false,
    code: true,
    excludes: "bold italic underline strike code link superscript subscript highlight text_color font_family font_size",
    parseDOM: [{ tag: "span[data-math]", priority: 60 }],
    toDOM: (): DOMOutputSpec => ["span", { class: "math-src", "data-math": "inline" }, 0],
  },

  superscript: {
    excludes: "subscript",
    parseDOM: [{ tag: "sup" }, { style: "vertical-align=super" }],
    toDOM: (): DOMOutputSpec => ["sup", 0],
  },

  /** A formatted inline citation, such as (Smith, 2020). The text is the citation; there is no source record behind it. */
  citation: {
    inclusive: false,
    parseDOM: [{ tag: "cite" }],
    toDOM: (): DOMOutputSpec => ["cite", 0],
  },

  subscript: {
    excludes: "superscript",
    parseDOM: [{ tag: "sub" }, { style: "vertical-align=sub" }],
    toDOM: (): DOMOutputSpec => ["sub", 0],
  },

  highlight: {
    attrs: { color: { default: "#fff2a8" } },
    parseDOM: [
      { tag: "mark", getAttrs: (dom) => ({ color: (dom as HTMLElement).style.backgroundColor || "#fff2a8" }) },
      {
        style: "background-color",
        getAttrs: (value) => (value && value !== "transparent" && value !== "inherit" ? { color: value } : false),
      },
    ],
    toDOM: (mark): DOMOutputSpec => ["mark", { style: `background-color: ${mark.attrs.color}` }, 0],
  },

  text_color: {
    attrs: { color: {} },
    parseDOM: [{ style: "color", getAttrs: (value) => (value && value !== "inherit" ? { color: value } : false) }],
    // Black is the page's own text color, so it turns light with the page in dark mode (document.css).
    toDOM: (mark): DOMOutputSpec => ["span", { style: `color: ${mark.attrs.color}`, ...(isBlack(mark.attrs.color) ? { class: "text-black" } : {}) }, 0],
  },

  font_family: {
    attrs: { family: {} },
    parseDOM: [{ style: "font-family", getAttrs: (value) => (value ? { family: value } : false) }],
    // Lines of the font are as tall as the font makes them (lib/doc/fontMetrics.ts), in documents laid out that way.
    toDOM: (mark): DOMOutputSpec => ["span", { style: `font-family: ${mark.attrs.family}; ${lineVars(String(mark.attrs.family))}` }, 0],
  },

  font_size: {
    attrs: { size: {} },
    parseDOM: [
      {
        tag: "span[data-font-size]",
        getAttrs: (dom) => {
          const pt = cssSizeToPt((dom as HTMLElement).getAttribute("data-font-size"));
          return pt ? { size: `${pt}pt` } : false;
        },
      },
      {
        style: "font-size",
        getAttrs: (value) => {
          const pt = cssSizeToPt(value as string);
          return pt ? { size: `${pt}pt` } : false;
        },
      },
    ],
    toDOM: (mark): DOMOutputSpec => {
      const pt = cssSizeToPt(String(mark.attrs.size));
      // Text smaller than Google Docs draws any is drawn at that size; the size it was set to stays.
      if (pt && pt < MIN_FONT_PT) return ["span", { style: `font-size: ${fontSizeCss(pt)}`, "data-font-size": `${pt}pt` }, 0];
      return ["span", { style: `font-size: ${mark.attrs.size}` }, 0];
    },
  },

  comment: {
    attrs: { id: {} },
    inclusive: false,
    excludes: "",
    parseDOM: [{ tag: "span[data-comment-id]", getAttrs: (dom) => ({ id: (dom as HTMLElement).getAttribute("data-comment-id") }) }],
    toDOM: (mark): DOMOutputSpec => ["span", { class: "comment-anchor", "data-comment-id": mark.attrs.id }, 0],
  },

  locked: {
    attrs: { id: {} },
    inclusive: false,
    parseDOM: [{ tag: "span[data-lock-id]", getAttrs: (dom) => ({ id: (dom as HTMLElement).getAttribute("data-lock-id") }) }],
    toDOM: (mark): DOMOutputSpec => ["span", { class: "locked-text", "data-lock-id": mark.attrs.id, title: "Locked from AI edits" }, 0],
  },

  /**
   * Text an agent inserted. The editor does not spellcheck it (Claude rarely
   * misspells, and the user should not have to dismiss those underlines).
   * Typing does not extend it (`inclusive: false`); characters the user then
   * inserts are unmarked and checked. Not parsed from HTML, so a paste is the
   * user's text.
   */
  agent: {
    inclusive: false,
    spanning: false,
    toDOM: (): DOMOutputSpec => ["span", { "data-agent": "", spellcheck: "false" }, 0],
  },
};

// Canvas containers keep the same editable descendants as ordinary documents.
for (const [kind, content] of Object.entries({ section: "block+", stack: "block+", richtext: "block+", columns: "canvas_column{2,3}", column: "block+", figure: "image paragraph?" })) {
  nodes[`canvas_${kind}`] = {
    content,
    ...(kind === "column" ? {} : { group: "block" }),
    defining: true,
    isolating: kind === "column",
    attrs: { id: { default: null }, canvasClass: { default: null }, pagination: { default: kind === "columns" || kind === "figure" ? "keep-together" : "flow" }, ratio: { default: null } },
    parseDOM: [{ tag: `[data-canvas="${kind}"]`, getAttrs: (dom) => { const el = dom as HTMLElement; return { id: el.dataset.id || null, canvasClass: el.dataset.canvasClass || null, pagination: el.dataset.pagination || "flow", ratio: el.dataset.ratio || null }; } }],
    toDOM: (node): DOMOutputSpec => ["div", {
      "data-canvas": kind,
      "data-pagination": node.attrs.pagination,
      ...(node.attrs.id ? { "data-id": node.attrs.id } : {}),
      ...(kind === "columns" ? { style: `--canvas-columns:${(node.attrs.ratio || "1:1").split(":").map((n: string) => `${Number(n) || 1}fr`).join(" ")}` } : {}),
    }, 0],
  };
}
// Preserve authored classes through editing and clipboard operations. These are
// inert without a validated, scoped Canvas stylesheet.
for (const [name, spec] of Object.entries(nodes)) {
  if (name === "doc" || name === "text" || name === "hard_break") continue;
  spec.attrs = { ...spec.attrs, canvasClass: { default: null } };
  const toDOM = spec.toDOM;
  if (toDOM) spec.toDOM = (node) => {
    const output = toDOM(node);
    if (!Array.isArray(output)) return output;
    const [tag, ...rest] = output;
    const hasAttrs = rest[0] && typeof rest[0] === "object" && !Array.isArray(rest[0]);
    const attrs = hasAttrs ? rest[0] as Record<string, unknown> : {};
    return [tag, { ...attrs, ...(node.attrs.canvasClass ? { class: [attrs.class, node.attrs.canvasClass].filter(Boolean).join(" "), "data-canvas-class": node.attrs.canvasClass } : {}) }, ...(hasAttrs ? rest.slice(1) : rest)] as DOMOutputSpec;
  };
  spec.parseDOM = spec.parseDOM?.map((rule) => {
    if (!("tag" in rule)) return rule;
    const getAttrs = rule.getAttrs;
    return { ...rule, getAttrs: (dom: HTMLElement) => {
      const base = getAttrs ? getAttrs(dom) : rule.attrs || {};
      return base === false ? false : { ...base, canvasClass: dom.getAttribute("data-canvas-class") || null };
    } };
  });
}
marks.canvas_span = {
  attrs: { class: { default: "" } },
  parseDOM: [{ tag: "span[data-canvas-class]", getAttrs: (dom) => ({ class: (dom as HTMLElement).dataset.canvasClass || "" }) }],
  toDOM: (mark): DOMOutputSpec => ["span", { class: mark.attrs.class, "data-canvas-class": mark.attrs.class }, 0],
};

export const schema = new Schema({ nodes, marks });

export type NodeName = keyof typeof nodes;

/** Marks that the Markdown view can express. Everything else is preserved invisibly. */
export const MARKDOWN_MARKS = new Set(["bold", "italic", "underline", "strike", "code", "math", "link", "superscript", "subscript", "highlight", "citation"]);

/** The code block language that makes it a displayed equation. */
export const MATH_LANGUAGE = "math";

/** Marks that describe ranges (comments, locks, text an agent inserted) rather than styling. */
export const RANGE_MARKS = new Set(["comment", "locked", "agent"]);

export const TEXTBLOCK_TYPES = new Set(["paragraph", "heading", "title", "subtitle"]);

export function isTextblockType(name: string) {
  return TEXTBLOCK_TYPES.has(name);
}

/** Whether a CSS color is plain black (#000, #000000, rgb(0, 0, 0), black), as Google Docs and Word color default text. */
export function isBlack(color: unknown) {
  if (typeof color !== "string") return false;
  return /^(#(000f?|000000(ff)?)|black|windowtext|rgba?\(0,0,0(,(1|1\.0*|100%))?\))$/.test(color.toLowerCase().replace(/\s+/g, ""));
}

export function cssSizeToPt(value: string | null | undefined): number | null {
  if (!value) return null;
  const match = value.trim().match(/^([\d.]+)(pt|px|em|rem)?$/);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = match[2] || "px";
  const pt = unit === "pt" ? n : unit === "px" ? (n * 72) / 96 : n * 11;
  return Math.round(pt * 2) / 2;
}

export function marksEqual(a: readonly Mark[], b: readonly Mark[]) {
  if (a.length !== b.length) return false;
  return a.every((mark, index) => mark.eq(b[index]!));
}

export function emptyDoc(): PMNode {
  return schema.node("doc", null, [schema.node("paragraph")]);
}
