import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import { type Node as PMNode, type Mark } from "prosemirror-model";
import { MATH_LANGUAGE, schema, safeHref } from "@/lib/doc/schema";
import { ensureBlockIds } from "@/lib/doc/ids";
import { escapeHtml } from "@/lib/doc/html";
import { pictureWidth, pictureWidthToken } from "@/lib/doc/picture";
import { validateCanvasCss, validateCanvasClass } from "./styles";
import { validateCanvasDocument } from "./model";

type Element = DefaultTreeAdapterMap["element"];
type Child = DefaultTreeAdapterMap["childNode"];
export type CanvasDesign = { format: 1; css: string };
export const isCanvas = (doc: PMNode) => doc.attrs.canvas?.format === 1;
const CONTAINERS: Record<string, string> = { section: "canvas_section", stack: "canvas_stack", columns: "canvas_columns", column: "canvas_column", richtext: "canvas_richtext", figure: "canvas_figure" };
const CLASSES = /^(?:[A-Za-z_][\w-]*)(?:\s+[A-Za-z_][\w-]*)*$/;
const IDS = /^[a-zA-Z0-9_-]{1,80}$/;
const ATTRS = new Set(["id", "class", "as", "pagination", "ratio", "href", "src", "alt", "colspan", "rowspan", "width"]);
const IMAGE_WIDTH = /^(?:\d+(?:\.\d+)?(?:px|%|in|cm|mm|pt|em|rem)?)$/i;

function imageWidth(value: string): string {
  const token = pictureWidthToken(value);
  const css = token ? pictureWidth(token) : null;
  if (!token || !css || !IMAGE_WIDTH.test(token)) throw new Error("Image width must be a length such as 330, 330px, 60%, or 4.5in.");
  return css;
}

