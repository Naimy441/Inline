import { z } from "zod";
import { json, readJson, route, routeDocument } from "@/lib/server/http";
import { documentHub } from "@/lib/server/hub";

type Context = { params: Promise<{ id: string }> };

export const GET = route(async (_request, context: Context) => {
  const doc = await routeDocument(context, { allowTrashed: true });
  return json({ document: doc.snapshot() });
});

const PatchBody = z.object({
  title: z.string().max(300).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  trashed: z.boolean().optional(),
});

export const PATCH = route(async (request, context: Context) => {
  const doc = await routeDocument(context, { allowTrashed: true });
  const body = await readJson(request, PatchBody);
  if (body.title !== undefined || body.settings !== undefined) doc.updateMeta({ title: body.title, settings: body.settings });
  if (body.trashed !== undefined) doc.setTrashed(body.trashed);
  return json({ meta: doc.meta });
});

export const DELETE = route(async (_request, context: Context) => {
  const doc = await routeDocument(context, { allowTrashed: true });
  await documentHub().remove(doc.id);
  return json({ ok: true });
});
