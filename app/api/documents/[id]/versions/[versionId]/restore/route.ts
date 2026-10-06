import { json, route, routeDocument } from "@/lib/server/http";

type Context = { params: Promise<{ id: string; versionId: string }> };

export const POST = route(async (_request, context: Context) => {
  const doc = await routeDocument(context);
  const { versionId } = await context.params;
  const version = await doc.restoreVersion(versionId);
  doc.noteUserEvent(`restored an earlier version of the document ("${version.label}", saved ${new Date(version.createdAt).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })})`);
  return json({ version, document: doc.snapshot() });
});
