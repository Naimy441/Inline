import { z } from "zod";
import type { ToolDefinition, ToolContext } from "./tools";
import { EditError, canvasHeadingTitle } from "@/lib/doc/editing";
import { documentHub } from "@/lib/server/hub";
import { compileCanvas } from "@/lib/canvas/compiler";
import { canvasHasContent, canvasTransform, readCanvas, type CanvasOp, type CanvasPatch } from "@/lib/canvas/operations";
import { canvasCssNotes } from "@/lib/canvas/styles";
import { CANVAS_FRAGMENTS, CANVAS_GUIDE } from "@/lib/canvas/examples";
import { renderCanvas } from "@/lib/server/canvasRender";
import { dropCanvasPreview, putCanvasPreview } from "@/lib/server/canvasPreview";
import { readWorkspaceText } from "@/lib/server/repo";

const document_id = z.string().optional();
const canvasOpShape = {
  operation: z.enum(["replace", "replace_component", "insert_after", "remove", "move_after", "styles"]),
  target: z.string().optional(), after: z.string().optional(), html: z.string().max(500_000).optional(), css: z.string().max(80_000).optional(),
  html_file: z.string().max(500).optional().describe("Path in this document's folder whose contents are the HTML. Use this instead of pasting html again."),
};
export const canvasPatchShape = {
  epoch: z.string(), version: z.number().int().min(0),
  operation: canvasOpShape.operation.optional(),
  operations: z.array(z.object(canvasOpShape)).min(1).max(12).optional(),
  operations_file: z.string().max(500).optional().describe("Path in this document's folder. The file is a JSON array of operations, used instead of operations."),
  target: z.string().optional(), after: z.string().optional(), html: z.string().max(500_000).optional(), css: z.string().max(80_000).optional(),
  html_file: z.string().max(500).optional().describe("Path in this document's folder whose contents are the HTML. Inline html still works."),
};
function patchWroteCss(patch: CanvasPatch) {
  const ops: CanvasOp[] = patch.operations ?? (patch.operation ? [{ operation: patch.operation, css: patch.css }] : []);
  return ops.some((op) => op.operation === "styles" || op.css !== undefined);
}

const STYLES_REPLACE = "styles replaces the whole stylesheet.";

function measurementUnavailable(error: unknown) {
  const message = error instanceof Error ? error.message : "";
  return /layout browser|Couldn't picture the page|Couldn't install the layout browser|no address a browser can open|Open Inline in a browser/i.test(message);
}

type FileOp = CanvasOp & { html_file?: string };

async function readFolderText(documentId: string, file: string) {
  try {
    const found = await readWorkspaceText(documentId, file);
    if (found.kind !== "text") throw new EditError(`${file} is not a text file.`);
    return found.text;
  } catch (error) {
    if (error instanceof EditError) throw error;
    throw new EditError(error instanceof Error ? error.message : "Couldn't read that file.");
  }
}

/** Inline HTML still works. A path reads that payload from the document folder instead of pasting it again. */
async function materializePatch(documentId: string, patch: CanvasPatch & { html_file?: string; operations_file?: string }): Promise<CanvasPatch> {
  let operations: FileOp[] | undefined = patch.operations?.map((op) => ({ ...op }));
  if (patch.operations_file) {
    if (operations || patch.operation) throw new EditError("Pass operations or operations_file, not both.");
    let parsed: unknown;
    try { parsed = JSON.parse(await readFolderText(documentId, patch.operations_file)); }
    catch (error) {
      if (error instanceof EditError) throw error;
      if (error instanceof SyntaxError) throw new EditError(`${patch.operations_file} must be a JSON array of operations.`);
      throw error;
    }
    if (!Array.isArray(parsed)) throw new EditError(`${patch.operations_file} must be a JSON array of operations.`);
    operations = parsed as FileOp[];
  }
  const fill = async (op: FileOp): Promise<CanvasOp> => {
    if (op.html_file) {
      if (op.html !== undefined) throw new EditError("Pass html or html_file, not both.");
      const html = await readFolderText(documentId, op.html_file);
      const { html_file: _file, ...rest } = op;
      return { ...rest, html };
    }
    const { html_file: _file, ...rest } = op;
    return rest;
  };
  if (operations) {
    const resolved: CanvasOp[] = [];
    for (const op of operations) resolved.push(await fill(op));
    return { epoch: patch.epoch, version: patch.version, operations: resolved };
  }
  const one = await fill({ operation: patch.operation!, target: patch.target, after: patch.after, html: patch.html, css: patch.css, html_file: patch.html_file });
  return { epoch: patch.epoch, version: patch.version, ...one };
}

async function resolve(ctx: ToolContext, id?: string) {
  const target = id || ctx.documentId;
  if (!target) throw new Error("Open a Canvas or pass document_id.");
  return documentHub().require(target);
}

