import { z } from "zod";
import { startPdfConversion } from "@/lib/agent/pdfConversion";
import { HttpError, json, notFound, readJson, route, routeDocument } from "@/lib/server/http";
import { pdfImportFor } from "@/lib/server/pdfImports";

type Context = { params: Promise<{ id: string }> };

/**
 * A document imported from a PDF (lib/server/pdfImports.ts). GET: the
 * original pages' sizes and annotation pictures, for the overlay. PATCH:
 * show or hide the annotations. POST: start Claude on converting the pages
 * still left (or the ones named), returning its chat.
 */

export const GET = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const record = await pdfImportFor(doc);
  if (!record) throw notFound("This document wasn't imported from a PDF.");
  return json({
    fileName: record.fileName,
    source: record.source,
    pages: record.manifest.pages.map((page, index) => ({ page: page.page, width: page.width, height: page.height, ink: record.pages[index]?.ink ?? null })),
  });
});

const PatchSchema = z.object({ showAnnotations: z.boolean() }).strict();

export const PATCH = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, PatchSchema);
  if (!doc.meta.pdfImport) throw notFound("This document wasn't imported from a PDF.");
  return json({ pdfImport: doc.setPdfImport({ showAnnotations: body.showAnnotations }) });
});

const ConvertSchema = z.object({ pages: z.array(z.number().int().min(1)).max(1000).optional() }).strict();

export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, ConvertSchema);
  const record = await pdfImportFor(doc);
  if (!record || !doc.meta.pdfImport) throw notFound("This document wasn't imported from a PDF.");
  if (body.pages?.some((page) => page > record.manifest.pageCount)) throw new HttpError(400, `The PDF has ${record.manifest.pageCount} pages.`);
  const chatId = await startPdfConversion(doc, record, { pages: body.pages });
  return json({ chatId });
});
