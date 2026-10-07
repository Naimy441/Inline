import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { syncDomSelection } from "@/lib/editor/domSync";

/**
 * Page layout for a single continuous ProseMirror document.
 *
 * The editor renders as one flow; this plugin measures where each line falls
 * and inserts spacer widgets so content that would cross a page's bottom
 * margin starts at the top of the next page. Pages themselves (paper, header,
 * footer, numbers) are drawn behind the editor by the React page stack, using
 * the page count this plugin reports.
 *
 * Measurement works in "natural" coordinates (the layout with every spacer
 * removed), so inserting spacers never feeds back into where they go.
 */

export type PageGeometry = {
  /** All values in CSS px at 100% zoom. */
  pageHeight: number;
  marginTop: number;
  marginBottom: number;
  gap: number;
};

type Break = { pos: number; height: number; inline: boolean };

/**
 * How far (px) a line may end past the bottom margin and stay on its page.
 * Browsers measure the same text a pixel apart (Firefox rounds line boxes
 * differently from Chrome), so a page that just fits in one would spill a line
 * in another. A couple of px stays well inside even a tenth-inch margin.
 */
const FIT_SLACK = 2;

/** What a layout pass found: the page count, where each page after the first starts, and how full the last page is (0-1). */
export type PageLayout = {
  pages: number;
  starts: number[];
  lastPageFill: number;
  /** The same once pending changes are kept, when struck-out deleted text is showing (it takes space until then). */
  kept?: { pages: number; starts: number[]; lastPageFill: number };
};
type PageState = { breaks: Break[]; pages: number; decorations: DecorationSet; epoch: number };

export const pageKey = new PluginKey<PageState>("pagination");

type Unit = { top: number; bottom: number; kind: "line"; block: PMNode; blockPos: number } | { top: number; bottom: number; kind: "box"; pos: number; forceBreakAfter?: boolean };

function spacer(height: number, inline: boolean) {
  const el = document.createElement(inline ? "span" : "div");
  el.className = "page-gap";
  el.contentEditable = "false";
  el.style.height = `${height}px`;
  el.setAttribute("data-height", String(height));
  el.setAttribute("aria-hidden", "true");
  return el;
}

function decorate(doc: PMNode, breaks: Break[]) {
  return DecorationSet.create(
    doc,
    breaks.map((item) =>
      Decoration.widget(item.pos, () => spacer(item.height, item.inline), {
        side: -1,
        key: `gap-${item.pos}-${Math.round(item.height)}`,
        ignoreSelection: true,
        marks: [],
      }),
    ),
  );
}

export function paginationPlugin(geometry: () => PageGeometry, onLayout?: (layout: PageLayout) => void) {
  return new Plugin<PageState>({
    key: pageKey,
    state: {
      init: () => ({ breaks: [], pages: 1, decorations: DecorationSet.empty, epoch: 0 }),
      apply(tr, value) {
        const meta = tr.getMeta(pageKey) as { breaks: Break[]; pages: number; reset?: boolean } | undefined;
        if (meta) return { breaks: meta.breaks, pages: meta.pages, decorations: decorate(tr.doc, meta.breaks), epoch: value.epoch + (meta.reset ? 1 : 0) };
        if (!tr.docChanged) return value;
        // Keep spacers roughly in place until the next measurement.
        const breaks = value.breaks.map((item) => ({ ...item, pos: tr.mapping.map(item.pos, -1) }));
        return { ...value, breaks, decorations: value.decorations.map(tr.mapping, tr.doc) };
      },
    },
    props: {
      decorations: (state) => pageKey.getState(state)?.decorations,
    },
    view(view) {
      let frame = 0;
      let settle = 0;
      const schedule = () => {
        if (frame) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          syncDomSelection(view);
          const result = measure(view, geometry());
          if (!result) return;
          const current = pageKey.getState(view.state)!;
          const report = () => {
            if (!onLayout) return;
            const kept = measureKept(view, geometry());
            onLayout({ pages: result.pages, starts: result.breaks.map((item) => item.pos), lastPageFill: result.lastPageFill, ...(kept ? { kept } : {}) });
          };
          if (sameBreaks(current.breaks, result.breaks) && current.pages === result.pages) {
            settle = 0;
            report();
            return;
          }
          // Guard against layout oscillation (e.g. a font still loading).
          if (settle > 4) return;
          settle += 1;
          view.dispatch(view.state.tr.setMeta(pageKey, result).setMeta("addToHistory", false));
          report();
        });
      };
      // Watch every top-level block, not only the editor: the editor's min-height
      // fills the pages, so it keeps its size when content shrinks without a doc
      // change (accepting a change removes its struck-out text, which is a widget).
      const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => schedule()) : null;
      const watched = new Set<Element>();
      const watchBlocks = () => {
        if (!observer) return;
        for (const element of watched) {
          if (element.parentNode !== view.dom) {
            observer.unobserve(element);
            watched.delete(element);
          }
        }
        for (const element of Array.from(view.dom.children)) {
          if (watched.has(element) || element.classList.contains("page-gap")) continue;
          observer.observe(element);
          watched.add(element);
        }
      };
      const children = typeof MutationObserver !== "undefined" ? new MutationObserver(watchBlocks) : null;
      observer?.observe(view.dom);
      children?.observe(view.dom, { childList: true });
      watchBlocks();
      document.fonts?.ready.then(() => schedule()).catch(() => undefined);
      schedule();
      return {
        update(updated, previous) {
          if (updated.state.doc !== previous.doc || pageKey.getState(updated.state) !== pageKey.getState(previous)) {
            if (updated.state.doc !== previous.doc || pageKey.getState(updated.state)!.epoch !== pageKey.getState(previous)!.epoch) settle = 0;
            schedule();
          }
        },
        destroy() {
          if (frame) cancelAnimationFrame(frame);
          observer?.disconnect();
          children?.disconnect();
        },
      };
    },
  });
}

