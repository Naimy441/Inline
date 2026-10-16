import type { Node as PMNode } from "prosemirror-model";
import { getVersion } from "prosemirror-collab";
import type { EditorState } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { DocumentSettings } from "@/lib/doc/settings";
import { nodeStyleId, resolveStyle, stylesOf } from "@/lib/doc/styles";
import { cssSizeToPt } from "@/lib/doc/schema";
import type { FitMark, FitMeasurement, FitUnit, FitWord } from "@/lib/doc/pageFit";
import { pageStarts, type PageGeometry } from "@/lib/editor/pagination";

/**
 * Measure a page range as it is laid out. `solveFit` turns that measurement
 * and a target height into font size and line spacing.
 */

export type FitPageRange = { fromPage: number; toPage: number };

const round1 = (value: number) => Math.round(value * 10) / 10;

function rangeBounds(state: EditorState, range: FitPageRange) {
  const starts = pageStarts(state);
  const pages = starts.length + 1;
  if (range.fromPage > pages) return null;
  const toPage = Math.min(range.toPage, pages);
  const from = range.fromPage <= 1 ? 0 : starts[range.fromPage - 2]!;
  const end = toPage >= pages ? state.doc.content.size : (starts[toPage - 1] ?? state.doc.content.size);
  return { from, end, toPage };
}

function frameOf(view: EditorView) {
  const root = view.dom as HTMLElement;
  const rootRect = root.getBoundingClientRect();
  const scale = rootRect.width / (root.offsetWidth || 1) || 1;
  const toLocal = (y: number) => (y - rootRect.top) / scale;
  const gaps = Array.from(root.querySelectorAll<HTMLElement>(".page-gap"))
    .map((element) => {
      const rect = element.getBoundingClientRect();
      return { top: toLocal(rect.top), height: Number(element.getAttribute("data-height")) || rect.height / scale };
    })
    .sort((a, b) => a.top - b.top);
  const natural = (y: number) => {
    let shift = 0;
    for (const gap of gaps) {
      if (gap.top < y - 0.5) shift += gap.height;
      else break;
    }
    return y - shift;
  };
  const insideGap = (top: number, bottom: number) => gaps.some((gap) => top >= gap.top - 0.5 && bottom <= gap.top + gap.height + 0.5);
  return { scale, toLocal, natural, insideGap };
}

function lineBoxes(dom: HTMLElement, frame: ReturnType<typeof frameOf>) {
  const range = document.createRange();
  range.selectNodeContents(dom);
  const lines: Array<{ top: number; bottom: number }> = [];
  for (const rect of Array.from(range.getClientRects())) {
    if (!rect.height) continue;
    const top = frame.toLocal(rect.top);
    const bottom = frame.toLocal(rect.bottom);
    if (frame.insideGap(top, bottom)) continue;
    const line = lines.find((item) => top < item.bottom - 2 && bottom > item.top + 2);
    if (line) {
      line.top = Math.min(line.top, top);
      line.bottom = Math.max(line.bottom, bottom);
    } else lines.push({ top, bottom });
  }
  lines.sort((a, b) => a.top - b.top);
  return lines.map((line) => ({ top: frame.natural(line.top), bottom: frame.natural(line.bottom) }));
}

function edge(view: EditorView, pos: number, side: "left" | "right") {
  try {
    const { node, offset } = view.domAtPos(pos, side === "left" ? 1 : -1);
    if (!(node instanceof Text) || offset < 0 || offset >= node.data.length) return null;
    const range = document.createRange();
    range.setStart(node, offset);
    range.setEnd(node, offset + 1);
    const rect = range.getBoundingClientRect();
    if (!rect.width && !rect.height) return null;
    return side === "left" ? rect.left : rect.right;
  } catch {
    return null;
  }
}

function spanWidth(view: EditorView, from: number, to: number, scale: number) {
  if (to <= from) return 0;
  const left = edge(view, from, "left");
  const right = edge(view, to - 1, "right");
  if (left == null || right == null) return 0;
  return Math.max(0, (right - left) / scale);
}

function measureWords(view: EditorView, node: PMNode, pos: number, scale: number): FitWord[] {
  const chars: Array<{ ch: string; at: number }> = [];
  node.descendants((child, rel) => {
    const at = pos + 1 + rel;
    if (child.isText && child.text) {
      for (let index = 0; index < child.text.length; index += 1) chars.push({ ch: child.text[index]!, at: at + index });
    } else if (child.type.name === "hard_break") chars.push({ ch: "\n", at });
    return !child.isText;
  });
  const words: FitWord[] = [];
  let index = 0;
  while (index < chars.length) {
    if (chars[index]!.ch === "\n") {
      index += 1;
      if (words.length) words.push({ width: 0, gap: 0, breakBefore: true });
      continue;
    }
    if (/\s/.test(chars[index]!.ch)) {
      index += 1;
      continue;
    }
    const start = index;
    while (index < chars.length && chars[index]!.ch !== "\n" && !/\s/.test(chars[index]!.ch)) index += 1;
    const from = chars[start]!.at;
    const to = chars[index - 1]!.at + 1;
    let gap = 0;
    const spaceStart = index;
    while (index < chars.length && chars[index]!.ch !== "\n" && /\s/.test(chars[index]!.ch)) index += 1;
    if (index > spaceStart) gap = spanWidth(view, chars[spaceStart]!.at, chars[index - 1]!.at + 1, scale);
    words.push({ width: spanWidth(view, from, to, scale), gap, ...(chars[start]!.ch === "\n" ? { breakBefore: true } : {}) });
  }
  return words.filter((word) => word.width > 0 || word.breakBefore);
}

