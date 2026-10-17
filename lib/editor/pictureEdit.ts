import { GapCursor } from "prosemirror-gapcursor";
import type { Node as PMNode } from "prosemirror-model";
import { NodeSelection, Selection, type EditorState, type Transaction } from "prosemirror-state";
import { pictureRotate, pictureWidth, pictureWrap, type PictureWrap } from "@/lib/doc/picture";
import { schema } from "@/lib/doc/schema";

/** CSS pixels in an inch. Image options speak inches; the document stores pixels. */
export const PX_PER_INCH = 96;

export const MIN_PICTURE_PX = 48;

export const HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type HandleName = (typeof HANDLES)[number];

export type PicturePlacement = "inline" | "square" | "break" | "behind" | "front";

/**
 * The wrap menu, named the way the editor already stores a picture.
 * `break` is a block picture with text above and below (no wrap attribute).
 * `inline` is a picture in the line (`inline_image`).
 */
export function picturePlacement(node: PMNode): PicturePlacement | null {
  if (node.type.name === "inline_image") return "inline";
  if (node.type.name !== "image") return null;
  const wrap = pictureWrap(node.attrs.wrap);
  if (wrap === "square" || wrap === "behind" || wrap === "front") return wrap;
  return "break";
}

/** Screen drag, turned into the picture's own axes. `degrees` is clockwise. */
export function localPointerDelta(dx: number, dy: number, degrees: number) {
  const theta = (degrees * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  return { dx: dx * cos + dy * sin, dy: -dx * sin + dy * cos };
}

/**
 * A corner keeps the starting aspect ratio. A side changes only that axis.
 * Width stays between {@link MIN_PICTURE_PX} and the text column.
 */
export function resizedBox(
  start: { width: number; height: number },
  dx: number,
  dy: number,
  handle: HandleName,
  maxWidth: number,
): { width: number; height: number } {
  const aspect = start.width / Math.max(1, start.height);
  const east = handle.includes("e");
  const west = handle.includes("w");
  const south = handle.includes("s");
  const north = handle.includes("n");
  const corner = (east || west) && (north || south);
  let width = start.width;
  let height = start.height;
  if (east) width = start.width + dx;
  if (west) width = start.width - dx;
  if (south) height = start.height + dy;
  if (north) height = start.height - dy;
  if (corner) {
    const fromW = Math.abs(width - start.width);
    const fromH = Math.abs(height - start.height) * aspect;
    if (fromH > fromW) width = Math.max(MIN_PICTURE_PX, height) * aspect;
    else height = Math.max(MIN_PICTURE_PX, width) / aspect;
  }
  const cap = maxWidth > 0 ? maxWidth : width;
  width = Math.round(Math.max(MIN_PICTURE_PX, Math.min(cap, width)));
  height = corner ? Math.round(Math.max(MIN_PICTURE_PX, width / aspect)) : Math.round(Math.max(MIN_PICTURE_PX, height));
  return { width, height };
}

/** Where a vertical or horizontal arrow should land around a block picture. */
export type PictureMotion = { kind: "gap"; pos: number } | { kind: "text"; pos: number };

export type PictureSelection =
  | { type: "text"; head: number; empty: boolean }
  | { type: "gap"; pos: number }
  | { type: "node"; pos: number; name: string };

/**
 * The picture is one line. That line's caret is the bottom-left corner (a gap
 * before the picture). Down from the line above and up from the line below
 * land there; another up or down leaves it.
 */
export function pictureArrowMotion(doc: PMNode, selection: PictureSelection, dir: "up" | "down" | "left" | "right", atEdge: boolean): PictureMotion | null {
  if (selection.type === "gap") {
    const gap = imageGap(doc, selection.pos);
    if (!gap) return null;
    if (dir === "right" && gap.side === "before") return { kind: "gap", pos: gap.imagePos + gap.size };
    if (dir === "left" && gap.side === "after") return { kind: "gap", pos: gap.imagePos };
    if (dir === "down" || dir === "right") {
      const pos = textAfterBlock(doc, gap.imagePos + gap.size);
      return pos == null ? null : { kind: "text", pos };
    }
    const pos = textBeforeBlock(doc, gap.imagePos);
    return pos == null ? null : { kind: "text", pos };
  }
  if (selection.type === "node" && selection.name === "image") {
    const node = doc.nodeAt(selection.pos);
    if (!node) return null;
    if (dir === "down" || dir === "right") {
      const pos = textAfterBlock(doc, selection.pos + node.nodeSize);
      return pos == null ? null : { kind: "text", pos };
    }
    if (dir === "up" || dir === "left") {
      const pos = textBeforeBlock(doc, selection.pos);
      return pos == null ? null : { kind: "text", pos };
    }
    return null;
  }
  if (selection.type !== "text" || !selection.empty || !atEdge) return null;
  const $head = doc.resolve(selection.head);
  if (!$head.parent.isTextblock) return null;
  if (dir === "down") {
    const nextPos = $head.after();
    const next = doc.nodeAt(nextPos);
    if (next?.type.name === "image") return { kind: "gap", pos: nextPos };
  }
  if (dir === "up") {
    const before = $head.before();
    const prev = doc.resolve(before).nodeBefore;
    if (prev?.type.name === "image") return { kind: "gap", pos: before - prev.nodeSize };
  }
  return null;
}

function imageGap(doc: PMNode, pos: number): { imagePos: number; side: "before" | "after"; size: number } | null {
  const $pos = doc.resolve(pos);
  if ($pos.nodeAfter?.type.name === "image") return { imagePos: pos, side: "before", size: $pos.nodeAfter.nodeSize };
  if ($pos.nodeBefore?.type.name === "image") return { imagePos: pos - $pos.nodeBefore.nodeSize, side: "after", size: $pos.nodeBefore.nodeSize };
  return null;
}

function textAfterBlock(doc: PMNode, pos: number): number | null {
  const next = pos <= doc.content.size ? doc.nodeAt(pos) : null;
  if (next?.isTextblock) return Math.min(doc.content.size, pos + 1);
  const found = Selection_find(doc, pos, 1);
  return found;
}

function textBeforeBlock(doc: PMNode, pos: number): number | null {
  const $pos = doc.resolve(pos);
  if ($pos.nodeBefore?.isTextblock) return Math.max(0, pos - 1);
  return Selection_find(doc, pos, -1);
}

function Selection_find(doc: PMNode, pos: number, dir: 1 | -1): number | null {
  const found = Selection.findFrom(doc.resolve(Math.max(0, Math.min(pos, doc.content.size))), dir, true);
  return found ? found.from : null;
}

/** A gap cursor beside a block picture, and which corner the caret draws at. */
export function gapBesidePicture(doc: PMNode, pos: number): { imagePos: number; side: "before" | "after" } | null {
  const gap = imageGap(doc, pos);
  return gap ? { imagePos: gap.imagePos, side: gap.side } : null;
}

/**
 * Move a picture to `target`. A target inside a paragraph splits that paragraph
 * so the picture can sit in the middle of the document, not only where it was inserted.
 */
export function movePicture(state: EditorState, from: number, target: number): Transaction | null {
  const node = state.doc.nodeAt(from);
  if (!node || (node.type.name !== "image" && node.type.name !== "inline_image")) return null;
  const end = from + node.nodeSize;
  if (target >= from && target <= end) return null;
  const tr = node.isInline ? moveInline(state, from, end, target, node) : moveBlock(state, from, end, target, node);
  if (!tr || tr.doc.eq(state.doc)) return null;
  return tr;
}

function moveInline(state: EditorState, from: number, end: number, target: number, node: PMNode): Transaction | null {
  const $target = state.doc.resolve(Math.max(0, Math.min(target, state.doc.content.size)));
  if (!$target.parent.inlineContent) return moveBlock(state, from, end, target, blockFrom(node, pictureWrap(node.attrs.wrap)));
  const tr = state.tr.delete(from, end);
  const at = tr.mapping.map(target, -1);
  const $at = tr.doc.resolve(at);
  if (!$at.parent.inlineContent) return null;
  tr.insert(at, node);
  return tr.setSelection(NodeSelection.create(tr.doc, at));
}

function moveBlock(state: EditorState, from: number, end: number, target: number, node: PMNode): Transaction | null {
  const block = node.type.name === "image" ? node : blockFrom(node, null);
  const $target = state.doc.resolve(Math.max(0, Math.min(target, state.doc.content.size)));
  let insertAt = target;
  let split = false;
  if ($target.parent.isTextblock) {
    if ($target.parentOffset === 0) insertAt = $target.before();
    else if ($target.parentOffset === $target.parent.content.size) insertAt = $target.after();
    else split = true;
  } else if (!$target.parent.inlineContent) {
    insertAt = $target.pos;
  }
  if (!split && (insertAt === from || insertAt === end)) return null;
  const tr = state.tr;
  if (split) {
    if (!canSplitAt(state.doc, target)) return null;
    tr.split(target);
    const mapped = tr.mapping.map(target);
    const boundary = tr.doc.resolve(mapped).before();
    const delFrom = tr.mapping.map(from);
    tr.delete(delFrom, tr.mapping.map(end));
    // `boundary` is a position in the doc after the split. Map it through the delete only.
    const at = tr.steps[tr.steps.length - 1]!.getMap().map(boundary);
    tr.insert(at, block);
    return tr.setSelection(NodeSelection.create(tr.doc, at));
  }
  if (insertAt < from) {
    tr.insert(insertAt, block);
    tr.delete(tr.mapping.map(from), tr.mapping.map(end));
    return tr.setSelection(NodeSelection.create(tr.doc, insertAt));
  }
  tr.delete(from, end);
  const at = tr.mapping.map(insertAt);
  tr.insert(at, block);
  return tr.setSelection(NodeSelection.create(tr.doc, at));
}

function canSplitAt(doc: PMNode, pos: number) {
  try {
    const $pos = doc.resolve(pos);
    return $pos.parent.isTextblock && $pos.parentOffset > 0 && $pos.parentOffset < $pos.parent.content.size;
  } catch {
    return false;
  }
}

/** Put the selected picture in one of the five wraps. */
export function placePicture(state: EditorState, placement: PicturePlacement): Transaction | null {
  const selection = state.selection;
  if (!(selection instanceof NodeSelection)) return null;
  const node = selection.node;
  if (node.type.name !== "image" && node.type.name !== "inline_image") return null;
  if (picturePlacement(node) === placement) return null;
  const pos = selection.from;
  if (placement === "inline") return node.type.name === "inline_image" ? null : toInline(state, pos, node);
  const wrap: PictureWrap | null = placement === "break" ? null : placement;
  if (node.type.name === "image") {
    const tr = state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, wrap });
    return tr.setSelection(NodeSelection.create(tr.doc, pos));
  }
  return toBlock(state, pos, node, wrap);
}

