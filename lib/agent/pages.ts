import { blockLines, docWordCount, textblockLines } from "@/lib/doc/editing";
import { serializeDoc } from "@/lib/doc/markdown";
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