/** Re-measure after geometry changes (page size, margins, zoom). */
export function relayout(view: EditorView) {
  view.dispatch(view.state.tr.setMeta(pageKey, { breaks: [], pages: pageKey.getState(view.state)?.pages ?? 1, reset: true }).setMeta("addToHistory", false));
}

export function pageCount(state: EditorState) {
  return pageKey.getState(state)?.pages ?? 1;
}

function sameBreaks(a: Break[], b: Break[]) {
  if (a.length !== b.length) return false;
  return a.every((item, i) => item.pos === b[i]!.pos && Math.abs(item.height - b[i]!.height) < 1 && item.inline === b[i]!.inline);
}

const TEXTBLOCKS = new Set(["paragraph", "heading", "title", "subtitle", "code_block"]);
const CONTAINERS = new Set(["bullet_list", "ordered_list", "list_item", "blockquote"]);

/**
 * A textblock's lines relative to its own top, kept per node. Reading line
 * boxes (Range.getClientRects) is the costly part of a layout pass; a block an
 * edit didn't touch is the same node object afterwards, so only blocks that
 * changed are read again. An entry is used only while the block is still the
 * same width and height, which catches decorations or fonts that rewrap it.
 */
type LineCache = { width: number; height: number; lines: Array<{ top: number; bottom: number }> };
const lineCache = new WeakMap<PMNode, LineCache>();

