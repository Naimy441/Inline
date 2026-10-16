import type { Attrs, Node as PMNode } from "prosemirror-model";
import type { Command, EditorState } from "prosemirror-state";
import { MAX_INDENT } from "@/lib/doc/schema";

/**
 * Where a paragraph's text sits, in inches.
 * `first` is the first line and `left` the lines under it, both measured from
 * the paragraph's own start (the left margin, or the right one for right-to-left
 * text). `right` is the gap before the opposite margin.
 */
export type IndentGeometry = { first: number; left: number; right: number };

/** The ruler handles. The margin marker moves the first line and the left indent together. */
export type MarkerKind = "margin" | "first" | "left" | "right";

/** Google's ruler snaps to an eighth of an inch. */
export const RULER_SNAP = 0.125;

const MIN_TEXT = 0.25;
/** First-line and hanging indents are stored to the thousandth, and kept within what a paste can round-trip. */
const MAX_TEXT_INDENT = 3;

export const ZERO_INDENT: IndentGeometry = { first: 0, left: 0, right: 0 };

export function snapInches(value: number) {
  return Math.round(value / RULER_SNAP) * RULER_SNAP;
}

export function roundInches(value: number) {
  return Math.round(value * 1000) / 1000;
}

function clamp(value: number, min: number, max: number) {
  if (max < min) return min;
  return Math.min(max, Math.max(min, value));
}

/** The paragraph's indent attributes as ruler positions. */
export function indentGeometry(attrs: { indent?: unknown; textIndent?: unknown; rightIndent?: unknown }): IndentGeometry {
  const margin = (Number(attrs.indent) || 0) * 0.5;
  const text = Number(attrs.textIndent) || 0;
  const right = Math.max(0, Number(attrs.rightIndent) || 0);
  if (text < 0) return { first: margin, left: roundInches(margin - text), right };
  return { first: roundInches(margin + text), left: roundInches(margin), right };
}

/** Attributes that put a paragraph at these positions. */
export function attrsForIndents(geometry: IndentGeometry): { indent: number; textIndent: number | null; rightIndent: number | null } {
  const first = Math.max(0, geometry.first);
  const left = Math.max(0, geometry.left);
  const base = Math.min(first, left);
  const indent = clamp(roundInches(base / 0.5), 0, MAX_INDENT);
  let text = roundInches(first - left);
  if (Math.abs(text) < 0.001) text = 0;
  text = clamp(text, -MAX_TEXT_INDENT, MAX_TEXT_INDENT);
  const right = Math.max(0, geometry.right);
  return {
    indent,
    textIndent: text === 0 ? null : text,
    rightIndent: right < 0.001 ? null : Math.min(12, roundInches(right)),
  };
}

/**
 * Marker positions in inches from the left edge of the text area.
 * Right-to-left paragraphs mirror, so the start markers sit on the right.
 */
export function markerPositions(geometry: IndentGeometry, contentWidth: number, rtl = false) {
  const start = (inches: number) => (rtl ? contentWidth - inches : inches);
  return {
    first: start(geometry.first),
    left: start(geometry.left),
    margin: start(geometry.left),
    right: rtl ? geometry.right : contentWidth - geometry.right,
  };
}

export function shiftIndent(geometry: IndentGeometry, by: IndentGeometry, sign: 1 | -1): IndentGeometry {
  return {
    first: geometry.first + sign * by.first,
    left: geometry.left + sign * by.left,
    right: geometry.right + sign * by.right,
  };
}

/**
 * Move one marker by `deltaScreen` inches (positive is toward the right of the page).
 * The margin marker keeps the gap between the first line and the lines below it.
 */
export function dragGeometry(start: IndentGeometry, kind: MarkerKind, deltaScreen: number, contentWidth: number, rtl: boolean): IndentGeometry {
  const width = Math.max(MIN_TEXT, contentWidth);
  if (kind === "right") {
    const delta = rtl ? deltaScreen : -deltaScreen;
    return finish({ ...start, right: start.right + delta }, width, "right");
  }
  const delta = rtl ? -deltaScreen : deltaScreen;
  if (kind === "margin") return finish({ first: start.first + delta, left: start.left + delta, right: start.right }, width, "margin");
  if (kind === "first") return finish({ ...start, first: start.first + delta }, width, "first");
  return finish({ ...start, left: start.left + delta }, width, "left");
}