export function compileCanvas(html: string, css = ""): PMNode {
  if (html.length > 500_000) throw new Error("Canvas markup exceeds 500,000 characters.");
  const parsed = parseFragment(html);
  const roots = parsed.childNodes.filter((n) => n.nodeName !== "#text" || ("value" in n && n.value.trim()));
  if (roots.length !== 1 || !("tagName" in roots[0]) || roots[0].tagName !== "canvas") throw new Error("Canvas markup must contain exactly one <Canvas> root.");
  const ids = new Set<string>();
  let count = 0;
  const attrs = (el: Element) => {
    const a = Object.fromEntries(el.attrs.map(({ name, value }) => [name, value]));
    for (const name of Object.keys(a)) if (!ATTRS.has(name) && !(name === "display" && el.tagName === "math")) throw new Error(`<${el.tagName}>: unsupported attribute ${name}.`);
    if (a.id && (!IDS.test(a.id) || ids.has(a.id))) throw new Error(`Invalid or duplicate component id ${a.id}.`);
    if (a.id) ids.add(a.id);
    if (a.width != null && el.tagName !== "img") throw new Error(`<${el.tagName}>: width is only supported on <img>.`);
    if (a.class && !CLASSES.test(a.class)) throw new Error(`Invalid class on ${a.id || el.tagName}.`);
    if (a.class) validateCanvasClass(a.class);
    return a;
  };
  const children = (el: Element, marks: readonly Mark[] = [], depth = 0): PMNode[] => el.childNodes.flatMap((n) => convert(n, marks, depth + 1));
  const convert = (node: Child, marks: readonly Mark[], depth: number): PMNode[] => {
    if (++count > 10_000 || depth > 30) throw new Error("Canvas exceeds the component count or nesting limit.");
    if (node.nodeName === "#comment") return [];
    if (node.nodeName === "#text" && "value" in node) return node.value ? [schema.text(node.value.replace(/\s+/g, " "), marks)] : [];
    if (!("tagName" in node)) throw new Error("Unsupported markup node.");
    const el = node as Element;
    const a = attrs(el);
    const tag = el.tagName;
    const common = { id: a.id || null, canvasClass: a.class || null };
    const make = (name: string, content: PMNode[], extra = {}) => {
      try { return [schema.nodes[name].createChecked({ ...common, ...extra }, content)]; }
      catch { throw new Error(`<${tag}> ${a.id || ""}: invalid children. Use Column inside Columns, paragraphs inside RichText, and inline content inside Text.`); }
    };
    const trim = (nodes: PMNode[]) => nodes.filter((n) => !n.isText || n.text?.trim());
    if (CONTAINERS[tag]) {
      const pagination = a.pagination || (tag === "columns" || tag === "figure" ? "keep-together" : "flow");
      if (!["flow", "keep-together"].includes(pagination) || ((tag === "columns" || tag === "figure") && pagination !== "keep-together")) throw new Error(`${tag}: use pagination="keep-together"; independent cross-page column flow is unsupported.`);
      if (a.ratio && (tag !== "columns" || !/^[1-4]:[1-4](?::[1-4])?$/.test(a.ratio))) throw new Error("Columns ratio must contain two or three values between 1 and 4, e.g. 2:1.");
      const content = trim(children(el, [], depth));
      if (tag === "columns" && (content.length < 2 || content.length > 3)) throw new Error("Columns needs two or three Column children.");
      if (tag === "columns" && a.ratio && a.ratio.split(":").length !== content.length) throw new Error("Columns ratio must match its number of children.");
      return make(CONTAINERS[tag], content, { pagination, ratio: a.ratio || null });
    }
    if (tag === "text" || /^(p|h[1-6]|figcaption)$/.test(tag)) {
      const as = tag === "text" ? a.as || "p" : tag;
      if (!/^(p|h[1-6]|figcaption)$/.test(as)) throw new Error("Text as must be p or h1–h6.");
      const content = children(el, marks, depth);
      if (content.some((node) => node.type.name === "code_block")) throw new Error("Display math is its own block. Put <Math display> beside Text, not inside it.");
      return make(as.startsWith("h") ? "heading" : "paragraph", content, as.startsWith("h") ? { level: Number(as[1]) } : {});
    }
    const markType = ({ strong: "bold", b: "bold", em: "italic", i: "italic", u: "underline", s: "strike", code: "code" } as Record<string, string>)[tag];
    if (markType) return children(el, [...marks, schema.mark(markType)], depth);
    if (tag === "span") return children(el, a.class ? [...marks, schema.mark("canvas_span", { class: a.class })] : marks, depth);
    if (tag === "a") {
      const href = safeHref(a.href);
      if (!href || !/^(https?:|mailto:|tel:|#)/.test(href)) throw new Error("Canvas links must be web, email, telephone, or anchor links.");
      return children(el, [...marks, schema.mark("link", { href })], depth);
    }
    if (tag === "br") return [schema.node("hard_break", null, undefined, marks)];
    if (tag === "hr") return make("horizontal_rule", []);
    if (tag === "pagebreak") return make("page_break", []);
    if (tag === "math") {
      let tex = "";
      for (const child of el.childNodes) {
        if (child.nodeName === "#text" && "value" in child) tex += child.value;
        else throw new Error("Math contains only LaTeX, not nested elements. Write < as &lt;.");
      }
      tex = tex.replace(/^\n/, "").replace(/\n$/, "").trim();
      if (!tex) throw new Error("Math needs LaTeX source.");
      const display = a.display != null && !/^(false|inline)$/i.test(a.display);
      if (display) return make("code_block", [schema.text(tex)], { language: MATH_LANGUAGE });
      return [schema.text(tex, [...marks, schema.mark("math")])];
    }
    if (tag === "img") {
      if (!a.src || !/^\/api\/(images\/|documents\/[a-zA-Z0-9_-]+\/files\/)/.test(a.src) || /[\\<>]/.test(a.src)) throw new Error("Images must use a file from this document's folder, such as /api/documents/<id>/files/graphs.png.");
      if (!a.alt) throw new Error("Images require descriptive alt text.");
      return make("image", [], { src: a.src, alt: a.alt, ...(a.width ? { width: imageWidth(a.width) } : {}) });
    }
    const block = ({ ul: "bullet_list", ol: "ordered_list", li: "list_item", blockquote: "blockquote", table: "table", tr: "table_row", td: "table_cell", th: "table_header" } as Record<string, string>)[tag];
    if (tag === "tbody" || tag === "thead" || tag === "tfoot") { attrs(el); return trim(children(el, [], depth)); }
    if (block) {
      let content = trim(children(el, [], depth));
      if (["td", "th", "li"].includes(tag) && content.every((n) => n.isInline)) content = [schema.node("paragraph", null, content)];
      const spans: Record<string, number> = {};
      for (const name of ["colspan", "rowspan"]) if (a[name]) {
        const value = Number(a[name]);
        if (!Number.isInteger(value) || value < 1 || value > 12) throw new Error(`${name} must be between 1 and 12.`);
        spans[name] = value;
      }
      return make(block, content, spans);
    }
    throw new Error(`Unsupported Canvas element <${tag}>. Use the Canvas SDK primitives; scripts, inline styles, arbitrary HTML, and executable components are unsupported.`);
  };
  attrs(roots[0] as Element);
  const content = children(roots[0] as Element).filter((n) => !n.isText || n.text?.trim());
  const doc = schema.nodes.doc.createChecked({ canvas: { format: 1, css: validateCanvasCss(css) } }, content.length ? content : [schema.node("paragraph")]);
  doc.check();
  const ready = ensureBlockIds(doc);
  validateCanvasDocument(ready);
  return ready;
}

/** Read from the live model, so manual edits always reach the next Claude turn. */
export function canvasMarkup(doc: PMNode): string {
  const render = (node: PMNode): string => {
    if (node.isText) {
      let text = escapeHtml(node.text || "");
      for (const mark of node.marks) {
        const tag = ({ bold: "strong", italic: "em", underline: "u", strike: "s", code: "code" } as Record<string, string>)[mark.type.name];
        if (tag) text = `<${tag}>${text}</${tag}>`;
        if (mark.type.name === "link") text = `<a href="${escapeHtml(mark.attrs.href)}">${text}</a>`;
        if (mark.type.name === "canvas_span") text = `<span class="${escapeHtml(mark.attrs.class)}">${text}</span>`;
        if (mark.type.name === "math") text = `<Math>${text}</Math>`;
      }
      return text;
    }
    if (node.type.name === "hard_break") return "<br>";
    if (node.type.name === "code_block") {
      if (node.attrs.language !== MATH_LANGUAGE) throw new Error("Canvas authoring cannot represent a code block. Use <Math display> for an equation.");
      const attrs = [node.attrs.id ? `id="${escapeHtml(node.attrs.id)}"` : "", node.attrs.canvasClass ? `class="${escapeHtml(node.attrs.canvasClass)}"` : ""].filter(Boolean).join(" ");
      return `<Math display${attrs ? ` ${attrs}` : ""}>${escapeHtml(node.textContent)}</Math>`;
    }
    const container = Object.entries(CONTAINERS).find(([, type]) => type === node.type.name)?.[0];
    const name = container || (node.type.name === "heading" ? `h${node.attrs.level}` : ({ paragraph: "p", title: "h1", subtitle: "p", bullet_list: "ul", ordered_list: "ol", list_item: "li", blockquote: "blockquote", table: "table", table_row: "tr", table_header: "th", table_cell: "td", image: "img", horizontal_rule: "hr", page_break: "PageBreak" } as Record<string, string>)[node.type.name]);
    if (!name) throw new Error(`Canvas authoring cannot represent ${node.type.name}. Use focused patches to preserve this content.`);
    const attrs = [node.attrs.id ? `id="${escapeHtml(node.attrs.id)}"` : "", node.attrs.canvasClass ? `class="${escapeHtml(node.attrs.canvasClass)}"` : "", container ? `pagination="${node.attrs.pagination}"` : "", node.attrs.ratio ? `ratio="${node.attrs.ratio}"` : "", name === "img" ? `src="${escapeHtml(node.attrs.src)}" alt="${escapeHtml(node.attrs.alt || "Image")}"${node.attrs.width ? ` width="${escapeHtml(node.attrs.width)}"` : ""}` : "", node.attrs.colspan > 1 ? `colspan="${node.attrs.colspan}"` : "", node.attrs.rowspan > 1 ? `rowspan="${node.attrs.rowspan}"` : ""].filter(Boolean).join(" ");
    if (["img", "hr"].includes(name)) return `<${name} ${attrs}>`;
    if (name === "PageBreak") return `<PageBreak ${attrs}></PageBreak>`;
    const inner: string[] = [];
    node.forEach((child) => inner.push(render(child)));
    return `<${name} ${attrs}>${inner.join(node.isTextblock ? "" : "\n")}</${name}>`;
  };
  const out: string[] = [];
  doc.forEach((child) => out.push(render(child)));
  return `<Canvas>\n${out.join("\n")}\n</Canvas>`;
}

/** Ids written in the markup, before missing ones are filled in. */
export function canvasAuthoredIds(html: string): { rootId: string | null; ids: string[] } {
  const parsed = parseFragment(html);
  const roots = parsed.childNodes.filter((n) => n.nodeName !== "#text" || ("value" in n && n.value.trim()));
  const canvas = roots[0];
  if (!canvas || !("tagName" in canvas)) return { rootId: null, ids: [] };
  const blocks = canvas.childNodes.filter((n): n is Element => "tagName" in n);
  const ids: string[] = [];
  const walk = (el: Element) => {
    const id = el.attrs.find((attr) => attr.name === "id")?.value;
    if (id) ids.push(id);
    for (const child of el.childNodes) if ("tagName" in child) walk(child as Element);
  };
  const root = blocks[0];
  if (root) walk(root);
  return { rootId: root?.attrs.find((attr) => attr.name === "id")?.value || null, ids };
}
