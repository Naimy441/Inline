import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { schema } from "@/lib/doc/schema";
import { EditError } from "@/lib/doc/editing";
import type { LiveDocument } from "@/lib/server/hub";

/**
 * Unrestricted Canvas: the page is one complete HTML document the author owns.
 * There is no component vocabulary, no CSS filter, and no pagination contract.
 * The editor shows it in a sandboxed frame, and the document's ProseMirror
 * body stays a single empty paragraph so every other tool keeps working.
 */
export const UNRESTRICTED_FORMAT = 2;
export const UNRESTRICTED_LIMIT = 500_000;

export const UNRESTRICTED_STARTER = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  body { margin: 0; font-family: system-ui, sans-serif; color: #1d1d1f; background: #ffffff; }
</style>
</head>
<body>
</body>
</html>`;

export function validateUnrestrictedHtml(html: unknown): string {
  if (typeof html !== "string") throw new EditError("An unrestricted canvas needs html.");
  if (html.length > UNRESTRICTED_LIMIT) throw new EditError(`The canvas HTML exceeds ${UNRESTRICTED_LIMIT.toLocaleString("en-US")} characters.`);
  if (!/<html[\s>]|<body[\s>]|<!doctype/i.test(html)) throw new EditError("Write a complete HTML document, starting with <!doctype html> and an <html> element.");
  return html;
}

/** The ProseMirror body of an unrestricted canvas: one empty paragraph. */
export function unrestrictedCanvasDoc(html: string): PMNode {
  const doc = schema.nodes.doc.createChecked({ canvas: { format: UNRESTRICTED_FORMAT, html: validateUnrestrictedHtml(html) } }, [schema.node("paragraph")]);
  doc.check();
  return doc;
}

export function unrestrictedHtml(doc: PMNode): string {
  const design = doc.attrs.canvas;
  if (design?.format !== UNRESTRICTED_FORMAT || typeof design.html !== "string") throw new EditError("This is not an unrestricted Canvas.");
  return design.html;
}

export function readUnrestrictedCanvas(doc: LiveDocument) {
  return { id: doc.id, title: doc.meta.title, epoch: doc.epoch, version: doc.version, html: unrestrictedHtml(doc.doc) };
}

export type UnrestrictedEdit = { old_string: string; new_string: string };

/**
 * Apply a whole-document replacement, or exact find-and-replace edits, against
 * the epoch and revision the author read. Each old_string must occur exactly once.
 */
export function unrestrictedTransform(
  doc: LiveDocument,
  patch: { epoch: string; version: number; html?: string; edits?: UnrestrictedEdit[] },
): Transform {
  const current = readUnrestrictedCanvas(doc);
  if (patch.epoch !== current.epoch || patch.version !== current.version) {
    throw new EditError(`This canvas is now revision ${current.version} (epoch ${current.epoch}). Read it again and apply a fresh write; no changes were applied.`);
  }
  if ((patch.html === undefined) === (patch.edits === undefined)) throw new EditError("Pass html for a full rewrite, or edits for exact replacements. Not both.");
  let html = patch.html ?? current.html;
  if (patch.edits) {
    if (!patch.edits.length) throw new EditError("edits needs at least one replacement.");
    for (const [index, edit] of patch.edits.entries()) {
      if (!edit.old_string) throw new EditError(`edits[${index}].old_string is empty.`);
      const first = html.indexOf(edit.old_string);
      if (first < 0) throw new EditError(`edits[${index}].old_string was not found. Read the canvas again and copy the text exactly.`);
      if (html.indexOf(edit.old_string, first + 1) >= 0) throw new EditError(`edits[${index}].old_string occurs more than once. Include more surrounding text so it is unique.`);
      html = html.slice(0, first) + edit.new_string + html.slice(first + edit.old_string.length);
    }
  }
  validateUnrestrictedHtml(html);
  const tr = new Transform(doc.doc);
  tr.setDocAttribute("canvas", { format: UNRESTRICTED_FORMAT, html });
  validateUnrestrictedDocument(tr.doc);
  return tr;
}

/** Called from the document model: a canvas attribute of format 2 must be a valid unrestricted page with no components. */
export function validateUnrestrictedDocument(doc: PMNode) {
  unrestrictedHtml(doc);
  if (!doc.attrs.canvas || doc.attrs.canvas.format !== UNRESTRICTED_FORMAT) throw new Error("Unsupported unrestricted Canvas format.");
  validateUnrestrictedHtml(doc.attrs.canvas.html);
  doc.descendants((node) => {
    if (node.type.name.startsWith("canvas_")) throw new Error("An unrestricted Canvas has no SDK components.");
  });
}
