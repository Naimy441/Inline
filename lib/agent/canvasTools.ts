import { z } from "zod";
import type { ToolDefinition, ToolContext } from "./tools";
import { documentHub } from "@/lib/server/hub";
import { compileCanvas } from "@/lib/canvas/compiler";
import { canvasTransform, readCanvas, type CanvasPatch } from "@/lib/canvas/operations";
import { CANVAS_EXAMPLES, CANVAS_GUIDE } from "@/lib/canvas/examples";
import { renderCanvas } from "@/lib/server/canvasRender";

const document_id = z.string().optional();
export const canvasPatchShape = {
  epoch: z.string(), version: z.number().int().min(0),
  operation: z.enum(["replace", "replace_component", "insert_after", "remove", "move_after", "styles"]),
  target: z.string().optional(), after: z.string().optional(), html: z.string().max(500_000).optional(), css: z.string().max(80_000).optional(),
};
async function resolve(ctx: ToolContext, id?: string) {
  const target = id || ctx.documentId;
  if (!target) throw new Error("Open a Canvas or pass document_id.");
  return documentHub().require(target);
}

function define<S extends z.ZodRawShape>(tool: ToolDefinition<S>): ToolDefinition<S> { return tool; }

export const canvasTools = [
  define({
    name: "read_canvas", title: "Read canvas", write: false,
    description: "Read current Canvas markup, CSS, epoch and revision, including the user's manual edits. Read before every patch. Set include_guide for SDK contracts and example designs.",
    shape: { document_id, include_guide: z.boolean().optional() },
    async handler(args, ctx) {
      const state = readCanvas(await resolve(ctx, args.document_id));
      return { text: JSON.stringify({ ...state, ...(args.include_guide ? { guide: CANVAS_GUIDE, examples: CANVAS_EXAMPLES } : {}) }, null, 2) };
    },
  }),
  define({
    name: "create_canvas", title: "Create canvas", write: true,
    description: "Create a designed, directly editable paged Canvas from validated SDK HTML and scoped CSS. Content and design should be composed together. Read read_canvas(include_guide:true) on an existing canvas for the SDK, or use get_canvas_guide first.",
    shape: { title: z.string().max(300), html: z.string().max(500_000), css: z.string().max(80_000), folder_id: z.string().optional() },
    async handler(args, ctx) {
      const candidate = compileCanvas(args.html, args.css);
      const doc = await documentHub().create({ title: args.title, doc: candidate.toJSON(), folderId: args.folder_id });
      ctx.onChange?.({ documentId: doc.id, title: doc.meta.title, tool: "create_canvas", added: doc.meta.wordCount, removed: 0 });
      ctx.onOpen?.(doc.id);
      return { text: JSON.stringify(readCanvas(doc), null, 2) };
    },
  }),
  define({
    name: "get_canvas_guide", title: "Canvas design guide", write: false,
    description: "Read the Inline Canvas SDK capabilities, pagination contracts, supported CSS, and three complete design examples before designing a Canvas.",
    shape: {},
    async handler() { return { text: `${CANVAS_GUIDE}\n\n${JSON.stringify(CANVAS_EXAMPLES, null, 2)}` }; },
  }),
  define({
    name: "patch_canvas", title: "Edit canvas", write: true,
    description: "Apply one atomic Canvas design/content operation against the epoch and revision returned by read_canvas. styles preserves every word; component operations preserve untouched model content. html is a complete Canvas root, with one block for component operations. Whole replace is for initial composition or an explicitly requested redesign/rewrite; prefer focused patches.",
    shape: { document_id, ...canvasPatchShape },
    async handler(args, ctx) {
      const doc = await resolve(ctx, args.document_id);
      const patch = args as unknown as CanvasPatch;
      canvasTransform(doc, patch); // Validate before checkpointing; recheck after the await.
      await ctx.beforeWrite?.(doc);
      const tr = canvasTransform(doc, patch);
      doc.applyTransform(tr, { kind: "agent", author: ctx.author, turn: ctx.turn, tool: "patch_canvas" });
      ctx.onChange?.({ documentId: doc.id, title: doc.meta.title, tool: "patch_canvas", added: 0, removed: 0 });
      return { text: `Canvas updated atomically. ${JSON.stringify({ epoch: doc.epoch, version: doc.version })}. Inspect the pages after changing layout.` };
    },
  }),
  define({
    name: "inspect_canvas", title: "Inspect canvas layout", write: false,
    description: "Measure the actual paginated HTML in a browser. Returns page count, content IDs, layout issues and the exact revision/profile. Use screenshot_page for visual composition. Page numbers are valid only for the returned revision.",
    shape: { document_id },
    async handler(args, ctx) {
      const doc = await resolve(ctx, args.document_id);
      readCanvas(doc);
      const result = await renderCanvas(doc);
      return { text: JSON.stringify(result.report, null, 2) };
    },
  }),
];
