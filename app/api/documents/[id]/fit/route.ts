import { z } from "zod";
import type { FitMeasurement } from "@/lib/doc/pageFit";
import { deliverFitMeasurement } from "@/lib/server/fitMeasure";
import { json, readJson, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string }> };

const Word = z.object({
  width: z.number().finite().min(0).max(20_000),
  gap: z.number().finite().min(0).max(20_000),
  breakBefore: z.boolean().optional(),
});

const Mark = z.object({
  from: z.number().int().min(0).max(1_000_000),
  to: z.number().int().min(0).max(1_000_000),
  size: z.number().finite().positive().max(400),
});

const Unit = z.object({
  pos: z.number().int().min(0),
  kind: z.enum(["text", "fixed", "break"]),
  gapBefore: z.number().finite().min(0).max(100_000),
  gapScales: z.boolean().optional(),
  lines: z.number().int().min(0).max(10_000).optional(),
  lineHeight: z.number().finite().min(0).max(10_000).optional(),
  fontSize: z.number().finite().min(0).max(400).optional(),
  lineSpacing: z.number().finite().min(0).max(20).optional(),
  width: z.number().finite().min(0).max(20_000).optional(),
  indent: z.number().finite().min(-2_000).max(20_000).optional(),
  height: z.number().finite().min(0).max(100_000).optional(),
  words: z.array(Word).max(20_000).optional(),
  marks: z.array(Mark).max(5_000).optional(),
  canSize: z.boolean().optional(),
  canLead: z.boolean().optional(),
  canSpace: z.boolean().optional(),
  spaceBeforePt: z.number().finite().min(0).max(400).optional(),
  spaceAfterPt: z.number().finite().min(0).max(400).optional(),
});

const Measurement = z.object({
  version: z.number().int().min(0),
  kind: z.enum(["half", "page"]),
  pageContentHeight: z.number().finite().positive().max(100_000),
  bodyFontSize: z.number().finite().positive().max(400),
  bodyLineSpacing: z.number().finite().positive().max(20),
  units: z.array(Unit).max(5_000),
});

const Body = z.object({
  requestId: z.string().min(1).max(80),
  error: z.string().max(500).optional(),
  measurement: Measurement.optional(),
});

/** The editor's measurement of the pages a fit asked for (lib/server/fitMeasure.ts). */
export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, Body);
  return json({
    delivered: deliverFitMeasurement(doc.id, body.requestId, {
      ...(body.error ? { error: body.error } : {}),
      ...(body.measurement ? { measurement: body.measurement as FitMeasurement } : {}),
    }),
  });
});
