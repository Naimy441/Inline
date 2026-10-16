import { GapCursor } from "prosemirror-gapcursor";
import type { Node as PMNode } from "prosemirror-model";
import { TextSelection, type Selection } from "prosemirror-state";
import { Transform } from "prosemirror-transform";
import { schema } from "@/lib/doc/schema";

/**
 * A table of contents is one field, not a list of paragraphs someone has to
 * maintain. It is generated from the document's headings. Page numbers are
 * not stored: the editor paints them from the page layout, so they follow
 * the document as it changes, and deleting the field removes the whole thing.
 */

export const TOC_MARKDOWN = "\\tableofcontents";
export const TOC_DEPTH_DEFAULT = 3;
export const TOC_TITLE = "Contents";
export const TOC_EMPTY = "Headings you add are listed here.";

export type TocHeading = { level: number; text: string; id: string | null; pos: number };

/** Heading levels a contents field lists: 1 through 6. */
export function tocDepth(value: unknown, fallback = TOC_DEPTH_DEFAULT): number {
  const depth = Number(value);
  return Number.isInteger(depth) && depth >= 1 && depth <= 6 ? depth : fallback;
}

/**
 * `\tableofcontents`, `\tableofcontents {depth=2}`, `{title="Index"}`, or both.
 * A missing title means the default heading. A title of `null` in the result
 * is that default; a string, including "", was written in the line.
 */
export function tocMarkdownMatch(text: string): { depth: number; title: string | null } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith(TOC_MARKDOWN)) return null;
  const rest = trimmed.slice(TOC_MARKDOWN.length);
  if (!rest.trim()) return { depth: TOC_DEPTH_DEFAULT, title: null };
  const body = /^\s*\{([\s\S]*)\}\s*$/.exec(rest);
  if (!body) return null;
  return parseTocAttrs(body[1] ?? "");
}

function parseTocAttrs(body: string): { depth: number; title: string | null } | null {
  let rest = body.trim();
  if (!rest) return { depth: TOC_DEPTH_DEFAULT, title: null };
  let depth = TOC_DEPTH_DEFAULT;
  let title: string | null = null;
  let sawDepth = false;
  let sawTitle = false;
  while (rest) {
    const depthMatch = /^depth=([1-6])(?=\s|$)/.exec(rest);
    if (depthMatch) {
      if (sawDepth) return null;
      sawDepth = true;
      depth = Number(depthMatch[1]);
      rest = rest.slice(depthMatch[0].length).trimStart();
      continue;
    }
    const titleMatch = /^title="((?:\\.|[^"\\])*)"(?=\s|$)/.exec(rest);
    if (titleMatch) {
      if (sawTitle) return null;
      sawTitle = true;
      title = (titleMatch[1] ?? "").replace(/\\(["\\])/g, "$1");
      rest = rest.slice(titleMatch[0].length).trimStart();
      continue;
    }
    return null;
  }
  return { depth, title };
}

function escapeTocTitle(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r?\n/g, " ");
}

/** The Markdown line for a contents field. The default heading is left off, so older lines stay as they were. */
export function tocMarkdown(node: PMNode): string {
  const depth = tocDepth(node.attrs.depth);
  const title = node.firstChild?.type.name === "toc_title" ? node.firstChild.textContent : TOC_TITLE;
  const bits: string[] = [];
  if (depth !== TOC_DEPTH_DEFAULT) bits.push(`depth=${depth}`);
  if (title !== TOC_TITLE) bits.push(`title="${escapeTocTitle(title)}"`);
  return bits.length ? `${TOC_MARKDOWN} {${bits.join(" ")}}` : TOC_MARKDOWN;
}

/** A contents heading. `text` defaults to "Contents"; "" is an empty heading. */
export function tocTitleNode(text: string = TOC_TITLE): PMNode {
  const type = schema.nodes.toc_title!;
  return text ? type.create(null, schema.text(text)) : type.create();
}