function toInline(state: EditorState, pos: number, node: PMNode): Transaction | null {
  const inline = inlineFrom(node);
  const after = pos + node.nodeSize;
  const next = state.doc.nodeAt(after);
  const tr = state.tr;
  if (next?.isTextblock) {
    tr.insert(after + 1, inline);
    tr.delete(pos, pos + node.nodeSize);
    return tr.setSelection(NodeSelection.create(tr.doc, pos + 1));
  }
  const prev = state.doc.resolve(pos).nodeBefore;
  if (prev?.isTextblock) {
    const insertAt = pos - 1;
    tr.insert(insertAt, inline);
    const delFrom = tr.mapping.map(pos);
    tr.delete(delFrom, delFrom + node.nodeSize);
    return tr.setSelection(NodeSelection.create(tr.doc, tr.mapping.map(insertAt)));
  }
  tr.replaceWith(pos, pos + node.nodeSize, schema.nodes.paragraph!.create(null, inline));
  return tr.setSelection(NodeSelection.create(tr.doc, pos + 1));
}

function toBlock(state: EditorState, pos: number, node: PMNode, wrap: PictureWrap | null): Transaction | null {
  const block = blockFrom(node, wrap);
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  const offset = pos - $pos.start();
  const parentPos = $pos.before();
  const tr = state.tr;
  if (parent.childCount === 1) {
    tr.replaceWith(parentPos, $pos.after(), block);
    return tr.setSelection(NodeSelection.create(tr.doc, parentPos));
  }
  tr.delete(pos, pos + node.nodeSize);
  let at: number;
  if (offset === 0) {
    at = tr.mapping.map(parentPos);
    tr.insert(at, block);
  } else if (offset >= parent.content.size - node.nodeSize) {
    at = tr.mapping.map($pos.after());
    tr.insert(at, block);
  } else {
    const splitAt = tr.mapping.map(pos);
    tr.split(splitAt);
    const afterSplit = tr.steps[tr.steps.length - 1]!.getMap().map(splitAt);
    at = tr.doc.resolve(afterSplit).before();
    tr.insert(at, block);
  }
  return tr.setSelection(NodeSelection.create(tr.doc, at));
}

