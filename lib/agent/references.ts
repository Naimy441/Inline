import type { Node as PMNode } from "prosemirror-model";
import { wordCount } from "@/lib/doc/editing";
import { docToMarkdown, serializeDoc } from "@/lib/doc/markdown";
import type { DocumentSettings } from "@/lib/doc/settings";
import { wordsPerPageFromSettings } from "@/lib/agent/pages";
import { formatPageList, type LinkedDocument } from "@/lib/agent/types";
import type { LiveDocument } from "@/lib/server/hub";

/**
 * Pages of a document, in the order the editor shows them.
 * A layout the editor measured for the current text wins. Otherwise a page
 * break starts a new page, and a stretch of text longer than one page is
 * split by how many words fit.
 */

export type DocumentPage = {
  number: number;
  markdown: string;
  words: number;
  preview: string;
};

export type DocumentPages = {
  /** True when the pages come from the editor's layout, false when they are inferred. */
  measured: boolean;
  pages: DocumentPage[];
};

type Range = { from: number; to: number };

const LINK_CHAR_LIMIT = 200_000;

function previewOf(markdown: string) {
  const flat = markdown.replace(/\s+/g, " ").trim();
  if (!flat) return "Empty page";
  return flat.length > 140 ? `${flat.slice(0, 139).trimEnd()}…` : flat;
}

function plainTitle(title: string) {
  return title.replace(/\s+/g, " ").trim() || "Untitled";
}

function capText(text: string, max: number) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n[The rest was cut for length. Read the whole document with read_document if you need it.]`;
}

/** Markdown of the blocks that fall in [from, to), cutting a block the boundary splits. */
function pageContent(doc: PMNode, from: number, to: number) {
  if (to <= from) return "";
  const parts: string[] = [];
  for (const block of serializeDoc(doc).blocks) {
    const start = block.pos;
    const end = start + block.node.nodeSize;
    if (end <= from || start >= to || block.node.type.name === "page_break") continue;
    if (start >= from && end <= to) {
      parts.push(block.markdown);
      continue;
    }
    const text = doc.textBetween(Math.max(from, start), Math.min(to, end), "\n", (node) => (node.type.name === "hard_break" ? "\n" : "")).trim();
    if (text) parts.push(text);
  }
  return parts.join("\n\n").trim();
}

function rangesFromBounds(points: number[], size: number): Range[] {
  const bounds = [0];
  for (const pos of points) {
    if (pos > bounds[bounds.length - 1]! && pos < size) bounds.push(pos);
  }
  if (bounds[bounds.length - 1] !== size) bounds.push(size);
  const ranges: Range[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) ranges.push({ from: bounds[i]!, to: bounds[i + 1]! });
  return ranges.length ? ranges : [{ from: 0, to: size }];
}

/** Ranges split by explicit page breaks, or null when the document has none. */
function pageBreakSegments(doc: PMNode): Range[] | null {
  const breaks: Range[] = [];
  doc.forEach((node, pos) => {
    if (node.type.name === "page_break") breaks.push({ from: pos, to: pos + node.nodeSize });
  });
  if (!breaks.length) return null;
  const segments: Range[] = [];
  let cursor = 0;
  for (const item of breaks) {
    segments.push({ from: cursor, to: item.from });
    cursor = item.to;
  }
  segments.push({ from: cursor, to: doc.content.size });
  return segments;
}

/** Split one stretch of text into pages of about `wordsPerPage` words, on block boundaries. */
function splitSegment(doc: PMNode, from: number, to: number, wordsPerPage: number): Range[] {
  const blocks: Array<Range & { words: number }> = [];
  doc.forEach((node, pos) => {
    const end = pos + node.nodeSize;
    if (end <= from || pos >= to || node.type.name === "page_break") return;
    blocks.push({ from: Math.max(pos, from), to: Math.min(end, to), words: wordCount(node.textContent) });
  });
  if (!blocks.length) return [{ from, to }];
  const ranges: Range[] = [];
  let pageFrom = blocks[0]!.from;
  let words = 0;
  let lastTo = blocks[0]!.from;
  for (const block of blocks) {
    if (words >= wordsPerPage) {
      ranges.push({ from: pageFrom, to: lastTo });
      pageFrom = block.from;
      words = 0;
    }
    words += block.words;
    lastTo = block.to;
  }
  ranges.push({ from: pageFrom, to: lastTo });
  return ranges;
}

export function pagesOf(doc: PMNode, settings: DocumentSettings, layout: { starts: number[] } | null): DocumentPages {
  const measured = layout != null;
  const ranges = measured
    ? rangesFromBounds(layout.starts, doc.content.size)
    : (pageBreakSegments(doc) ?? [{ from: 0, to: doc.content.size }]).flatMap((segment) => splitSegment(doc, segment.from, segment.to, wordsPerPageFromSettings(settings)));
  return {
    measured,
    pages: ranges.map((range, index) => {
      const markdown = pageContent(doc, range.from, range.to);
      return { number: index + 1, markdown, words: wordCount(markdown), preview: previewOf(markdown) };
    }),
  };
}

export function documentPages(doc: LiveDocument): DocumentPages {
  const layout = doc.layoutIsCurrent() && doc.layout ? { starts: doc.layout.starts } : null;
  return pagesOf(doc.doc, doc.meta.settings, layout);
}

/**
 * The text added to a turn's context for one linked document: the pages the
 * user chose, or the whole document, depending on the purpose they set.
 */
export function linkedDocumentContext(
  source: { id: string; title: string; doc: PMNode; settings: DocumentSettings; layout: { starts: number[] } | null } | null,
  link: LinkedDocument,
) {
  const title = plainTitle(source?.title || link.title);
  if (!source) return `The linked document "${title}" is no longer available.`;
  if (link.purpose === "voice") {
    const { pages, measured } = pagesOf(source.doc, source.settings, source.layout);
    const wanted = [...new Set(link.pages ?? [])].filter((n) => Number.isInteger(n) && n >= 1).sort((a, b) => a - b);
    const chosen = pages.filter((page) => wanted.includes(page.number));
    if (!chosen.length) {
      return `The user linked "${title}" (id ${source.id}) as a writing sample, but none of the selected pages are in it (it has ${pages.length} page${pages.length === 1 ? "" : "s"}).`;
    }
    const missing = wanted.filter((n) => !pages.some((page) => page.number === n));
    const body = chosen.map((page) => `Page ${page.number}\n${page.markdown || "(This page has no text.)"}`).join("\n\n");
    const estimate = measured ? "" : " Page numbers follow page breaks, and any page without one is estimated from length.";
    const missingNote = missing.length ? ` Pages ${formatPageList(missing)} are no longer in the document.` : "";
    return `Writing sample from "${title}" (id ${source.id}), page ${formatPageList(chosen.map((page) => page.number))}.${estimate} Match this voice. Do not copy the sample's facts or subject unless the user asks.${missingNote}\n<writing-sample>\n${capText(body, LINK_CHAR_LIMIT)}\n</writing-sample>`;
  }
  return `Context document "${title}" (id ${source.id}). The whole document is included because its information is relevant. Use it as background. Do not treat it as a voice to imitate unless the user asks.\n<linked-document>\n${capText(docToMarkdown(source.doc), LINK_CHAR_LIMIT)}\n</linked-document>`;
}
