import type { Node as PMNode } from "prosemirror-model";
import { getVersion } from "prosemirror-collab";
import type { EditorState, Transaction } from "prosemirror-state";
import type { EditorView } from "prosemirror-view";
import type { DocumentSettings } from "@/lib/doc/settings";
import { nodeStyleId, resolveStyle, stylesOf } from "@/lib/doc/styles";
import { cssSizeToPt } from "@/lib/doc/schema";
import { LockedContentError } from "@/lib/doc/merge";
import { applyFit, solveFit, type FitKind, type FitMark, type FitMeasurement, type FitUnit, type FitWord } from "@/lib/doc/pageFit";
import { pageStarts, type PageGeometry } from "@/lib/editor/pagination";

/**
 * Measure the pages the user can see and fit them. The same solver the agent
 * tools use (`solveFit`) turns one measurement into font size and line spacing.
 */

const round1 = (value: number) => Math.round(value * 10) / 10;

function rangeEnd(state: EditorState, kind: FitKind) {
  const starts = pageStarts(state);
  if (kind === "half") return starts[0] ?? state.doc.content.size;
  return starts[1] ?? state.doc.content.size;
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

/** The laid-out height of the pages a fit will squeeze, in CSS px at 100% zoom. */
export function measurePageFit(view: EditorView, geometry: PageGeometry, settings: DocumentSettings, kind: FitKind): FitMeasurement {
  const root = view.dom as HTMLElement;
  if (!root.isConnected || !root.offsetWidth) throw new Error("The page isn't laid out yet.");
  const end = rangeEnd(view.state, kind);
  const frame = frameOf(view);
  const units: FitUnit[] = [];
  let cursor = 0;
  const visit = (node: PMNode, pos: number) => {
    if (node.type.name === "page_break") {
      if (pos < end) units.push({ pos, kind: "break", gapBefore: 0, gapScales: false });
      return;
    }
    if (node.isTextblock) {
      if (pos >= end) return;
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
      units.push({
        pos,
        kind: "text",
        gapBefore: Math.max(0, top - cursor),
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
      });
      cursor = Math.max(cursor, bottom);
      return;
    }
    if (node.isAtom || node.isLeaf) {
      if (pos >= end) return;
      const dom = view.nodeDOM(pos);
      if (!(dom instanceof HTMLElement)) return;
      const rect = dom.getBoundingClientRect();
      const top = frame.natural(frame.toLocal(rect.top));
      const bottom = frame.natural(frame.toLocal(rect.bottom));
      units.push({ pos, kind: "fixed", gapBefore: Math.max(0, top - cursor), gapScales: false, height: Math.max(0, bottom - top) });
      cursor = Math.max(cursor, bottom);
      return;
    }
    if (pos >= end) return;
    node.forEach((child, offset) => visit(child, pos + 1 + offset));
  };
  view.state.doc.forEach((node, offset) => visit(node, offset));
  return {
    version: getVersion(view.state),
    kind,
    pageContentHeight: geometry.pageHeight - geometry.marginTop - geometry.marginBottom,
    bodyFontSize: settings.fontSize,
    bodyLineSpacing: settings.lineSpacing,
    units,
  };
}

/** Measure, solve, and build the transaction the Format menu applies. */
export function fitPagesInView(view: EditorView, settings: DocumentSettings, geometry: PageGeometry, kind: FitKind, flow: boolean): { summary: string; transaction: Transaction | null } {
  if (flow) return { summary: "Fit uses the page layout. Turn off reflow to use it.", transaction: null };
  let measurement: FitMeasurement;
  try {
    measurement = measurePageFit(view, geometry, settings, kind);
  } catch (error) {
    return { summary: error instanceof Error ? error.message : "Couldn't measure the pages.", transaction: null };
  }
  const solution = solveFit(measurement);
  if (solution.unchanged || solution.blocked) return { summary: solution.summary, transaction: null };
  let transform;
  try {
    transform = applyFit(view.state.doc, solution);
  } catch (error) {
    if (error instanceof LockedContentError) return { summary: error.message, transaction: null };
    throw error;
  }
  if (!transform.steps.length) return { summary: solution.summary, transaction: null };
  const transaction = view.state.tr;
  for (const step of transform.steps) {
    if (transaction.maybeStep(step).failed) return { summary: "Couldn't apply the fit.", transaction: null };
  }
  return { summary: solution.summary, transaction };
}