function finish(geometry: IndentGeometry, width: number, kind: MarkerKind): IndentGeometry {
  let { first, left, right } = geometry;
  const maxStart = () => Math.max(0, width - right - MIN_TEXT);
  const capText = () => {
    if (first - left > MAX_TEXT_INDENT) first = left + MAX_TEXT_INDENT;
    if (left - first > MAX_TEXT_INDENT) left = first + MAX_TEXT_INDENT;
  };
  if (kind === "right") {
    const used = Math.max(first, left);
    right = clamp(right, 0, Math.max(0, width - used - MIN_TEXT));
  } else if (kind === "margin") {
    const low = Math.min(first, left);
    if (low < 0) {
      first -= low;
      left -= low;
    }
    const high = Math.max(first, left);
    const room = maxStart();
    if (high > room) {
      const over = high - room;
      first -= over;
      left -= over;
    }
    capText();
  } else if (kind === "first") {
    first = clamp(first, 0, maxStart());
    capText();
    first = clamp(first, 0, maxStart());
  } else {
    left = clamp(left, 0, maxStart());
    capText();
    left = clamp(left, 0, maxStart());
  }
  const maxIndent = MAX_INDENT * 0.5;
  if (kind === "margin") {
    const high = Math.max(first, left);
    if (high > maxIndent) {
      const over = high - maxIndent;
      first -= over;
      left -= over;
    }
  } else {
    first = clamp(first, 0, maxIndent);
    left = clamp(left, 0, maxIndent);
  }
  return {
    first: roundInches(Math.max(0, first)),
    left: roundInches(Math.max(0, left)),
    right: roundInches(Math.max(0, right)),
  };
}

/** Paint a paragraph's indents while a marker is moving, before the edit is committed. */
export function writeIndentPreview(dom: HTMLElement, geometry: IndentGeometry, rtl: boolean) {
  const side = rtl ? "right" : "left";
  const end = rtl ? "left" : "right";
  const margin = Math.min(geometry.first, geometry.left);
  const text = geometry.first - geometry.left;
  dom.style.setProperty(`margin-${side}`, margin > 0.001 ? `${roundInches(margin)}in` : "0in");
  dom.style.setProperty(`margin-${end}`, geometry.right > 0.001 ? `${roundInches(geometry.right)}in` : "0in");
  dom.style.textIndent = Math.abs(text) > 0.001 ? `${roundInches(text)}in` : "0in";
  dom.style.setProperty(`padding-${side}`, text < -0.001 ? `${roundInches(-text)}in` : "0px");
}

/** Paragraphs the caret is in, or every paragraph the selection covers. */
export function paragraphsInSelection(state: EditorState) {
  const out: Array<{ node: PMNode; pos: number }> = [];
  const { from, to } = state.selection;
  // A caret's range is empty, and nodesBetween stops before a position it only touches.
  const end = from === to ? to + 1 : to;
  state.doc.nodesBetween(from, Math.min(end, state.doc.content.size), (node, pos) => {
    if (node.isTextblock) {
      out.push({ node, pos });
      return false;
    }
    return true;
  });
  if (out.length) return out.filter(({ node }) => "indent" in node.attrs);
  const parent = state.selection.$from.parent;
  if (parent.isTextblock && "indent" in parent.attrs) return [{ node: parent, pos: state.selection.$from.before() }];
  return [];
}

function sameIndent(attrs: Attrs, next: ReturnType<typeof attrsForIndents>) {
  return attrs.indent === next.indent && (attrs.textIndent ?? null) === next.textIndent && (attrs.rightIndent ?? null) === next.rightIndent;
}

/** Set the indent of the paragraph at the caret, or of every paragraph in the selection. */
export function setParagraphIndents(geometry: IndentGeometry): Command {
  return (state, dispatch) => {
    const blocks = paragraphsInSelection(state);
    if (!blocks.length) return false;
    const next = attrsForIndents(geometry);
    if (blocks.every(({ node }) => sameIndent(node.attrs, next))) return false;
    if (!dispatch) return true;
    const tr = state.tr;
    for (const { node, pos } of blocks) tr.setNodeMarkup(tr.mapping.map(pos), undefined, { ...node.attrs, ...next });
    dispatch(tr);
    return true;
  };
}
