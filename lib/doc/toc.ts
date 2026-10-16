import type { Node as PMNode } from "prosemirror-model";
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

/** `\tableofcontents` or `\tableofcontents {depth=2}`. */
export function tocMarkdownMatch(text: string): { depth: number } | null {
  const match = /^\\tableofcontents(?:\s*\{depth=([1-6])\})?$/.exec(text.trim());
  return match ? { depth: match[1] ? Number(match[1]) : TOC_DEPTH_DEFAULT } : null;
}

export function tocMarkdown(depth: number): string {
  return depth === TOC_DEPTH_DEFAULT ? TOC_MARKDOWN : `${TOC_MARKDOWN} {depth=${depth}}`;
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

function tocChildren(doc: PMNode, depth: number): PMNode[] {
  const headings = collectTocHeadings(doc, depth);
  const title = schema.nodes.toc_title!.create({ text: TOC_TITLE });
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
  if (toc.firstChild?.type.name === "toc_title" && nodeSignature(toc) === entrySignature(headings) && toc.attrs.depth === depth) return toc;
  return schema.nodes.toc!.create({ ...toc.attrs, depth }, tocChildren(doc, depth));
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
  if (!headings.length) return `The table of contents is in the document. There are no headings to list yet (it includes heading levels 1–${depth}).`;
  const top = Math.min(...headings.map((heading) => heading.level));
  const lines = headings.map((heading) => {
    const page = starts ? pageFromStarts(starts, heading.pos) : null;
    const indent = "  ".repeat(Math.max(0, heading.level - top));
    return `${indent}${heading.text}${page != null ? `\t${page}` : ""}`;
  });
  const measured = starts
    ? "Page numbers are the pages those headings fall on in the editor."
    : "Page numbers appear in the editor, and in the PDF, once the document is laid out.";
  return `Table of contents, heading levels 1–${depth} (${headings.length} ${headings.length === 1 ? "entry" : "entries"}):\n${lines.join("\n")}\n${measured}`;
}
