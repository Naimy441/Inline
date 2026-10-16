import type { Node as PMNode } from "prosemirror-model";
import { EditError } from "@/lib/doc/editing";
import { newId } from "@/lib/doc/ids";
import { docToMarkdown, markdownToDoc } from "@/lib/doc/markdown";

/**
 * A canvas is an Inline document whose source is HTML the agent writes:
 * expandable sections, layout, and styling, with the passages a person should
 * type left as text and the passages that are structure or code left that way.
 * Notebook cells live in the same HTML. The ProseMirror document stays a text
 * projection so word count, search, and turning the canvas back into a page
 * still work.
 */

export type RegionMode = "text" | "structure" | "code";
export type CellLanguage = "javascript" | "python";

export type CanvasBlock =
  | { kind: "heading"; id: string; text: string; mode: RegionMode }
  | { kind: "text"; id: string; text: string; mode: RegionMode }
  | { kind: "layout"; id: string; html: string; mode: RegionMode }
  | { kind: "code"; id: string; source: string; mode: RegionMode }
  | { kind: "cell"; id: string; language: CellLanguage; source: string; mode: RegionMode };

export type CanvasSection = { id: string; headingId: string; open: boolean; title: string; blocks: CanvasBlock[] };
export type CanvasModel = { style: string; sections: CanvasSection[] };

export type CanvasOutput = { stdout: string; stderr: string; error: string | null; ranAt: number };

/** Stored beside the ProseMirror doc. `projection` is the Markdown last written into that doc. */
export type CanvasFile = { html: string; outputs: Record<string, CanvasOutput>; projection: string };

const MAX_HTML = 1_000_000;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const DROP = new Set(["script", "iframe", "object", "embed", "link", "meta", "noscript"]);
const ALLOWED = new Set([
  "div", "p", "span", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td",
  "strong", "em", "b", "i", "a", "br", "hr", "blockquote", "code", "pre", "figure", "figcaption", "small", "sup", "sub",
]);

type ElementNode = {
  type: "element";
  name: string;
  attrs: Record<string, string>;
  start: number;
  openEnd: number;
  innerEnd: number;
  end: number;
  children: CanvasNode[];
  selfClosing: boolean;
};
type TextNode = { type: "text"; text: string; start: number; end: number };
type CanvasNode = ElementNode | TextNode;

export function escapeText(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function decodeEntities(text: string) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
}

