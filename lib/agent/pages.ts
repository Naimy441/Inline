import type { Node as PMNode } from "prosemirror-model";
import { blockLines, docWordCount, textblockLines } from "@/lib/doc/editing";
import { serializeDoc } from "@/lib/doc/markdown";
import { croppedFrame, cssPx, pictureCrop } from "@/lib/doc/picture";
import { layoutKey, pageSize, type DocumentSettings } from "@/lib/doc/settings";
import type { ClientLayout, LiveDocument } from "@/lib/server/hub";

/**
 * Page counts for Claude. Pages are laid out by the user's editor (fonts,
 * images and spacing all matter), which reports where each page starts; the
 * server only knows the text. So a count is measured when an editor has
 * reported the current version, and estimated otherwise.
 */

export type PageCount = {
  pages: number;
  /** True when it comes from the user's editor for the current text; false for an estimate. */
  measured: boolean;
  /** How full the last page is, 0-1 (measured only). */
  lastPageFill?: number;
  /** Words on a full page with this document's formatting (measured or estimated). */
  wordsPerPage: number;
  /** Where pages 2, 3, … start (measured only). */
  starts?: number[];
  /**
   * Pages the editor shows right now, when that differs from `pages` because
   * deleted text awaiting review is still showing struck through. `pages` and
   * the rest describe the document once the pending changes are kept.
   */
  showing?: number;
};

/** Rough words on a full page of plain paragraphs, from the page setup and default font. */
export function wordsPerPageFromSettings(settings: DocumentSettings) {
  const { width, height } = pageSize(settings.pageSetup);
  const margins = settings.pageSetup.margins;
  const contentWidth = Math.max(1, width - margins.left - margins.right) * 72;
  const contentHeight = Math.max(1, height - margins.top - margins.bottom) * 72;
  const fontSize = settings.fontSize || 11;
  const lineHeight = fontSize * (settings.lineSpacing || 1.15);
  // About 0.5em per character and six characters per word with its space;
  // paragraph breaks and short last lines take roughly a fifth of a page.
  const wordsPerLine = contentWidth / (fontSize * 0.5 * 6);
  const lines = contentHeight / lineHeight;
  return Math.max(50, Math.round(wordsPerLine * lines * 0.8));
}

function fullPages(layout: { pages: number; lastPageFill: number }) {
  return layout.pages - 1 + layout.lastPageFill;
}

/** Page count without waiting: measured if the editor's last report is current, else estimated. */
export function pageCountNow(doc: LiveDocument): PageCount {
  return pageCountFrom(doc, doc.layoutIsCurrent() ? doc.layout : null);
}

/** Page count, waiting briefly for an open editor to measure the latest change. */
export async function pageCount(doc: LiveDocument): Promise<PageCount> {
  return pageCountFrom(doc, await doc.currentLayout());
}

/**
 * Counts describe the document as it will be once pending changes are kept:
 * the word count already leaves out deleted text, so the page count must too,
 * or cutting text appears not to shorten it (the struck-out words stay on the
 * page until the user reviews them).
 */
function pageCountFrom(doc: LiveDocument, layout: ClientLayout | null): PageCount {
  const words = docWordCount(doc.doc);
  const earlier = doc.layout && doc.layout.settings === layoutKey(doc.meta.settings) ? doc.layout : null;
  // A layout measured for earlier text still says how many words this formatting fits on a page.
  const measuredRate = (sample: ClientLayout | null) => {
    const fall = sample ? (sample.kept ?? sample) : null;
    return sample && fall && sample.words >= 150 && fullPages(fall) >= 0.5 ? Math.round(sample.words / fullPages(fall)) : null;
  };
  if (layout) {
    const fall = layout.kept ?? layout;
    return {
      pages: fall.pages,
      measured: true,
      lastPageFill: fall.lastPageFill,
      wordsPerPage: measuredRate(layout) ?? wordsPerPageFromSettings(doc.meta.settings),
      starts: fall.starts,
      ...(layout.kept && layout.kept.pages !== layout.pages ? { showing: layout.pages } : {}),
    };
  }
  const wordsPerPage = measuredRate(earlier) ?? wordsPerPageFromSettings(doc.meta.settings);
  const breaks = doc.doc.content.content.filter((node) => node.type.name === "page_break").length;
  return { pages: Math.max(1, Math.ceil(words / wordsPerPage), breaks + 1), measured: false, wordsPerPage };
}

/** How full a 1-based page range is, from the layout get_page_count already uses. */
export function describePageRange(count: PageCount, fromPage: number, toPage: number) {
  const span = fromPage === toPage ? `Page ${fromPage}` : `Pages ${fromPage}–${toPage}`;
  if (!count.measured) return `${span} can't be measured until an editor has the document open.`;
  const total = count.pages;
  if (fromPage > total) return `The document is ${total} page${total === 1 ? "" : "s"}. ${span} is past the end.`;
  const end = Math.min(toPage, total);
  const shown = fromPage === end ? `Page ${fromPage}` : `Pages ${fromPage}–${end}`;
  const includesLast = end === total;
  const fill = includesLast ? end - fromPage + (count.lastPageFill ?? 1) : end - fromPage + 1;
  if (fromPage === end) return `${shown} is ${Math.round(fill * 100)}% full.`;
  const rounded = Math.round(fill * 100) / 100;
  return `${shown} fill ${rounded} page${rounded === 1 ? "" : "s"}.`;
}

