import { Schema, type DOMOutputSpec, type Mark, type Node as PMNode, type NodeSpec, type MarkSpec } from "prosemirror-model";
import { tableNodes } from "prosemirror-tables";

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
export const MAX_INDENT = 8;

const blockAttrs = {
  id: { default: null as string | null },
  align: { default: "left" as Align },
  indent: { default: 0 },
  lineHeight: { default: null as string | null },
  spaceBefore: { default: null as number | null },
  spaceAfter: { default: null as number | null },
  /** First-line indent in inches; negative is a hanging indent (works cited, bibliographies). */
  textIndent: { default: null as number | null },
};

function blockStyle(node: PMNode, extra = ""): string {
  const parts: string[] = [];
  const { align, indent, lineHeight, spaceBefore, spaceAfter, textIndent } = node.attrs;
  if (align && align !== "left") parts.push(`text-align: ${align}`);
  if (indent) parts.push(`margin-left: ${Number(indent) * 0.5}in`);
  if (textIndent) parts.push(`text-indent: ${textIndent}in`, ...(textIndent < 0 ? [`padding-left: ${-textIndent}in`] : []));
  if (lineHeight) parts.push(`line-height: ${lineHeight}`);
  if (spaceBefore != null) parts.push(`margin-top: ${spaceBefore}pt`);
  if (spaceAfter != null) parts.push(`margin-bottom: ${spaceAfter}pt`);
  if (extra) parts.push(extra);
  return parts.join("; ");
}

function blockDomAttrs(node: PMNode, extra: Record<string, string> = {}) {
  const attrs: Record<string, string> = { ...extra };
  if (node.attrs.id) attrs["data-id"] = node.attrs.id;
  const style = blockStyle(node);
  if (style) attrs.style = style;
  return attrs;
}

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
  const align = (style?.textAlign || dom.getAttribute("align") || "left") as Align;
  const marginLeft = style?.marginLeft || "";
  let indent = 0;
  const inches = marginLeft.match(/^([\d.]+)in$/);
  const px = marginLeft.match(/^([\d.]+)px$/);
  if (inches) indent = Math.round(Number(inches[1]) / 0.5);
  else if (px) indent = Math.round(Number(px[1]) / 48);
  return {
    id: dom.getAttribute("data-id") || null,
    align: ALIGNMENTS.includes(align) ? align : "left",
    indent: Math.max(0, Math.min(MAX_INDENT, indent)),
    lineHeight: style?.lineHeight && /^[\d.]+$/.test(style.lineHeight) ? style.lineHeight : null,
    spaceBefore: null,
    spaceAfter: null,
    textIndent: parseTextIndent(style?.textIndent || ""),
  };
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
    attrs: { id: { default: null } },
    parseDOM: [{ tag: "ul" }],
    toDOM: (node): DOMOutputSpec => ["ul", node.attrs.id ? { "data-id": node.attrs.id } : {}, 0],
  },

  ordered_list: {
    content: "list_item+",
    group: "block",
    attrs: { id: { default: null }, order: { default: 1 } },
    parseDOM: [
      {
        tag: "ol",
        getAttrs: (dom) => ({ order: Number((dom as HTMLElement).getAttribute("start") || 1) || 1 }),
      },
    ],
    toDOM: (node): DOMOutputSpec => [
      "ol",
      { ...(node.attrs.order !== 1 ? { start: String(node.attrs.order) } : {}), ...(node.attrs.id ? { "data-id": node.attrs.id } : {}) },
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
    toDOM: (mark): DOMOutputSpec => ["span", { style: `font-family: ${mark.attrs.family}` }, 0],
  },

  font_size: {
    attrs: { size: {} },
    parseDOM: [
      {
        style: "font-size",
        getAttrs: (value) => {
          const pt = cssSizeToPt(value as string);
          return pt ? { size: `${pt}pt` } : false;
        },
      },
    ],
    toDOM: (mark): DOMOutputSpec => ["span", { style: `font-size: ${mark.attrs.size}` }, 0],
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
export const MARKDOWN_MARKS = new Set(["bold", "italic", "underline", "strike", "code", "link", "superscript", "subscript", "highlight"]);

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