/**
 * Headings the contents field lists, in document order. Headings inside a
 * contents field (there are none; its title is not a heading) are skipped.
 */
export function collectTocHeadings(doc: PMNode, depth: number): TocHeading[] {
  const out: TocHeading[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "toc") return false;
    if (node.type.name !== "heading") return true;
    const text = node.textContent.replace(/\s+/g, " ").trim();
    const level = Number(node.attrs.level) || 1;
    if (text && level >= 1 && level <= depth) out.push({ level, text, id: (node.attrs.id as string | null) ?? null, pos });
    return false;
  });
  return out;
}

export function findToc(doc: PMNode): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === "toc") {
      found = { node, pos };
      return false;
    }
    return true;
  });
  return found;
}

function entrySignature(headings: TocHeading[]): string {
  if (!headings.length) return `p:1::${TOC_EMPTY}`;
  return headings.map((heading) => `e:${heading.level}:${heading.id ? `#${heading.id}` : ""}:${heading.text}`).join("\n");
}

function nodeSignature(toc: PMNode): string {
  const parts: string[] = [];
  toc.forEach((child) => {
    if (child.type.name !== "toc_entry") return;
    parts.push(`${child.attrs.placeholder ? "p" : "e"}:${child.attrs.level}:${child.attrs.href ?? ""}:${child.attrs.text}`);
  });
  return parts.join("\n");
}

/** The heading already on the field, including one stored the old way as an attribute. */
function titleFrom(existing: PMNode | null | undefined, text?: string | null): PMNode {
  const current = existing?.type.name === "toc" ? existing.firstChild : existing?.type.name === "toc_title" ? existing : null;
  if (current?.type.name === "toc_title" && text == null) {
    const legacy = typeof current.attrs.text === "string" && current.attrs.text ? current.attrs.text : "";
    if (!legacy) return current;
    // The words live in the node now. An empty heading stays empty.
    return tocTitleNode(current.content.size > 0 ? current.textContent : legacy);
  }
  return tocTitleNode(text ?? TOC_TITLE);
}

function titleNeedsMigration(toc: PMNode): boolean {
  const title = toc.firstChild;
  if (title?.type.name !== "toc_title") return true;
  return typeof title.attrs.text === "string" && title.attrs.text.length > 0;
}

function tocChildren(doc: PMNode, depth: number, existing?: PMNode | null, titleText?: string | null): PMNode[] {
  const headings = collectTocHeadings(doc, depth);
  const title = titleFrom(existing, titleText);
  if (!headings.length) {
    return [title, schema.nodes.toc_entry!.create({ level: 1, text: TOC_EMPTY, href: null, placeholder: true })];
  }
  return [
    title,
    ...headings.map((heading) =>
      schema.nodes.toc_entry!.create({
        level: heading.level,
        text: heading.text,
        href: heading.id ? `#${heading.id}` : null,
        placeholder: false,
      }),
    ),
  ];
}

/** A contents field for `doc`, already filled from its headings. */
export function createToc(doc: PMNode, depth = TOC_DEPTH_DEFAULT): PMNode {
  const levels = tocDepth(depth);
  return schema.nodes.toc!.create({ depth: levels }, tocChildren(doc, levels));
}

/**
 * The same field with its entries rebuilt from the headings. Returns `toc`
 * itself when nothing would change, so a caller can skip the write.
 */
export function syncedToc(toc: PMNode, doc: PMNode): PMNode {
  const depth = tocDepth(toc.attrs.depth);
  const headings = collectTocHeadings(doc, depth);
  if (!titleNeedsMigration(toc) && toc.firstChild?.type.name === "toc_title" && nodeSignature(toc) === entrySignature(headings) && toc.attrs.depth === depth) return toc;
  return schema.nodes.toc!.create({ ...toc.attrs, depth }, tocChildren(doc, depth, toc));
}

/** A text caret in the contents heading, for a gap cursor that would otherwise sit beside the field. */
export function selectionReplacingTocGap(doc: PMNode, selection: Selection): TextSelection | null {
  if (!(selection instanceof GapCursor)) return null;
  const $pos = selection.$from;
  let tocPos: number | null = null;
  let atEnd = false;
  if ($pos.nodeAfter?.type.name === "toc") tocPos = $pos.pos;
  else if ($pos.nodeBefore?.type.name === "toc") {
    tocPos = $pos.pos - $pos.nodeBefore.nodeSize;
    atEnd = true;
  } else if ($pos.parent.type.name === "toc") tocPos = $pos.before();
  if (tocPos == null) return null;
  return tocTitleSelection(doc, tocPos, atEnd ? "end" : "start");
}

/** Caret in the contents heading. The heading is the field's first child. */
export function tocTitleSelection(doc: PMNode, tocPos: number, edge: "start" | "end" = "start"): TextSelection | null {
  const toc = doc.nodeAt(tocPos);
  const title = toc?.firstChild;
  if (!toc || toc.type.name !== "toc" || !title?.isTextblock) return null;
  const start = tocPos + 2;
  const end = start + title.content.size;
  return TextSelection.create(doc, edge === "end" ? end : start);
}

/** Steps that rebuild every contents field, or null when they already match the headings. */
export function syncTocTransform(doc: PMNode): Transform | null {
  const found: Array<{ pos: number }> = [];
  doc.descendants((node, pos) => {
    if (node.type.name === "toc") {
      found.push({ pos });
      return false;
    }
    return true;
  });
  if (!found.length) return null;
  const tr = new Transform(doc);
  for (const item of found.reverse()) {
    const mapped = tr.mapping.mapResult(item.pos, 1);
    if (mapped.deleted) continue;
    const current = tr.doc.nodeAt(mapped.pos);
    if (!current || current.type.name !== "toc") continue;
    const updated = syncedToc(current, tr.doc);
    if (updated === current) continue;
    tr.replaceWith(mapped.pos, mapped.pos + current.nodeSize, updated);
  }
  return tr.docChanged ? tr : null;
}

/** Rebuild every contents field. No-op (same node) when they already match. */
export function withSyncedTocs(doc: PMNode): PMNode {
  return syncTocTransform(doc)?.doc ?? doc;
}

/** 1-based page of a document position. `starts` are where pages 2, 3, … begin. */
export function pageFromStarts(starts: readonly number[], pos: number): number {
  let page = 1;
  for (const start of starts) {
    if (start <= pos) page += 1;
    else break;
  }
  return page;
}

/** What Claude reads back: the entries, with page numbers when the editor has measured them. */
export function describeToc(doc: PMNode, starts?: readonly number[]): string {
  const toc = findToc(doc);
  if (!toc) return "This document has no table of contents.";
  const depth = tocDepth(toc.node.attrs.depth);
  const headings = collectTocHeadings(doc, depth);
  const title = toc.node.firstChild?.type.name === "toc_title" ? toc.node.firstChild.textContent : TOC_TITLE;
  const named = title.trim() ? `“${title}”` : "with a blank heading";
  if (!headings.length) return `The table of contents ${named} is in the document. There are no headings to list yet (it includes heading levels 1–${depth}).`;
  const top = Math.min(...headings.map((heading) => heading.level));
  const lines = headings.map((heading) => {
    const page = starts ? pageFromStarts(starts, heading.pos) : null;
    const indent = "  ".repeat(Math.max(0, heading.level - top));
    return `${indent}${heading.text}${page != null ? `\t${page}` : ""}`;
  });
  const measured = starts
    ? "Page numbers are the pages those headings fall on in the editor."
    : "Page numbers appear in the editor, and in the PDF, once the document is laid out.";
  return `Table of contents ${named}, heading levels 1–${depth} (${headings.length} ${headings.length === 1 ? "entry" : "entries"}):\n${lines.join("\n")}\n${measured}`;
}
