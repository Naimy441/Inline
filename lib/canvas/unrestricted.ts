import type { Node as PMNode } from "prosemirror-model";
import { Transform } from "prosemirror-transform";
import { schema } from "@/lib/doc/schema";
import { EditError } from "@/lib/doc/editing";
import type { LiveDocument } from "@/lib/server/hub";

/**
 * Unrestricted Canvas: the page is one complete HTML document the author owns.
 * There is no component vocabulary and no CSS filter, so it is not held to the
 * SDK. It is still paginated by convention (see UNRESTRICTED_GUIDE). The editor shows it in a sandboxed frame, and the document's ProseMirror
 * body stays a single empty paragraph so every other tool keeps working.
 */
export const UNRESTRICTED_FORMAT = 2;
export const UNRESTRICTED_LIMIT = 500_000;

export const UNRESTRICTED_STARTER = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  @page { size: 8.5in 11in; margin: 0; }
  * { box-sizing: border-box; }
  html { background: #e8e8ea; }
  body { margin: 0; font-family: system-ui, sans-serif; color: #1d1d1f; }
  .page { position: relative; width: 8.5in; height: 11in; margin: 24px auto; padding: 0.75in; overflow: hidden; background: #fff; box-shadow: 0 1px 8px rgba(0, 0, 0, 0.18); break-after: page; page-break-after: always; }
  .page:last-child { break-after: auto; page-break-after: auto; }
  @media print { html { background: none; } .page { margin: 0; box-shadow: none; } }
</style>
</head>
<body>
<section class="page"></section>
</body>
</html>`;

/**
 * What an author must know to write an unrestricted Canvas. It is still a
 * paginated document that people print and export, so the page contract
 * stays even though the SDK does not.
 */
export const UNRESTRICTED_GUIDE = [
  "An unrestricted Canvas is one complete HTML document you write freely: your own HTML, CSS and optional script, no SDK components. It is still a paginated document that will be printed and exported to PDF, so design it as pages.",
  "Page contract:",
  "- Declare @page { size: 8.5in 11in; margin: 0 } (or another size the user asked for) and make every page a fixed-size element, such as <section class=\"page\">, exactly that wide and tall (8.5in x 11in = 816 x 1056 CSS px) with overflow: hidden, its own padding for margins, and break-after: page. The last page has no trailing break, so the export has no blank page.",
  "- Nothing may overflow a page's box. Split content across pages yourself: choose where each page ends, and never rely on content flowing onto a next page automatically. Repeat running headers, footers and page numbers per page.",
  "- On screen, show the pages as sheets: a neutral backdrop on html, pages centered with margin: 24px auto and a soft shadow. Inside @media print remove the backdrop, margins and shadows so each sheet prints edge to edge.",
  "- Colors: every page's background is white (#fff) and the backdrop behind the sheets is the neutral gray of the starter (#e8e8ea). Keep both exactly as the starter has them. Change either one only when the user tells you to use a different color; design with color inside the page's content, not by repainting the page or the backdrop.",
  "- No page chrome outside the sheets: no footer, bar or panel under or beside the pages, and no extra background below the last page. The document is the pages and nothing else; running footers belong inside each page.",
  "- Print-friendly rules: set -webkit-print-color-adjust: exact (print-color-adjust: exact) where backgrounds matter; use break-inside: avoid on cards, figures, table rows and captions; keep text at 10pt or larger; avoid fixed or sticky positioning, viewport units (vh, vw) and animation that hides content, because print has no viewport.",
  "- Scripts run in the editor and in the export, but the printed page is static, so the content must be fully laid out without interaction.",
  "- Images must be https URLs, data: URIs, or files in this document's folder at /api/documents/<id>/files/<name>.",
  "After each write, call screenshot_unrestricted_canvas and check that every page is a complete sheet with nothing clipped at the bottom edge.",
].join("\n");

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

/**
 * Permanently switch a Canvas from the SDK to a free HTML page. The SDK content
 * is replaced by the new page; there is no way back, except by restoring a version.
 */
export function switchToUnrestrictedTransform(doc: LiveDocument, patch: { epoch: string; version: number; html: string }): Transform {
  if (!doc.doc.attrs.canvas) throw new EditError("This is not a Canvas.");
  if (doc.doc.attrs.canvas.format === UNRESTRICTED_FORMAT) throw new EditError("This Canvas is already unrestricted.");
  if (patch.epoch !== doc.epoch || patch.version !== doc.version) {
    throw new EditError(`This canvas is now revision ${doc.version} (epoch ${doc.epoch}). Read it again and apply a fresh write; no changes were applied.`);
  }
  const html = validateUnrestrictedHtml(patch.html);
  const tr = new Transform(doc.doc);
  tr.replaceWith(0, doc.doc.content.size, schema.node("paragraph"));
  tr.setDocAttribute("canvas", { format: UNRESTRICTED_FORMAT, html });
  validateUnrestrictedDocument(tr.doc);
  return tr;
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
