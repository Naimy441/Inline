import { z } from "zod";
import { parseCanvas } from "@/lib/doc/canvas";
import { HttpError, json, readJson, route, routeDocument } from "@/lib/server/http";
import { runNotebookSource } from "@/lib/server/notebook";

type Context = { params: Promise<{ id: string }> };

const PatchBody = z
  .object({
    html: z.string().max(1_000_000).optional(),
    kind: z.enum(["page", "canvas"]).optional(),
  })
  .strict();

/** Save canvas HTML, or turn the document between a page and a canvas. */
export const PATCH = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, PatchBody);
  if (body.kind) doc.setKind(body.kind);
  if (body.html !== undefined) {
    if (doc.meta.kind !== "canvas") doc.setKind("canvas");
    doc.setCanvas(body.html);
  }
  return json({ meta: doc.meta, html: doc.canvas?.html ?? null, outputs: doc.canvas?.outputs ?? {} });
});

const RunBody = z.object({ cellId: z.string().regex(/^[A-Za-z0-9_-]{1,80}$/) }).strict();

/** Run one notebook cell. Its working directory is this canvas document only. */
export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  if (doc.meta.kind !== "canvas" || !doc.canvas) throw new HttpError(422, "This document is not a canvas.");
  const body = await readJson(request, RunBody);
  const cell = parseCanvas(doc.canvas.html)
    .sections.flatMap((section) => section.blocks)
    .find((block) => block.kind === "cell" && block.id === body.cellId);
  if (!cell || cell.kind !== "cell") throw new HttpError(404, `No notebook cell "${body.cellId}".`);
  const output = await runNotebookSource({ documentId: doc.id, cellId: cell.id, language: cell.language, source: cell.source });
  doc.setCellOutput(cell.id, output);
  return json({ output });
});
