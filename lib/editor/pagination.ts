import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey, type EditorState } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { TableMap } from "prosemirror-tables";
import { syncDomSelection } from "@/lib/editor/domSync";
import { headerRowCount } from "@/lib/editor/tables";

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

/** A break inside a table is a row, so the spacer stays in the table. `headerHTML` is the header repeated on the next page. */
type RowGap = { columns: number; headerHeight: number; headerHTML: string };
type Break = { pos: number; height: number; inline: boolean; rowGap?: RowGap };

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

type Unit =
  | { top: number; bottom: number; kind: "line"; block: PMNode; blockPos: number }
  | { top: number; bottom: number; kind: "box"; pos: number; forceBreakAfter?: boolean }
  | { top: number; bottom: number; kind: "row"; pos: number; tablePos: number; rowIndex: number; headerRows: number; headerHeight: number; headerHTML: string; columns: number };

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
      Decoration.widget(item.pos, () => (item.rowGap ? tableGap(item) : spacer(item.height, item.inline)), {
        side: -1,
        key: `gap-${item.pos}-${Math.round(item.height)}-${item.rowGap ? hashText(item.rowGap.headerHTML) : 0}`,
        ignoreSelection: true,
        marks: [],
      }),
    ),
  );
}

function hashText(text: string) {
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) hash = (hash * 33 + text.charCodeAt(i)) | 0;
  return hash;
}

/**
 * The page break has to be a table row. A div between rows is moved out of the
 * table by the browser, and the header is drawn again at the bottom of the gap
 * so it sits at the top of the next page, above the row that follows.
 */
function tableGap(item: Break) {
  const gap = item.rowGap!;
  const tr = document.createElement("tr");
  tr.className = "page-gap table-page-break";
  tr.contentEditable = "false";
  tr.style.height = `${item.height}px`;
  tr.setAttribute("data-height", String(item.height));
  tr.setAttribute("aria-hidden", "true");
  const td = document.createElement("td");
  td.colSpan = Math.max(1, gap.columns);
  td.style.cssText = `height:${item.height}px;padding:0;border:none;background:transparent;vertical-align:bottom`;
  if (gap.headerHTML && gap.headerHeight > 0) {
    const space = document.createElement("div");
    space.style.height = `${Math.max(0, item.height - gap.headerHeight)}px`;
    const table = document.createElement("table");
    table.className = "repeated-header";
    table.innerHTML = `<tbody>${gap.headerHTML}</tbody>`;
    td.append(space, table);
  }
  tr.append(td);
  return tr;
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

/** Where each page after the first starts, as document positions. */
export function pageStarts(state: EditorState) {
  return dedupe(pageKey.getState(state)?.breaks ?? []).map((item) => item.pos);
}

function sameBreaks(a: Break[], b: Break[]) {
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    const other = b[i]!;
    return item.pos === other.pos && Math.abs(item.height - other.height) < 1 && item.inline === other.inline && (item.rowGap?.headerHTML ?? "") === (other.rowGap?.headerHTML ?? "") && Math.abs((item.rowGap?.headerHeight ?? 0) - (other.rowGap?.headerHeight ?? 0)) < 1;
  });
}

const TEXTBLOCKS = new Set(["paragraph", "heading", "title", "subtitle", "code_block", "toc_title"]);
const CONTAINERS = new Set(["bullet_list", "ordered_list", "list_item", "blockquote", "toc"]);

/**
 * A textblock's lines relative to its own top, kept per node. Reading line
 * boxes (Range.getClientRects) is the costly part of a layout pass; a block an
 * edit didn't touch is the same node object afterwards, so only blocks that
 * changed are read again. An entry is used only while the block is still the
 * same width and height, which catches decorations or fonts that rewrap it.
 */
type LineCache = { width: number; height: number; lines: Array<{ top: number; bottom: number }> };
const lineCache = new WeakMap<PMNode, LineCache>();

/** Rows are separate so a long table breaks between them and can repeat its header. */
function collectRows(view: EditorView, node: PMNode, pos: number, dom: HTMLElement, units: Unit[], natural: (y: number) => number, toLocal: (y: number) => number, scale: number) {
  const headers = headerRowCount(node);
  let columns = 1;
  try {
    columns = TableMap.get(node).width;
  } catch {
    columns = 1;
  }
  const tableEl = dom.tagName === "TABLE" ? dom : (dom.querySelector("table") ?? dom);
  const pending: Array<{ top: number; bottom: number; pos: number; index: number }> = [];
  let headerHeight = 0;
  node.forEach((row, offset, index) => {
    const rowPos = pos + 1 + offset;
    const rowDom = view.nodeDOM(rowPos);
    const measured = rowDom instanceof HTMLElement && rowDom.tagName === "TR" ? rowDom : null;
    if (!measured) return;
    const rect = measured.getBoundingClientRect();
    const top = natural(toLocal(rect.top));
    const bottom = natural(toLocal(rect.bottom));
    if (index < headers) headerHeight += Math.max(0, bottom - top);
    pending.push({ top, bottom, pos: rowPos, index });
  });
  const headerHTML = headers > 0 ? repeatedHeaderHTML(node, tableEl, headers, scale) : "";
  for (const row of pending) {
    units.push({ kind: "row", top: row.top, bottom: row.bottom, pos: row.pos, tablePos: pos, rowIndex: row.index, headerRows: headers, headerHeight, headerHTML, columns });
  }
}