function pxNum(value: unknown): number | null {
  if (typeof value === "number" && value > 0) return Math.round(value);
  const width = pictureWidth(value);
  if (!width || width.endsWith("%")) return null;
  const n = Number.parseFloat(width);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function inlineFrom(node: PMNode) {
  return schema.nodes.inline_image!.create({
    src: node.attrs.src,
    alt: node.attrs.alt,
    width: pxNum(node.attrs.width),
    height: pxNum(node.attrs.height),
    crop: node.attrs.crop,
    rotate: pictureRotate(node.attrs.rotate),
  });
}

function blockFrom(node: PMNode, wrap: PictureWrap | null) {
  const width = node.type.name === "image" ? pictureWidth(node.attrs.width) : pxNum(node.attrs.width) ? `${pxNum(node.attrs.width)}px` : null;
  const height = node.type.name === "image" ? pictureWidth(node.attrs.height) : pxNum(node.attrs.height) ? `${pxNum(node.attrs.height)}px` : null;
  return schema.nodes.image!.create({
    src: node.attrs.src,
    alt: node.attrs.alt ?? "",
    title: node.attrs.title ?? "",
    width,
    height,
    align: node.attrs.align ?? "center",
    wrap,
    crop: node.attrs.crop ?? null,
    rotate: pictureRotate(node.attrs.rotate),
  });
}

/** Backspace or Delete on a selected picture removes it. */
export function deleteSelectedPicture(state: EditorState, dispatch?: (tr: Transaction) => void) {
  const selection = state.selection;
  if (!(selection instanceof NodeSelection)) return false;
  if (selection.node.type.name !== "image" && selection.node.type.name !== "inline_image") return false;
  dispatch?.(state.tr.deleteSelection().scrollIntoView());
  return true;
}

/** A gap cursor at `pos`, when one is allowed there. */
export function gapAt(doc: PMNode, pos: number) {
  const $pos = doc.resolve(pos);
  const valid = (GapCursor as unknown as { valid($pos: ReturnType<PMNode["resolve"]>): boolean }).valid($pos);
  return valid ? new GapCursor($pos) : null;
}