function escapeAttr(text: string) {
  return escapeText(text).replace(/"/g, "&quot;");
}

/** The HTML a new canvas opens with: one section, editable text, a layout, and a notebook cell. */
export function starterCanvasHtml() {
  return `<article class="inline-canvas">
<style>
.figures { display: flex; gap: 16px; }
.figure b { display: block; font-size: 22px; line-height: 1.2; }
.figure span { color: #5c5852; font-size: 13px; }
</style>
<section id="intro" data-canvas-section open>
<h2 id="intro-title" data-canvas-heading>Untitled canvas</h2>
<div id="intro-text" data-canvas-text>Start writing here. This text stays editable.</div>
<div id="intro-layout" data-canvas-layout data-mode="structure">
<div class="figures"><div class="figure"><b>1</b><span>section</span></div><div class="figure"><b>1</b><span>notebook cell</span></div></div>
</div>
<div id="intro-cell" data-canvas-cell data-language="javascript" data-mode="code">
<pre data-canvas-source>console.log("hello from the canvas")</pre>
</div>
</section>
</article>`;
}

/** A page document becomes a canvas: headings open sections, prose stays text, code becomes a cell. */
export function pageToCanvasHtml(doc: PMNode) {
  const sections: Array<{ title: string; blocks: string[] }> = [];
  let current: { title: string; blocks: string[] } | null = null;
  const ensure = () => {
    if (!current) {
      current = { title: "Document", blocks: [] };
      sections.push(current);
    }
    return current;
  };
  doc.forEach((node) => {
    if (node.type.name === "heading" || node.type.name === "title") {
      current = { title: node.textContent.trim() || "Section", blocks: [] };
      sections.push(current);
      return;
    }
    const section = ensure();
    if (node.type.name === "code_block") {
      const named = String(node.attrs.language || "").toLowerCase();
      const source = node.textContent;
      const language = named === "python" || named === "py" ? "python" : named === "" || named === "javascript" || named === "js" || named === "node" ? "javascript" : null;
      if (language) section.blocks.push(cellMarkup(freshId(), language, source));
      else section.blocks.push(`<pre id="${freshId()}" data-canvas-code data-mode="code"><code>${escapeText(source)}</code></pre>`);
      return;
    }
    if (node.type.name === "image") {
      const src = String(node.attrs.src || "");
      if (safeImageSrc(src)) section.blocks.push(`<div id="${freshId()}" data-canvas-layout data-mode="structure"><img src="${escapeAttr(src)}" alt="${escapeAttr(String(node.attrs.alt || ""))}" /></div>`);
      return;
    }
    const text = node.textBetween(0, node.content.size, "\n", (leaf) => (leaf.type.name === "inline_image" ? String(leaf.attrs.alt || "") : "")).trim();
    if (text) section.blocks.push(`<div id="${freshId()}" data-canvas-text>${escapeText(text)}</div>`);
  });
  if (!sections.length) sections.push({ title: "Document", blocks: [`<div id="${freshId()}" data-canvas-text></div>`] });
  const body = sections
    .map((section, index) => {
      const id = `section-${index + 1}`;
      return `<section id="${id}" data-canvas-section open>
<h2 id="${id}-title" data-canvas-heading>${escapeText(section.title)}</h2>
${section.blocks.join("\n")}
</section>`;
    })
    .join("\n");
  return normalizeCanvasHtml(`<article class="inline-canvas">\n${body}\n</article>`);
}

/** Visible text of a canvas, as Markdown, so a page document can hold it. */
export function canvasToMarkdown(html: string) {
  const model = parseCanvas(html);
  const parts: string[] = [];
  for (const section of model.sections) {
    const title = section.title.trim();
    if (title) parts.push(`## ${title}`);
    for (const block of section.blocks) {
      if (block.kind === "heading" && block.text.trim()) parts.push(`### ${block.text.trim()}`);
      else if (block.kind === "text" && block.text.trim()) parts.push(block.text.trim());
      else if (block.kind === "layout") {
        const text = visibleText(block.html).trim();
        if (text) parts.push(text);
      } else if (block.kind === "code" && block.source.trim()) parts.push("```\n" + block.source.replace(/\n$/, "") + "\n```");
      else if (block.kind === "cell" && block.source.trim()) parts.push("```" + block.language + "\n" + block.source.replace(/\n$/, "") + "\n```");
    }
  }
  return parts.join("\n\n");
}

/** True when the page still matches the Markdown last projected from this canvas. */
export function sameProjection(doc: PMNode, projection: string) {
  try {
    return docToMarkdown(doc) === docToMarkdown(markdownToDoc(projection));
  } catch {
    return false;
  }
}

export function visibleText(html: string) {
  return decodeEntities(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

export function normalizeCanvasHtml(html: string) {
  let source = html.replace(/\u0000/g, "").trim();
  if (source.length > MAX_HTML) source = source.slice(0, MAX_HTML);
  if (!/inline-canvas/.test(source)) source = `<article class="inline-canvas">\n${source}\n</article>`;
  return ensureCanvasIds(source);
}

export function parseCanvas(html: string): CanvasModel {
  const roots = parseFragment(html);
  const article = findElement(roots, (el) => el.name === "article") ?? synthetic(roots);
  const style = collect(article)
    .filter((el) => el.name === "style")
    .map((el) => html.slice(el.openEnd, el.innerEnd))
    .join("\n");
  let sections = article.children.filter((node): node is ElementNode => node.type === "element" && (node.name === "section" || node.attrs["data-canvas-section"] !== undefined));
  if (!sections.length) {
    const wrapper = synthetic(article.children.filter((node) => node.type === "element" && node.name !== "style"));
    wrapper.attrs = { id: "canvas", "data-canvas-section": "", open: "" };
    sections = [wrapper];
  }
  return {
    style,
    sections: sections.map((section) => parseSection(section, html)),
  };
}

/** Replace the text of a region. Cells update their source. Layout and code can take raw HTML when `asHtml` is set. */
export function setRegionText(html: string, id: string, text: string, asHtml = false) {
  const el = findElement(parseFragment(html), (node) => node.attrs.id === id);
  if (!el) return html;
  const target = el.attrs["data-canvas-cell"] !== undefined ? findElement(el.children, (node) => node.attrs["data-canvas-source"] !== undefined) ?? el : el;
  const inner = asHtml ? text : escapeText(text);
  if (target === el && el.attrs["data-canvas-cell"] !== undefined && !findElement(el.children, (node) => node.attrs["data-canvas-source"] !== undefined)) {
    return html.slice(0, el.openEnd) + `<pre data-canvas-source>${inner}</pre>` + html.slice(el.innerEnd);
  }
  return html.slice(0, target.openEnd) + inner + html.slice(target.innerEnd);
}

export function setRegionMode(html: string, id: string, mode: RegionMode) {
  return setAttribute(html, id, "data-mode", mode);
}

export function setSectionOpen(html: string, id: string, open: boolean) {
  return open ? setAttribute(html, id, "open", "") : setAttribute(html, id, "open", null);
}

export function setCellLanguage(html: string, id: string, language: CellLanguage) {
  return setAttribute(html, id, "data-language", language);
}

export function replaceCanvas(html: string, oldString: string, newString: string, replaceAll = false) {
  if (oldString === newString) throw new EditError("No changes to make: old_string and new_string are exactly the same.");
  if (!oldString) throw new EditError("old_string is empty. To add content use insert_content, or write_document to replace the whole canvas.");
  const matches = indexesOf(html, oldString);
  if (!matches.length) {
    throw new EditError("String to replace not found in the canvas. old_string must match the HTML shown by read_document exactly (without the line-number prefix).");
  }
  if (!replaceAll && matches.length > 1) {
    throw new EditError(`Found ${matches.length} matches of old_string, but replace_all is false. Include more surrounding HTML so it is unique, or set replace_all.`);
  }
  return replaceAll ? html.split(oldString).join(newString) : html.replace(oldString, newString);
}

export function insertInCanvas(html: string, content: string, position: { at: "start" | "end" } | { afterLine: number } | { beforeLine: number }) {
  const lines = html.split("\n");
  let index: number;
  if ("at" in position && position.at === "start") {
    const article = lines.findIndex((line) => /<article\b/.test(line));
    index = article >= 0 ? article + 1 : 0;
  } else if ("at" in position && position.at === "end") {
    const close = lines.findIndex((line) => /<\/article>/.test(line));
    index = close >= 0 ? close : lines.length;
  } else if ("afterLine" in position) index = Math.min(lines.length, position.afterLine);
  else if ("beforeLine" in position) index = Math.max(0, Math.min(lines.length, position.beforeLine - 1));
  else index = lines.length;
  lines.splice(index, 0, content.replace(/\s+$/, ""));
  return lines.join("\n");
}

/** Add a notebook cell to the last section. Returns the new id. */
export function appendCell(html: string, language: CellLanguage, source: string) {
  const id = freshId();
  const markup = cellMarkup(id, language, source);
  const close = html.lastIndexOf("</section>");
  const at = close >= 0 ? close : html.lastIndexOf("</article>");
  if (at < 0) return { html: `${html}\n${markup}`, id };
  return { html: `${html.slice(0, at)}${markup}\n${html.slice(at)}`, id };
}

/** Layout HTML safe to render: no scripts, no event handlers, no scriptable URLs. */
export function sanitizeLayoutHtml(html: string) {
  return parseFragment(html).map((node) => serializeSafe(node)).join("");
}

/** CSS the agent wrote, kept inside the canvas and stripped of imports and scriptable urls. */
export function canvasStyle(css: string) {
  const cleaned = css
    .replace(/<\/style/gi, "")
    .replace(/@import[^;]+;?/gi, "")
    .replace(/expression\s*\(/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/url\s*\(\s*(['"]?)\s*javascript:/gi, "url($1");
  if (!cleaned.trim()) return "";
  return `@scope (.canvas-doc) {\n${cleaned}\n}`;
}

export function normalizeStoredCanvas(value: unknown): CanvasFile | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<CanvasFile>;
  if (typeof raw.html !== "string" || !raw.html.trim()) return null;
  const outputs: Record<string, CanvasOutput> = {};
  if (raw.outputs && typeof raw.outputs === "object") {
    for (const [id, output] of Object.entries(raw.outputs)) {
      if (!output || typeof output !== "object") continue;
      const item = output as Partial<CanvasOutput>;
      if (typeof item.stdout !== "string" || typeof item.stderr !== "string") continue;
      outputs[id] = { stdout: item.stdout.slice(0, 100_000), stderr: item.stderr.slice(0, 100_000), error: typeof item.error === "string" ? item.error.slice(0, 10_000) : null, ranAt: Number(item.ranAt) || 0 };
    }
  }
  return { html: raw.html.slice(0, MAX_HTML), outputs, projection: typeof raw.projection === "string" ? raw.projection : canvasToMarkdown(raw.html) };
}

function parseSection(section: ElementNode, html: string): CanvasSection {
  const heading = section.children.find((node): node is ElementNode => node.type === "element" && isHeading(node));
  const blocks = section.children.flatMap((node) => {
    if (node.type !== "element" || node === heading || node.name === "style") return [];
    const block = blockOf(node, html);
    return block ? [block] : [];
  });
  return {
    id: section.attrs.id || "section",
    headingId: heading?.attrs.id || "",
    open: "open" in section.attrs,
    title: heading ? elementText(heading, html) : "Section",
    blocks,
  };
}

function blockOf(el: ElementNode, html: string): CanvasBlock | null {
  const id = el.attrs.id || "";
  if (el.attrs["data-canvas-cell"] !== undefined) {
    return { kind: "cell", id, language: cellLanguage(el.attrs["data-language"] || "") ?? "javascript", source: cellSource(el, html), mode: modeOf(el, "code") };
  }
  if (el.attrs["data-canvas-code"] !== undefined || el.name === "pre") {
    return { kind: "code", id, source: elementText(el, html), mode: modeOf(el, "code") };
  }
  if (el.attrs["data-canvas-layout"] !== undefined) {
    return { kind: "layout", id, html: html.slice(el.openEnd, el.innerEnd), mode: modeOf(el, "structure") };
  }
  if (isHeading(el)) return { kind: "heading", id, text: elementText(el, html), mode: modeOf(el, "text") };
  if (el.name === "p" || el.attrs["data-canvas-text"] !== undefined) return { kind: "text", id, text: elementText(el, html), mode: modeOf(el, "text") };
  if (["div", "ul", "ol", "table", "figure", "blockquote"].includes(el.name)) {
    return { kind: "layout", id, html: html.slice(el.openEnd, el.innerEnd), mode: modeOf(el, "structure") };
  }
  return null;
}

function isHeading(el: ElementNode) {
  return el.attrs["data-canvas-heading"] !== undefined || /^h[1-6]$/.test(el.name);
}

function modeOf(el: ElementNode, fallback: RegionMode): RegionMode {
  const value = el.attrs["data-mode"];
  return value === "text" || value === "structure" || value === "code" ? value : fallback;
}

function cellLanguage(value: string): CellLanguage | null {
  const name = value.toLowerCase();
  if (name === "python" || name === "py") return "python";
  if (name === "javascript" || name === "js" || name === "node" || name === "") return "javascript";
  return null;
}

function cellSource(el: ElementNode, html: string) {
  const pre = findElement(el.children, (node) => node.attrs["data-canvas-source"] !== undefined) ?? findElement(el.children, (node) => node.name === "pre");
  return elementText(pre ?? el, html);
}

function elementText(el: ElementNode, html: string) {
  return decodeEntities(html.slice(el.openEnd, el.innerEnd).replace(/<[^>]+>/g, ""));
}

function cellMarkup(id: string, language: CellLanguage, source: string) {
  return `<div id="${id}" data-canvas-cell data-language="${language}" data-mode="code">\n<pre data-canvas-source>${escapeText(source)}</pre>\n</div>`;
}

function freshId() {
  return `c${newId(6)}`;
}

function ensureCanvasIds(html: string) {
  let current = html;
  for (let guard = 0; guard < 300; guard += 1) {
    const missing = firstMissingId(parseFragment(current));
    if (!missing) return current;
    current = rewriteOpen(current, missing, { ...missing.attrs, id: freshId() });
  }
  return current;
}

function firstMissingId(nodes: CanvasNode[], parent: ElementNode | null = null): ElementNode | null {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (needsId(node, parent) && !node.attrs.id) return node;
    const nested = firstMissingId(node.children, node);
    if (nested) return nested;
  }
  return null;
}

function needsId(el: ElementNode, parent: ElementNode | null) {
  if (el.name === "style") return false;
  if (el.name === "section" || el.attrs["data-canvas-section"] !== undefined) return true;
  if (["data-canvas-heading", "data-canvas-text", "data-canvas-layout", "data-canvas-code", "data-canvas-cell"].some((name) => el.attrs[name] !== undefined)) return true;
  if (el.attrs["data-canvas-source"] !== undefined) return false;
  const inSection = parent?.name === "section" || parent?.attrs["data-canvas-section"] !== undefined;
  return Boolean(inSection && (el.name === "p" || el.name === "pre" || isHeading(el)));
}

function setAttribute(html: string, id: string, name: string, value: string | null) {
  const el = findElement(parseFragment(html), (node) => node.attrs.id === id);
  if (!el) return html;
  const attrs = { ...el.attrs };
  if (value === null) delete attrs[name];
  else attrs[name] = value;
  return rewriteOpen(html, el, attrs);
}

function rewriteOpen(html: string, el: ElementNode, attrs: Record<string, string>) {
  return html.slice(0, el.start) + renderOpen(el.name, attrs, el.selfClosing) + html.slice(el.openEnd);
}

function renderOpen(name: string, attrs: Record<string, string>, selfClosing: boolean) {
  const parts = [name];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === "") parts.push(key);
    else parts.push(`${key}="${escapeAttr(value)}"`);
  }
  return `<${parts.join(" ")}${selfClosing ? " />" : ">"}`;
}

function indexesOf(haystack: string, needle: string) {
  const found: number[] = [];
  let from = 0;
  while (from <= haystack.length) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    found.push(at);
    from = at + Math.max(1, needle.length);
  }
  return found;
}

function safeImageSrc(src: string) {
  return /^(https?:|data:image\/|\/)/i.test(src) && !/^\/\//.test(src) && !/javascript:/i.test(src);
}

function serializeSafe(node: CanvasNode): string {
  if (node.type === "text") return escapeText(decodeEntities(node.text));
  if (DROP.has(node.name)) return "";
  if (node.name === "img") {
    const src = node.attrs.src || "";
    if (!safeImageSrc(src)) return "";
    const attrs = [`src="${escapeAttr(src)}"`];
    if (node.attrs.alt) attrs.push(`alt="${escapeAttr(node.attrs.alt)}"`);
    const style = node.attrs.style && !/url\s*\(|expression|javascript/i.test(node.attrs.style) ? node.attrs.style.replace(/[<>]/g, "") : "";
    if (style) attrs.push(`style="${escapeAttr(style)}"`);
    return `<img ${attrs.join(" ")} />`;
  }
  const inner = node.children.map((child) => serializeSafe(child)).join("");
  if (!ALLOWED.has(node.name)) return inner;
  const attrs: string[] = [];
  if (node.attrs.class) attrs.push(`class="${escapeAttr(node.attrs.class)}"`);
  const style = node.attrs.style && !/url\s*\(|expression|javascript/i.test(node.attrs.style) ? node.attrs.style.replace(/[<>]/g, "") : "";
  if (style) attrs.push(`style="${escapeAttr(style)}"`);
  if (node.name === "a") {
    const href = node.attrs.href || "";
    if (/^(https?:|mailto:|tel:|#|\/)/i.test(href) && !/^\/\//.test(href)) attrs.push(`href="${escapeAttr(href)}"`);
  }
  const open = `<${node.name}${attrs.length ? ` ${attrs.join(" ")}` : ""}>`;
  if (VOID.has(node.name)) return open.replace(/>$/, " />");
  return `${open}${inner}</${node.name}>`;
}

function synthetic(children: CanvasNode[]): ElementNode {
  return { type: "element", name: "article", attrs: {}, start: 0, openEnd: 0, innerEnd: 0, end: 0, children, selfClosing: false };
}

function findElement(nodes: CanvasNode[], match: (el: ElementNode) => boolean): ElementNode | null {
  for (const node of nodes) {
    if (node.type !== "element") continue;
    if (match(node)) return node;
    const nested = findElement(node.children, match);
    if (nested) return nested;
  }
  return null;
}

function collect(el: ElementNode) {
  const all: ElementNode[] = [];
  const walk = (node: ElementNode) => {
    all.push(node);
    for (const child of node.children) if (child.type === "element") walk(child);
  };
  walk(el);
  return all;
}

function parseFragment(html: string): CanvasNode[] {
  const roots: CanvasNode[] = [];
  const stack: ElementNode[] = [];
  let i = 0;
  const current = () => (stack.length ? stack[stack.length - 1]!.children : roots);
  while (i < html.length) {
    if (html[i] !== "<") {
      const start = i;
      const next = html.indexOf("<", i);
      const end = next === -1 ? html.length : next;
      current().push({ type: "text", text: html.slice(start, end), start, end });
      i = end;
      continue;
    }
    if (html.startsWith("<!--", i)) {
      const close = html.indexOf("-->", i + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (html.startsWith("<!", i) || html.startsWith("<?", i)) {
      const close = html.indexOf(">", i + 2);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    const isClose = html[i + 1] === "/";
    let j = i + (isClose ? 2 : 1);
    const nameStart = j;
    while (j < html.length && /[A-Za-z0-9:-]/.test(html[j]!)) j += 1;
    const name = html.slice(nameStart, j).toLowerCase();
    if (!name) {
      current().push({ type: "text", text: "<", start: i, end: i + 1 });
      i += 1;
      continue;
    }
    if (isClose) {
      const gt = html.indexOf(">", j);
      const tagEnd = gt === -1 ? html.length : gt + 1;
      for (let s = stack.length - 1; s >= 0; s -= 1) {
        if (stack[s]!.name === name) {
          const el = stack[s]!;
          el.innerEnd = i;
          el.end = tagEnd;
          stack.length = s;
          break;
        }
      }
      i = tagEnd;
      continue;
    }
    const parsed = readAttrs(html, j);
    const selfClosing = parsed.selfClosing || VOID.has(name);
    const el: ElementNode = {
      type: "element",
      name,
      attrs: parsed.attrs,
      start: i,
      openEnd: parsed.tagEnd,
      innerEnd: parsed.tagEnd,
      end: parsed.tagEnd,
      children: [],
      selfClosing,
    };
    current().push(el);
    if (!selfClosing) stack.push(el);
    i = parsed.tagEnd;
  }
  for (const el of stack) {
    el.innerEnd = html.length;
    el.end = html.length;
  }
  return roots;
}

function readAttrs(html: string, i: number) {
  const attrs: Record<string, string> = {};
  while (i < html.length) {
    while (i < html.length && /\s/.test(html[i]!)) i += 1;
    if (i >= html.length || html[i] === ">") return { attrs, tagEnd: Math.min(html.length, i + 1), selfClosing: false };
    if (html[i] === "/" && html[i + 1] === ">") return { attrs, tagEnd: i + 2, selfClosing: true };
    const nameStart = i;
    while (i < html.length && /[^\s=/>]/.test(html[i]!)) i += 1;
    const name = html.slice(nameStart, i).toLowerCase();
    while (i < html.length && /\s/.test(html[i]!)) i += 1;
    if (html[i] !== "=") {
      if (name) attrs[name] = "";
      continue;
    }
    i += 1;
    while (i < html.length && /\s/.test(html[i]!)) i += 1;
    let value = "";
    const quote = html[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      const start = i;
      while (i < html.length && html[i] !== quote) i += 1;
      value = html.slice(start, i);
      if (html[i] === quote) i += 1;
    } else {
      const start = i;
      while (i < html.length && /[^\s>]/.test(html[i]!)) i += 1;
      value = html.slice(start, i);
    }
    if (name) attrs[name] = decodeEntities(value);
  }
  return { attrs, tagEnd: i, selfClosing: false };
}
