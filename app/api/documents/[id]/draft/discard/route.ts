import { json, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string }> };

export const POST = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  await doc.dropDraft();
  doc.noteUserEvent("discarded Claude's revision and kept the document as it was");
  return json({ ok: true });
});