function leadingOf(node: PMNode, settings: DocumentSettings) {
  const own = node.attrs.lineHeight;
  if (typeof own === "string" && own && Number(own) > 0) return Number(own);
  const resolved = resolveStyle(stylesOf(settings), nodeStyleId(node));
  if (resolved?.lineHeight != null) return resolved.lineHeight;
  if (node.type.name === "code_block") return 1.5;
  return settings.lineSpacing || 1.15;
}

function marginPt(value: string) {
  const amount = parseFloat(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;
  return round1((amount * 72) / 96);
}

function marksIn(node: PMNode): FitMark[] {
  const marks: FitMark[] = [];
  node.descendants((child, rel) => {
    if (!child.isText || !child.text) return;
    const mark = child.marks.find((item) => item.type.name === "font_size");
    const size = mark ? cssSizeToPt(String(mark.attrs.size)) : null;
    if (size) marks.push({ from: rel, to: rel + child.text.length, size });
  });
  return marks;
}

/** The laid-out height of a page range, in CSS px at 100% zoom. `targetPages` is left for the caller. */
export function measurePageFit(view: EditorView, geometry: PageGeometry, settings: DocumentSettings, range: FitPageRange): Omit<FitMeasurement, "targetPages"> {
  const root = view.dom as HTMLElement;
  if (!root.isConnected || !root.offsetWidth) throw new Error("The page isn't laid out yet.");
  const bounds = rangeBounds(view.state, range);
  if (!bounds) throw new Error(`The document doesn't have page ${range.fromPage}.`);
  const { from, end, toPage } = bounds;
  const frame = frameOf(view);
  const found: Array<FitUnit & { top: number; bottom: number }> = [];
  const visit = (node: PMNode, pos: number) => {
    if (pos >= end || pos + node.nodeSize <= from) return;
    if (node.type.name === "page_break") {
      if (pos >= from) found.push({ pos, kind: "break", gapBefore: 0, gapScales: false, top: 0, bottom: 0 });
      return;
    }
    if (node.isTextblock) {
      if (pos < from) return;
      const dom = view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return;
      const boxes = lineBoxes(dom, frame);
      const rect = dom.getBoundingClientRect();
      const top = boxes[0]?.top ?? frame.natural(frame.toLocal(rect.top));
      const bottom = boxes.length ? boxes[boxes.length - 1]!.bottom : frame.natural(frame.toLocal(rect.bottom));
      const style = getComputedStyle(dom);
      const fontPx = parseFloat(style.fontSize) || 16;
      const textHeight = Math.max(fontPx, bottom - top);
      const lines = Math.max(1, boxes.length);
      const padLeft = parseFloat(style.paddingLeft) || 0;
      const padRight = parseFloat(style.paddingRight) || 0;
      found.push({
        pos,
        kind: "text",
        gapBefore: 0,
        gapScales: "spaceBefore" in node.attrs || "spaceAfter" in node.attrs,
        lines,
        lineHeight: textHeight / lines,
        fontSize: round1((fontPx * 72) / 96),
        lineSpacing: leadingOf(node, settings),
        width: Math.max(0, dom.clientWidth - padLeft - padRight),
        indent: parseFloat(style.textIndent) || 0,
        words: measureWords(view, node, pos, frame.scale),
        marks: marksIn(node),
        canSize: "fontSize" in node.attrs,
        canLead: "lineHeight" in node.attrs,
        canSpace: "spaceBefore" in node.attrs || "spaceAfter" in node.attrs,
        spaceBeforePt: marginPt(style.marginTop),
        spaceAfterPt: marginPt(style.marginBottom),
        top,
        bottom,
      });
      return;
    }
    if (node.isAtom || node.isLeaf) {
      if (pos < from) return;
      const dom = view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return;
      const rect = dom.getBoundingClientRect();
      const top = frame.natural(frame.toLocal(rect.top));
      const bottom = frame.natural(frame.toLocal(rect.bottom));
      found.push({ pos, kind: "fixed", gapBefore: 0, gapScales: false, height: Math.max(0, bottom - top), top, bottom });
      return;
    }
    node.forEach((child, offset) => visit(child, pos + 1 + offset));
  };
  view.state.doc.forEach((node, offset) => visit(node, offset));
  const pageContentHeight = geometry.pageHeight - geometry.marginTop - geometry.marginBottom;
  let origin = (Math.max(1, range.fromPage) - 1) * pageContentHeight;
  const firstBox = found.find((item) => item.kind !== "break");
  if (firstBox && firstBox.top < origin) origin = firstBox.top;
  let cursor = origin;
  const units: FitUnit[] = found.map((item) => {
    const gapBefore = item.kind === "break" ? 0 : Math.max(0, item.top - cursor);
    if (item.kind !== "break") cursor = Math.max(cursor, item.bottom);
    const { top: _top, bottom: _bottom, ...unit } = item;
    return { ...unit, gapBefore };
  });
  return {
    version: getVersion(view.state),
    fromPage: range.fromPage,
    toPage,
    pageContentHeight,
    bodyFontSize: settings.fontSize,
    bodyLineSpacing: settings.lineSpacing,
    units,
  };
}