function measure(view: EditorView, geometry: PageGeometry, keepCache = true): { breaks: Break[]; pages: number; lastPageFill: number } | null {
  const root = view.dom as HTMLElement;
  if (!root.isConnected || !root.offsetWidth) return null;
  const rootRect = root.getBoundingClientRect();
  const scale = rootRect.width / root.offsetWidth || 1;
  const toLocal = (y: number) => (y - rootRect.top) / scale;

  const gaps = Array.from(root.querySelectorAll<HTMLElement>(".page-gap")).map((el) => {
    const rect = el.getBoundingClientRect();
    return { top: toLocal(rect.top), height: Number(el.getAttribute("data-height")) || rect.height / scale };
  });
  gaps.sort((a, b) => a.top - b.top);
  const natural = (y: number) => {
    let shift = 0;
    for (const gap of gaps) {
      if (gap.top < y - 0.5) shift += gap.height;
      else break;
    }
    return y - shift;
  };
  const insideGap = (top: number, bottom: number) => gaps.some((gap) => top >= gap.top - 0.5 && bottom <= gap.top + gap.height + 0.5);

  const units: Unit[] = [];
  const collect = (node: PMNode, pos: number) => {
    const dom = view.nodeDOM(pos) as HTMLElement | null;
    if (!dom || !(dom instanceof HTMLElement)) return;
    if (TEXTBLOCKS.has(node.type.name)) {
      const box = dom.getBoundingClientRect();
      const blockTop = natural(toLocal(box.top));
      const blockHeight = natural(toLocal(box.bottom)) - blockTop;
      const width = box.width;
      const cached = lineCache.get(node);
      if (cached && Math.abs(cached.width - width) < 0.5 && Math.abs(cached.height - blockHeight) < 0.5) {
        for (const line of cached.lines) units.push({ kind: "line", top: blockTop + line.top, bottom: blockTop + line.bottom, block: node, blockPos: pos });
        return;
      }
      const range = document.createRange();
      range.selectNodeContents(dom);
      const lines: Array<{ top: number; bottom: number }> = [];
      for (const rect of Array.from(range.getClientRects())) {
        if (!rect.height) continue;
        const top = toLocal(rect.top);
        const bottom = toLocal(rect.bottom);
        if (insideGap(top, bottom)) continue;
        const line = lines.find((item) => top < item.bottom - 2 && bottom > item.top + 2);
        if (line) {
          line.top = Math.min(line.top, top);
          line.bottom = Math.max(line.bottom, bottom);
        } else {
          lines.push({ top, bottom });
        }
      }
      if (!lines.length) lines.push({ top: toLocal(box.top), bottom: toLocal(box.bottom) });
      lines.sort((a, b) => a.top - b.top);
      const relative = lines.map((line) => ({ top: natural(line.top) - blockTop, bottom: natural(line.bottom) - blockTop }));
      if (keepCache) lineCache.set(node, { width, height: blockHeight, lines: relative });
      for (const line of relative) units.push({ kind: "line", top: blockTop + line.top, bottom: blockTop + line.bottom, block: node, blockPos: pos });
      return;
    }
    if (CONTAINERS.has(node.type.name)) {
      node.forEach((child, offset) => collect(child, pos + 1 + offset));
      return;
    }
    const rect = dom.getBoundingClientRect();
    units.push({ kind: "box", top: natural(toLocal(rect.top)), bottom: natural(toLocal(rect.bottom)), pos, forceBreakAfter: node.type.name === "page_break" });
  };
  view.state.doc.forEach((child, offset) => collect(child, offset));

  const contentHeight = geometry.pageHeight - geometry.marginTop - geometry.marginBottom;
  const pitch = geometry.pageHeight + geometry.gap;
  const breaks: Break[] = [];
  let page = 0;
  let shift = 0;
  let forceNext = false;
  let firstOnPage = true;
  let lastBottom = 0;

  for (const unit of units) {
    const top = unit.top + shift;
    const bottom = unit.bottom + shift;
    const pageStart = page * pitch;
    const pageEnd = pageStart + contentHeight;
    if (forceNext || (bottom > pageEnd + FIT_SLACK && !firstOnPage)) {
      // Start this unit at the top of the next page that it reaches.
      let target = page + 1;
      while (!forceNext && top > target * pitch + contentHeight) target += 1;
      const height = target * pitch - top;
      if (height > 0) {
        let pos = unit.kind === "line" ? lineStart(view, unit.block, unit.blockPos, unit.top, toLocal, natural) : unit.pos;
        let inline = unit.kind === "line";
        // A block's first line moves the whole block: a spacer inside it would leave what comes before its
        // text (a list marker, a first-line indent) as a line of its own above the spacer.
        if (unit.kind === "line" && pos === unit.blockPos + 1) {
          pos = blockStart(view.state.doc, unit.blockPos);
          inline = false;
        }
        if (pos != null) {
          breaks.push({ pos, height, inline });
          shift += height;
        }
      }
      page = target;
      forceNext = false;
      firstOnPage = true;
    }
    if (unit.kind === "box" && unit.forceBreakAfter) forceNext = true;
    firstOnPage = false;
    // Units taller than a page simply overflow onto the following pages.
    const end = unit.bottom + shift;
    while (end > page * pitch + contentHeight + pitch) page += 1;
    lastBottom = end;
  }
  if (forceNext) page += 1;
  const lastPageFill = forceNext || !units.length ? 0 : Math.max(0, Math.min(1, (lastBottom - page * pitch) / contentHeight));
  return { breaks: dedupe(breaks), pages: page + 1, lastPageFill };
}

/**
 * The layout as it will be once every pending change is kept: struck-out
 * deleted text hidden for one synchronous measurement, then shown again
 * before the browser paints, so nothing flickers.
 */
function measureKept(view: EditorView, geometry: PageGeometry): PageLayout["kept"] {
  const root = view.dom as HTMLElement;
  if (!root.querySelector(".review-delete")) return undefined;
  root.classList.add("measuring-kept");
  try {
    const result = measure(view, geometry, false);
    return result ? { pages: result.pages, starts: dedupe(result.breaks).map((item) => item.pos), lastPageFill: result.lastPageFill } : undefined;
  } finally {
    root.classList.remove("measuring-kept");
  }
}

function dedupe(breaks: Break[]) {
  const seen = new Set<number>();
  return breaks.filter((item) => (seen.has(item.pos) ? false : (seen.add(item.pos), true)));
}

/** Where the block at `pos` starts, before the list items and quotes it opens. */
function blockStart(doc: PMNode, pos: number) {
  let $pos = doc.resolve(pos);
  while ($pos.depth > 0 && $pos.index() === 0 && CONTAINERS.has($pos.parent.type.name)) $pos = doc.resolve($pos.before());
  return $pos.pos;
}

/**
 * Document position of the first character on the line whose natural top is
 * `lineTop`, found by binary search with coordsAtPos (which, unlike
 * posAtCoords, works for off-screen content).
 */
function lineStart(view: EditorView, block: PMNode, blockPos: number, lineTop: number, toLocal: (y: number) => number, natural: (y: number) => number) {
  const start = blockPos + 1;
  const end = blockPos + 1 + block.content.size;
  const topOf = (pos: number) => {
    try {
      return natural(toLocal(view.coordsAtPos(pos, 1).top));
    } catch {
      return Number.NEGATIVE_INFINITY;
    }
  };
  if (topOf(start) >= lineTop - 2) return start;
  let lo = start;
  let hi = end;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (topOf(mid) >= lineTop - 2) hi = mid;
    else lo = mid + 1;
  }
  return lo >= end ? null : lo;
}