function repeatedHeaderHTML(table: PMNode, tableEl: HTMLElement, headerRows: number, scale: number) {
  const trs = Array.from(tableEl.querySelectorAll(":scope > tbody > tr, :scope > tr")).filter((el) => !el.classList.contains("page-gap"));
  const parts: string[] = [];
  for (let i = 0; i < headerRows && i < table.childCount; i += 1) {
    const row = table.child(i);
    const tr = trs[i] as HTMLTableRowElement | undefined;
    const cells: string[] = [];
    row.forEach((cell, _offset, column) => {
      const td = tr?.cells[column];
      const width = td ? td.getBoundingClientRect().width / (scale || 1) : 0;
      const bg = safeCssColor(typeof cell.attrs.background === "string" ? cell.attrs.background : null);
      const span = Number(cell.attrs.colspan) || 1;
      const style = [`border:1px solid #c4c7c5`, `padding:5px 7px`, `font-weight:700`, `vertical-align:top`, width ? `width:${Math.round(width)}px` : "", bg ? `background:${bg}` : "background:rgba(0,0,0,0.03)"].filter(Boolean).join(";");
      cells.push(`<td colspan="${span}" style="${style}">${escapeHtml(cell.textContent)}</td>`);
    });
    parts.push(`<tr>${cells.join("")}</tr>`);
  }
  return parts.join("");
}

function safeCssColor(value: string | null) {
  if (!value) return null;
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value) || /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+/i.test(value) ? value : null;
}

function escapeHtml(text: string) {
  return text.replace(/[&<>]/g, (char) => (char === "&" ? "&amp;" : char === "<" ? "&lt;" : "&gt;"));
}

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
    if (node.type.name === "table") {
      collectRows(view, node, pos, dom, units, natural, toLocal, scale);
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
    // A page break fits wherever it falls: pushed onto the next page by the content before it, it would
    // break again there and leave that page blank.
    const pageBreak = unit.kind === "box" && unit.forceBreakAfter;
    if (forceNext || (bottom > pageEnd + FIT_SLACK && !firstOnPage && !pageBreak)) {
      // Start this unit at the top of the next page that it reaches.
      let target = page + 1;
      while (!forceNext && top > target * pitch + contentHeight) target += 1;
      // After a page break, a block keeps the space it asks for above it (as Word does after a manual break);
      // after a page simply filling up, it starts at the top.
      const above = forceNext && unit.kind === "line" && Number(unit.block.attrs.spaceBefore) > 0 ? (Number(unit.block.attrs.spaceBefore) * 96) / 72 : 0;
      // A header row is drawn again at the top of the next page, and the row that didn't fit starts under it.
      const repeat = unit.kind === "row" && unit.rowIndex > 0 && unit.headerRows > 0 && unit.rowIndex >= unit.headerRows && unit.headerHeight > 0 && unit.headerHeight < contentHeight * 0.6;
      const extra = repeat ? unit.headerHeight : 0;
      const height = target * pitch - top + above + extra;
      if (height > 0) {
        let pos: number | null = unit.kind === "line" ? lineStart(view, unit.block, unit.blockPos, unit.top, toLocal, natural) : unit.kind === "row" && unit.rowIndex === 0 ? unit.tablePos : unit.pos;
        let inline = unit.kind === "line";
        // A block's first line moves the whole block: a spacer inside it would leave what comes before its
        // text (a list marker, a first-line indent) as a line of its own above the spacer.
        if (unit.kind === "line" && pos === unit.blockPos + 1) {
          pos = blockStart(view.state.doc, unit.blockPos);
          inline = false;
        }
        const rowGap = unit.kind === "row" && unit.rowIndex > 0 ? { columns: unit.columns, headerHeight: repeat ? unit.headerHeight : 0, headerHTML: repeat ? unit.headerHTML : "" } : undefined;
        if (pos != null) {
          breaks.push({ pos, height, inline, ...(rowGap ? { rowGap } : {}) });
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
