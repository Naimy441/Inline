import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { Transform, ReplaceStep } from "prosemirror-transform";
import { canvasAuthoredIds, compileCanvas, canvasMarkup, isCanvas } from "./compiler";
import { validateCanvasCss } from "./styles";
import { EditError, lockedBetween } from "@/lib/doc/editing";
import type { LiveDocument } from "@/lib/server/hub";
import { validateCanvasDocument } from "./model";

export type CanvasOperationName = "replace" | "replace_component" | "insert_after" | "remove" | "move_after" | "styles";
export type CanvasOp = { operation: CanvasOperationName; target?: string; after?: string; html?: string; css?: string };
export type CanvasPatch = {
  epoch: string;
  version: number;
  operation?: CanvasOperationName;
  operations?: CanvasOp[];
  target?: string;
  after?: string;
  html?: string;
  css?: string;
};
export type CanvasPatchResult = { tr: Transform; notes: string[] };

export function readCanvas(doc: LiveDocument) {
  if (!isCanvas(doc.doc)) throw new EditError("This is not a Canvas. Use create_canvas to create one.");
  return { id: doc.id, title: doc.meta.title, epoch: doc.epoch, version: doc.version, html: canvasMarkup(doc.doc), css: doc.doc.attrs.canvas.css as string };
}

function normalizeOps(patch: CanvasPatch): CanvasOp[] {
  const hasList = patch.operations != null;
  const hasOne = patch.operation != null;
  if (hasList && hasOne) throw new Error("Pass operation or operations, not both.");
  if (hasList) {
    if (patch.target || patch.after || patch.html || patch.css) throw new Error("Put target, html, and css on each entry in operations.");
    if (!patch.operations!.length) throw new Error("operations needs at least one edit.");
    if (patch.operations!.length > 12) throw new Error("A canvas patch can batch at most 12 operations.");
    return patch.operations!;
  }
  if (!hasOne) throw new Error("Canvas patch requires an operation.");
  return [{ operation: patch.operation!, target: patch.target, after: patch.after, html: patch.html, css: patch.css }];
}

function findIn(doc: PMNode, id?: string) {
  let result: { node: PMNode; pos: number } | undefined;
  doc.descendants((node, pos) => { if (id && node.attrs.id === id) result = { node, pos }; });
  if (!result) throw new Error(`Canvas component ${id || "(missing id)"} was not found.`);
  return result;
}

function idsOutside(doc: PMNode, from: number, to: number) {
  const ids = new Set<string>();
  doc.descendants((node, pos) => {
    if (!node.isBlock || !node.attrs.id) return;
    const inside = pos >= from && pos + node.nodeSize <= to;
    if (!inside) ids.add(node.attrs.id as string);
  });
  return ids;
}

function claimIds(doc: PMNode, ids: Iterable<string>, except: string | null) {
  const outside = new Set<string>();
  doc.descendants((node) => { if (node.isBlock && node.attrs.id) outside.add(node.attrs.id as string); });
  for (const id of ids) {
    if (id !== except && outside.has(id)) throw new Error(`id "${id}" is already used. Choose another id, or replace the component that has it.`);
  }
}

export function canvasTransform(doc: LiveDocument, patch: CanvasPatch): CanvasPatchResult {
  readCanvas(doc);
  if (patch.epoch !== doc.epoch || patch.version !== doc.version) throw new EditError("Canvas changed since you read it. Read it again and apply a fresh patch; no changes were applied.");
  const tr = new Transform(doc.doc);
  const notes: string[] = [];
  try {
    for (const op of normalizeOps(patch)) applyOp(tr, op, notes);
    return { tr, notes };
  } catch (error) { throw new EditError(error instanceof Error ? error.message : "Invalid Canvas patch."); }
}

