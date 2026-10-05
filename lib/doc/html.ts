import type { DOMOutputSpec, Mark, Node as PMNode } from "prosemirror-model";
import { fillHeaderTokens, pageSize, type DocumentMeta } from "@/lib/doc/settings";

/**
 * DOM-free HTML rendering of documents, driven by the schema's own `toDOM`
 * specs so exported HTML matches what the editor shows. Works on the server.
 */

const VOID = new Set(["br", "hr", "img", "input", "col"]);

export function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderSpec(spec: DOMOutputSpec, hole: string): string {
  if (typeof spec === "string") return escapeHtml(spec);
  if (!Array.isArray(spec)) throw new Error("Unsupported DOM spec.");
  const [tagSpec, ...rest] = spec as readonly unknown[];
  const tag = String(tagSpec).replace(/^.*\s/, "");
  let attrs: Record<string, unknown> = {};
  let children = rest;
  if (rest.length && rest[0] && typeof rest[0] === "object" && !Array.isArray(rest[0])) {
    attrs = rest[0] as Record<string, unknown>;
    children = rest.slice(1);
  }
  const attrText = Object.entries(attrs)
    .filter(([, value]) => value != null && value !== false)
    .map(([key, value]) => ` ${key}="${escapeHtml(String(value))}"`)
    .join("");
  if (VOID.has(tag)) return `<${tag}${attrText}>`;
  const inner = children.map((child) => (child === 0 ? hole : renderSpec(child as DOMOutputSpec, hole))).join("");
  return `<${tag}${attrText}>${inner}</${tag}>`;
}

function renderMarks(marks: readonly Mark[], html: string) {
  let out = html;
  for (let i = marks.length - 1; i >= 0; i -= 1) {
    const mark = marks[i]!;
    const toDOM = mark.type.spec.toDOM;
    if (!toDOM) continue;
    out = renderSpec(toDOM(mark, true), out);
  }
  return out;
}

export function nodeToHtml(node: PMNode): string {
  if (node.isText) return renderMarks(node.marks, escapeHtml(node.text ?? ""));
  const toDOM = node.type.spec.toDOM;
  let inner = "";
  node.forEach((child) => {
    inner += nodeToHtml(child);
  });
  if (node.isTextblock && !inner) inner = "<br>";
  if (!toDOM) return inner;
  return renderMarks(node.marks, renderSpec(toDOM(node), inner));
}

export function fragmentToHtml(doc: PMNode): string {
  let out = "";
  doc.forEach((child) => {
    out += nodeToHtml(child);
  });
  return out;
}

/** A standalone HTML file with print styles matching the document's page setup. */
export function documentHtmlFile(doc: PMNode, meta: DocumentMeta): string {
  const settings = meta.settings;
  const size = pageSize(settings.pageSetup);
  const m = settings.pageSetup.margins;
  const header = fillHeaderTokens(settings.headerFooter.header, { page: 1, pages: 1, title: meta.title });
  const footer = fillHeaderTokens(settings.headerFooter.footer, { page: 1, pages: 1, title: meta.title });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(meta.title)}</title>
<style>
@page { size: ${size.width}in ${size.height}in; margin: ${m.top}in ${m.right}in ${m.bottom}in ${m.left}in; }
body { font-family: ${settings.fontFamily}; font-size: ${settings.fontSize}pt; line-height: ${settings.lineSpacing}; color: #1f1f1f; max-width: ${size.width - m.left - m.right}in; margin: 0.75in auto; }
p { margin: 0 0 ${settings.paragraphSpacing}pt; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.1em 0 0.4em; }
.doc-title { font-size: 26pt; margin: 0 0 4pt; }
.doc-subtitle { font-size: 15pt; color: #5f6368; margin: 0 0 12pt; }
blockquote { border-left: 3px solid #d0d7de; margin: 0 0 ${settings.paragraphSpacing}pt; padding-left: 1em; color: #444; }
pre { background: #f6f8fa; padding: 10px 12px; border-radius: 6px; overflow-x: auto; font-size: 0.9em; }
code { font-family: "Roboto Mono", ui-monospace, monospace; font-size: 0.92em; }
table { border-collapse: collapse; width: 100%; margin: 0 0 ${settings.paragraphSpacing}pt; }
td, th { border: 1px solid #c8ccd0; padding: 4px 8px; vertical-align: top; }
th { background: #f3f4f6; text-align: left; }
td p, th p { margin: 0; }
figure.doc-image { margin: 0 0 ${settings.paragraphSpacing}pt; }
figure.doc-image img { max-width: 100%; }
figure.align-center { text-align: center; } figure.align-right { text-align: right; }
li.task-item { list-style: none; }
li.task-item[data-checked="true"]::before { content: "☑ "; } li.task-item[data-checked="false"]::before { content: "☐ "; }
.page-break { break-after: page; }
mark { padding: 0 1px; }
.doc-header, .doc-footer { color: #5f6368; font-size: 9pt; }
.doc-header { text-align: ${settings.headerFooter.headerAlign}; margin-bottom: 18pt; }
.doc-footer { text-align: ${settings.headerFooter.footerAlign}; margin-top: 18pt; }
</style>
</head>
<body>
${header ? `<div class="doc-header">${escapeHtml(header)}</div>\n` : ""}${fragmentToHtml(doc)}
${footer ? `<div class="doc-footer">${escapeHtml(footer)}</div>\n` : ""}</body>
</html>
`;
}
