import { json, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string }> };

/** The user keeps Claude's revision: it becomes the document. */
export const POST = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const result = await doc.keepDraft();
  doc.noteUserEvent("kept Claude's revision, which replaced the document");
  return json({ ...result, document: doc.snapshot() });
});
