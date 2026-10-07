import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import type { TabStop } from "@/lib/doc/schema";

/**
 * Tab stops. Each tab in a paragraph is drawn as a box (document.css
 * `.doc-tab`) as wide as the way from where the tab starts to its tab stop,
 * so text after it starts at the stop (left tabs), ends at it (right tabs) or
 * centers on it, as in Word and Google Docs. Stops are the paragraph's own
 * (`tabs`, in points from the left margin), then the default stops every
 * half inch (or the document's `tabStop`).
 *
 * Where a tab starts is only known once the browser has laid the line out,
 * so after each change the tabs are measured and their widths set (like the
 * page breaks, lib/editor/pagination.ts, which run after this). Right-aligned
 * text ends at its stop not counting spaces after it, which hang past it, and
 * a stop past the right margin is taken at the margin, as Google Docs does.
 */

type TabState = { widths: Map<number, number>; decorations: DecorationSet };

export const tabsKey = new PluginKey<TabState>("tabs");

/** Positions of the tab characters in textblocks, code excepted. */
function tabPositions(doc: PMNode) {
  const positions: number[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code || !node.textContent.includes("\t")) return false;
    node.forEach((child, offset) => {
      if (!child.isText) return;
      const text = child.text ?? "";
      for (let i = text.indexOf("\t"); i >= 0; i = text.indexOf("\t", i + 1)) positions.push(pos + 1 + offset + i);
    });
    return false;
  });
  return positions;
}

function decorate(doc: PMNode, widths: Map<number, number>) {
  const positions = tabPositions(doc);
  if (!positions.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    positions.map((pos) => Decoration.inline(pos, pos + 1, { class: "doc-tab", style: `width: ${(widths.get(pos) ?? 0).toFixed(2)}px` }, { inclusiveStart: false, inclusiveEnd: false })),
  );
}

export function tabsPlugin(defaultStop: () => number) {
  return new Plugin<TabState>({
    key: tabsKey,
    state: {
      init: (_config, state) => ({ widths: new Map(), decorations: decorate(state.doc, new Map()) }),
      apply(tr, value) {
        const measured = tr.getMeta(tabsKey) as Map<number, number> | undefined;
        if (measured) return { widths: measured, decorations: decorate(tr.doc, measured) };
        if (!tr.docChanged) return value;
        // Tabs keep their widths until they are measured again.
        const widths = new Map<number, number>();
        for (const [pos, width] of value.widths) {
          const mapped = tr.mapping.mapResult(pos, 1);
          if (!mapped.deleted) widths.set(mapped.pos, width);
        }
        return { widths, decorations: decorate(tr.doc, widths) };
      },
    },
    props: {
      decorations: (state) => tabsKey.getState(state)?.decorations,
    },
    view(view) {
      let frame = 0;
      let settle = 0;
      const schedule = () => {
        if (frame || !tabsKey.getState(view.state)?.decorations.find().length) return;
        frame = requestAnimationFrame(() => {
          frame = 0;
          const widths = measure(view, defaultStop());
          if (!widths) return;
          const current = tabsKey.getState(view.state)!.widths;
          const same = widths.size === current.size && [...widths].every(([pos, width]) => Math.abs((current.get(pos) ?? -1) - width) < 0.25);
          if (same) {
            settle = 0;
            return;
          }
          // Guard against layout oscillation (a font still loading, a line that rewraps back and forth).
          if (settle > 6) return;
          settle += 1;
          view.dispatch(view.state.tr.setMeta(tabsKey, widths).setMeta("addToHistory", false));
        });
      };
      const fonts = typeof document !== "undefined" ? document.fonts : undefined;
      const onFonts = () => {
        settle = 0;
        schedule();
      };
      fonts?.addEventListener?.("loadingdone", onFonts);
      schedule();
      return {
        update(updated, previous) {
          if (updated.state.doc !== previous.doc) settle = 0;
          if (updated.state.doc !== previous.doc || tabsKey.getState(updated.state) !== tabsKey.getState(previous)) schedule();
        },
        destroy() {
          if (frame) cancelAnimationFrame(frame);
          fonts?.removeEventListener?.("loadingdone", onFonts);
        },
      };
    },
  });
}

const PX_PER_PT = 96 / 72;