/** "Page 2 starts on line 18, mid-paragraph: “…the committee…”" for each measured page start. */
export function describePageStarts(doc: LiveDocument, starts: number[]) {
  const serialized = serializeDoc(doc.doc);
  const textblocks = textblockLines(serialized);
  const blocks = blockLines(serialized);
  return starts.map((pos, index) => {
    const page = index + 2;
    const entry = textblocks.find((item) => pos >= item.pos && pos < item.pos + item.node.nodeSize);
    if (entry) {
      const offset = pos - entry.pos - 1;
      const mid = offset > 0;
      const words = entry.node.textBetween(Math.max(0, offset), entry.node.content.size, " ", " ").trim().split(/\s+/).slice(0, 8).join(" ");
      return `Page ${page} starts on line ${entry.startLine}${mid ? ", mid-paragraph" : ""}${words ? `: “${mid ? "…" : ""}${words}…”` : ""}`;
    }
    const block = blocks.find((item) => pos >= item.block.pos && pos < item.block.pos + item.block.node.nodeSize);
    return block ? `Page ${page} starts on line ${block.startLine} (${block.block.node.type.name.replace(/_/g, " ")})` : `Page ${page} starts near the end of the document`;
  });
}

const PX_PER_IN = 96;

export type ImageNaturalSize = { width: number; height: number };

/**
 * Each picture's height and the room left on its page. Height comes from the
 * height attribute, or from the file's aspect ratio fitted to the width.
 * Page breaks follow a measured layout when one was reported; otherwise the
 * height is estimated from the page size and the text above the picture.
 */
export function describeImages(doc: PMNode, settings: DocumentSettings, natural: ReadonlyMap<string, ImageNaturalSize>, starts?: readonly number[]): string[] {
  const paper = pageSize(settings.pageSetup);
  const margins = settings.pageSetup.margins;
  const contentWidth = Math.max(1, (paper.width - margins.left - margins.right) * PX_PER_IN);
  const contentHeight = Math.max(1, (paper.height - margins.top - margins.bottom) * PX_PER_IN);
  const fontPx = ((settings.fontSize || 11) * PX_PER_IN) / 72;
  const lineHeight = fontPx * (settings.lineSpacing || 1.15);
  const gap = ((settings.paragraphSpacing || 0) * PX_PER_IN) / 72;
  const lines = blockLines(serializeDoc(doc));
  const measured = Boolean(starts?.length);
  const pageStarts = starts ?? [];
  const linesOut: string[] = [];
  let y = 0;
  let page = 1;
  let startCursor = 0;

  const picturesIn = (node: PMNode) => {
    const found: PMNode[] = [];
    if (node.type.name === "image" || node.type.name === "inline_image") found.push(node);
    else node.descendants((child) => {
      if (child.type.name === "image" || child.type.name === "inline_image") found.push(child);
    });
    return found;
  };

  doc.forEach((node, pos) => {
    while (startCursor < pageStarts.length && pos >= pageStarts[startCursor]!) {
      page += 1;
      y = 0;
      startCursor += 1;
    }
    if (!measured && y >= contentHeight) {
      page += Math.floor(y / contentHeight);
      y %= contentHeight;
    }
    if (node.type.name === "page_break") {
      page += 1;
      y = 0;
      return;
    }
    const entry = lines.find((item) => item.block.pos === pos);
    const line = entry?.startLine ?? 1;
    const pictures = picturesIn(node);
    for (const picture of pictures) linesOut.push(imageLine(picture, line, page, y, contentWidth, contentHeight, natural));
    if (node.type.name === "image") {
      const height = imageMetrics(node, contentWidth, natural).height;
      y += height ?? lineHeight;
      return;
    }
    const text = node.textContent || " ";
    const charsPerLine = Math.max(10, contentWidth / (fontPx * 0.5));
    const textLines = Math.max(1, Math.ceil(text.length / charsPerLine));
    y += textLines * lineHeight + gap;
  });
  return linesOut;
}

function imageMetrics(node: PMNode, contentWidth: number, natural: ReadonlyMap<string, ImageNaturalSize>) {
  const widthToken = node.attrs.width != null && String(node.attrs.width) !== "" ? String(node.attrs.width) : null;
  const heightToken = node.attrs.height != null && String(node.attrs.height) !== "" ? String(node.attrs.height) : null;
  const file = natural.get(String(node.attrs.src ?? ""));
  const displayWidth = cssPx(widthToken, contentWidth, file?.width ?? 0);
  let height: number | null = null;
  if (heightToken && !heightToken.endsWith("%")) {
    const parsed = Number.parseFloat(heightToken);
    if (parsed > 0) height = parsed;
  }
  if (height == null && file && file.width > 0 && file.height > 0) {
    height = croppedFrame(displayWidth, file.width, file.height, pictureCrop(node.attrs.crop)).frameHeight;
  }
  const wide = widthToken ?? `${Math.round(displayWidth)}px`;
  return { height, wide };
}

function imageLine(node: PMNode, line: number, page: number, y: number, contentWidth: number, contentHeight: number, natural: ReadonlyMap<string, ImageNaturalSize>) {
  const alt = String(node.attrs.alt || "image");
  const { height, wide } = imageMetrics(node, contentWidth, natural);
  const where = `Image "${alt}" (line ${line}, page ${page})`;
  if (height == null) return `${where} has no known height (${wide} wide).`;
  const tall = Math.round(height);
  const space = Math.round(contentHeight - y - height);
  if (space < 0) return `${where} is ${tall}px tall (${wide} wide); 0px is left on that page and it runs ${Math.abs(space)}px past the bottom.`;
  return `${where} is ${tall}px tall (${wide} wide); ${space}px is left on that page.`;
}
