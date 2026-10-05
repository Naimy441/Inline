import { json, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string; versionId: string }> };

export const POST = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const { versionId } = await context.params;
  const version = await doc.restoreVersion(versionId);
  return json({ version, document: doc.snapshot() });
});