function applyOp(tr: Transform, op: CanvasOp, notes: string[]) {
  const unlock = (from: number, to: number) => { if (lockedBetween(tr.doc, from, to)) throw new Error("This operation would change locked content. Preserve it with a style-only or more focused patch."); };
  const finish = () => { tr.doc.check(); validateCanvasDocument(tr.doc); };
  if (op.operation === "styles") {
    if (op.css === undefined) throw new Error("styles requires css.");
    tr.setDocAttribute("canvas", { format: 1, css: validateCanvasCss(op.css) });
    finish();
    return;
  }
  if (op.operation === "replace") {
    if (op.html === undefined) throw new Error("replace requires html.");
    unlock(0, tr.doc.content.size);
    const candidate = compileCanvas(op.html, op.css ?? tr.doc.attrs.canvas.css);
    tr.replaceWith(0, tr.doc.content.size, candidate.content);
    tr.setDocAttribute("canvas", candidate.attrs.canvas);
    finish();
    return;
  }
  const target = findIn(tr.doc, op.target);
  if (op.operation === "remove") {
    unlock(target.pos, target.pos + target.node.nodeSize);
    tr.step(new ReplaceStep(target.pos, target.pos + target.node.nodeSize, Slice.empty));
  } else if (op.operation === "move_after") {
    const after = findIn(tr.doc, op.after);
    if (after.pos >= target.pos && after.pos < target.pos + target.node.nodeSize) throw new Error("Cannot move a component inside itself.");
    unlock(target.pos, target.pos + target.node.nodeSize);
    const piece = new Slice(Fragment.from(target.node), 0, 0);
    const targetEnd = target.pos + target.node.nodeSize;
    const afterEnd = after.pos + after.node.nodeSize;
    tr.step(new ReplaceStep(target.pos, targetEnd, Slice.empty));
    const at = afterEnd > target.pos ? afterEnd - target.node.nodeSize : afterEnd;
    tr.step(new ReplaceStep(at, at, piece));
  } else {
    if (!op.html) throw new Error(`${op.operation} requires html containing one block inside Canvas.`);
    const fragment = compileCanvas(op.html).content;
    if (fragment.childCount !== 1) throw new Error("A component patch must contain exactly one block.");
    const replacement = fragment.firstChild!;
    if (op.operation === "replace_component") {
      unlock(target.pos, target.pos + target.node.nodeSize);
      const authored = canvasAuthoredIds(op.html);
      const targetId = target.node.attrs.id as string | null;
      let rootId = replacement.attrs.id as string | null;
      let childHasTarget = false;
      replacement.descendants((node) => { if (targetId && node.attrs.id === targetId) childHasTarget = true; });
      if (authored.rootId) {
        rootId = authored.rootId;
        if (authored.rootId !== targetId) notes.push(`Kept id "${authored.rootId}" on the replacement (it replaced "${targetId}").`);
      } else if (targetId && childHasTarget) {
        notes.push(`The replacement root had no id, and a child already uses "${targetId}", so the root kept a new id and the child kept "${targetId}".`);
      } else if (targetId) rootId = targetId;
      const outside = idsOutside(tr.doc, target.pos, target.pos + target.node.nodeSize);
      for (const id of authored.ids) {
        if (id !== targetId && outside.has(id)) throw new Error(`id "${id}" is already used outside the component you are replacing. Choose another id.`);
      }
      const next = replacement.type.create({ ...replacement.attrs, id: rootId }, replacement.content, replacement.marks);
      tr.step(new ReplaceStep(target.pos, target.pos + target.node.nodeSize, new Slice(Fragment.from(next), 0, 0)));
    } else if (op.operation === "insert_after") {
      claimIds(tr.doc, canvasAuthoredIds(op.html).ids, null);
      const at = target.pos + target.node.nodeSize;
      tr.step(new ReplaceStep(at, at, new Slice(fragment, 0, 0)));
    } else throw new Error("Unknown Canvas operation.");
  }
  if (op.css !== undefined) tr.setDocAttribute("canvas", { format: 1, css: validateCanvasCss(op.css) });
  finish();
}
