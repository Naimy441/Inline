import { Fragment, Slice, type Node as PMNode } from "prosemirror-model";
import { Transform, ReplaceStep } from "prosemirror-transform";
import { compileCanvas, canvasMarkup, isCanvas } from "./compiler";
import { validateCanvasCss } from "./styles";
import { EditError, lockedBetween } from "@/lib/doc/editing";
import type { LiveDocument } from "@/lib/server/hub";
import { validateCanvasDocument } from "./model";

export type CanvasPatch = { epoch: string; version: number; operation: "replace" | "replace_component" | "insert_after" | "remove" | "move_after" | "styles"; target?: string; after?: string; html?: string; css?: string };
export function readCanvas(doc: LiveDocument) {
  if (!isCanvas(doc.doc)) throw new EditError("This is not a Canvas. Use create_canvas to create one.");
  return { id: doc.id, title: doc.meta.title, epoch: doc.epoch, version: doc.version, html: canvasMarkup(doc.doc), css: doc.doc.attrs.canvas.css as string };
}

export function canvasTransform(doc: LiveDocument, patch: CanvasPatch): Transform {
  readCanvas(doc);
  if (patch.epoch !== doc.epoch || patch.version !== doc.version) throw new EditError("Canvas changed since you read it. Read it again and apply a fresh patch; no changes were applied.");
  const tr = new Transform(doc.doc);
  const find = (id?: string) => {
    let result: { node: PMNode; pos: number } | undefined;
    doc.doc.descendants((node, pos) => { if (id && node.attrs.id === id) result = { node, pos }; });
    if (!result) throw new EditError(`Canvas component ${id || "(missing id)"} was not found.`);
    return result;
  };
  const unlock = (from: number, to: number) => { if (lockedBetween(doc.doc, from, to)) throw new EditError("This operation would change locked content. Preserve it with a style-only or more focused patch."); };
  try {
    if (patch.operation === "styles") {
      if (patch.css === undefined) throw new Error("styles requires css.");
      tr.setDocAttribute("canvas", { format: 1, css: validateCanvasCss(patch.css) });
      validateCanvasDocument(tr.doc);
      return tr;
    }
    if (patch.operation === "replace") {
      if (patch.html === undefined) throw new Error("replace requires html.");
      unlock(0, doc.doc.content.size);
      const candidate = compileCanvas(patch.html, patch.css ?? doc.doc.attrs.canvas.css);
      tr.replaceWith(0, doc.doc.content.size, candidate.content);
      return tr.setDocAttribute("canvas", candidate.attrs.canvas);
    }
    const target = find(patch.target);
    if (patch.operation === "remove") {
      unlock(target.pos, target.pos + target.node.nodeSize);
      tr.step(new ReplaceStep(target.pos, target.pos + target.node.nodeSize, Slice.empty));
    } else if (patch.operation === "move_after") {
      const after = find(patch.after);
      if (after.pos >= target.pos && after.pos < target.pos + target.node.nodeSize) throw new Error("Cannot move a component inside itself.");
      unlock(target.pos, target.pos + target.node.nodeSize);
      tr.step(new ReplaceStep(target.pos, target.pos + target.node.nodeSize, Slice.empty));
      const at = tr.mapping.map(after.pos + after.node.nodeSize);
      tr.step(new ReplaceStep(at, at, new Slice(Fragment.from(target.node), 0, 0)));
    } else {
      if (!patch.html) throw new Error(`${patch.operation} requires html containing one block inside Canvas.`);
      const fragment = compileCanvas(patch.html).content;
      if (fragment.childCount !== 1) throw new Error("A component patch must contain exactly one block.");
      if (patch.operation === "replace_component") {
        unlock(target.pos, target.pos + target.node.nodeSize);
        const replacement = fragment.firstChild!;
        tr.step(new ReplaceStep(target.pos, target.pos + target.node.nodeSize, new Slice(Fragment.from(replacement.type.create({ ...replacement.attrs, id: target.node.attrs.id }, replacement.content, replacement.marks)), 0, 0)));
      } else if (patch.operation === "insert_after") { const at = target.pos + target.node.nodeSize; tr.step(new ReplaceStep(at, at, new Slice(fragment, 0, 0))); }
      else throw new Error("Unknown Canvas operation.");
    }
    if (patch.css !== undefined) tr.setDocAttribute("canvas", { format: 1, css: validateCanvasCss(patch.css) });
    // Check the resulting structure, including parent cardinality, before commit.
    tr.doc.check();
    validateCanvasDocument(tr.doc);
    return tr;
  } catch (error) { throw new EditError(error instanceof Error ? error.message : "Invalid Canvas patch."); }
}
