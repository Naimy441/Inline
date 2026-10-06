import { z } from "zod";
import { json, readJson, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string }> };

const Body = z.object({
  version: z.number().int().min(0),
  epoch: z.string().max(40).optional(),
  pages: z.number().int().min(1).max(100_000),
  starts: z.array(z.number().int().min(0)).max(100_000),
  lastPageFill: z.number().min(0).max(1),
  /** The page-breaking settings it was measured under (layoutKey). */
  settings: z.string().max(400).optional(),
  kept: z
    .object({
      pages: z.number().int().min(1).max(100_000),
      starts: z.array(z.number().int().min(0)).max(100_000),
      lastPageFill: z.number().min(0).max(1),
    })
    .optional(),
});

/** How the user's editor laid the document out on pages, so Claude can count them. */
export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, Body);
  if (!body.epoch || body.epoch === doc.epoch) doc.setLayout(body);
  return json({ ok: true });
});
