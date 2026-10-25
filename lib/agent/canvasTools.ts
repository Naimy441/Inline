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
import { UNRESTRICTED_GUIDE, UNRESTRICTED_STARTER, readUnrestrictedCanvas, switchToUnrestrictedTransform, unrestrictedHtml, unrestrictedTransform, validateUnrestrictedHtml } from "@/lib/canvas/unrestricted";
import { renderUnrestrictedCanvas } from "@/lib/server/unrestrictedRender";

const document_id = z.string().optional();
const canvasOpShape = {
  operation: z.enum(["replace", "replace_component", "insert_after", "remove", "move_after", "styles"]),
  target: z.string().optional(), after: z.string().optional(), html: z.string().max(500_000).optional(), css: z.string().max(80_000).optional(),
};
export const canvasPatchShape = {
  epoch: z.string(), version: z.number().int().min(0),
  operation: canvasOpShape.operation.optional(),
  operations: z.array(z.object(canvasOpShape)).min(1).max(12).optional(),
  target: z.string().optional(), after: z.string().optional(), html: z.string().max(500_000).optional(), css: z.string().max(80_000).optional(),
};
function patchWroteCss(patch: CanvasPatch) {
  const ops: CanvasOp[] = patch.operations ?? (patch.operation ? [{ operation: patch.operation, css: patch.css }] : []);
  return ops.some((op) => op.operation === "styles" || op.css !== undefined);
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
    name: "switch_to_unrestricted_canvas", title: "Switch to unrestricted canvas", write: true,
    description: `Permanently switch a regular Canvas to an unrestricted Canvas: one complete HTML document you write freely, with no SDK components, no CSS filter and no required vocabulary. Use it only when the user asks for it, or asks for something the SDK cannot express. The SDK content is replaced by the html you pass, so carry over the user's content into it. It cannot be switched back (the user can only restore an earlier version from history). Pass the epoch and version from read_canvas, and html, a complete document (<!doctype html> through </html>); omit html only for a blank starter page. The page is shown in a sandboxed frame with scripts enabled but no access to Inline's own page. Afterwards use read_unrestricted_canvas, write_unrestricted_canvas and screenshot_unrestricted_canvas.\n\n${UNRESTRICTED_GUIDE}`,
    shape: {
      document_id,
      epoch: z.string(),
      version: z.number().int().min(0),
      html: z.string().max(500_000).optional(),
    },
    async handler(args, ctx) {
      const doc = await resolve(ctx, args.document_id);
      const patch = { epoch: args.epoch, version: args.version, html: validateUnrestrictedHtml(args.html ?? UNRESTRICTED_STARTER) };
      switchToUnrestrictedTransform(doc, patch);
      await ctx.beforeWrite?.(doc);
      const tr = switchToUnrestrictedTransform(doc, patch);
      doc.applyTransform(tr, { kind: "agent", author: ctx.author, turn: ctx.turn, tool: "switch_to_unrestricted_canvas" });
      ctx.onChange?.({ documentId: doc.id, title: doc.meta.title, tool: "switch_to_unrestricted_canvas", added: 0, removed: 0 });
      return { text: `Switched to an unrestricted Canvas. ${JSON.stringify({ epoch: doc.epoch, version: doc.version })}. Call screenshot_unrestricted_canvas to see the result.` };
    },
  }),
  define({
    name: "read_unrestricted_canvas", title: "Read HTML canvas", write: false,
    description: `Read the complete HTML of an unrestricted Canvas, with its epoch and revision. Read before every write_unrestricted_canvas, because the revision changes on every write.\n\n${UNRESTRICTED_GUIDE}`,
    shape: { document_id },
    async handler(args, ctx) {
      const doc = await resolve(ctx, args.document_id);
      return { text: JSON.stringify(readUnrestrictedCanvas(doc), null, 2) };
    },
  }),
  define({
    name: "write_unrestricted_canvas", title: "Write HTML canvas", write: true,
    description: "Change an unrestricted Canvas against the epoch and version from read_unrestricted_canvas. Pass html to replace the whole document, or edits for exact find-and-replace pairs: each old_string must occur exactly once in the current HTML and is replaced by new_string, applied in order. Either the whole write applies or none of it does. A stale epoch or version is rejected. Keep the document paginated and print-ready: fixed-size page elements with page breaks, as in the page contract of read_unrestricted_canvas.",
    shape: {
      document_id,
      epoch: z.string(),
      version: z.number().int().min(0),
      html: z.string().max(500_000).optional(),
      edits: z.array(z.object({ old_string: z.string().max(500_000), new_string: z.string().max(500_000) })).min(1).max(50).optional(),
    },
    async handler(args, ctx) {
      const doc = await resolve(ctx, args.document_id);
      unrestrictedTransform(doc, args); // Validate before checkpointing; recheck after the await.
      await ctx.beforeWrite?.(doc);
      const tr = unrestrictedTransform(doc, args);
      doc.applyTransform(tr, { kind: "agent", author: ctx.author, turn: ctx.turn, tool: "write_unrestricted_canvas" });
      ctx.onChange?.({ documentId: doc.id, title: doc.meta.title, tool: "write_unrestricted_canvas", added: 0, removed: 0 });
      return { text: `Canvas updated. ${JSON.stringify({ epoch: doc.epoch, version: doc.version })}. Call screenshot_unrestricted_canvas to see the result.` };
    },
  }),
  define({
    name: "screenshot_unrestricted_canvas", title: "Screenshot HTML canvas", write: false,
    description: "Picture an unrestricted Canvas as one full-height PNG, laid out at the width you pass (default 1280 px) in light or dark appearance. Scripts run as they do in the editor. Use it after each write you judged visually. It shows the current stored HTML, and it does not change the document.",
    shape: {
      document_id,
      width: z.number().int().min(320).max(2400).optional().describe("Viewport width in CSS pixels (default 1280)."),
      theme: z.enum(["light", "dark"]).optional().describe("Color scheme to render with (default light)."),
    },
    async handler(args, ctx) {
      const doc = await resolve(ctx, args.document_id);
      unrestrictedHtml(doc.doc);
      const shot = await renderUnrestrictedCanvas(doc, { width: args.width, theme: args.theme });
      const errors = shot.errors.length ? ` Script errors: ${shot.errors.slice(0, 5).join(" | ")}` : "";
      return {
        text: `Picture of "${doc.meta.title}" at ${shot.width} × ${shot.height} CSS px.${errors}`,
        images: [{ data: Buffer.from(shot.png).toString("base64"), mimeType: "image/png" }],
      };
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
    description: "Apply one atomic Canvas design/content operation, or a list of up to 12 operations, against the epoch and revision returned by read_canvas. Pass operations instead of operation to apply them together; the result's steps field is how many steps the revision advanced (a rekeyed duplicate id adds a step). styles preserves every word; component operations preserve untouched model content and the ids you write. html is a complete Canvas root, with one block for component operations. Whole replace is for the first composition of an empty canvas. Once the canvas has content, replace is rejected unless redesign is true because the user asked for a redesign or rewrite. Prefer replace_component, insert_after, remove, move_after, or styles. Set dry_run to validate and measure the patch without writing it. A dry run returns the same page measurements as inspect_canvas, and the editor does not change.",
    shape: {
      document_id,
      ...canvasPatchShape,
      dry_run: z.boolean().optional().describe("Validate and measure the patch without writing it. Returns the same page measurements as inspect_canvas."),
      redesign: z.boolean().optional().describe("Allow a whole-document replace on a canvas that already has content. Set this only when the user asked for a redesign or rewrite."),
    },
    async handler(args, ctx) {
      const doc = await resolve(ctx, args.document_id);
      const patch = args as unknown as CanvasPatch;
      const ops = patch.operations ?? (patch.operation ? [{ operation: patch.operation }] : []);
      if (!args.redesign && ops.some((op) => op.operation === "replace") && canvasHasContent(doc.doc)) {
        throw new EditError("This canvas already has content, so a whole-document replace was rejected and nothing was written. Edit with replace_component, insert_after, remove, move_after, or styles. Pass redesign: true only when the user asked for a redesign or rewrite.");
      }
      if (args.dry_run) {
        const { tr, notes } = canvasTransform(doc, patch);
        const token = putCanvasPreview(doc.id, { ...doc.snapshot(), doc: tr.doc.toJSON() });
        try {
          const result = await renderCanvas(doc, { preview: token });
          return { text: `Dry run only; the canvas was not changed.\n${JSON.stringify({ ...result.report, notes }, null, 2)}` };
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
      if (patchWroteCss(patch)) detail.push(...canvasCssNotes(doc.doc.attrs.canvas.css as string, doc.doc));
      ctx.onChange?.({ documentId: doc.id, title: doc.meta.title, tool: "patch_canvas", added: 0, removed: 0 });
      return { text: `Canvas updated atomically. ${JSON.stringify({ epoch: doc.epoch, version: doc.version, steps, notes: detail })}. Call check_layout after a layout change.` };
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
