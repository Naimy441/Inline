import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";

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

export function paginationPlugin(geometry: () => PageGeometry, onLayout?: (pages: number) => void) {
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
          const result = measure(view, geometry());
          if (!result) return;
          const current = pageKey.getState(view.state)!;
          if (sameBreaks(current.breaks, result.breaks) && current.pages === result.pages) {
            settle = 0;
            return;
          }
          // Guard against layout oscillation (e.g. a font still loading).
          if (settle > 4) return;
          settle += 1;
          view.dispatch(view.state.tr.setMeta(pageKey, result).setMeta("addToHistory", false));
          onLayout?.(result.pages);
        });
      };
      const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => schedule()) : null;
      observer?.observe(view.dom);
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

function measure(view: EditorView, geometry: PageGeometry): { breaks: Break[]; pages: number } | null {
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
      if (!lines.length) {
        const rect = dom.getBoundingClientRect();
        lines.push({ top: toLocal(rect.top), bottom: toLocal(rect.bottom) });
      }
      lines.sort((a, b) => a.top - b.top);
      for (const line of lines) units.push({ kind: "line", top: natural(line.top), bottom: natural(line.bottom), block: node, blockPos: pos });
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

  for (const unit of units) {
    const top = unit.top + shift;
    const bottom = unit.bottom + shift;
    const pageStart = page * pitch;
    const pageEnd = pageStart + contentHeight;
    if (forceNext || (bottom > pageEnd + 0.5 && !firstOnPage)) {
      // Start this unit at the top of the next page that it reaches.
      let target = page + 1;
      while (!forceNext && top > target * pitch + contentHeight) target += 1;
      const height = target * pitch - top;
      if (height > 0) {
        const pos = unit.kind === "line" ? lineStart(view, unit.block, unit.blockPos, unit.top, toLocal, natural) : unit.pos;
        if (pos != null) {
          breaks.push({ pos, height, inline: unit.kind === "line" });
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
  }
  if (forceNext) page += 1;
  return { breaks: dedupe(breaks), pages: page + 1 };
}

function dedupe(breaks: Break[]) {
  const seen = new Set<number>();
  return breaks.filter((item) => (seen.has(item.pos) ? false : (seen.add(item.pos), true)));
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
