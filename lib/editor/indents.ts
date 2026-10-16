import type { Node as PMNode } from "prosemirror-model";
import type { Command, EditorState } from "prosemirror-state";
import { MAX_INDENT } from "@/lib/doc/schema";

/**
 * A paragraph's indents the way the ruler draws them, in inches from the
 * text area (inside the page margins). `indent` is the start margin in half
 * inches and `textIndent` is the first line relative to the lines below it
 * (negative hangs). `right` is the end margin, `rightIndent`, in inches.
 * Dragging a marker writes those same attributes back; the ruler has no
 * indents of its own.
 */
export type IndentEdges = {
  /** Where the lines after the first start. */
  body: number;
  /** Where the first line starts. */
  first: number;
  /** How far every line stops short of the far margin. */
  right: number;
};

const MIN_LINE = 0.5;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Thousandths of an inch: finer than a pixel, coarse enough that a drag doesn't store noise. */
function roundIn(value: number) {
  return Math.round(value * 1000) / 1000;
}

export function indentEdges(indent: number, textIndent: number | null, rightIndent: number | null): IndentEdges {
  const left = (Number(indent) || 0) * 0.5;
  const delta = Number(textIndent) || 0;
  const right = Math.max(0, Number(rightIndent) || 0);
  // A hanging indent pads the lines below and pulls the first line back to the margin.
  if (delta < 0) return { body: left - delta, first: left, right };
  return { body: left, first: left + delta, right };
}

/** Marker positions back into the paragraph's own indent attributes. */
export function edgesToAttrs(body: number, first: number, right: number, contentInches: number) {
  const content = Math.max(MIN_LINE, contentInches);
  const maxEdge = Math.max(0, content - MIN_LINE);
  right = clamp(roundIn(right), 0, Math.min(8, maxEdge));
  const room = Math.max(0, content - right - MIN_LINE);
  body = clamp(roundIn(body), 0, room);
  first = clamp(roundIn(first), 0, room);
  if (first - body > 3) first = roundIn(body + 3);
  if (body - first > 3) body = roundIn(first + 3);
  // `indent` only reaches four inches (MAX_INDENT half-inch steps).
  const maxMargin = MAX_INDENT * 0.5;
  if (Math.min(first, body) > maxMargin) {
    if (first <= body) {
      const hang = Math.min(3, body - first);
      first = maxMargin;
      body = Math.min(room, roundIn(first + hang));
    } else {
      const extra = Math.min(3, first - body);
      body = maxMargin;
      first = Math.min(room, roundIn(body + extra));
    }
  }
  body = clamp(body, 0, room);
  first = clamp(first, 0, room);
  const margin = Math.min(first, body);
  const indent = clamp(Math.round((margin / 0.5) * 1000) / 1000, 0, MAX_INDENT);
  const delta = Math.round((first - body) * 100) / 100;
  return {
    indent,
    textIndent: Math.abs(delta) < 0.01 ? null : clamp(delta, -3, 3),
    rightIndent: right < 0.005 ? 0 : Math.round(right * 100) / 100,
  };
}

function sameIndent(node: PMNode, next: { indent: number; textIndent: number | null; rightIndent: number }) {
  return Number(node.attrs.indent) === next.indent && ((node.attrs.textIndent as number | null) ?? null) === next.textIndent && (Number(node.attrs.rightIndent) || 0) === next.rightIndent;
}

/** Give the selected paragraphs these indents. Unchanged paragraphs are left alone. */
export function setParagraphIndents(next: { indent: number; textIndent: number | null; rightIndent: number }): Command {
  return (state, dispatch) => {
    const blocks: Array<{ node: PMNode; pos: number }> = [];
    state.doc.nodesBetween(state.selection.from, state.selection.to, (node, pos) => {
      if (!node.isTextblock) return true;
      if ("indent" in node.attrs) blocks.push({ node, pos });
      return false;
    });
    if (!blocks.length || !blocks.some(({ node }) => !sameIndent(node, next))) return blocks.length > 0;
    if (dispatch) {
      let tr = state.tr;
      for (const { node, pos } of blocks) {
        if (!sameIndent(node, next)) tr = tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...next });
      }
      dispatch(tr);
    }
    return true;
  };
}

/** The text block the caret is in, when that block has paragraph indents. */
export function paragraphAtSelection(state: EditorState): { node: PMNode; pos: number } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.isTextblock && "indent" in node.attrs) return { node, pos: $from.before(depth) };
  }
  return null;
}