function define<S extends z.ZodRawShape>(tool: ToolDefinition<S>): ToolDefinition<S> { return tool; }

export const canvasTools = [
  define({
    name: "read_canvas", title: "Read canvas", write: false,
    description: "Read current Canvas markup, CSS, epoch and revision, including the user's manual edits. Read before every patch. Set include_guide for SDK contracts and syntax fragments. The fragments are syntax only: invent the composition, and do not reuse a title, equation, or palette from a previous canvas.",
    shape: { document_id, include_guide: z.boolean().optional() },
    async handler(args, ctx) {
      const state = readCanvas(await resolve(ctx, args.document_id));
      return { text: JSON.stringify({ ...state, ...(args.include_guide ? { guide: CANVAS_GUIDE, fragments: CANVAS_FRAGMENTS } : {}) }, null, 2) };
    },
  }),
  define({
    name: "create_canvas", title: "Create canvas", write: true,
    description: "Create a designed, directly editable paged Canvas from validated SDK HTML and scoped CSS. Content and design should be composed together. Use this for a composed page, and create_document for ordinary Markdown. The document title becomes the first h1 when the markup has one. Read read_canvas(include_guide:true) on an existing canvas for the SDK, or use get_canvas_guide first.",
    shape: { title: z.string().max(300), html: z.string().max(500_000), css: z.string().max(80_000), folder_id: z.string().optional() },
    async handler(args, ctx) {
      const candidate = compileCanvas(args.html, args.css);
      const doc = await documentHub().create({ title: canvasHeadingTitle(candidate) || args.title, doc: candidate.toJSON(), folderId: args.folder_id });
      ctx.onChange?.({ documentId: doc.id, title: doc.meta.title, tool: "create_canvas", added: doc.meta.wordCount, removed: 0 });
      ctx.onOpen?.(doc.id);
      return { text: JSON.stringify(readCanvas(doc), null, 2) };
    },
  }),
  define({
    name: "get_canvas_guide", title: "Canvas design guide", write: false,
    description: "Read the Inline Canvas SDK capabilities, pagination contracts, supported CSS, and short syntax fragments. The fragments are syntax only: invent the composition for the subject, and do not reuse a title, equation, or palette from a previous canvas.",
    shape: {},
    async handler() { return { text: `${CANVAS_GUIDE}\n\n${JSON.stringify(CANVAS_FRAGMENTS, null, 2)}` }; },
  }),
  define({
    name: "patch_canvas", title: "Edit canvas", write: true,
    description: "Apply one atomic Canvas design/content operation, or a list of up to 12 operations, against the epoch and revision returned by read_canvas. Pass operations instead of operation to apply them together; the result's steps field is how many steps the revision advanced (a rekeyed duplicate id adds a step). styles replaces the whole stylesheet and preserves every word; component operations preserve untouched model content and the ids you write. html is a complete Canvas root, with one block for component operations. Pass html_file or operations_file to read that HTML or those operations from a file in this document's folder. Inline html still works. Whole replace is for the first composition of an empty canvas. Once the canvas has content, replace is rejected unless redesign is true because the user asked for a redesign or rewrite. Prefer replace_component, insert_after, remove, move_after, or styles. Set dry_run to validate and measure the patch without writing it. A dry run returns the same page measurements as inspect_canvas, and the editor does not change. If the page cannot be measured, the dry run still validates the markup and says measurement is unavailable.",
    shape: {
      document_id,
      ...canvasPatchShape,
      dry_run: z.boolean().optional().describe("Validate and measure the patch without writing it. Returns the same page measurements as inspect_canvas."),
      redesign: z.boolean().optional().describe("Allow a whole-document replace on a canvas that already has content. Set this only when the user asked for a redesign or rewrite."),
    },
    async handler(args, ctx) {
      const doc = await resolve(ctx, args.document_id);
      const patch = await materializePatch(doc.id, args as unknown as CanvasPatch & { html_file?: string; operations_file?: string });
      const ops = patch.operations ?? (patch.operation ? [{ operation: patch.operation }] : []);
      if (!args.redesign && ops.some((op) => op.operation === "replace") && canvasHasContent(doc.doc)) {
        throw new EditError("This canvas already has content, so a whole-document replace was rejected and nothing was written. Edit with replace_component, insert_after, remove, move_after, or styles. Pass redesign: true only when the user asked for a redesign or rewrite.");
      }
      const styleNote = patchWroteCss(patch) ? ` ${STYLES_REPLACE}` : "";
      if (args.dry_run) {
        const { tr, notes } = canvasTransform(doc, patch);
        const token = putCanvasPreview(doc.id, { ...doc.snapshot(), doc: tr.doc.toJSON() });
        try {
          const result = await renderCanvas(doc, { preview: token });
          return { text: `Dry run only; the canvas was not changed.${styleNote}\n${JSON.stringify({ ...result.report, notes }, null, 2)}` };
        } catch (error) {
          if (!measurementUnavailable(error)) throw error;
          const reason = error instanceof Error ? error.message : "The page could not be measured.";
          return { text: `Dry run only; the canvas was not changed. The markup is valid. Measurement is unavailable. ${reason} Apply this same patch to write it.${styleNote}\n${JSON.stringify({ notes }, null, 2)}` };
        } finally {
          dropCanvasPreview(token);
        }
      }
      canvasTransform(doc, patch); // Validate before checkpointing; recheck after the await.
      await ctx.beforeWrite?.(doc);
      const before = doc.version;
      const { tr, notes } = canvasTransform(doc, patch);
      const planned = tr.steps.length;
      doc.applyTransform(tr, { kind: "agent", author: ctx.author, turn: ctx.turn, tool: "patch_canvas" });
      const steps = doc.version - before;
      const detail = [...notes];
      if (steps > planned) detail.push(`Duplicate ids were rekeyed, which advanced the revision by ${steps - planned} extra step${steps - planned === 1 ? "" : "s"}.`);
      else if (steps > 1) detail.push(`The revision advanced by ${steps} steps.`);
      if (patchWroteCss(patch)) {
        detail.push(STYLES_REPLACE);
        detail.push(...canvasCssNotes(doc.doc.attrs.canvas.css as string, doc.doc));
      }
      ctx.onChange?.({ documentId: doc.id, title: doc.meta.title, tool: "patch_canvas", added: 0, removed: 0 });
      return { text: `Canvas updated atomically. ${JSON.stringify({ epoch: doc.epoch, version: doc.version, steps, notes: detail })}.${styleNote} Call check_layout after a layout change.` };
    },
  }),
  define({
    name: "inspect_canvas", title: "Inspect canvas layout", write: false,
    description: "Measure the actual paginated HTML in a browser. Returns page count, content IDs with top and height in CSS pixels, the content box, free space on each page, fonts, assets, layout issues and the exact revision/profile. A PageBreak counts only its own height. Overflow names the child and says width or height, in px. Issues also include a component taller than a page, decorated flowing containers, a mostly empty page, a heading left at the bottom, a last page with only a short block, and a page with very little content before a PageBreak. The page a PageBreak starts is not flagged for being short. Use screenshot_page for visual composition. Page numbers are valid only for the returned revision. Pass epoch and version to reject a stale page reference instead of measuring a newer revision.",
    shape: { document_id, epoch: z.string().optional(), version: z.number().int().optional() },
    async handler(args, ctx) {
      const doc = await resolve(ctx, args.document_id);
      if ((args.epoch == null) !== (args.version == null)) throw new EditError("Pass both epoch and version, or neither.");
      if (args.epoch != null && (args.epoch !== doc.epoch || args.version !== doc.version)) {
        throw new EditError(`This Canvas is now revision ${doc.version} (epoch ${doc.epoch}). That page reference is stale. Read the canvas again; page numbers are not content identity.`);
      }
      readCanvas(doc);
      const result = await renderCanvas(doc);
      return { text: JSON.stringify(result.report, null, 2) };
    },
  }),
  define({
    name: "check_layout", title: "Check canvas layout", write: false,
    description: "Check a Canvas for layout problems a design change can cause: content overflowing its width or height (the child and the overflow in px), a component taller than a page, padding, borders, or backgrounds on flowing containers, a mostly empty page, a heading left at the bottom, a last page with only a short block, and a page with very little content before a PageBreak. Returns those issues and the revision they were measured on. Use patch_canvas dry_run to measure a patch before writing it. Page numbers are valid only for the returned revision.",
    shape: { document_id, epoch: z.string().optional(), version: z.number().int().optional() },
    async handler(args, ctx) {
      const doc = await resolve(ctx, args.document_id);
      if ((args.epoch == null) !== (args.version == null)) throw new EditError("Pass both epoch and version, or neither.");
      if (args.epoch != null && (args.epoch !== doc.epoch || args.version !== doc.version)) {
        throw new EditError(`This Canvas is now revision ${doc.version} (epoch ${doc.epoch}). That page reference is stale. Read the canvas again; page numbers are not content identity.`);
      }
      readCanvas(doc);
      const result = await renderCanvas(doc);
      const issues = result.report.issues;
      const hard = issues.filter((issue) => issue.severity !== "warning");
      const warnings = issues.filter((issue) => issue.severity === "warning");
      const summary = hard.length
        ? `${hard.length} layout issue${hard.length === 1 ? "" : "s"}.`
        : warnings.length
          ? `No overflow or unsupported page decorations. ${warnings.length} page-fit warning${warnings.length === 1 ? "" : "s"}.`
          : "No overflow or unsupported page decorations.";
      return { text: `${summary}\n${JSON.stringify({ epoch: result.report.epoch, version: result.report.version, pages: result.report.pages, issues }, null, 2)}` };
    },
  }),
];