/** The width each tab should be, by position, from the layout on screen; null when it can't be read. */
function measure(view: EditorView, defaultStopPt: number): Map<number, number> | null {
  const root = view.dom as HTMLElement;
  if (!root.isConnected || !root.offsetWidth) return null;
  const rootRect = root.getBoundingClientRect();
  const scale = rootRect.width / root.offsetWidth || 1;
  const local = (x: number) => (x - rootRect.left) / scale;
  const step = Math.max(1, defaultStopPt) * PX_PER_PT;
  const widths = new Map<number, number>();
  const current = tabsKey.getState(view.state)?.widths ?? new Map<number, number>();

  view.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code || !node.textContent.includes("\t")) return false;
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement)) return false;
    const positions: number[] = [];
    node.forEach((child, offset) => {
      const text = child.isText ? (child.text ?? "") : "";
      for (let i = text.indexOf("\t"); i >= 0; i = text.indexOf("\t", i + 1)) positions.push(pos + 1 + offset + i);
    });
    const spans = Array.from(dom.querySelectorAll<HTMLElement>("span.doc-tab"));
    if (spans.length !== positions.length) return false;

    const style = getComputedStyle(dom);
    const box = dom.getBoundingClientRect();
    const right = local(box.right) - (parseFloat(style.paddingRight) || 0) - (parseFloat(style.borderRightWidth) || 0);
    const left = local(box.left) + (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.borderLeftWidth) || 0);
    const hanging = (parseFloat(style.textIndent) || 0) < 0;
    const stops = ((node.attrs.tabs as TabStop[] | null) ?? []).map((tab) => ({ at: tab.pos * PX_PER_PT, align: tab.align }));
    // A hanging indent is a stop too, as in Word: a tab after a number goes to where the lines below start.
    if (hanging) stops.push({ at: left, align: "left" });
    stops.sort((a, b) => a.at - b.at);

    // How far tabs already sized on a line moved what follows them, by line.
    const moved: Array<{ middle: number; shift: number }> = [];
    spans.forEach((span, index) => {
      const rect = span.getBoundingClientRect();
      const middle = (rect.top + rect.bottom) / 2;
      const line = moved.find((item) => Math.abs(item.middle - middle) < Math.max(3, rect.height / 2));
      const start = local(rect.left) + (line?.shift ?? 0);
      const custom = stops.find((stop) => stop.at > start + 0.5);
      const stop = custom ?? { at: (Math.floor((start + 0.5) / step) + 1) * step, align: "left" as const };
      let width: number;
      if (stop.align === "left") width = stop.at - start;
      else {
        const target = Math.min(stop.at, right);
        const text = segmentWidth(span, spans[index + 1] ?? null, dom, rect, scale);
        width = stop.align === "center" ? target - start - text / 2 : target - start - text;
      }
      width = Math.max(0, Number(width.toFixed(2)));
      const before = current.get(positions[index]!) ?? rect.width / scale;
      if (line) line.shift += width - before;
      else moved.push({ middle, shift: width - before });
      widths.set(positions[index]!, width);
    });
    return false;
  });
  return widths;
}

/** How wide the text after a tab is on its line, up to the next tab, not counting spaces at its end. */
function segmentWidth(span: HTMLElement, next: HTMLElement | null, block: HTMLElement, line: DOMRect, scale: number) {
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let last: { node: Text; offset: number } | null = null;
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (span.contains(node) || !(span.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    if (next && (next.contains(node) || next.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
    const end = node.data.replace(/\s+$/, "").length;
    if (end) last = { node, offset: end };
  }
  if (!last) return 0;
  const range = document.createRange();
  range.setStartAfter(span);
  range.setEnd(last.node, last.offset);
  // A range's boxes cover both its elements and their text, so take how far they reach on each line rather
  // than adding them. Text that has wrapped below (its tab was too wide a moment ago) counts all the same,
  // or the tab would keep it there.
  const lines: Array<{ middle: number; from: number; to: number }> = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (!rect.width) continue;
    const middle = (rect.top + rect.bottom) / 2;
    const row = lines.find((item) => Math.abs(item.middle - middle) < Math.max(line.height, rect.height) / 2);
    if (row) {
      row.from = Math.min(row.from, rect.left);
      row.to = Math.max(row.to, rect.right);
    } else lines.push({ middle, from: rect.left, to: rect.right });
  }
  return lines.reduce((sum, row) => sum + (row.to - row.from), 0) / scale;
}
