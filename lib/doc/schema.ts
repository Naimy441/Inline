import { Schema, type DOMOutputSpec, type Mark, type Node as PMNode, type NodeSpec, type MarkSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";
import { lineVars } from "@/lib/doc/fontMetrics";

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
 * Link targets Inline allows: web, mail and phone links, in-document anchors
 * and relative paths. Script and data URLs are refused wherever a link enters
 * a document (paste, import, Markdown, Claude's tools) and never rendered.
 */
export function safeHref(href: unknown): string | null {
  if (typeof href !== "string") return null;
  const trimmed = href.trim();
  if (!trimmed) return null;
  // Browsers ignore control characters and whitespace inside a scheme ("java\tscript:").
  const scheme = /^([^:/?#]+):/.exec(trimmed.replace(/[\u0000-\u0020\u007f]+/g, ""))?.[1]?.toLowerCase();
  if (scheme && !["http", "https", "mailto", "tel"].includes(scheme)) return null;
  return trimmed;
}

export const ALIGNMENTS: Align[] = ["left", "center", "right", "justify"];

/** Numbered-list marker styles, as CSS names them. */
export const LIST_NUMBERINGS = ["decimal", "lower-alpha", "upper-alpha", "lower-roman", "upper-roman"] as const;
export type ListNumbering = (typeof LIST_NUMBERINGS)[number];

/** The marker style a numbered list gets by default at a depth (0 for the top), as app/styles/document.css numbers them. */
export function defaultListNumbering(depth: number): ListNumbering {
  return depth === 0 ? "decimal" : depth === 1 ? "lower-alpha" : "lower-roman";
}
export const MAX_INDENT = 8;

/** A tab stop: `pos` in points from the left margin. */
export type TabStop = { pos: number; align: "left" | "center" | "right" | "decimal"; leader?: "dot" | "hyphen" | "underscore" | "middleDot" | null };

/** A line drawn along one side of a paragraph: its width and its distance from the text in points, and its color (#rrggbb, null for the text's). */
export type BorderLine = { style: "solid" | "double" | "dotted" | "dashed"; width: number; space: number; color: string | null };
/** `between` is drawn between neighbouring paragraphs with the same borders, which otherwise share one box. */
export type Borders = Partial<Record<"top" | "bottom" | "left" | "right" | "between", BorderLine>>;

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
  /** First-line indent in inches; negative is a hanging indent (works cited, bibliographies). */
  textIndent: { default: null as number | null },
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
};

const BORDER_SIDES = ["top", "bottom", "left", "right"] as const;

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
  const { align, indent, lineHeight, spaceBefore, spaceAfter, textIndent, dir, fontSize } = node.attrs;
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
  if (finish) parts.push(`margin-${end}: -${finish.width + finish.space}px`);
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
  if (node.attrs.id) attrs["data-id"] = node.attrs.id;
  if (node.attrs.dir === "rtl") attrs.dir = "rtl";
  // What a style can't say exactly travels with the paragraph when it is copied and pasted.
  if (node.attrs.fontSize) attrs["data-font-size"] = String(node.attrs.fontSize);
  if (node.attrs.tabs) attrs["data-tabs"] = JSON.stringify(node.attrs.tabs);
  if (node.attrs.borders) attrs["data-borders"] = JSON.stringify(node.attrs.borders);
  if (node.attrs.indent && !Number.isInteger(Number(node.attrs.indent))) attrs["data-indent"] = String(node.attrs.indent);
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

/** "0.5in", "36pt" or "48px" in inches, rounded to a hundredth; null for none. */
export function parseTextIndent(value: string): number | null {
  const match = value.trim().match(/^(-?[\d.]+)(in|pt|px)$/);
  if (!match) return null;
  const amount = Number(match[1]) / (match[2] === "in" ? 1 : match[2] === "pt" ? 72 : 96);
  const rounded = Math.round(Math.max(-3, Math.min(3, amount)) * 100) / 100;
  return Number.isFinite(rounded) && rounded !== 0 ? rounded : null;
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
  return {
    id: dom.getAttribute("data-id") || null,
    align: ALIGNMENTS.includes(align) ? align : "left",
    indent: Math.max(0, Math.min(MAX_INDENT, indent)),
    lineHeight: style?.lineHeight && /^[\d.]+$/.test(style.lineHeight) ? style.lineHeight : null,
    spaceBefore: null,
    spaceAfter: null,
    textIndent: parseTextIndent(style?.textIndent || ""),
    dir: rtl ? ("rtl" as const) : null,
    fontSize: fontSize > 0 && fontSize <= 400 ? fontSize : null,
    tabs: jsonAttr<TabStop[]>(dom, "data-tabs", isTabs),
    borders: jsonAttr<Borders>(dom, "data-borders", isBorders),
  };
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

const nodes: Record<string, NodeSpec> = {
  doc: { content: "block+" },

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
    attrs: { id: { default: null } },
    parseDOM: [{ tag: "blockquote" }],
    toDOM: (node): DOMOutputSpec => ["blockquote", node.attrs.id ? { "data-id": node.attrs.id } : {}, 0],
  },

  code_block: {
    content: "text*",
    marks: "",
    group: "block",
    code: true,
    defining: true,
    attrs: { id: { default: null }, language: { default: "" } },
    parseDOM: [
      {
        tag: "pre",
        preserveWhitespace: "full",
        getAttrs: (dom) => ({ language: (dom as HTMLElement).getAttribute("data-language") || "" }),
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      "pre",
      { ...(node.attrs.id ? { "data-id": node.attrs.id } : {}), "data-language": node.attrs.language || "" },
      ["code", 0],
    ],
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
      align: { default: "center" as Align },
    },
    parseDOM: [
      {
        tag: "img[src]",
        getAttrs: (dom) => {
          const el = dom as HTMLImageElement;
          const width = el.style.width || el.getAttribute("width") || null;
          return {
            src: el.getAttribute("src") || "",
            alt: el.getAttribute("alt") || "",
            title: el.getAttribute("title") || "",
            width: width ? (/^\d+$/.test(width) ? `${width}px` : width) : null,
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      "figure",
      {
        class: `doc-image align-${node.attrs.align}`,
        ...(node.attrs.id ? { "data-id": node.attrs.id } : {}),
      },
      [
        "img",
        {
          src: node.attrs.src,
          alt: node.attrs.alt,
          ...(node.attrs.title ? { title: node.attrs.title } : {}),
          ...(node.attrs.width ? { style: `width: ${node.attrs.width}` } : {}),
          draggable: "false",
        },
      ],
    ],
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
    },
    leafText: () => "",
    parseDOM: [
      {
        tag: "img.doc-inline-image[src]",
        priority: 60,
        getAttrs: (dom) => {
          const el = dom as HTMLImageElement;
          const px = (value: string) => (/^[\d.]+px$/.test(value) ? Number.parseFloat(value) : null);
          const opacity = Number.parseFloat(el.style.opacity);
          return {
            src: el.getAttribute("src") || "",
            alt: el.getAttribute("alt") || "",
            width: px(el.style.width),
            height: px(el.style.height),
            opacity: Number.isFinite(opacity) && opacity < 1 ? opacity : null,
            dist: (() => {
              const values = (el.getAttribute("data-dist") ?? "").split(",").map(Number);
              return values.length === 4 && values.every((value) => Number.isFinite(value) && value >= 0) ? values : null;
            })(),
          };
        },
      },
    ],
    toDOM: (node): DOMOutputSpec => {
      const style = [
        node.attrs.width ? `width: ${node.attrs.width}px` : "",
        node.attrs.height ? `height: ${node.attrs.height}px` : "",
        node.attrs.opacity != null ? `opacity: ${node.attrs.opacity}` : "",
        node.attrs.dist ? `margin: 0 ${node.attrs.dist[1]}px 0 ${node.attrs.dist[3]}px` : "",
      ].filter(Boolean);
      const dist = node.attrs.dist ? { "data-dist": (node.attrs.dist as number[]).join(",") } : {};
      return ["img", { class: "doc-inline-image", src: node.attrs.src, alt: node.attrs.alt, draggable: "false", ...dist, ...(style.length ? { style: style.join("; ") } : {}) }];
    },
  },
};

// prosemirror-tables' table node has no id attribute; add one so tables are addressable blocks.
nodes.table = {
  ...nodes.table,
  attrs: { ...(nodes.table.attrs ?? {}), id: { default: null } },
  toDOM: (node): DOMOutputSpec => ["table", node.attrs.id ? { "data-id": node.attrs.id } : {}, ["tbody", 0]],
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
    toDOM: (mark): DOMOutputSpec => ["span", { style: `color: ${mark.attrs.color}` }, 0],
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
};

export const schema = new Schema({ nodes, marks });

export type NodeName = keyof typeof nodes;

/** Marks that the Markdown view can express. Everything else is preserved invisibly. */
export const MARKDOWN_MARKS = new Set(["bold", "italic", "underline", "strike", "code", "math", "link", "superscript", "subscript", "highlight"]);

/** The code block language that makes it a displayed equation. */
export const MATH_LANGUAGE = "math";

/** Marks that describe ranges (comments, locks) rather than styling. */
export const RANGE_MARKS = new Set(["comment", "locked"]);

export const TEXTBLOCK_TYPES = new Set(["paragraph", "heading", "title", "subtitle"]);

export function isTextblockType(name: string) {
  return TEXTBLOCK_TYPES.has(name);
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
