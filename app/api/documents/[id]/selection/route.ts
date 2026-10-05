import { z } from "zod";
import { json, readJson, route, routeDocument } from "@/lib/server/http";
import { documentHub } from "@/lib/server/hub";

type Context = { params: Promise<{ id: string }> };

const Body = z.object({ from: z.number().int().min(0), to: z.number().int().min(0), version: z.number().int().min(0) });

/** The user's selection, so Claude can resolve "this" and "here". */
export const POST = route(async (request, context: Context) => {
  const doc = await routeDocument(context);
  const body = await readJson(request, Body);
  doc.setSelection(body);
  documentHub().activeDocumentId = doc.id;
  return json({ ok: true });
});
